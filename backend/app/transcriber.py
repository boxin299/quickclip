"""
语音转录服务模块
ASR: faster-whisper small (CTranslate2, 原生词级 start+end 时间戳, 热词支持)
说话人分离: sherpa-onnx (pyannote 3.0 分割 + 3D-Speaker ERes2Net 嵌入)
"""

import asyncio
import gc
import json
import os
import re
import shutil
import tempfile
import site
import subprocess
import sys
import time
import urllib.request
from typing import List, Dict, Any, Optional
from pathlib import Path

# ── 可写数据根目录（打包后 .app bundle 内的路径不可写）──
def _resolve_data_root() -> Path:
    """返回可写的数据根目录，打包后使用 ~/.quickclip/，开发时优先用项目 data/."""
    import platform
    _self = Path(__file__).resolve()
    _in_bundle = ".app/Contents/" in str(_self)
    # 开发模式：项目 data/ 目录存在且可写（.app bundle 内路径不可靠，跳过）
    if not _in_bundle:
        dev_data = _self.parents[1] / "data"
        try:
            if dev_data.exists():
                dev_data.mkdir(parents=True, exist_ok=True)
                test = dev_data / ".write_test"
                test.write_text("ok")
                test.unlink(missing_ok=True)
                return dev_data
        except Exception:
            pass
    # 打包模式：使用用户目录
    candidates = []
    if platform.system() == "Darwin":
        candidates.extend([
            Path(os.path.expanduser("~/.quickclip")),
            Path(os.path.expanduser("~/Library/Caches/QuickClip")),
        ])
    elif platform.system() == "Windows":
        candidates.append(Path(os.environ.get("APPDATA", "~")) / "QuickClip")
    else:
        candidates.append(Path(os.path.expanduser("~/.quickclip")))
    candidates.append(Path(tempfile.gettempdir()) / "quickclip")
    for c in candidates:
        try:
            c.mkdir(parents=True, exist_ok=True)
            test = c / ".write_test"
            test.write_text("ok")
            test.unlink(missing_ok=True)
            return c
        except Exception:
            continue
    raise RuntimeError("无法找到可写的数据目录")

_DATA_ROOT = _resolve_data_root()

# ── 下载源配置 ──
# Whisper 模型：ModelScope API（国内可达，速度快）
_MODELSCOPE_WHISPER_REPO = "Systran/faster-whisper-small"
_MODELSCOPE_API = "https://modelscope.cn"
# 回退 HF 端点（ModelScope 失败时尝试；国内镜像优先）
_HF_ENDPOINTS = [
    "https://hf-mirror.com",
    "https://huggingface.co",
]
# ModelScope 说话人分离模型（分割模型）
_MODELSCOPE_DIAR_SEG_REPO = "pengzhendong/sherpa-onnx-pyannote-segmentation-3-0"
# GitHub 加速镜像（用于说话人嵌入模型下载，实测可用）
_GITHUB_MIRRORS = [
    "https://ghproxy.net",
    "https://gh.llkk.cc",
]
# GitHub 直连（最后回退）
_GITHUB_DIRECT = "https://github.com"

WHISPER_CACHE = _DATA_ROOT / "whisper_models"
WHISPER_CACHE.mkdir(parents=True, exist_ok=True)
os.environ["HF_HUB_CACHE"] = str(WHISPER_CACHE)
os.environ.setdefault("HF_ENDPOINT", _HF_ENDPOINTS[0])

# 确保 UI 安装流程写入的自定义 target 目录在 sys.path 中（后端重启后不会自动保留）
_CUSTOM_SITE = Path(__file__).resolve().parents[1] / "lib" / "site-packages"
if _CUSTOM_SITE.exists() and str(_CUSTOM_SITE) not in sys.path:
    sys.path.insert(0, str(_CUSTOM_SITE))
    try:
        site.addsitedir(str(_CUSTOM_SITE))
    except Exception:
        pass

try:
    from faster_whisper import WhisperModel
    FW_AVAILABLE = True
except ImportError:
    WhisperModel = None
    FW_AVAILABLE = False

try:
    import sherpa_onnx as _so
    SHERPA_AVAILABLE = True
except ImportError:
    _so = None
    SHERPA_AVAILABLE = False

TRANSCRIPTION_AVAILABLE = FW_AVAILABLE

WHISPER_COMPUTE = "int8_float32"  # M5 最优: 混合精度 + Accelerate 框架
WHISPER_WORKERS = 4
WHISPER_CPU_THREADS = 4
AVAILABLE_WHISPER_SIZES = [
    {"key": "small", "label": "faster-whisper (small)", "download_size": "~927MB", "description": "速度快，精度适中"},
]

