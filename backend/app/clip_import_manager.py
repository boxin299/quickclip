"""剪贴导入 — 剪贴板图片导入 DaVinci Resolve"""

import json
import os
import time
import hashlib
import asyncio
import threading
import logging
from pathlib import Path
from typing import Dict, Any, List, Optional
from datetime import datetime
import re

logger = logging.getLogger("clip_import")
logger.addHandler(logging.NullHandler())

try:
    from AppKit import NSPasteboard, NSImage, NSWorkspace, NSPasteboardTypeTIFF, NSPasteboardTypePDF, NSPasteboardTypePNG
    from Foundation import NSData
    PYOBJC_AVAILABLE = True
except ImportError:
    PYOBJC_AVAILABLE = False

from PIL import Image
import io

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
CONFIG_PATH = DATA_DIR / "clip_import_config.json"
HISTORY_PATH = DATA_DIR / "clip_import_history.json"
MAX_HISTORY = 200

DEFAULT_CONFIG = {
    "enabled": False,
    "output_format": "PNG",
    "local_target_folder": "",
    "davinci_folder": "",
    "organization": "flat",
    "dedup_method": "md5",
}

DEDUP_METHOD_ALIASES = {
    "hash": "sha256",
    "path+name": "sha256",
}

SUPPORTED_DEDUP_METHODS = {"sha256", "md5", "sha1", "none"}

SOURCE_APP_MAP = {
    "com.google.Chrome": "Chrome",
    "com.apple.Safari": "Safari",
    "com.microsoft.edgemac": "Edge",
    "com.adobe.Photoshop": "Photoshop",
    "com.adobe.Illustrator": "Illustrator",
    "com.apple.Finder": "Finder",
    "com.apple.Preview": "Preview",
    "com.apple.QuickTimePlayerX": "QuickTime",
    "com.figma.Desktop": "Figma",
}


def natural_path_key(path: str) -> list:
    key = []
    for part in str(path).split("/"):
        chunks = re.split(r"(\d+)", part)
        key.append(tuple((0, int(chunk)) if chunk.isdigit() else (1, chunk.lower()) for chunk in chunks))
    return key


def load_config() -> dict:
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return normalize_config(json.load(f))
    save_config(DEFAULT_CONFIG)
    return normalize_config(DEFAULT_CONFIG)


def save_config(config: dict) -> None:
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(normalize_config(config), f, indent=2, ensure_ascii=False)


def normalize_config(config: dict) -> dict:
    normalized = dict(DEFAULT_CONFIG)
    normalized.update(config or {})
    dedup_method = normalized.get("dedup_method", DEFAULT_CONFIG["dedup_method"])
    dedup_method = DEDUP_METHOD_ALIASES.get(dedup_method, dedup_method)
    if dedup_method not in SUPPORTED_DEDUP_METHODS:
        dedup_method = DEFAULT_CONFIG["dedup_method"]
    normalized["dedup_method"] = dedup_method
    return normalized


