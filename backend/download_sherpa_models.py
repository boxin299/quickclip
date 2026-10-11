"""下载 sherpa-onnx 模型（SenseVoiceSmall + 说话人分离），中国网络优化。

下载策略（自动选择最快源）:
  HuggingFace  hf-mirror.com (国内镜像) → huggingface.co (原站)
  GitHub       mirror.ghproxy.com (国内代理) → github.com (原站)
"""

import os
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

MODELS_DIR = Path(__file__).resolve().parent / "data" / "sherpa_onnx"

HF_PATH = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main"
GH_BASE = "https://github.com"
GH_PROXY_BASE = "https://mirror.ghproxy.com/https://github.com"


def download_from_sources(sources, dest_path, desc):
    """从多个源依次尝试下载，第一个成功即停止。"""
    for idx, url in enumerate(sources):
        source_label = url.split("/")[2] if "://" in url else url
        print(f"  [{desc}] 尝试源 {idx + 1}/{len(sources)}: {source_label}")

        try:
            req = urllib.request.Request(url, headers={"User-Agent": "QuickClip/1.0"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()

            Path(dest_path).parent.mkdir(parents=True, exist_ok=True)
            Path(dest_path).write_bytes(data)
            size_mb = len(data) / (1024 * 1024)
            print(f"  [{desc}] 下载成功 ({size_mb:.1f}MB) from {source_label}")
            return True
        except Exception as e:
            print(f"  [{desc}] 失败: {e}")
            continue

    print(f"  [{desc}] 所有源均失败！")
    return False


def download_models():
    MODELS_DIR.mkdir(parents=True, exist_ok=True)

    # ── 1. SenseVoiceSmall ASR (228MB INT8) ──
    sv_dir = MODELS_DIR / "sense_voice"
    sv_dir.mkdir(parents=True, exist_ok=True)

    model_dest = sv_dir / "model.int8.onnx"
    if model_dest.exists():
        print(f"[跳过] SenseVoiceSmall 模型已存在: {model_dest}")
    else:
        model_sources = [
            f"https://hf-mirror.com/{HF_PATH}/model.int8.onnx",
            f"https://huggingface.co/{HF_PATH}/model.int8.onnx",
        ]
        if not download_from_sources(model_sources, str(model_dest), "SenseVoiceSmall ASR"):
            print("\n手动下载提示:")
            print("  pip install huggingface_hub")
            print(f"  HF_ENDPOINT=https://hf-mirror.com huggingface-cli download csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17 --local-dir {sv_dir}")
            return False

    tokens_dest = sv_dir / "tokens.txt"
    if tokens_dest.exists():
        print(f"[跳过] tokens 已存在: {tokens_dest}")
    else:
        token_sources = [
            f"https://hf-mirror.com/{HF_PATH}/tokens.txt",
            f"https://huggingface.co/{HF_PATH}/tokens.txt",
        ]
        download_from_sources(token_sources, str(tokens_dest), "SenseVoiceSmall tokens")

    # ── 2. 说话人分割模型 (~20MB) ──
    seg_dir = MODELS_DIR / "speaker_segmentation"
    seg_dir.mkdir(parents=True, exist_ok=True)
    seg_dest = seg_dir / "model.int8.onnx"

    if seg_dest.exists():
        print(f"[跳过] 说话人分割模型已存在: {seg_dest}")
    else:
        gh_seg = "k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
        seg_sources = [
            f"{GH_PROXY_BASE}/{gh_seg}",
            f"{GH_BASE}/{gh_seg}",
        ]

        with tempfile.NamedTemporaryFile(suffix=".tar.bz2", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            if download_from_sources(seg_sources, tmp_path, "说话人分割模型"):
                print("  解压中...")
                with tarfile.open(tmp_path, "r:bz2") as tar:
                    for member in tar.getmembers():
                        if member.name.endswith("model.int8.onnx"):
                            member.name = "model.int8.onnx"
                            tar.extract(member, seg_dir)
                            break
                print(f"  解压完成: {seg_dest}")
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

    # ── 3. 说话人嵌入模型 (~100MB) ──
    emb_dir = MODELS_DIR / "speaker_embedding"
    emb_dir.mkdir(parents=True, exist_ok=True)
    emb_dest = emb_dir / "model.onnx"

    if emb_dest.exists():
        print(f"[跳过] 说话人嵌入模型已存在: {emb_dest}")
    else:
        gh_emb = "k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx"
        emb_sources = [
            f"{GH_PROXY_BASE}/{gh_emb}",
            f"{GH_BASE}/{gh_emb}",
        ]
        download_from_sources(emb_sources, str(emb_dest), "说话人嵌入模型")

    # ── 检查完整性 ──
    all_ok = True
    for label, path in [
        ("SenseVoiceSmall 模型", model_dest),
        ("SenseVoiceSmall tokens", tokens_dest),
        ("说话人分割模型", seg_dest),
        ("说话人嵌入模型", emb_dest),
    ]:
        if path.exists():
            print(f"  ✓ {label}")
        else:
            print(f"  ✗ {label} - 缺失!")
            all_ok = False

    if all_ok:
        print(f"\n全部模型下载完成 → {MODELS_DIR}")
    else:
        print("\n部分模型下载失败，请检查网络后重试。")
        print("如果反复失败，可尝试手动下载:")
        print(f"  1. ASR: https://hf-mirror.com/{HF_PATH}")
        print(f"  2. 分割: {GH_BASE}/{gh_seg}")
        print(f"  3. 嵌入: {GH_BASE}/{gh_emb}")
    return all_ok


if __name__ == "__main__":
    success = download_models()
    sys.exit(0 if success else 1)