_MODEL_SIZE_CONFIG = _DATA_ROOT / "model_config.json"

def _load_whisper_size() -> str:
    try:
        if _MODEL_SIZE_CONFIG.exists():
            data = json.loads(_MODEL_SIZE_CONFIG.read_text(encoding="utf-8"))
            size = data.get("whisper_size", "small")
            if size in {s["key"] for s in AVAILABLE_WHISPER_SIZES}:
                return size
    except Exception:
        pass
    return "small"

def _save_whisper_size(size: str):
    _MODEL_SIZE_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    data = {}
    try:
        if _MODEL_SIZE_CONFIG.exists():
            data = json.loads(_MODEL_SIZE_CONFIG.read_text(encoding="utf-8"))
    except Exception:
        pass
    data["whisper_size"] = size
    _MODEL_SIZE_CONFIG.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

WHISPER_SIZE = _load_whisper_size()

MODELS_DIR = _DATA_ROOT / "sherpa_onnx"
DIAR_SEG = str(MODELS_DIR / "speaker_segmentation" / "model.int8.onnx")
DIAR_EMB = str(MODELS_DIR / "speaker_embedding" / "model.onnx")

LANG_MAP = {"zh": "zh", "en": "en", "ja": "ja", "ko": "ko", "yue": "zh", "auto": None}

# ── 繁体 → 简体 后处理 ──
# Whisper 中文训练数据简繁混杂，同一段音频可能简繁交替输出。initial_prompt 只能软引导，
# 无法稳定保证全简体。此处用 zhconv 在转录结果上做一次确定性的繁→简字形转换（zh-hans，
# 只转字形不改地区词汇），兜底保证输出纯简体。zhconv 缺失时降级为原样返回，不影响转录。
_zhconv_convert = [None]  # [0]: None=未初始化, False=不可用, callable=转换函数

def _to_simplified(text: str) -> str:
    if not text:
        return text
    fn = _zhconv_convert[0]
    if fn is None:
        try:
            from zhconv import convert as _conv
            fn = _zhconv_convert[0] = _conv
        except Exception:
            _zhconv_convert[0] = False
            print("[WARN] zhconv 未安装，跳过繁→简转换（转录可能含繁体字）", flush=True)
            return text
    if fn is False:
        return text
    try:
        return fn(text, "zh-hans")
    except Exception:
        return text

VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".wmv", ".flv", ".ts", ".mts", ".m2ts"}


class TranscriptionModelMissingError(RuntimeError):
    """Raised when transcription is requested before the local model is installed."""

    def __init__(self, message: str = "语音识别模型未安装，请先在「偏好设置 → 模型依赖」下载模型。"):
        super().__init__(message)

# ── 安装进度（list[0] wrapper 避免 Cython 编译后跨函数访问丢失绑定）──
_progress = [{
    "running": False,
    "stage": "",
    "detail": "",
    "error": None,
    "finished": False,
    "total_bytes": 0,
    "downloaded_bytes": 0,
    "speed": 0,
}]

_install_progress = _progress[0]  # 别名，供 main.py import


def _scan_local_model_bytes() -> int:
    """扫描本地已下载的模型文件总字节数（磁盘真实大小）。"""
    total = 0
    # Whisper 模型目录
    whisper_dir = WHISPER_CACHE / f"faster-whisper-{WHISPER_SIZE}"
    if whisper_dir.exists():
        for f in whisper_dir.iterdir():
            if f.is_file():
                total += f.stat().st_size
    # 说话人分离模型
    for p in [DIAR_SEG, DIAR_EMB]:
        pp = Path(p)
        if pp.exists():
            total += pp.stat().st_size
    return total


def _all_models_installed() -> bool:
    """检查所有模型文件是否都已存在于本地磁盘。"""
    whisper_dir = WHISPER_CACHE / f"faster-whisper-{WHISPER_SIZE}"
    whisper_ok = (whisper_dir / "model.bin").exists()
    diar_ok = Path(DIAR_SEG).exists() and Path(DIAR_EMB).exists()
    return whisper_ok and diar_ok


def get_install_progress() -> dict:
    """返回安装进度。

    downloaded_bytes / total_bytes 以 _download_url 逐 chunk 写入的内存计数为准——
    它实时、平滑、按"当前阶段"语义计数。不要用 _scan_local_model_bytes() 覆盖：
    磁盘扫描是"全局累计"且对正在下载的 *.part 文件不可见，会把当前阶段进度覆盖成
    已完成阶段的累计值，导致进度条卡在满格、下完才跳变。
    磁盘扫描仅用于"所有模型已就绪"的完成兜底（防御 Cython/异步状态丢失）。
    """
    p = dict(_progress[0])
    if _all_models_installed():
        p["running"] = False
        p["stage"] = "done"
        p["finished"] = True
        p["detail"] = "安装完成"
        p["error"] = None
    return p