def load_history() -> list:
    if HISTORY_PATH.exists():
        with open(HISTORY_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


def save_history(history: list) -> None:
    if len(history) > MAX_HISTORY:
        history = history[-MAX_HISTORY:]
    with open(HISTORY_PATH, "w", encoding="utf-8") as f:
        json.dump(history, f, indent=2, ensure_ascii=False)


def add_history_entry(entry: dict) -> list:
    history = load_history()
    history.append(entry)
    save_history(history)
    return history


class ClipboardMonitor:
    """剪贴板监听 — 通过 asyncio 在主线程检测（NSPasteboard 必须在主线程访问）"""

    def __init__(self, on_change_callback):
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._on_change = on_change_callback

    @property
    def running(self) -> bool:
        return self._running

    def start(self) -> tuple[bool, Optional[str]]:
        """同步启动（需在 event loop 线程中调用）"""
        if self._running:
            return True, None
        if not PYOBJC_AVAILABLE:
            return False, "当前环境缺少 macOS 剪贴板监听依赖"
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return False, "当前不在 event loop 上下文中，无法启动监听"
        try:
            pasteboard = NSPasteboard.generalPasteboard()
            initial_hash = self._pasteboard_image_hash(pasteboard)
            self._running = True
            self._task = loop.create_task(self._run(initial_hash))
            return True, None
        except Exception as exc:
            self._running = False
            self._task = None
            return False, f"监听启动失败: {exc}"

    def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            self._task = None

    async def _run(self, initial_hash: Optional[str] = None) -> None:
        pasteboard = NSPasteboard.generalPasteboard()
        last_hash: Optional[str] = initial_hash
        loop_count = 0
        logger.info(f"[ClipImport] 监听协程已启动, changeCount={pasteboard.changeCount()}")
        while self._running:
            await asyncio.sleep(0.3)
            loop_count += 1
            try:
                current_hash = self._pasteboard_image_hash(pasteboard)
            except Exception as exc:
                logger.warning(f"[ClipImport] hash读取异常: {exc}")
                await asyncio.sleep(2)
                continue
            if current_hash == last_hash:
                if loop_count % 20 == 0:  # 每6秒打一次心跳
                    logger.debug(f"[ClipImport] 监听心跳 {loop_count}, hash={current_hash[:12] if current_hash else 'None'}...")
                continue
            last_hash = current_hash
            if current_hash is not None:
                logger.info(f"[ClipImport] 检测到新图片，hash={current_hash[:12]}... ({loop_count} cycles)")
                self._on_change(pasteboard)

    @staticmethod
    def _pasteboard_image_hash(pasteboard) -> Optional[str]:
        for ptype in (NSPasteboardTypeTIFF, NSPasteboardTypePNG):
            data = pasteboard.dataForType_(ptype)
            if data is None:
                continue
            data_bytes = bytes(data)
            if not data_bytes:
                continue
            # 如果同时有文件路径，以文件路径为准（Finder 复制文件场景）
            try:
                paths = pasteboard.propertyListForType_("NSFilenamesPboardType")
                if paths:
                    path_str = "\n".join(sorted(paths))
                    return hashlib.md5(path_str.encode()).hexdigest()
            except Exception:
                pass
            return hashlib.md5(data_bytes).hexdigest()
        # 无图像数据时检查文件路径
        try:
            paths = pasteboard.propertyListForType_("NSFilenamesPboardType")
            if paths:
                path_str = "\n".join(sorted(paths))
                return hashlib.md5(path_str.encode()).hexdigest()
        except Exception:
            pass
        return None


class ImageProcessor:
    """从 NSPasteboard 读取图像数据并转换为目标格式"""

    def extract_image_data(self, pasteboard) -> Optional[bytes]:
        """按优先级读取剪贴板图像：TIFF > PDF > PNG"""
        if not PYOBJC_AVAILABLE:
            return None

        candidates = [
            ("TIFF", pasteboard.dataForType_(NSPasteboardTypeTIFF), self._tiff_to_bytes),
            ("PDF", pasteboard.dataForType_(NSPasteboardTypePDF), self._pdf_to_bytes),
            ("PNG", pasteboard.dataForType_(NSPasteboardTypePNG), lambda data: bytes(data)),
        ]
        for label, raw_data, converter in candidates:
            if raw_data is None:
                continue
            image_bytes = converter(raw_data)
            if self._is_decodable_image_bytes(image_bytes):
                return image_bytes
            logger.warning(f"[ClipImport] 剪贴板 {label} 图像数据不可解码，尝试下一个格式")

        return None

    def convert_format(self, image_bytes: bytes, target_format: str) -> tuple:
        """将图像字节流转换为目标格式"""
        img = Image.open(io.BytesIO(image_bytes))
        fmt = target_format.upper()
        if fmt == "JPEG":
            img = img.convert("RGB")
        elif fmt == "HEIC":
            fmt = "PNG"  # Pillow 不支持 HEIC 写入，回退 PNG
        elif fmt in {"PNG", "WEBP"} and img.mode not in {"1", "L", "LA", "P", "RGB", "RGBA"}:
            img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
        out = io.BytesIO()
        save_kwargs = {}
        if fmt == "PNG":
            save_kwargs = {}
        elif fmt == "TIFF":
            save_kwargs = {}
        elif fmt == "JPEG":
            save_kwargs = {"quality": 95}
        elif fmt == "WEBP":
            save_kwargs = {"lossless": True}
        img.save(out, format=fmt, **save_kwargs)
        return out.getvalue(), fmt

    def get_source_app(self) -> str:
        """获取当前前台应用友好名称"""
        if not PYOBJC_AVAILABLE:
            return "Unknown"
        ws = NSWorkspace.sharedWorkspace()
        bundle_id = ws.frontmostApplication().bundleIdentifier() or ""
        return SOURCE_APP_MAP.get(bundle_id, bundle_id.rsplit(".", 1)[-1] or "Unknown")

    def extract_file_paths(self, pasteboard) -> list:
        """从剪贴板提取文件路径列表（用户在 Finder 中复制文件）"""
        if not PYOBJC_AVAILABLE:
            return []
        try:
            paths = pasteboard.propertyListForType_("NSFilenamesPboardType")
            if paths:
                return list(paths)
        except Exception:
            pass
        return []

    @staticmethod
    def is_image_file(file_path: str) -> bool:
        ext = os.path.splitext(file_path)[1].lower()
        return ext in {'.png', '.jpg', '.jpeg', '.tiff', '.tif', '.webp', '.bmp', '.gif', '.heic', '.heif'}

    @staticmethod
    def read_image_file(file_path: str) -> Optional[bytes]:
        try:
            with open(file_path, 'rb') as f:
                return f.read()
        except Exception:
            return None

    def _tiff_to_bytes(self, ns_data) -> Optional[bytes]:
        try:
            return bytes(ns_data)
        except Exception:
            return None

    def _pdf_to_bytes(self, ns_data) -> Optional[bytes]:
        """PDF 栅格化为 TIFF 字节流 — NSImage 自动处理矢量转位图，保留透明通道"""
        try:
            ns_image = NSImage.alloc().initWithData_(ns_data)
            if ns_image is None:
                return None
            tiff_data = ns_image.TIFFRepresentation()
            return bytes(tiff_data) if tiff_data else None
        except Exception:
            return None

    @staticmethod
    def _is_decodable_image_bytes(image_bytes: Optional[bytes]) -> bool:
        if not image_bytes:
            return False
        try:
            with Image.open(io.BytesIO(image_bytes)) as img:
                img.verify()
            return True
        except Exception:
            return False


class DedupChecker:
    """去重检查 — 支持 SHA256 / MD5 / SHA1 / 关闭去重"""

    def is_duplicate(self, file_bytes: bytes, target_path: str, method: str) -> bool:
        normalized_method = DEDUP_METHOD_ALIASES.get(method, method)
        if normalized_method == "none":
            return False
        if normalized_method == "sha256":
            return self._digest_exists(file_bytes, "sha256")
        if normalized_method == "md5":
            return self._digest_exists(file_bytes, "md5")
        if normalized_method == "sha1":
            return self._digest_exists(file_bytes, "sha1")
        return False

    def _digest_exists(self, file_bytes: bytes, algorithm: str) -> bool:
        file_hash = self.compute_hash(file_bytes, algorithm)
        for entry in load_history():
            if entry.get(algorithm) == file_hash:
                return True
        return False

    @staticmethod
    def compute_hash(file_bytes: bytes, algorithm: str = "sha256") -> str:
        return hashlib.new(algorithm, file_bytes).hexdigest()

    @classmethod
    def compute_hashes(cls, file_bytes: bytes) -> Dict[str, str]:
        return {
            "sha256": cls.compute_hash(file_bytes, "sha256"),
            "md5": cls.compute_hash(file_bytes, "md5"),
            "sha1": cls.compute_hash(file_bytes, "sha1"),
        }


class PathResolver:
    """根据配置决定文件保存路径"""

    def resolve(self, config: dict, project_path: str, source_app: str, filename: str) -> Optional[str]:
        folder = config.get("local_target_folder", "")
        if not folder:
            return None
        if not project_path:
            return None
        # "." 表示项目根目录本身
        if folder == ".":
            base_dir = Path(project_path)
        else:
            base_dir = Path(project_path) / folder
        if not base_dir.is_dir():
            return None
        target_dir = base_dir
        target_dir.mkdir(parents=True, exist_ok=True)
        return str(self._ensure_unique(target_dir, filename))

    def _ensure_unique(self, directory: Path, filename: str) -> Path:
        target = directory / filename
        if not target.exists():
            return target
        stem = Path(filename).stem
        suffix = Path(filename).suffix
        counter = 1
        while True:
            candidate = directory / f"{stem}-{counter}{suffix}"
            if not candidate.exists():
                return candidate
            counter += 1


class ResolveImporter:
    """封装对 resolve_api 的调用，含超时和失败降级"""

    def __init__(self, resolve_controller):
        self._rc = resolve_controller

    def import_to_media_pool(self, file_path: str, davinci_folder: str) -> Dict[str, Any]:
        """导入文件到达芬奇媒体池并移至目标文件夹"""
        if not self._is_resolve_ready():
            return {"status": "local_only", "message": "达芬奇未运行，仅本地保存"}

        try:
            # 定位目标文件夹并设为当前，直接导入到该文件夹
            if davinci_folder and davinci_folder != ".":
                target = self._rc._get_or_create_davinci_folder(None, davinci_folder)
                if target:
                    self._rc.media_pool.SetCurrentFolder(target)
            elif davinci_folder == ".":
                # "." 表示媒体池根目录
                root = self._rc.media_pool.GetRootFolder()
                if root:
                    self._rc.media_pool.SetCurrentFolder(root)
            self._rc.media_pool.ImportMedia([file_path])
            return {"status": "imported", "davinci_folder": davinci_folder}
        except Exception as exc:
            return {"status": "import_failed", "message": f"导入异常: {exc}"}

    def _is_resolve_ready(self) -> bool:
        try:
            self._rc._refresh_context()
            return self._rc.resolve is not None and self._rc.media_pool is not None
        except Exception:
            return False


class ClipImportManager:
    """剪贴导入主管理器 — 串联监听、处理、去重、路径、导入全流程"""

    def __init__(self, resolve_controller):
        self._rc = resolve_controller
        self._config = load_config()
        # 每次启动都从关闭状态开始，由用户手动开启
        if self._config.get("enabled"):
            self._config["enabled"] = False
            save_config(self._config)
        self._processor = ImageProcessor()
        self._dedup = DedupChecker()
        self._resolver = PathResolver()
        self._importer = ResolveImporter(resolve_controller)
        self._monitor = ClipboardMonitor(on_change_callback=self._on_clipboard_change)
        self._last_error: Optional[str] = None

    @property
    def config(self) -> dict:
        return self._config

    @property
    def running(self) -> bool:
        return self._monitor.running

    def toggle(self, enabled: bool) -> dict:
        if enabled:
            started, reason = self._monitor.start()
            self._config["enabled"] = started
            self._last_error = None if started else (reason or "监听启动失败")
        else:
            self._monitor.stop()
            self._config["enabled"] = False
            self._last_error = None
        save_config(self._config)
        return {
            "enabled": self._config["enabled"],
            "running": self._monitor.running,
            "available": PYOBJC_AVAILABLE,
            "message": self._last_error or ("监听已开启" if enabled else "监听已暂停"),
        }

    def update_settings(self, settings: dict) -> dict:
        allowed = {"output_format", "local_target_folder",
                    "davinci_folder", "organization", "dedup_method"}
        for key in allowed:
            if key in settings:
                self._config[key] = settings[key]
        self._config = normalize_config(self._config)
        save_config(self._config)
        return dict(self._config)

    def get_status(self) -> dict:
        history = load_history()
        recent = history[-50:] if len(history) > 50 else history
        return {
            "enabled": self._config["enabled"],
            "running": self._monitor.running,
            "available": PYOBJC_AVAILABLE,
            "last_error": self._last_error,
            "config": dict(self._config),
            "recent_imports": list(reversed(recent)),
        }

    def clear_history(self) -> dict:
        save_history([])
        return {"message": "历史已清空"}

    def _on_clipboard_change(self, pasteboard) -> None:
        if not self._config["enabled"]:
            return

        # 优先处理文件路径（Finder 复制文件场景）
        file_paths = self._processor.extract_file_paths(pasteboard)
        if file_paths:
            image_files = [f for f in file_paths if ImageProcessor.is_image_file(f)]
            if image_files:
                for file_path in image_files:
                    try:
                        image_bytes = ImageProcessor.read_image_file(file_path)
                        if image_bytes is None:
                            continue
                    except Exception:
                        continue
                    original_name = os.path.basename(file_path)
                    self._import_image(image_bytes, timestamp="", seq=0, original_filename=original_name)
                return

        # 回退：从剪贴板直接读取图像数据（浏览器 / AI / PS 复制图片）
        try:
            image_bytes = self._processor.extract_image_data(pasteboard)
            if image_bytes is None:
                return
            logger.info(f"[ClipImport] 提取到图片: {len(image_bytes)} bytes")
        except Exception as exc:
            logger.warning(f"[ClipImport] 图片提取异常: {exc}")
            return

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self._import_image(image_bytes, timestamp, 0)

    def _import_image(self, image_bytes: bytes, timestamp: str, seq: int = 0, original_filename: Optional[str] = None) -> None:
        """处理单张图片导入的通用逻辑"""
        source_app = self._processor.get_source_app()
        hashes = {"sha256": "", "md5": "", "sha1": ""}

        # 格式转换
        try:
            image_bytes, actual_fmt = self._processor.convert_format(image_bytes, self._config["output_format"])
            actual_fmt = actual_fmt.lower()
            hashes = DedupChecker.compute_hashes(image_bytes)
        except Exception as exc:
            logger.warning(f"[ClipImport] 格式转换失败: {exc}")
            error_detail = str(exc) or exc.__class__.__name__
            entry = {
                "filename": f"{timestamp}.unknown",
                "source_app": source_app,
                "timestamp": timestamp,
                "status": "error",
                "status_text": f"格式转换失败：{error_detail}",
                "size": 0,
                "sha256": "", "md5": "", "sha1": "",
            }
            add_history_entry(entry)
            return

        # 文件名：访达来源保留原名，其他用时间戳
        if original_filename:
            filename = original_filename
        elif seq > 0:
            filename = f"{timestamp}_{seq}.{actual_fmt}"
        else:
            filename = f"{timestamp}.{actual_fmt}"

        # 路径解析
        project_path = self._get_project_path()
        logger.info(f"[ClipImport] 项目路径={project_path}, 目标文件夹={self._config.get('local_target_folder')}")
        target_path = self._resolver.resolve(self._config, project_path, source_app, filename)
        if target_path is None:
            logger.warning(f"[ClipImport] 路径解析失败，跳过保存（检查本地保存文件夹是否存在）")
            return

        logger.info(f"[ClipImport] 目标路径={target_path}")

        # 去重
        if self._dedup.is_duplicate(image_bytes, target_path, self._config.get("dedup_method", "sha256")):
            entry = {
                "filename": filename,
                "source_app": source_app,
                "timestamp": timestamp,
                "status": "skipped",
                "status_text": "重复内容，已跳过",
                "size": len(image_bytes),
                **hashes,
            }
            add_history_entry(entry)
            return

        # 写入文件
        try:
            os.makedirs(os.path.dirname(target_path), exist_ok=True)
            with open(target_path, "wb") as f:
                f.write(image_bytes)
        except Exception:
            entry = {
                "filename": filename,
                "source_app": source_app,
                "timestamp": timestamp,
                "status": "error",
                "status_text": "写入失败",
                "size": len(image_bytes),
                **hashes,
            }
            add_history_entry(entry)
            return

        # 导入达芬奇
        try:
            davinci_result = self._importer.import_to_media_pool(
                target_path,
                self._config.get("davinci_folder", ""),
            )
        except Exception as exc:
            davinci_result = {"status": "import_failed", "message": f"导入异常: {exc}"}

        entry = {
            "filename": filename,
            "source_app": source_app,
            "target_path": target_path,
            "timestamp": timestamp,
            "status": davinci_result.get("status", "imported"),
            "status_text": davinci_result.get("message", "已导入"),
            "size": len(image_bytes),
            **hashes,
        }
        add_history_entry(entry)

    def _get_project_path(self) -> str:
        # 1. 通过达芬奇 API 检测项目路径
        try:
            path, source = self._rc._detect_project_local_path()
            if path:
                return path
        except Exception:
            pass
        # 2. 通过项目注册表获取
        try:
            from app.project_registry import load_project_registry
            reg = load_project_registry()
            active = reg.get("active_project")
            if active and active.get("local_path"):
                return active["local_path"]
        except Exception:
            pass
        return os.path.expanduser("~/Desktop")

    def list_local_folders(self) -> list:
        """扫描项目根目录及其子文件夹，返回相对于项目路径的路径列表。

        "." 表示项目根目录本身，始终作为第一个选项，确保即便项目下没有
        任何子文件夹也能选择保存位置。
        """
        project_path = self._get_project_path()
        if not project_path or not os.path.isdir(project_path):
            return []
        folders = ["."]
        root = Path(project_path)
        self._scan_dirs(root, root, folders, depth=0, max_depth=3)
        # 保持根目录在首位，其余子文件夹按自然顺序排序（01、2、10；再按首字母）
        rest = sorted((f for f in folders if f != "."), key=natural_path_key)
        return ["."] + rest

    @staticmethod
    def _scan_dirs(root: Path, current: Path, result: list, depth: int, max_depth: int) -> None:
        if depth >= max_depth:
            return
        try:
            for entry in os.scandir(current):
                if not entry.is_dir():
                    continue
                name = entry.name
                if name.startswith('.') or name.startswith('__'):
                    continue
                entry_path = Path(entry.path)
                rel_path = str(entry_path.relative_to(root))
                result.append(rel_path)
                ClipImportManager._scan_dirs(root, entry_path, result, depth + 1, max_depth)
        except (PermissionError, OSError, ValueError):
            pass

    def list_davinci_folders(self) -> list:
        """遍历达芬奇媒体池，返回所有文件夹的路径列表。

        "." 表示媒体池根目录（Master），始终作为第一个选项。
        """
        try:
            self._rc._refresh_context()
            if not self._rc.media_pool:
                return []
            root = self._rc.media_pool.GetRootFolder()
            if not root:
                return []
            folders = []
            self._collect_davinci_folders(root, "", folders)
            return ["."] + sorted(folders, key=natural_path_key)
        except Exception:
            return []

    @staticmethod
    def _collect_davinci_folders(folder, prefix: str, result: list) -> None:
        try:
            subfolders = folder.GetSubFolderList() or []
        except Exception:
            return
        for sf in subfolders:
            try:
                name = sf.GetName()
            except Exception:
                continue
            full_path = f"{prefix}/{name}" if prefix else name
            result.append(full_path)
            ClipImportManager._collect_davinci_folders(sf, full_path, result)