def _get_ffmpeg():
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe:
            return exe
    except Exception:
        pass
    return "ffmpeg"


def _extract_audio_from_video(video_path: str) -> str:
    """Extract audio from a video file to a temporary WAV file using ffmpeg."""
    ffmpeg = _get_ffmpeg()
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    try:
        subprocess.run(
            [ffmpeg, "-y", "-i", video_path, "-vn", "-acodec", "pcm_s16le",
             "-ar", "16000", "-ac", "1", tmp.name],
            capture_output=True, timeout=300, check=True,
        )
        return tmp.name
    except subprocess.CalledProcessError as e:
        os.unlink(tmp.name)
        raise RuntimeError(f"无法从视频提取音频: {e.stderr.decode(errors='replace')[:300]}")
    except Exception:
        os.unlink(tmp.name)
        raise


class TranscriberService:

    @staticmethod
    def _whisper_local_dir(size: str = None) -> Path:
        if size is None:
            size = WHISPER_SIZE
        return WHISPER_CACHE / f"faster-whisper-{size}"

    @staticmethod
    def _is_model_cached(size: str) -> bool:
        """检查模型是否已下载（model.bin 存在即认为完整）"""
        return (TranscriberService._whisper_local_dir(size) / "model.bin").exists()

    @property
    def toolkit_label(self):
        return f"faster-whisper ({WHISPER_SIZE})"

    @property
    def model_preset_name(self):
        return f"faster-whisper ({WHISPER_SIZE})"

    def __init__(self):
        self.whisper = None
        self.diarization = None
        self._speaker_threshold = 0.5
        self.init_error = None if FW_AVAILABLE else "faster-whisper 未安装"

    @property
    def model(self): return self.whisper
    @property
    def recognizer(self): return self.whisper

    def _diar_ready(self) -> bool:
        return Path(DIAR_SEG).exists() and Path(DIAR_EMB).exists()

    def get_model_status(self) -> Dict[str, Any]:
        whisper_cached = self._is_model_cached(WHISPER_SIZE)
        ready = FW_AVAILABLE and whisper_cached and self._diar_ready()
        models = [
            {"key": "whisper", "label": f"Whisper ({WHISPER_SIZE})", "installed": whisper_cached, "path": str(WHISPER_CACHE)},
            {"key": "seg", "label": "说话人分割", "installed": Path(DIAR_SEG).exists(), "path": DIAR_SEG},
            {"key": "emb", "label": "说话人嵌入", "installed": Path(DIAR_EMB).exists(), "path": DIAR_EMB},
        ]
        missing = [m["label"] for m in models[1:] if not m["installed"]]
        optional_presets = []
        for s in AVAILABLE_WHISPER_SIZES:
            is_current = s["key"] == WHISPER_SIZE
            is_installed = self._is_model_cached(s["key"])
            optional_presets.append({
                "key": f"whisper_{s['key']}",
                "label": s["label"],
                "size_key": s["key"],
                "download_size": s["download_size"],
                "description": s["description"],
                "installed": is_installed,
                "ready": is_installed and is_current,
                "is_current": is_current,
            })
        return {
            "preset": self.toolkit_label, "package": {"label": "语音识别工具包", "ready": ready, "missing_labels": missing},
            "funasr_available": ready, "ready": ready, "model_loaded": self.whisper is not None,
            "models": models, "optional_presets": optional_presets, "missing_labels": missing,
            "profiles": [{"key": "core", "label": self.model_preset_name, "installed": ready, "ready": ready,
                          "missing_labels": missing, "supports_transcription_progress": False}],
            "supports_transcription_progress": False,
            "error": self.init_error if not ready else None,
            "model_info_url": "https://github.com/SYSTRAN/faster-whisper",
        }

    def _download_whisper_files(self) -> Path:
        """下载 whisper 模型文件：逐文件尝试 ModelScope，失败则用 HF 补齐。"""
        local_dir = self._whisper_local_dir()
        repo = _MODELSCOPE_WHISPER_REPO

        _WHISPER_FILES = [
            ("config.json", 2370),
            ("configuration.json", 86),
            ("tokenizer.json", 2203239),
            ("vocabulary.txt", 459861),
            ("model.bin", 483546902),
        ]

        total_size = sum(sz for _, sz in _WHISPER_FILES)
        _progress[0]["total_bytes"] = total_size
        _progress[0]["downloaded_bytes"] = 0
        _progress[0]["speed"] = 0

        local_dir.mkdir(parents=True, exist_ok=True)

        # ── 第一轮：ModelScope ──
        remaining = []
        cumulative_bytes = 0
        for name, size in _WHISPER_FILES:
            dest = str(local_dir / name)
            _progress[0]["detail"] = f"下载 {name} ({size / 1024 / 1024:.0f}MB) via ModelScope…"
            ms_url = f"{_MODELSCOPE_API}/models/{repo}/resolve/master/{name}"
            if self._download_url([ms_url], dest, name, offset=cumulative_bytes):
                cumulative_bytes += size
                _progress[0]["downloaded_bytes"] = cumulative_bytes
            else:
                remaining.append((name, size))
                print(f"[MODELSCOPE] {name} 失败", flush=True)

        if not remaining:
            _progress[0]["detail"] = "Whisper 模型下载完成"
            return local_dir

        # ── 第二轮：HF/mirror 补齐缺失文件 ──
        for endpoint in _HF_ENDPOINTS:
            host = endpoint.split("://")[1]
            print(f"  HF 补齐 {len(remaining)} 个文件 via {host} ...", flush=True)
            for name, size in list(remaining):
                if name == "configuration.json":
                    remaining.remove((name, size))
                    continue
                dest = str(local_dir / name)
                _progress[0]["detail"] = f"下载 {name} ({size / 1024 / 1024:.0f}MB) via {host}…"
                file_url = f"{endpoint}/{repo}/resolve/main/{name}"
                if self._download_url([file_url], dest, name, offset=cumulative_bytes):
                    cumulative_bytes += size
                    _progress[0]["downloaded_bytes"] = cumulative_bytes
                    remaining.remove((name, size))
                else:
                    break

            if not remaining:
                _progress[0]["detail"] = "Whisper 模型下载完成"
                return local_dir

        missing = [n for n, _ in remaining]
        raise RuntimeError(f"Whisper 模型下载不完整，缺失: {', '.join(missing)}")

    def _ensure_ready(self, allow_download: bool = False):
        if not FW_AVAILABLE:
            raise RuntimeError("faster-whisper 未安装")
        if self.whisper is None:
            print(f"[INFO] 加载 faster-whisper ({WHISPER_SIZE})...", flush=True)
            t0 = time.time()
            if not self._is_model_cached(WHISPER_SIZE):
                if not allow_download:
                    raise TranscriptionModelMissingError()
                self._download_whisper_files()
            # 从本地缓存加载
            local_dir = self._whisper_local_dir()
            self.whisper = WhisperModel(str(local_dir), device="cpu", compute_type=WHISPER_COMPUTE,
                                        local_files_only=True, num_workers=WHISPER_WORKERS,
                                        cpu_threads=WHISPER_CPU_THREADS)
            print(f"[INFO] 加载完成 ({time.time() - t0:.1f}s)", flush=True)
            gc.collect()  # 清理模型加载产生的临时缓冲区
        if self.diarization is None and self._diar_ready():
            self._init_diarization()
            gc.collect()  # 清理说话人分离模型加载产生的临时缓冲区
        elif self.diarization is not None and getattr(self, '_diar_threshold', None) != self._speaker_threshold:
            self._init_diarization()

    def _init_diarization(self):
        threshold = self._speaker_threshold
        print(f"[INFO] 加载说话人分离 (threshold={threshold})...", flush=True)
        t0 = time.time()
        seg_cfg = _so.OfflineSpeakerSegmentationModelConfig(
            pyannote=_so.OfflineSpeakerSegmentationPyannoteModelConfig(model=DIAR_SEG))
        emb_cfg = _so.SpeakerEmbeddingExtractorConfig(model=DIAR_EMB)
        diar_cfg = _so.OfflineSpeakerDiarizationConfig(
            segmentation=seg_cfg, embedding=emb_cfg,
            clustering=_so.FastClusteringConfig(num_clusters=-1, threshold=threshold),
            min_duration_on=0.3, min_duration_off=0.5)
        self.diarization = _so.OfflineSpeakerDiarization(diar_cfg)
        self._diar_threshold = threshold
        print(f"[INFO] 加载完成 ({time.time() - t0:.1f}s)", flush=True)

    def _load_audio(self, audio_path: str):
        import soundfile as sf, numpy as np
        src_path = audio_path
        extracted = None
        ext = os.path.splitext(audio_path)[1].lower()
        if ext in VIDEO_EXTENSIONS:
            extracted = _extract_audio_from_video(audio_path)
            src_path = extracted
        try:
            info = sf.info(src_path)
            if info.samplerate != 16000:
                # 用 ffmpeg 子进程重采样，避免 import torch 产生多份音频副本撑爆内存
                tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
                tmp.close()
                try:
                    ffmpeg = _get_ffmpeg()
                    subprocess.run(
                        [ffmpeg, "-y", "-i", src_path, "-vn", "-acodec", "pcm_s16le",
                         "-ar", "16000", "-ac", "1", tmp.name],
                        capture_output=True, timeout=300, check=True,
                    )
                    audio, sr = sf.read(tmp.name, dtype="float32")
                finally:
                    os.unlink(tmp.name)
            else:
                audio, sr = sf.read(src_path, dtype="float32")
                if getattr(audio, "ndim", 1) > 1:
                    audio = audio[:, 0]
            return audio, 16000, len(audio) / 16000
        finally:
            if extracted:
                try:
                    os.unlink(extracted)
                except OSError:
                    pass

    async def transcribe(
        self, audio_path: str, language: str = "auto",
        hotwords: Optional[List[str]] = None, model_profile: Optional[str] = None,
        enable_speaker: bool = False,
        speaker_threshold: float = 0.5,
        word_timestamps: bool = True,
    ) -> Dict[str, Any]:
        t0 = time.time()
        self._speaker_threshold = speaker_threshold
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._ensure_ready)

        whisper_lang = LANG_MAP.get(str(language or "").strip().lower() or "auto")
        prompt = " ".join(str(w).strip() for w in (hotwords or []) if str(w).strip()) or None

        audio, sr, duration = await loop.run_in_executor(None, self._load_audio, audio_path)

        # 先 ASR（CPU 密集型），完成后再做说话人分离（避免 M5 核争抢）
        segments, detected_lang = await loop.run_in_executor(
            None, self._do_whisper, audio, whisper_lang, prompt, word_timestamps
        )

        # whisper 完成后立即触发 gc，释放 CTranslate2 内部交叉注意力缓冲区
        gc.collect()

        diar_segments = []
        if enable_speaker and self.diarization:
            diar_segments = await loop.run_in_executor(None, self._do_diarization, audio)

        self._match_speakers(segments, diar_segments)

        # 显式释放音频数组，避免长时间占用大块内存
        del audio
        gc.collect()

        # 转录完成后自动卸载模型，释放 CTranslate2 内部 GPU/CPU 缓冲区
        self.release_memory()

        elapsed = round(time.time() - t0, 1)
        print(
            f"[INFO] 转录完成: {len(segments)} 段, "
            f"音频 {duration:.1f}s, 耗时 {elapsed:.1f}s, 语言 {detected_lang or whisper_lang or 'zh'}",
            flush=True,
        )
        if segments:
            preview = segments[0]["text"][:120]
            wc = sum(len(s.get("words", [])) for s in segments)
            print(f"[INFO] 预览: {preview}, 词数: {wc}", flush=True)

        return {
            "audio_path": audio_path, "duration": round(duration, 3),
            "language": detected_lang or whisper_lang or "zh", "language_probability": 1.0,
            "segments": segments, "elapsed_seconds": elapsed, "model_profile": "whisper",
        }

    def _do_whisper(self, audio, language, initial_prompt, word_timestamps: bool = True):
        """faster-whisper: 原生词级 start+end 时间戳"""
        use_word_timestamps = bool(word_timestamps)
        kwargs = {
            "beam_size": 1,
            "word_timestamps": use_word_timestamps,
            "without_timestamps": False,
            "vad_filter": True,
            "vad_parameters": {
                "max_speech_duration_s": 30,  # 强制每段 ≤30s，防止单段交叉注意力膨胀
            },
            "no_speech_threshold": 0.6,
            "condition_on_previous_text": False,  # 减少 decoder 状态缓存
        }
        if language:
            kwargs["language"] = language
        # 中文默认注入简体提示词，避免模型随机输出繁体
        if language == "zh":
            zh_prompt = "以下是简体中文普通话的句子。请优先输出简体中文，保留专有名词。"
            initial_prompt = f"{zh_prompt} 术语参考：{initial_prompt}" if initial_prompt else zh_prompt
        if initial_prompt:
            kwargs["initial_prompt"] = initial_prompt

        seg_iter, info = self.whisper.transcribe(audio, **kwargs)
        detected_lang = info.language if info else None
        # 仅对中文结果做繁→简转换（auto 模式下以 whisper 检测语言为准），避免误伤日文/韩文汉字
        is_zh = (language == "zh") or (detected_lang in ("zh", "yue"))
        segments = []
        for idx, seg in enumerate(seg_iter):
            words = []
            if seg.words:
                for w in seg.words:
                    w_text = w.word.strip()
                    if w_text:
                        if is_zh:
                            w_text = _to_simplified(w_text)
                        words.append({"word": w_text, "start": round(w.start, 3),
                                       "end": round(w.end, 3), "speaker": None})
            raw_text = seg.text.strip()
            if not raw_text:
                continue
            if is_zh:
                raw_text = _to_simplified(raw_text)
            # 保留 whisper 原始文本（含标点），交由后续断句逻辑用标点做切分线索，
            # 最终输出时再由 strip_chinese_punctuation() 去除标点
            text = raw_text
            if not text:
                continue
            segments.append({
                "id": idx, "start": round(seg.start, 3), "end": round(seg.end, 3),
                "text": text, "raw_text": raw_text, "words": words,
                "speaker": None, "speaker_label": None,
                "deleted": False, "bold": False, "confidence": None,
            })
        del seg_iter
        gc.collect()
        return segments, detected_lang

    def _do_diarization(self, audio):
        # 确保是 float32 numpy 数组，sherpa-onnx 直接接受
        import numpy as np
        samples = np.asarray(audio, dtype=np.float32)
        result = self.diarization.process(samples)
        return [{"start": s.start, "end": s.end, "speaker": s.speaker}
                for s in result.sort_by_start_time()]

    def _match_speakers(self, segments, diar_segments):
        if not diar_segments:
            return

        # 收集所有出现的说话人 ID 并重新映射为连续的 0, 1, 2, ...
        all_spk_ids = sorted(set(ds["speaker"] for ds in diar_segments))
        spk_map = {old: new for new, old in enumerate(all_spk_ids)}
        # 重新映射 diarization 结果
        for ds in diar_segments:
            ds["speaker"] = spk_map[ds["speaker"]]

        for seg in segments:
            s, e = float(seg["start"]), float(seg["end"])
            best_spk, best_ov = None, 0.0
            for ds in diar_segments:
                ov = max(0.0, min(e, ds["end"]) - max(s, ds["start"]))
                if ov > best_ov:
                    best_ov, best_spk = ov, ds["speaker"]
            if best_spk is None and diar_segments:
                mid = (s + e) / 2
                best_spk = min(diar_segments, key=lambda d: abs((d["start"] + d["end"]) / 2 - mid))["speaker"]
            if best_spk is not None:
                spk = int(best_spk)
                seg["speaker"] = spk
                seg["speaker_label"] = f"说话人 {spk}"
                for w in seg.get("words") or []:
                    w["speaker"] = spk

    # ── 内存管理 ──

    def release_memory(self):
        """卸载模型并释放内存，用于长时间闲置时降低内存占用。"""
        if self.whisper is not None:
            self.whisper = None
        if self.diarization is not None:
            self.diarization = None
        gc.collect()
        # try to return freed C/C++ heap to OS (Linux only; macOS mmap-based
        # allocator handles this automatically for large blocks)
        try:
            import sys
            if sys.platform == "linux":
                import ctypes
                ctypes.CDLL("libc.so.6").malloc_trim(0)
        except Exception:
            pass

    # ── 安装 ──

    def _get_install_target(self) -> Optional[Path]:
        rsp = Path(__file__).resolve().parents[1] / "lib" / "site-packages"
        if rsp.exists() or Path(__file__).resolve().parents[1].name == "backend-runtime":
            rsp.mkdir(parents=True, exist_ok=True)
            if str(rsp) not in sys.path:
                sys.path.insert(0, str(rsp))
            return rsp
        return None

    def _pip_install(self, pkg: str) -> bool:
        for mirror in ["https://mirrors.aliyun.com/pypi/simple/",
                       "https://pypi.tuna.tsinghua.edu.cn/simple/"]:
            host = mirror.split("/")[2]
            cmd = [sys.executable, "-m", "pip", "install", pkg, "-i", mirror, "--trusted-host", host]
            try:
                tgt = self._get_install_target()
                if tgt:
                    cmd.extend(["--target", str(tgt)])
            except Exception:
                pass
            env = os.environ.copy()
            env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
            r = subprocess.run(cmd, capture_output=True, text=True,
                               encoding="utf-8", errors="replace", env=env, timeout=300)
            if r.returncode == 0:
                return True
        return False

    def install_runtime_and_models(self, force: bool = False, profile_key: Optional[str] = None) -> Dict[str, Any]:
        global FW_AVAILABLE, WhisperModel, _progress
        _progress[0] = {"running": True, "stage": "start", "detail": "准备安装…", "error": None, "finished": False, "total_bytes": 0, "downloaded_bytes": 0, "speed": 0}
        try:
            if not FW_AVAILABLE:
                _progress[0]["stage"] = "pip"
                _progress[0]["detail"] = "安装 faster-whisper Python 包…"
                print("[INSTALL] 安装 faster-whisper...", flush=True)
                if not self._pip_install("faster-whisper"):
                    raise RuntimeError("faster-whisper 安装失败")
                _progress[0]["detail"] = "faster-whisper 安装完成，正在导入…"
                try:
                    from faster_whisper import WhisperModel as _WM
                    WhisperModel = _WM
                    FW_AVAILABLE = True
                    print("[INSTALL] faster-whisper 安装并导入成功", flush=True)
                except ImportError:
                    raise RuntimeError("faster-whisper 安装后仍无法导入，请检查 Python 环境")
            # 下载 whisper 模型权重（如果尚未缓存）
            if not self._is_model_cached(WHISPER_SIZE):
                _progress[0]["stage"] = "whisper"
                _progress[0]["detail"] = "下载 faster-whisper-small 模型 (~487MB)…"
                _progress[0]["total_bytes"] = 510 * 1024 * 1024  # 预估 ~510MB（含所有文件）
                _progress[0]["downloaded_bytes"] = 0
                _progress[0]["speed"] = 0
                print(f"[INSTALL] 下载 faster-whisper ({WHISPER_SIZE}) 模型...", flush=True)
                self._ensure_ready(allow_download=True)
                self.release_memory()
                print(f"[INSTALL] faster-whisper 模型下载完成", flush=True)
            # 下载说话人分离模型
            if not self._diar_ready() or force:
                _progress[0]["stage"] = "diarization"
                _progress[0]["detail"] = "下载说话人分离模型…"
                # 实际大小：segmentation ~1.5MB + embedding ~39.5MB ≈ 41MB
                _progress[0]["total_bytes"] = 42 * 1024 * 1024
                _progress[0]["downloaded_bytes"] = 0
                _progress[0]["speed"] = 0
                self._download_diar_models()
            _progress[0] = {"running": False, "stage": "done", "detail": "安装完成", "error": None, "finished": True}
        except Exception as exc:
            _progress[0] = {"running": False, "stage": "error", "detail": str(exc), "error": str(exc), "finished": True}
            raise
        return {"preset": self.toolkit_label, "status": self.get_model_status()}

    def _switch_whisper_size(self, size: str):
        """切换 whisper 模型大小（仅更新配置，模型延迟到下次转录时加载）"""
        global WHISPER_SIZE
        print(f"[MODEL] 切换 whisper 大小: {WHISPER_SIZE} -> {size}", flush=True)
        # 释放旧模型
        if self.whisper is not None:
            del self.whisper
            self.whisper = None
            gc.collect()
        # 更新配置持久化
        WHISPER_SIZE = size
        _save_whisper_size(size)
        print(f"[MODEL] 配置已更新，新模型将在下次转录时加载", flush=True)

    def _download_url(self, urls: List[str], dest: str, desc: str, offset: int = 0) -> bool:
        """下载文件到 dest（边下边写盘）。offset 为已下载字节累加基数。"""
        for i, url in enumerate(urls):
            host = url.split("/")[2]
            timeout = 60
            print(f"  [{desc}] {host}", flush=True)
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "QuickClip/1.0"})
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    Path(dest).parent.mkdir(parents=True, exist_ok=True)
                    tmp = dest + ".part"
                    downloaded = 0
                    t0 = time.time()
                    with open(tmp, "wb") as f:
                        while True:
                            chunk = r.read(64 * 1024)
                            if not chunk:
                                break
                            f.write(chunk)
                            downloaded += len(chunk)
                            elapsed = time.time() - t0
                            _progress[0]["downloaded_bytes"] = offset + downloaded
                            _progress[0]["speed"] = downloaded / elapsed if elapsed > 0 else 0
                    file_size = Path(tmp).stat().st_size
                if file_size < 1000:
                    Path(tmp).unlink(missing_ok=True)
                    continue
                Path(tmp).rename(dest)
                print(f"    成功 {file_size/(1024*1024):.1f}MB", flush=True)
                return True
            except Exception as e:
                try:
                    Path(dest + ".part").unlink(missing_ok=True)
                except Exception:
                    pass
                print(f"    失败: {e}", flush=True)
        return False

    def _build_github_urls(self, path: str) -> List[str]:
        """构建 GitHub 下载 URL 列表：镜像优先 → 直连兜底"""
        urls = []
        for mirror in _GITHUB_MIRRORS:
            urls.append(f"{mirror}/{_GITHUB_DIRECT}/{path}")
        urls.append(f"{_GITHUB_DIRECT}/{path}")
        return urls

    def _download_diar_models(self):
        import tarfile, tempfile
        errors = []

        _SEG_GITHUB_PATH = "k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
        _EMB_GITHUB_PATH = "k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx"

        # ── 说话人分割模型（优先 ModelScope 直接 ONNX）──
        if not Path(DIAR_SEG).exists():
            _progress[0]["detail"] = "下载说话人分割模型…"
            _progress[0]["speed"] = 0

            _seg_parent = Path(DIAR_SEG).parent
            try:
                for _child in list(_seg_parent.iterdir()):
                    if _child.is_dir() and _child.name != Path(DIAR_SEG).name:
                        shutil.rmtree(_child, ignore_errors=True)
            except FileNotFoundError:
                pass  # 目录尚不存在，无需清理

            seg_ok = False
            try:
                ms_url = f"{_MODELSCOPE_API}/models/{_MODELSCOPE_DIAR_SEG_REPO}/resolve/master/model.int8.onnx"
                if self._download_url([ms_url], DIAR_SEG, "说话人分割 (ModelScope)"):
                    seg_ok = True
                    print("[DIAR] 分割模型从 ModelScope 下载完成", flush=True)
            except Exception as e:
                print(f"[DIAR] ModelScope 分割模型失败: {e}", flush=True)

            if not seg_ok:
                _progress[0]["detail"] = "下载说话人分割模型 (GitHub 回退)…"
                seg_urls = self._build_github_urls(_SEG_GITHUB_PATH)
                tmp = tempfile.mktemp(suffix=".tar.bz2")
                try:
                    if self._download_url(seg_urls, tmp, "说话人分割"):
                        _progress[0]["detail"] = "解压说话人分割模型…"
                        with open(tmp, "rb") as f:
                            if f.read(3) == b"BZh":
                                with tarfile.open(tmp, "r:bz2") as tar:
                                    for m in tar.getmembers():
                                        if m.name.endswith("model.int8.onnx"):
                                            Path(DIAR_SEG).parent.mkdir(parents=True, exist_ok=True)
                                            tar.extract(m, Path(DIAR_SEG).parent)
                                            extracted = Path(DIAR_SEG).parent / m.name
                                            if extracted != Path(DIAR_SEG):
                                                extracted.rename(Path(DIAR_SEG))
                                            for _child in list(Path(DIAR_SEG).parent.iterdir()):
                                                if _child.is_dir() and _child.name != Path(DIAR_SEG).name:
                                                    shutil.rmtree(_child, ignore_errors=True)
                                            seg_ok = True
                                            break
                finally:
                    if os.path.exists(tmp):
                        os.unlink(tmp)

            if not seg_ok:
                errors.append("说话人分割模型下载失败")

        # ── 说话人嵌入模型（GitHub mirror）──
        if not Path(DIAR_EMB).exists():
            _progress[0]["detail"] = "下载说话人嵌入模型 (~40MB)…"
            _progress[0]["speed"] = 0
            # 接续 segmentation 已下载的字节，保证当前阶段进度单调不回退
            seg_done = Path(DIAR_SEG).stat().st_size if Path(DIAR_SEG).exists() else 0
            emb_urls = self._build_github_urls(_EMB_GITHUB_PATH)
            if not self._download_url(emb_urls, DIAR_EMB, "说话人嵌入", offset=seg_done):
                errors.append("说话人嵌入模型下载失败")

        if errors:
            raise RuntimeError("；".join(errors))

    def delete_model_package(self) -> Dict[str, Any]:
        self.diarization = None
        self.whisper = None
        gc.collect()
        removed = []
        for p in [DIAR_SEG, DIAR_EMB]:
            if Path(p).exists():
                Path(p).unlink(missing_ok=True)
                removed.append({"label": Path(p).name, "type": "diarization"})
        # 同时删除 whisper 模型缓存
        whisper_cache_dir = self._whisper_local_dir()
        # 也清理旧的 HF 格式缓存目录（如果存在）
        old_cache_dir = WHISPER_CACHE / f"models--Systran--faster-whisper-{WHISPER_SIZE}"
        for d in [whisper_cache_dir, old_cache_dir]:
            if d.exists():
                shutil.rmtree(d)
                removed.append({"label": f"faster-whisper ({WHISPER_SIZE})", "type": "whisper"})
        # 清理残留的 .locks 文件
        locks_dir = WHISPER_CACHE / ".locks"
        if locks_dir.exists():
            for lock_entry in list(locks_dir.glob(f"*{WHISPER_SIZE}*")):
                try:
                    if lock_entry.is_dir():
                        shutil.rmtree(lock_entry)
                    else:
                        lock_entry.unlink(missing_ok=True)
                except OSError:
                    pass
        return {"profile": "toolkit", "removed_items": removed, "status": self.get_model_status()}
