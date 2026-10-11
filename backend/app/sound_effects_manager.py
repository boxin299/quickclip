"""
音效库管理模块
负责音效库的扫描、复制到项目、波形数据生成、
时间线快照对比及媒体池文件夹整理。

交互流程（v3 — 按下/释放）：
1. 用户按住 🔊 → 复制音效到项目本地文件夹（不导入达芬奇媒体池）+ 采集时间线快照
2. 用户在达芬奇中将文件拖入时间线（音效自动出现在当前媒体池文件夹）
3. 用户释放鼠标 → 对比快照判断是否使用：
   - 已使用 → 在媒体池中找到该音效，移动到配置的目标文件夹（按映射层级创建子文件夹）
   - 未使用 → 删除本地副本
"""

import os
import json
import shutil
import time
import struct
import math
import hashlib
import tempfile
import subprocess
import sqlite3
import gzip
import threading
from typing import List, Dict, Any, Optional, Set, Tuple
from pathlib import Path
from datetime import datetime


# ==================== 配置管理 ====================

SOUND_EFFECTS_CONFIG_FILE = os.path.join(
    os.path.dirname(os.path.dirname(__file__)), "data", "sound_effects_config.json"
)


def load_sound_effects_config() -> Dict[str, Any]:
    """加载音效库配置"""
    defaults = {
        "library_path": "",
        "save_subfolder": "音效",
        "davinci_folder": "音效",
        "folder_depth": 1,
        "folder_depth_direction": "forward",
        "library_scan_depth": 20,
        "preview_cache_max_mb": 512,
        "waveform_cache_max_mb": 128,
        "waveform_cache_backend": "library",
        "waveform_cache_library_dir": ".sfx_cache",
        "waveform_cache_compress": True,
        "scan_cache_ttl_seconds": 300,
        "path_mappings": [],
    }
    if os.path.exists(SOUND_EFFECTS_CONFIG_FILE):
        try:
            with open(SOUND_EFFECTS_CONFIG_FILE, "r", encoding="utf-8") as f:
                loaded = json.load(f)
                if isinstance(loaded, dict):
                    return {**defaults, **loaded}
        except Exception:
            pass
    return defaults


def save_sound_effects_config(config: Dict[str, Any]) -> bool:
    """保存音效库配置"""
    try:
        merged = {**load_sound_effects_config(), **(config or {})}
        config_dir = os.path.dirname(os.path.abspath(SOUND_EFFECTS_CONFIG_FILE))
        os.makedirs(config_dir, exist_ok=True)
        tmp_path = os.path.join(config_dir, ".sound_effects_config.tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(merged, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, SOUND_EFFECTS_CONFIG_FILE)
        return True
    except Exception:
        return False


def _library_cache_id(library_path: str, max_depth: int, path_mappings: Optional[List[Dict[str, Any]]] = None) -> str:
    actual_root = _resolve_library_root(library_path, path_mappings)
    raw = f"{library_path}::{actual_root}::{int(max_depth)}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


_library_scan_progress: Dict[str, Dict[str, Any]] = {}
_library_scan_progress_lock = threading.Lock()
_library_scan_locks: Dict[str, threading.Lock] = {}
_library_scan_locks_guard = threading.Lock()
_library_scan_refresh_threads: Dict[str, threading.Thread] = {}
_library_scan_refresh_guard = threading.Lock()
_project_audio_basenames_cache: Dict[str, Dict[str, Any]] = {}
_project_audio_basenames_cache_lock = threading.Lock()
PROJECT_AUDIO_BASENAMES_CACHE_TTL_SECONDS = 5
WAVEFORM_CACHE_VERSION = 2


def _get_library_scan_lock(library_id: str) -> threading.Lock:
    with _library_scan_locks_guard:
        lock = _library_scan_locks.get(library_id)
        if lock is None:
            lock = threading.Lock()
            _library_scan_locks[library_id] = lock
        return lock


def _update_library_scan_progress(library_id: str, library_path: str, **updates: Any) -> Dict[str, Any]:
    now = int(time.time())
    with _library_scan_progress_lock:
        current = dict(_library_scan_progress.get(library_id) or {})
        current.setdefault("library_id", library_id)
        current.setdefault("library_path", library_path)
        current.setdefault("started_at", now)
        current.update(updates)
        current["updated_at"] = now
        _library_scan_progress[library_id] = current
        return dict(current)


def _get_project_audio_basenames(project_path: str, ttl_seconds: int = PROJECT_AUDIO_BASENAMES_CACHE_TTL_SECONDS) -> Set[str]:
    normalized_path = os.path.normpath(str(project_path or ""))
    if not normalized_path or not os.path.isdir(normalized_path):
        return set()

    safe_ttl = max(0.0, float(ttl_seconds or 0))
    now = time.monotonic()
    if safe_ttl > 0:
        with _project_audio_basenames_cache_lock:
            cached = _project_audio_basenames_cache.get(normalized_path)
            if cached and (now - float(cached.get("loaded_at") or 0.0)) <= safe_ttl:
                return set(cached.get("basenames") or ())

    basenames: Set[str] = set()
    for root, dirs, files in os.walk(normalized_path):
        dirs[:] = [name for name in dirs if not name.startswith(".")]
        for filename in files:
            if filename.startswith("."):
                continue
            if filename.lower().endswith(('.wav', '.mp3', '.aiff', '.aif', '.flac', '.ogg', '.m4a')):
                basenames.add(filename.lower())

    with _project_audio_basenames_cache_lock:
        _project_audio_basenames_cache[normalized_path] = {
            "loaded_at": now,
            "basenames": tuple(sorted(basenames)),
        }
    return basenames


def get_sound_library_index_status(
    library_path: str,
    max_depth: int = 20,
    path_mappings: Optional[List[Dict[str, Any]]] = None,
    ttl_seconds: int = 300,
) -> Dict[str, Any]:
    library_id = _library_cache_id(library_path, max_depth, path_mappings)
    conn = _get_asset_meta_db()
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT generated_at FROM library_scan_cache WHERE library_id=?",
        (library_id,),
    ).fetchone()
    generated_at = int(row["generated_at"] or 0) if row else 0
    has_cache = bool(row)
    stale = bool(
        has_cache
        and ttl_seconds > 0
        and generated_at > 0
        and (time.time() - generated_at) > ttl_seconds
    )
    with _library_scan_progress_lock:
        progress = dict(_library_scan_progress.get(library_id) or {})
    if progress.get("active"):
        progress["has_cache"] = bool(progress.get("has_cache")) or has_cache
        progress.setdefault("generated_at", generated_at)
        progress.setdefault("stale", stale)
        progress.setdefault("stage", "scanning")
        return progress
    fallback_stage = "ready" if has_cache else "idle"
    fallback_message = (
        "本地索引可用，等待刷新" if has_cache and stale else "本地索引已就绪" if has_cache else "尚未建立本地索引"
    )
    if progress:
        progress.setdefault("active", False)
        progress.setdefault("has_cache", has_cache)
        progress.setdefault("generated_at", generated_at)
        progress.setdefault("stale", stale)
        progress.setdefault("stage", fallback_stage)
        progress.setdefault("message", fallback_message)
        return progress
    return {
        "library_id": library_id,
        "library_path": library_path,
        "active": False,
        "has_cache": has_cache,
        "generated_at": generated_at,
        "stale": stale,
        "stage": fallback_stage,
        "message": fallback_message,
        "processed_files": 0,
        "processed_dirs": 0,
        "started_at": 0,
        "updated_at": int(time.time()),
    }


def resolve_mapped_path(path: str, path_mappings: Optional[List[Dict[str, Any]]] = None) -> str:
    p = str(path or "")
    if not p or not path_mappings:
        return p
    best_from = ""
    best_to = ""
    for m in path_mappings:
        src = str((m or {}).get("from") or "")
        dst = str((m or {}).get("to") or "")
        if not src or not dst:
            continue
        if p == src or p.startswith(src.rstrip("/") + "/"):
            if len(src) > len(best_from):
                best_from = src
                best_to = dst
    if not best_from:
        return p
    suffix = p[len(best_from):]
    return best_to.rstrip("/") + suffix


ASSET_META_DB_FILE = os.path.join(os.path.dirname(SOUND_EFFECTS_CONFIG_FILE), "sfx_meta.sqlite3")
_asset_meta_db_local = threading.local()
_asset_meta_db_init_lock = threading.Lock()
_asset_meta_db_initialized = False


def _initialize_asset_meta_db(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS asset_meta (
          asset_key TEXT PRIMARY KEY,
          favorite INTEGER DEFAULT 0,
          tags_json TEXT DEFAULT '[]',
          used_count INTEGER DEFAULT 0,
          last_used_at INTEGER DEFAULT 0
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS asset_meta_tags (
          asset_key TEXT NOT NULL,
          tag TEXT NOT NULL,
          tag_lower TEXT NOT NULL,
          PRIMARY KEY(asset_key, tag_lower)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_asset_meta_favorite ON asset_meta(favorite)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_asset_meta_used_count ON asset_meta(used_count)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_asset_meta_last_used_at ON asset_meta(last_used_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_asset_meta_tags_lower ON asset_meta_tags(tag_lower)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS library_scan_cache (
          library_id TEXT PRIMARY KEY,
          library_path TEXT NOT NULL,
          actual_root TEXT NOT NULL,
          max_depth INTEGER NOT NULL,
          generated_at INTEGER NOT NULL,
          folders_json TEXT DEFAULT '[]'
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS library_asset_index (
          asset_key TEXT PRIMARY KEY,
          library_id TEXT NOT NULL,
          library_path TEXT NOT NULL,
          actual_root TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          parent_folder TEXT NOT NULL,
          parent_path TEXT NOT NULL,
          path TEXT NOT NULL,
          path_lower TEXT NOT NULL,
          name TEXT NOT NULL,
          name_lower TEXT NOT NULL,
          filename TEXT NOT NULL,
          filename_lower TEXT NOT NULL,
          relative_path_lower TEXT NOT NULL,
          extension TEXT DEFAULT '',
          size INTEGER DEFAULT 0,
          size_mb REAL DEFAULT 0,
          modified TEXT DEFAULT '',
          duration TEXT DEFAULT '',
          duration_seconds REAL DEFAULT 0,
          sample_rate INTEGER DEFAULT 0
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_library_asset_index_library ON library_asset_index(library_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_library_asset_index_parent ON library_asset_index(library_id, parent_path)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_library_asset_index_path ON library_asset_index(library_id, path)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_library_asset_index_filename ON library_asset_index(library_id, filename_lower)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_library_asset_index_name ON library_asset_index(library_id, name_lower)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS waveform_cache (
          asset_key TEXT,
          mtime_ns INTEGER,
          size INTEGER,
          samples INTEGER,
          data_json TEXT,
          duration REAL,
          sample_rate INTEGER,
          bytes INTEGER,
          created_at INTEGER,
          PRIMARY KEY(asset_key, mtime_ns, size, samples)
        )
        """
    )
    columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(waveform_cache)").fetchall()}
    if "version" not in columns:
        conn.execute("ALTER TABLE waveform_cache ADD COLUMN version INTEGER DEFAULT 1")
    _rebuild_asset_meta_tags_index(conn)
    conn.commit()


def _get_asset_meta_db() -> sqlite3.Connection:
    global _asset_meta_db_initialized
    conn = getattr(_asset_meta_db_local, "conn", None)
    if conn is not None:
        return conn

    os.makedirs(os.path.dirname(ASSET_META_DB_FILE), exist_ok=True)
    conn = sqlite3.connect(ASSET_META_DB_FILE, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=10000")

    with _asset_meta_db_init_lock:
        if not _asset_meta_db_initialized:
            _initialize_asset_meta_db(conn)
            _asset_meta_db_initialized = True
        else:
            # Even after global init, ensure this thread-local connection sees the schema.
            _initialize_asset_meta_db(conn)

    _asset_meta_db_local.conn = conn
    return conn


def _normalize_tags(raw: Any) -> List[str]:
    if isinstance(raw, list):
        items = raw
    else:
        try:
            items = json.loads(raw or "[]")
            if not isinstance(items, list):
                items = []
        except Exception:
            items = []
    deduped: List[str] = []
    seen = set()
    for item in items:
        text = str(item or "").strip()
        if not text:
            continue
        lowered = text.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        deduped.append(text)
    return deduped


def _sync_asset_meta_tags(conn: sqlite3.Connection, asset_key: str, tags: List[str]) -> None:
    conn.execute("DELETE FROM asset_meta_tags WHERE asset_key=?", (asset_key,))
    rows = [(asset_key, tag, tag.lower()) for tag in _normalize_tags(tags)]
    if rows:
        conn.executemany(
            "INSERT OR REPLACE INTO asset_meta_tags(asset_key, tag, tag_lower) VALUES(?, ?, ?)",
            rows,
        )


def _rebuild_asset_meta_tags_index(conn: sqlite3.Connection) -> None:
    row = conn.execute("SELECT COUNT(1) FROM asset_meta_tags").fetchone()
    if int((row or [0])[0] or 0) > 0:
        return
    rows = conn.execute("SELECT asset_key, tags_json FROM asset_meta").fetchall()
    for asset_key, tags_json in rows:
        _sync_asset_meta_tags(conn, str(asset_key), _normalize_tags(tags_json))


def _parse_asset_key(asset_key: str) -> Tuple[str, str]:
    raw = str(asset_key or "")
    if "::" not in raw:
        return "", ""
    lib, rel = raw.split("::", 1)
    return str(lib or ""), str(rel or "")


def _library_waveform_cache_file(asset_key: str, mtime_ns: int, size: int, samples: int, path_mappings: Optional[List[Dict[str, Any]]], cache_dir_name: str, compress: bool) -> str:
    lib, rel = _parse_asset_key(asset_key)
    if not lib or not rel:
        return ""
    lib_actual = resolve_mapped_path(lib, path_mappings)
    if not lib_actual or not os.path.isdir(lib_actual):
        return ""
    rel_norm = rel.replace("\\", "/").lstrip("/")
    h = hashlib.sha1(rel_norm.encode("utf-8")).hexdigest()
    sub = h[:2]
    ext = "json.gz" if compress else "json"
    name = f"{h}.v{int(WAVEFORM_CACHE_VERSION)}.{int(samples)}.{int(mtime_ns)}.{int(size)}.{ext}"
    
    # 按照用户的要求，将缓存文件直接保存在音效库根目录下。
    # 这有利于与他人共享整个硬盘时，其他人不需要重新生成缓存。
    return os.path.join(lib_actual, cache_dir_name, "waveforms", sub, name)


def get_waveform_cache_library(asset_key: str, mtime_ns: int, size: int, samples: int, path_mappings: Optional[List[Dict[str, Any]]], cache_dir_name: str = ".sfx_cache", compress: bool = True) -> Optional[Dict[str, Any]]:
    p = _library_waveform_cache_file(asset_key, mtime_ns, size, samples, path_mappings, cache_dir_name, compress)
    if not p or not os.path.exists(p):
        return None
    try:
        if compress:
            with gzip.open(p, "rt", encoding="utf-8") as f:
                payload = json.load(f)
        else:
            with open(p, "r", encoding="utf-8") as f:
                payload = json.load(f)
        data = payload.get("data")
        if not isinstance(data, list) or not data:
            return None
        return {
            "status": "success",
            "data": data,
            "duration": float(payload.get("duration") or 0),
            "sample_rate": int(payload.get("sample_rate") or 0),
            "samples": int(samples),
            "cached": True,
            "cached_backend": "library",
        }
    except Exception:
        return None


def set_waveform_cache_library(asset_key: str, mtime_ns: int, size: int, samples: int, data: List[float], duration: float, sample_rate: int, path_mappings: Optional[List[Dict[str, Any]]], cache_dir_name: str = ".sfx_cache", compress: bool = True) -> bool:
    if not asset_key:
        return False
    p = _library_waveform_cache_file(asset_key, mtime_ns, size, samples, path_mappings, cache_dir_name, compress)
    if not p:
        return False
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        payload = {
            "status": "success",
            "version": int(WAVEFORM_CACHE_VERSION),
            "samples": int(samples),
            "duration": float(duration or 0),
            "sample_rate": int(sample_rate or 0),
            "data": data,
        }
        tmp_path = f"{p}.tmp"
        if compress:
            with gzip.open(tmp_path, "wt", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
        else:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp_path, p)
        return True
    except Exception:
        try:
            tmp_path = f"{p}.tmp"
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass
        return False


def get_asset_meta(keys: List[str]) -> Dict[str, Dict[str, Any]]:
    if not keys:
        return {}
    conn = _get_asset_meta_db()
    placeholders = ",".join(["?"] * len(keys))
    rows = conn.execute(
        f"SELECT asset_key, favorite, tags_json, used_count, last_used_at FROM asset_meta WHERE asset_key IN ({placeholders})",
        keys,
    ).fetchall()
    out: Dict[str, Dict[str, Any]] = {}
    for asset_key, favorite, tags_json, used_count, last_used_at in rows:
        try:
            tags = json.loads(tags_json or "[]")
            if not isinstance(tags, list):
                tags = []
        except Exception:
            tags = []
        out[str(asset_key)] = {
            "favorite": bool(favorite),
            "tags": tags,
            "used_count": int(used_count or 0),
            "last_used_at": int(last_used_at or 0),
        }
    return out


def _ensure_asset_meta_row(asset_key: str) -> None:
    conn = _get_asset_meta_db()
    conn.execute("INSERT OR IGNORE INTO asset_meta(asset_key) VALUES(?)", (asset_key,))
    conn.commit()


def set_asset_favorite(asset_key: str, favorite: bool) -> None:
    if not asset_key:
        return
    _ensure_asset_meta_row(asset_key)
    conn = _get_asset_meta_db()
    conn.execute("UPDATE asset_meta SET favorite=? WHERE asset_key=?", (1 if favorite else 0, asset_key))
    conn.commit()


def add_asset_tag(asset_key: str, tag: str) -> None:
    t = str(tag or "").strip()
    if not asset_key or not t:
        return
    _ensure_asset_meta_row(asset_key)
    conn = _get_asset_meta_db()
    row = conn.execute("SELECT tags_json FROM asset_meta WHERE asset_key=?", (asset_key,)).fetchone()
    raw = row[0] if row else "[]"
    tags = _normalize_tags(raw)
    normalized = t.lower()
    if any(str(x).lower() == normalized for x in tags):
        return
    tags.append(t)
    normalized_tags = _normalize_tags(tags)
    with conn:
        conn.execute("UPDATE asset_meta SET tags_json=? WHERE asset_key=?", (json.dumps(normalized_tags, ensure_ascii=False), asset_key))
        _sync_asset_meta_tags(conn, asset_key, normalized_tags)


def remove_asset_tag(asset_key: str, tag: str) -> None:
    normalized = str(tag or "").strip().lower()
    if not asset_key or not normalized:
        return
    _ensure_asset_meta_row(asset_key)
    conn = _get_asset_meta_db()
    row = conn.execute("SELECT tags_json FROM asset_meta WHERE asset_key=?", (asset_key,)).fetchone()
    raw = row[0] if row else "[]"
    tags = _normalize_tags(raw)
    next_tags = [t for t in tags if str(t).lower() != normalized]
    with conn:
        conn.execute("UPDATE asset_meta SET tags_json=? WHERE asset_key=?", (json.dumps(next_tags, ensure_ascii=False), asset_key))
        _sync_asset_meta_tags(conn, asset_key, next_tags)


def bulk_add_asset_tag(asset_keys: List[str], tag: str) -> None:
    t = str(tag or "").strip()
    if not asset_keys or not t:
        return
    for k in asset_keys:
        add_asset_tag(k, t)


def bulk_remove_asset_tag(asset_keys: List[str], tag: str) -> None:
    t = str(tag or "").strip()
    if not asset_keys or not t:
        return
    for k in asset_keys:
        remove_asset_tag(k, t)


def increment_asset_used(asset_key: str, delta: int = 1) -> None:
    if not asset_key:
        return
    _ensure_asset_meta_row(asset_key)
    conn = _get_asset_meta_db()
    now = int(time.time())
    conn.execute(
        "UPDATE asset_meta SET used_count = used_count + ?, last_used_at = ? WHERE asset_key=?",
        (int(delta), now, asset_key),
    )
    conn.commit()


# ==================== 音效库扫描 ====================

AUDIO_EXTENSIONS = {'.wav', '.mp3', '.aac', '.m4a', '.flac', '.ogg', '.wma', '.aiff', '.aif'}


def _resolve_library_root(library_path: str, path_mappings: Optional[List[Dict[str, Any]]] = None) -> str:
    if not library_path:
        return ""
    actual_root = library_path
    if not os.path.isdir(actual_root):
        mapped = resolve_mapped_path(actual_root, path_mappings)
        if mapped and os.path.isdir(mapped):
            actual_root = mapped
    if not os.path.isdir(actual_root):
        return ""
    return actual_root


def _library_scan_rows_to_files(rows: List[sqlite3.Row]) -> List[Dict[str, Any]]:
    files: List[Dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item.pop("library_id", None)
        item.pop("actual_root", None)
        item.pop("path_lower", None)
        item.pop("name_lower", None)
        item.pop("filename_lower", None)
        item.pop("relative_path_lower", None)
        files.append(item)
    return files


def _save_library_scan_to_db(
    library_path: str,
    max_depth: int,
    payload: Dict[str, Any],
    path_mappings: Optional[List[Dict[str, Any]]] = None,
) -> None:
    actual_root = str(payload.get("actual_root") or _resolve_library_root(library_path, path_mappings) or "")
    library_id = _library_cache_id(library_path, max_depth, path_mappings)
    folders_json = json.dumps(list(payload.get("folders") or []), ensure_ascii=False)
    files = list(payload.get("files") or [])
    conn = _get_asset_meta_db()
    conn.row_factory = sqlite3.Row
    with conn:
        conn.execute("DELETE FROM library_asset_index WHERE library_id=?", (library_id,))
        conn.execute(
            """
            INSERT OR REPLACE INTO library_scan_cache(library_id, library_path, actual_root, max_depth, generated_at, folders_json)
            VALUES(?, ?, ?, ?, ?, ?)
            """,
            (
                library_id,
                library_path,
                actual_root,
                int(max_depth),
                int(payload.get("generated_at") or time.time()),
                folders_json,
            ),
        )
        rows = []
        for item in files:
            relative_path = str(item.get("relative_path") or "")
            asset_key = f"{library_path}::{relative_path}"
            rows.append(
                (
                    asset_key,
                    library_id,
                    library_path,
                    actual_root,
                    relative_path,
                    str(item.get("parent_folder") or "/"),
                    str(item.get("parent_path") or ""),
                    str(item.get("path") or ""),
                    str(item.get("path") or "").lower(),
                    str(item.get("name") or ""),
                    str(item.get("name") or "").lower(),
                    str(item.get("filename") or ""),
                    str(item.get("filename") or "").lower(),
                    relative_path.lower(),
                    str(item.get("extension") or ""),
                    int(item.get("size") or 0),
                    float(item.get("size_mb") or 0),
                    str(item.get("modified") or ""),
                    str(item.get("duration") or ""),
                    float(item.get("duration_seconds") or 0),
                    int(item.get("sample_rate") or 0),
                )
            )
        if rows:
            conn.executemany(
                """
                INSERT OR REPLACE INTO library_asset_index(
                  asset_key, library_id, library_path, actual_root, relative_path, parent_folder, parent_path,
                  path, path_lower, name, name_lower, filename, filename_lower, relative_path_lower,
                  extension, size, size_mb, modified, duration, duration_seconds, sample_rate
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )


def _load_library_scan_from_db(
    library_path: str,
    max_depth: int,
    path_mappings: Optional[List[Dict[str, Any]]] = None,
    ttl_seconds: int = 300,
) -> Optional[Dict[str, Any]]:
    library_id = _library_cache_id(library_path, max_depth, path_mappings)
    conn = _get_asset_meta_db()
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT actual_root, generated_at, folders_json FROM library_scan_cache WHERE library_id=?",
        (library_id,),
    ).fetchone()
    if not row:
        return None
    generated_at = int(row["generated_at"] or 0)
    if ttl_seconds > 0 and generated_at > 0 and (time.time() - generated_at) > ttl_seconds:
        return None
    rows = conn.execute(
        """
        SELECT library_id, actual_root, relative_path, parent_folder, parent_path, path, path_lower,
               name, name_lower, filename, filename_lower, relative_path_lower,
               extension, size, size_mb, modified, duration, duration_seconds, sample_rate
        FROM library_asset_index
        WHERE library_id=?
        ORDER BY relative_path ASC
        """,
        (library_id,),
    ).fetchall()
    try:
        folders = json.loads(row["folders_json"] or "[]")
        if not isinstance(folders, list):
            folders = []
    except Exception:
        folders = []
    return {
        "files": _library_scan_rows_to_files(rows),
        "folders": folders,
        "actual_root": str(row["actual_root"] or ""),
        "generated_at": generated_at,
    }


def _decode_library_folders(raw_json: Any) -> List[Dict[str, Any]]:
    try:
        folders = json.loads(raw_json or "[]")
        if isinstance(folders, list):
            return folders
    except Exception:
        pass
    return []


def _load_library_scan_cache_entry(
    library_path: str,
    max_depth: int,
    path_mappings: Optional[List[Dict[str, Any]]] = None,
) -> Optional[Dict[str, Any]]:
    library_id = _library_cache_id(library_path, max_depth, path_mappings)
    conn = _get_asset_meta_db()
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT actual_root, generated_at, folders_json FROM library_scan_cache WHERE library_id=?",
        (library_id,),
    ).fetchone()
    if not row:
        return None
    return {
        "library_id": library_id,
        "actual_root": str(row["actual_root"] or ""),
        "generated_at": int(row["generated_at"] or 0),
        "folders": _decode_library_folders(row["folders_json"]),
    }


def _is_library_scan_cache_stale(generated_at: int, ttl_seconds: int) -> bool:
    if ttl_seconds <= 0 or generated_at <= 0:
        return False
    return (time.time() - generated_at) > ttl_seconds


def trigger_sound_library_scan_refresh(
    library_path: str,
    max_depth: int = 20,
    path_mappings: Optional[List[Dict[str, Any]]] = None,
    ttl_seconds: int = 300,
) -> bool:
    library_id = _library_cache_id(library_path, max_depth, path_mappings)
    with _library_scan_progress_lock:
        if (_library_scan_progress.get(library_id) or {}).get("active"):
            return False

    with _library_scan_refresh_guard:
        existing = _library_scan_refresh_threads.get(library_id)
        if existing and existing.is_alive():
            return False

        def _runner() -> None:
            try:
                get_sound_library_scan_data(
                    library_path,
                    max_depth=max_depth,
                    path_mappings=path_mappings,
                    ttl_seconds=ttl_seconds,
                    force_refresh=True,
                )
            except Exception:
                pass
            finally:
                with _library_scan_refresh_guard:
                    current = _library_scan_refresh_threads.get(library_id)
                    if current is thread:
                        _library_scan_refresh_threads.pop(library_id, None)

        thread = threading.Thread(
            target=_runner,
            name=f"sfx-index-refresh-{library_id[:8]}",
            daemon=True,
        )
        _library_scan_refresh_threads[library_id] = thread
        thread.start()
    return True


def ensure_sound_library_scan_cache(
    library_path: str,
    max_depth: int = 20,
    path_mappings: Optional[List[Dict[str, Any]]] = None,
    ttl_seconds: int = 300,
    force_refresh: bool = False,
    include_folders: bool = False,
    background_refresh: bool = True,
) -> Dict[str, Any]:
    if force_refresh:
        payload = get_sound_library_scan_data(
            library_path,
            max_depth=max_depth,
            path_mappings=path_mappings,
            ttl_seconds=ttl_seconds,
            force_refresh=True,
        )
        return {
            "library_path": library_path,
            "actual_root": str(payload.get("actual_root") or ""),
            "folders": list(payload.get("folders") or []) if include_folders else [],
            "generated_at": int(payload.get("generated_at") or 0),
            "cached": bool(payload.get("cached")),
            "stale": False,
            "refreshing": False,
        }

    cached_entry = _load_library_scan_cache_entry(
        library_path,
        max_depth=max_depth,
        path_mappings=path_mappings,
    )
    if cached_entry:
        stale = _is_library_scan_cache_stale(
            int(cached_entry.get("generated_at") or 0),
            ttl_seconds,
        )
        status = get_sound_library_index_status(
            library_path,
            max_depth=max_depth,
            path_mappings=path_mappings,
            ttl_seconds=ttl_seconds,
        )
        refreshing = bool(status.get("active"))
        if stale and background_refresh and not refreshing:
            refreshing = trigger_sound_library_scan_refresh(
                library_path,
                max_depth=max_depth,
                path_mappings=path_mappings,
                ttl_seconds=ttl_seconds,
            ) or refreshing
        return {
            "library_path": library_path,
            "actual_root": str(cached_entry.get("actual_root") or ""),
            "folders": list(cached_entry.get("folders") or []) if include_folders else [],
            "generated_at": int(cached_entry.get("generated_at") or 0),
            "cached": True,
            "stale": stale,
            "refreshing": refreshing,
        }

    payload = get_sound_library_scan_data(
        library_path,
        max_depth=max_depth,
        path_mappings=path_mappings,
        ttl_seconds=ttl_seconds,
        force_refresh=False,
    )
    return {
        "library_path": library_path,
        "actual_root": str(payload.get("actual_root") or ""),
        "folders": list(payload.get("folders") or []) if include_folders else [],
        "generated_at": int(payload.get("generated_at") or 0),
        "cached": bool(payload.get("cached")),
        "stale": False,
        "refreshing": False,
    }


def load_sound_library_scan_cache(
    library_path: str,
    max_depth: int = 20,
    path_mappings: Optional[List[Dict[str, Any]]] = None,
    ttl_seconds: int = 300,
) -> Optional[Dict[str, Any]]:
    return _load_library_scan_from_db(
        library_path,
        max_depth=max_depth,
        path_mappings=path_mappings,
        ttl_seconds=ttl_seconds,
    )


def save_sound_library_scan_cache(
    library_path: str,
    max_depth: int,
    payload: Dict[str, Any],
    path_mappings: Optional[List[Dict[str, Any]]] = None,
    ttl_seconds: int = 300,
) -> None:
    try:
        _save_library_scan_to_db(
            library_path,
            max_depth=max_depth,
            payload=payload,
            path_mappings=path_mappings,
        )
    except Exception:
        pass


def clear_sound_library_scan_cache(library_path: Optional[str] = None, max_depth: Optional[int] = None, path_mappings: Optional[List[Dict[str, Any]]] = None) -> None:
    try:
        conn = _get_asset_meta_db()
        conn.row_factory = sqlite3.Row
        if library_path:
            depth = int(max_depth or 20)
            library_id = _library_cache_id(library_path, depth, path_mappings)
            with conn:
                conn.execute("DELETE FROM library_asset_index WHERE library_id=?", (library_id,))
                conn.execute("DELETE FROM library_scan_cache WHERE library_id=?", (library_id,))
            return
        with conn:
            conn.execute("DELETE FROM library_asset_index")
            conn.execute("DELETE FROM library_scan_cache")
    except Exception:
        pass


def _scan_sound_library_data_uncached(library_path: str, max_depth: int = 20, path_mappings: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    actual_root = _resolve_library_root(library_path, path_mappings)
    if not actual_root:
        return {"files": [], "folders": [], "actual_root": "", "generated_at": int(time.time())}

    library_id = _library_cache_id(library_path, max_depth, path_mappings)
    files = []
    root_name = os.path.basename(actual_root.rstrip(os.sep)) or actual_root
    progress = {
        "processed_files": 0,
        "processed_dirs": 0,
        "last_emit_files": 0,
        "last_emit_at": 0.0,
        "current_path": actual_root,
    }

    def emit_progress(force: bool = False, current_path: str = "") -> None:
        now = time.monotonic()
        if not current_path:
            current_path = progress["current_path"]
        if not force:
            if progress["processed_files"] - progress["last_emit_files"] < 20 and (now - progress["last_emit_at"]) < 0.25:
                return
        progress["last_emit_files"] = progress["processed_files"]
        progress["last_emit_at"] = now
        progress["current_path"] = current_path
        _update_library_scan_progress(
            library_id,
            library_path,
            active=True,
            has_cache=False,
            stage="scanning",
            message=f"正在扫描音效库，已发现 {progress['processed_files']} 个音效文件",
            processed_files=progress["processed_files"],
            processed_dirs=progress["processed_dirs"],
            current_path=current_path,
        )

    def _scan(current_path: str, depth: int, rel_prefix: str) -> Optional[Dict[str, Any]]:
        if depth > max_depth:
            return None
        progress["processed_dirs"] += 1
        progress["current_path"] = current_path
        emit_progress(force=progress["processed_dirs"] <= 2, current_path=current_path)
        try:
            with os.scandir(current_path) as iterator:
                entries = sorted(
                    (entry for entry in iterator if not entry.name.startswith(".")),
                    key=lambda entry: entry.name.lower(),
                )
        except PermissionError:
            return None
        except Exception:
            return None

        dirs = []
        audio_count = 0
        for entry in entries:
            entry_name = entry.name
            full_path = entry.path
            if entry.is_dir(follow_symlinks=False):
                dirs.append(entry_name)
            elif entry.is_file(follow_symlinks=False):
                ext = os.path.splitext(entry_name)[1].lower()
                if ext in AUDIO_EXTENSIONS:
                    try:
                        stat = entry.stat()
                        rel_path = os.path.join(rel_prefix, entry_name) if rel_prefix else entry_name
                        files.append({
                            "name": os.path.splitext(entry_name)[0],
                            "filename": entry_name,
                            "path": full_path,
                            "relative_path": rel_path,
                            "parent_folder": rel_prefix if rel_prefix else "/",
                            "parent_path": current_path,
                            "size": stat.st_size,
                            "size_mb": round(stat.st_size / (1024 * 1024), 2),
                            "modified": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M"),
                            "extension": ext,
                        })
                        audio_count += 1
                        progress["processed_files"] += 1
                        emit_progress(current_path=current_path)
                    except Exception:
                        pass

        children = []
        total_audio_count = audio_count
        for d in dirs:
            sub_path = os.path.join(current_path, d)
            sub_rel = os.path.join(rel_prefix, d) if rel_prefix else d
            child = _scan(sub_path, depth + 1, sub_rel)
            if child:
                children.append(child)
                total_audio_count += int(child.get("total_audio_count", 0))

        return {
            "name": os.path.basename(current_path) if depth > 1 else root_name,
            "path": current_path,
            "audio_count": audio_count,
            "total_audio_count": total_audio_count,
            "children": children,
        }

    root_node = _scan(actual_root, 1, "")
    emit_progress(force=True, current_path=actual_root)
    return {
        "files": files,
        "folders": list((root_node or {}).get("children") or []),
        "actual_root": actual_root,
        "generated_at": int(time.time()),
    }


def get_sound_library_scan_data(
    library_path: str,
    max_depth: int = 20,
    path_mappings: Optional[List[Dict[str, Any]]] = None,
    ttl_seconds: int = 300,
    force_refresh: bool = False,
) -> Dict[str, Any]:
    library_id = _library_cache_id(library_path, max_depth, path_mappings)
    if not force_refresh:
        cached = load_sound_library_scan_cache(
            library_path,
            max_depth=max_depth,
            path_mappings=path_mappings,
            ttl_seconds=ttl_seconds,
        )
        if cached:
            return {
                "files": list(cached.get("files") or []),
                "folders": list(cached.get("folders") or []),
                "actual_root": str(cached.get("actual_root") or ""),
                "generated_at": int(cached.get("generated_at") or 0),
                "cached": True,
            }

    scan_lock = _get_library_scan_lock(library_id)
    with scan_lock:
        if not force_refresh:
            cached = load_sound_library_scan_cache(
                library_path,
                max_depth=max_depth,
                path_mappings=path_mappings,
                ttl_seconds=ttl_seconds,
            )
            if cached:
                return {
                    "files": list(cached.get("files") or []),
                    "folders": list(cached.get("folders") or []),
                    "actual_root": str(cached.get("actual_root") or ""),
                    "generated_at": int(cached.get("generated_at") or 0),
                    "cached": True,
                }

        actual_root = _resolve_library_root(library_path, path_mappings)
        _update_library_scan_progress(
            library_id,
            library_path,
            active=True,
            has_cache=False,
            stage="starting",
            message="正在准备建立本地索引",
            processed_files=0,
            processed_dirs=0,
            current_path=actual_root or library_path,
            generated_at=0,
        )
        try:
            payload = _scan_sound_library_data_uncached(
                library_path,
                max_depth=max_depth,
                path_mappings=path_mappings,
            )
            _update_library_scan_progress(
                library_id,
                library_path,
                active=True,
                has_cache=False,
                stage="writing",
                message=f"正在写入本地索引，共 {len(payload.get('files') or [])} 个音效文件",
                processed_files=len(payload.get("files") or []),
                processed_dirs=len(payload.get("folders") or []),
                current_path=str(payload.get("actual_root") or actual_root or library_path),
            )
            save_sound_library_scan_cache(
                library_path,
                max_depth=max_depth,
                payload=payload,
                path_mappings=path_mappings,
                ttl_seconds=ttl_seconds,
            )
            _update_library_scan_progress(
                library_id,
                library_path,
                active=False,
                has_cache=True,
                stage="ready",
                message="本地索引已就绪",
                processed_files=len(payload.get("files") or []),
                processed_dirs=len(payload.get("folders") or []),
                current_path=str(payload.get("actual_root") or actual_root or library_path),
                generated_at=int(payload.get("generated_at") or time.time()),
            )
            return {
                **payload,
                "cached": False,
            }
        except Exception as exc:
            _update_library_scan_progress(
                library_id,
                library_path,
                active=False,
                has_cache=False,
                stage="error",
                message=f"本地索引建立失败：{str(exc)}",
                current_path=actual_root or library_path,
            )
            raise


def scan_sound_library(
    library_path: str,
    max_depth: int = 20,
    path_mappings: Optional[List[Dict[str, Any]]] = None,
    ttl_seconds: int = 300,
    force_refresh: bool = False,
) -> List[Dict[str, Any]]:
    """
    扫描指定路径下的音效文件

    Args:
        library_path: 音效库根路径
        max_depth: 最大递归深度

    Returns:
        音效文件列表
    """
    payload = get_sound_library_scan_data(
        library_path,
        max_depth=max_depth,
        path_mappings=path_mappings,
        ttl_seconds=ttl_seconds,
        force_refresh=force_refresh,
    )
    return list(payload.get("files") or [])


def _enrich_audio_metadata(files: List[Dict[str, Any]]) -> None:
    for f in files:
        p = f.get("path", "")
        if not p or not os.path.isfile(p):
            continue
        meta = get_audio_file_metadata(p)
        dur = meta.get("duration")
        if isinstance(dur, (int, float)) and dur > 0:
            s = int(dur)
            h = s // 3600
            m = (s % 3600) // 60
            sec = s % 60
            f["duration_seconds"] = round(dur, 1)
            if h > 0:
                f["duration"] = f"{h}:{m:02d}:{sec:02d}"
            else:
                f["duration"] = f"{m}:{sec:02d}"
        sr = meta.get("sample_rate")
        if isinstance(sr, int) and sr > 0:
            f["sample_rate"] = sr


def scan_all_libraries(config: Optional[Dict[str, Any]] = None, force_refresh: bool = False) -> Dict[str, List[Dict[str, Any]]]:
    """扫描配置的音效库（单库模式）"""
    if config is None:
        config = load_sound_effects_config()

    result = {}
    mappings = config.get("path_mappings", [])
    max_depth = int(config.get("library_scan_depth", 20))
    ttl_seconds = int(config.get("scan_cache_ttl_seconds", 300) or 300)
    lib_path = (config.get("library_path") or "").strip()
    if lib_path and os.path.isdir(lib_path):
        result[lib_path] = scan_sound_library(
            lib_path,
            max_depth=max_depth,
            path_mappings=mappings,
            ttl_seconds=ttl_seconds,
            force_refresh=force_refresh,
        )
    return result


def _library_meta_map_for_asset_keys(asset_keys: List[str]) -> Dict[str, Dict[str, Any]]:
    return get_asset_meta(asset_keys)


def _decorate_library_asset_rows(rows: List[sqlite3.Row]) -> List[Dict[str, Any]]:
    files = _library_scan_rows_to_files(rows)
    asset_keys = [str(row["asset_key"]) for row in rows]
    meta_map = _library_meta_map_for_asset_keys(asset_keys)
    now = int(time.time())
    for file_item, asset_key in zip(files, asset_keys):
        meta = meta_map.get(asset_key) or {}
        last_used_at = int(meta.get("last_used_at", 0) or 0)
        file_item["asset_key"] = asset_key
        file_item["favorite"] = bool(meta.get("favorite", False))
        file_item["tags"] = list(meta.get("tags", []) or [])
        file_item["used_count"] = int(meta.get("used_count", 0) or 0)
        file_item["last_used_at"] = last_used_at
        file_item["last_used_days"] = max(0, int((now - last_used_at) // 86400)) if last_used_at > 0 else 9999
    return files


def summarize_sound_library_assets_index(
    library_path: str,
    max_depth: int = 20,
    path_mappings: Optional[List[Dict[str, Any]]] = None,
    top_tags_limit: int = 50,
) -> Dict[str, Any]:
    library_id = _library_cache_id(library_path, max_depth, path_mappings)
    conn = _get_asset_meta_db()
    conn.row_factory = sqlite3.Row
    threshold = int(time.time()) - 7 * 86400
    nav_row = conn.execute(
        """
        SELECT
          COUNT(1) AS total_count,
          SUM(CASE WHEN COALESCE(am.favorite, 0) = 1 THEN 1 ELSE 0 END) AS favorite_count,
          SUM(CASE WHEN COALESCE(am.last_used_at, 0) >= ? THEN 1 ELSE 0 END) AS recent_count,
          SUM(CASE WHEN COALESCE(am.used_count, 0) > 0 THEN 1 ELSE 0 END) AS used_count
        FROM library_asset_index lai
        LEFT JOIN asset_meta am ON am.asset_key = lai.asset_key
        WHERE lai.library_id = ?
        """,
        (threshold, library_id),
    ).fetchone()
    tag_rows = conn.execute(
        """
        SELECT att.tag AS tag, COUNT(1) AS tag_count
        FROM library_asset_index lai
        JOIN asset_meta_tags att ON att.asset_key = lai.asset_key
        WHERE lai.library_id = ?
        GROUP BY att.tag_lower
        ORDER BY tag_count DESC, att.tag_lower ASC
        LIMIT ?
        """,
        (library_id, max(1, int(top_tags_limit or 50))),
    ).fetchall()
    return {
        "nav_counts": {
            "all": int((nav_row or {}).get("total_count", 0) if isinstance(nav_row, dict) else (nav_row["total_count"] if nav_row else 0) or 0),
            "favorites": int((nav_row or {}).get("favorite_count", 0) if isinstance(nav_row, dict) else (nav_row["favorite_count"] if nav_row else 0) or 0),
            "recent": int((nav_row or {}).get("recent_count", 0) if isinstance(nav_row, dict) else (nav_row["recent_count"] if nav_row else 0) or 0),
            "project_used": int((nav_row or {}).get("used_count", 0) if isinstance(nav_row, dict) else (nav_row["used_count"] if nav_row else 0) or 0),
        },
        "top_tags": [{"t": str(row["tag"] or ""), "count": int(row["tag_count"] or 0)} for row in tag_rows],
    }


def _append_asset_query_filters(
    clauses: List[str],
    params: List[Any],
    query: str = "",
    selected_folder: str = "",
    forced_tag: str = "",
    favorite_only: bool = False,
    untagged_only: bool = False,
    smart_rules: Optional[Dict[str, Any]] = None,
) -> None:
    folder_prefix = str(selected_folder or "").rstrip("/")
    if folder_prefix:
        clauses.append("(lai.parent_path = ? OR lai.path LIKE ?)")
        params.extend([folder_prefix, f"{folder_prefix}/%"])

    def _append_search(search_text: str) -> None:
        normalized_query = str(search_text or "").strip().lower()
        if not normalized_query:
            return
        like = f"%{normalized_query}%"
        clauses.append(
            "("
            "lai.name_lower LIKE ? OR lai.filename_lower LIKE ? OR lai.relative_path_lower LIKE ? OR lai.path_lower LIKE ? "
            "OR EXISTS (SELECT 1 FROM asset_meta_tags attq WHERE attq.asset_key = lai.asset_key AND attq.tag_lower LIKE ?)"
            ")"
        )
        params.extend([like, like, like, like, like])

    normalized_tag = str(forced_tag or "").strip().lower()
    if normalized_tag:
        clauses.append("EXISTS (SELECT 1 FROM asset_meta_tags att WHERE att.asset_key = lai.asset_key AND att.tag_lower = ?)")
        params.append(normalized_tag)
    if favorite_only:
        clauses.append("COALESCE(am.favorite, 0) = 1")
    if untagged_only:
        clauses.append("NOT EXISTS (SELECT 1 FROM asset_meta_tags attu WHERE attu.asset_key = lai.asset_key)")

    _append_search(query)

    rules = smart_rules or {}
    if bool(rules.get("favoriteOnly")):
        clauses.append("COALESCE(am.favorite, 0) = 1")
    if bool(rules.get("untaggedOnly")):
        clauses.append("NOT EXISTS (SELECT 1 FROM asset_meta_tags attr WHERE attr.asset_key = lai.asset_key)")
    used_count_min = rules.get("usedCountMin")
    if isinstance(used_count_min, (int, float)):
        clauses.append("COALESCE(am.used_count, 0) >= ?")
        params.append(int(used_count_min))
    last_used_within_days = rules.get("lastUsedWithinDays")
    if isinstance(last_used_within_days, (int, float)) and int(last_used_within_days) > 0:
        threshold = int(time.time()) - int(last_used_within_days) * 86400
        clauses.append("COALESCE(am.last_used_at, 0) >= ?")
        params.append(threshold)
    tags_any = [str(tag).strip().lower() for tag in list(rules.get("tagsAny") or []) if str(tag).strip()]
    if tags_any:
        placeholders = ",".join(["?"] * len(tags_any))
        clauses.append(
            f"EXISTS (SELECT 1 FROM asset_meta_tags attt WHERE attt.asset_key = lai.asset_key AND attt.tag_lower IN ({placeholders}))"
        )
        params.extend(tags_any)
    _append_search(str(rules.get("query") or ""))

    in_project_path = str(rules.get("inProjectPath") or "").strip()
    if in_project_path:
        if os.path.isdir(in_project_path):
            _project_basenames = _get_project_audio_basenames(in_project_path)
            if _project_basenames:
                _placeholders = ",".join(["?"] * len(_project_basenames))
                clauses.append(f"lai.filename_lower IN ({_placeholders})")
                params.extend(sorted(_project_basenames))
            else:
                clauses.append("1=0")
        else:
            clauses.append("1=0")


def browse_sound_library_assets_index(
    library_path: str,
    max_depth: int = 20,
    path_mappings: Optional[List[Dict[str, Any]]] = None,
    query: str = "",
    selected_folder: str = "",
    forced_tag: str = "",
    favorite_only: bool = False,
    untagged_only: bool = False,
    sort_mode: str = "name_asc",
    smart_rules: Optional[Dict[str, Any]] = None,
    limit: int = 120,
    offset: int = 0,
) -> Dict[str, Any]:
    library_id = _library_cache_id(library_path, max_depth, path_mappings)
    conn = _get_asset_meta_db()
    conn.row_factory = sqlite3.Row
    clauses = ["lai.library_id = ?"]
    params: List[Any] = [library_id]
    _append_asset_query_filters(
        clauses,
        params,
        query=query,
        selected_folder=selected_folder,
        forced_tag=forced_tag,
        favorite_only=favorite_only,
        untagged_only=untagged_only,
        smart_rules=smart_rules,
    )
    where_sql = " AND ".join(clauses)
    mode = str(sort_mode or "name_asc")
    order_sql = "lai.name_lower ASC"
    if mode == "name_desc":
        order_sql = "lai.name_lower DESC"
    elif mode == "used_desc":
        order_sql = "COALESCE(am.used_count, 0) DESC, lai.name_lower ASC"
    elif mode == "used_asc":
        order_sql = "COALESCE(am.used_count, 0) ASC, lai.name_lower ASC"
    elif mode == "recent_asc":
        order_sql = "COALESCE(am.last_used_at, 0) DESC, lai.name_lower ASC"
    elif mode == "recent_desc":
        order_sql = "COALESCE(am.last_used_at, 0) ASC, lai.name_lower ASC"

    total_row = conn.execute(
        f"""
        SELECT COUNT(1) AS total_count
        FROM library_asset_index lai
        LEFT JOIN asset_meta am ON am.asset_key = lai.asset_key
        WHERE {where_sql}
        """,
        params,
    ).fetchone()
    safe_offset = max(0, int(offset or 0))
    safe_limit = max(1, min(int(limit or 120), 500))
    rows = conn.execute(
        f"""
        SELECT
          lai.asset_key, lai.library_id, lai.actual_root, lai.relative_path, lai.parent_folder, lai.parent_path,
          lai.path, lai.path_lower, lai.name, lai.name_lower, lai.filename, lai.filename_lower,
          lai.relative_path_lower, lai.extension, lai.size, lai.size_mb, lai.modified,
          lai.duration, lai.duration_seconds, lai.sample_rate
        FROM library_asset_index lai
        LEFT JOIN asset_meta am ON am.asset_key = lai.asset_key
        WHERE {where_sql}
        ORDER BY {order_sql}
        LIMIT ? OFFSET ?
        """,
        params + [safe_limit, safe_offset],
    ).fetchall()
    total = int(total_row["total_count"] if total_row else 0)
    items = _decorate_library_asset_rows(rows)
    return {
        "total": total,
        "items": items,
        "offset": safe_offset,
        "limit": safe_limit,
        "has_more": safe_offset + safe_limit < total,
    }


def resolve_asset_keys_for_paths_index(
    library_path: str,
    max_depth: int = 20,
    path_mappings: Optional[List[Dict[str, Any]]] = None,
    asset_keys: Optional[List[str]] = None,
    folder_paths: Optional[List[str]] = None,
) -> List[str]:
    result = {str(key) for key in list(asset_keys or []) if str(key).strip()}
    normalized_folders = [str(path or "").rstrip("/") for path in list(folder_paths or []) if str(path or "").strip()]
    if not normalized_folders:
        return list(result)
    library_id = _library_cache_id(library_path, max_depth, path_mappings)
    conn = _get_asset_meta_db()
    conn.row_factory = sqlite3.Row
    clauses = []
    params: List[Any] = [library_id]
    for folder in normalized_folders:
        clauses.append("(parent_path = ? OR path LIKE ?)")
        params.extend([folder, f"{folder}/%"])
    rows = conn.execute(
        f"""
        SELECT asset_key
        FROM library_asset_index
        WHERE library_id=? AND ({' OR '.join(clauses)})
        """,
        params,
    ).fetchall()
    for row in rows:
        result.add(str(row["asset_key"]))
    return list(result)


def get_library_folder_tree(
    library_path: str,
    max_depth: int = 20,
    path_mappings: Optional[List[Dict[str, Any]]] = None,
    ttl_seconds: int = 300,
    force_refresh: bool = False,
) -> List[Dict[str, Any]]:
    """
    获取音效库的文件夹树结构（用于前端树形展示）

    Returns:
        文件夹树节点列表，每个节点含 {name, path, audio_count, total_audio_count, children}
    """
    payload = ensure_sound_library_scan_cache(
        library_path,
        max_depth=max_depth,
        path_mappings=path_mappings,
        ttl_seconds=ttl_seconds,
        force_refresh=force_refresh,
        include_folders=True,
    )
    return list(payload.get("folders") or [])


# ==================== 音效复制到项目 ====================

def copy_sound_to_project(
    source_path: str,
    project_local_path: str,
    subfolder: str = "音效",
) -> Dict[str, Any]:
    """将音效文件从音效库复制到项目本地文件夹"""
    if not os.path.exists(source_path):
        return {"status": "error", "message": f"源文件不存在: {source_path}"}

    if not project_local_path:
        return {"status": "error", "message": "未设置项目本地路径"}

    dest_dir = os.path.join(project_local_path, str(subfolder or "音效").lstrip("/").replace("..", "").replace("\\", "/"))
    return copy_sound_to_dest_dir(source_path, dest_dir)


def _files_same(path_a: str, path_b: str) -> bool:
    """快速判断两个文件内容是否相同（比较头尾各 4KB）"""
    try:
        sa = os.stat(path_a)
        sb = os.stat(path_b)
        if sa.st_size != sb.st_size:
            return False
        with open(path_a, "rb") as a, open(path_b, "rb") as b:
            if a.read(4096) != b.read(4096):
                return False
            if sa.st_size > 8192:
                a.seek(max(0, sa.st_size - 4096))
                b.seek(max(0, sb.st_size - 4096))
                if a.read(4096) != b.read(4096):
                    return False
        return True
    except Exception:
        return False


def _ensure_dir(dest_dir: str) -> Tuple[bool, str]:
    """创建目标目录，优先使用 Python 原生 os.makedirs，失败时回退到 /bin/mkdir -p"""
    target = os.path.normpath(str(dest_dir or ""))
    if not target or target == "/":
        return False, "invalid_path"
    if os.path.isdir(target):
        return True, ""

    try:
        os.makedirs(target, exist_ok=True)
        return True, ""
    except OSError as e:
        errno = getattr(e, "errno", None)
        if errno not in (1, 13):
            return False, str(e)

    try:
        result = subprocess.run(
            ["/bin/mkdir", "-p", target],
            capture_output=True,
            timeout=15,
        )
        if result.returncode == 0 and os.path.isdir(target):
            return True, ""
        stderr = (result.stderr or b"").decode("utf-8", errors="replace")
        return False, stderr.strip() or "mkdir failed"
    except Exception as e2:
        return False, str(e2)


def _copy_file(source_path: str, dest_path: str) -> Tuple[bool, str]:
    """复制文件，优先使用 shutil.copyfile，失败时回退到 /bin/cp"""
    try:
        shutil.copyfile(source_path, dest_path)
        return True, ""
    except Exception as e:
        errno = getattr(e, "errno", None)
        if errno not in (1, 13) and not isinstance(e, PermissionError):
            return False, str(e)

    try:
        result = subprocess.run(
            ["/bin/cp", source_path, dest_path],
            capture_output=True,
            timeout=30,
        )
        if result.returncode == 0 and os.path.exists(dest_path):
            return True, ""
        stderr = (result.stderr or b"").decode("utf-8", errors="replace")
        return False, stderr.strip() or "cp failed"
    except Exception as e2:
        return False, str(e2)


def _delete_file(target_path: str) -> Tuple[bool, str]:
    """删除文件，优先使用 os.remove，失败时回退到 /bin/rm -f"""
    try:
        os.remove(target_path)
        return True, ""
    except Exception as e:
        errno = getattr(e, "errno", None)
        if errno not in (1, 13) and not isinstance(e, PermissionError):
            return False, str(e)

    try:
        result = subprocess.run(
            ["/bin/rm", "-f", target_path],
            capture_output=True,
            timeout=10,
        )
        if result.returncode == 0 and not os.path.exists(target_path):
            return True, ""
        stderr = (result.stderr or b"").decode("utf-8", errors="replace")
        return False, stderr.strip() or "rm failed"
    except Exception as e2:
        return False, str(e2)


PERMISSION_HINT = (
    "macOS 可能未授予进程对该目录的访问权限。"
    "请用应用内「选择文件夹」重新选中该目录，"
    "或在系统设置→隐私与安全性→文件与文件夹中允许访问。"
)


def compute_copy_destination(
    source_path: str,
    dest_dir: str,
) -> Dict[str, Any]:
    """计算复制目标路径（不实际创建目录或复制文件）

    供前端通过 Tauri 原生 API 执行文件操作时使用，
    绕过 Python 进程的 macOS 沙盒权限限制。
    """
    if not source_path or not os.path.exists(source_path):
        return {"status": "error", "message": f"源文件不存在: {source_path}"}
    if not dest_dir:
        return {"status": "error", "message": "未设置目标目录"}

    filename = os.path.basename(source_path)
    dest_path = os.path.join(dest_dir, filename)

    if os.path.exists(dest_path):
        if _files_same(source_path, dest_path):
            return {
                "status": "reuse",
                "source_path": source_path,
                "dest_dir": dest_dir,
                "filename": filename,
                "dest_path": dest_path,
                "message": f"已复用项目内副本: {dest_path}",
            }
        name, ext = os.path.splitext(filename)
        counter = 1
        while True:
            candidate_name = f"{name}_{counter}{ext}"
            candidate_path = os.path.join(dest_dir, candidate_name)
            if not os.path.exists(candidate_path):
                filename = candidate_name
                dest_path = candidate_path
                break
            if _files_same(source_path, candidate_path):
                filename = candidate_name
                dest_path = candidate_path
                return {
                    "status": "reuse",
                    "source_path": source_path,
                    "dest_dir": dest_dir,
                    "filename": filename,
                    "dest_path": dest_path,
                    "message": f"已复用项目内副本: {dest_path}",
                }
            counter += 1

    return {
        "status": "success",
        "source_path": source_path,
        "dest_dir": dest_dir,
        "filename": filename,
        "dest_path": dest_path,
    }


def copy_sound_to_dest_dir(source_path: str, dest_dir: str, target_filename: str = "") -> Dict[str, Any]:
    """将音效文件复制到目标目录，自动处理重名冲突

    优先使用 Python 原生操作，失败时回退到系统命令。
    如果所有方式均失败，返回 need_client_copy 标记，
    让前端通过 Tauri 原生 API 完成文件操作。

    target_filename: 可选的目标文件名；若不传则默认使用 source_path 的 basename。
    调用方如果已在外部完成去重，应把去重后的文件名传入以避免重复计算。
    """
    if not source_path or not os.path.exists(source_path):
        return {"status": "error", "message": f"源文件不存在: {source_path}"}
    if not dest_dir:
        return {"status": "error", "message": "未设置目标目录"}

    filename = target_filename or os.path.basename(source_path)

    ok, err = _ensure_dir(dest_dir)
    if not ok:
        return {
            "status": "error",
            "message": f"无法创建项目音效目录: {dest_dir} ({err})。{PERMISSION_HINT}",
            "need_client_copy": True,
            "client_copy_params": compute_copy_destination(source_path, dest_dir),
        }

    dest_path = os.path.join(dest_dir, filename)
    if os.path.exists(dest_path):
        if _files_same(source_path, dest_path):
            return {
                "status": "success",
                "local_path": dest_path,
                "original_path": source_path,
                "filename": filename,
                "message": f"已复用项目内副本: {dest_path}",
            }
        name, ext = os.path.splitext(filename)
        counter = 1
        while True:
            candidate_name = f"{name}_{counter}{ext}"
            candidate_path = os.path.join(dest_dir, candidate_name)
            if not os.path.exists(candidate_path):
                filename = candidate_name
                dest_path = candidate_path
                break
            if _files_same(source_path, candidate_path):
                filename = candidate_name
                dest_path = candidate_path
                return {
                    "status": "success",
                    "local_path": dest_path,
                    "original_path": source_path,
                    "filename": filename,
                    "message": f"已复用项目内副本: {dest_path}",
                }
            counter += 1

    ok, err = _copy_file(source_path, dest_path)
    if not ok:
        return {
            "status": "error",
            "message": f"复制文件失败: {err}。{PERMISSION_HINT}",
            "need_client_copy": True,
            "client_copy_params": {
                "status": "success",
                "source_path": source_path,
                "dest_dir": dest_dir,
                "filename": filename,
                "dest_path": dest_path,
            },
        }

    return {
        "status": "success",
        "local_path": dest_path,
        "original_path": source_path,
        "filename": os.path.basename(dest_path),
        "message": f"已复制到项目本地文件夹: {dest_path}",
    }


def delete_local_sound_file(local_path: str) -> Dict[str, Any]:
    """删除项目本地文件夹中的音效文件"""
    if not local_path or not os.path.exists(local_path):
        return {"status": "error", "message": "文件不存在"}

    ok, err = _delete_file(local_path)
    if ok:
        return {"status": "success", "message": f"已删除: {os.path.basename(local_path)}"}
    return {
        "status": "error",
        "message": f"删除文件失败: {err}。{PERMISSION_HINT}",
        "need_client_delete": True,
        "client_delete_path": local_path,
    }


# ==================== 时间线音频轨道快照 ====================

def snapshot_audio_tracks(timeline, fps: float) -> Dict[str, Any]:
    """对当前时间线的所有音频轨道进行快照"""
    if not timeline:
        return {"timestamp": time.time(), "tracks": [], "total_clips": 0}

    tracks = []
    total_clips = 0

    audio_track_count = 0
    try:
        audio_track_count = timeline.GetTrackCount("audio") or 0
    except Exception:
        pass

    for track_idx in range(1, audio_track_count + 1):
        clips_info = []
        try:
            clips = timeline.GetItemListInTrack("audio", track_idx)
        except Exception:
            clips = None

        if clips:
            for clip in clips:
                mp_item = clip.GetMediaPoolItem()
                clip_name = clip.GetName() or ""
                clip_path = mp_item.GetClipProperty("File Path") if mp_item else ""
                clip_start = clip.GetStart()
                clip_end = clip.GetEnd()

                clips_info.append({
                    "clip_name": clip_name,
                    "clip_path": clip_path,
                    "start_frame": clip_start,
                    "end_frame": clip_end,
                    "duration_frames": clip_end - clip_start,
                    "media_id": mp_item.GetMediaId() if mp_item else None,
                })

        total_clips += len(clips_info)
        tracks.append({
            "track_index": track_idx,
            "track_name": f"A{track_idx}",
            "clip_count": len(clips_info),
            "clips": clips_info,
        })

    return {
        "timestamp": time.time(),
        "tracks": tracks,
        "total_clips": total_clips,
        "track_count": audio_track_count,
    }


def get_timeline_clip_paths(timeline, fps: float) -> set:
    """获取时间线上所有音频 clip 的文件路径集合"""
    snapshot = snapshot_audio_tracks(timeline, fps)
    paths = set()
    for track in snapshot.get("tracks", []):
        for clip in track.get("clips", []):
            if clip.get("clip_path"):
                paths.add(os.path.basename(clip["clip_path"]))
    return paths


# ==================== 波形数据生成 ====================

def _get_ffmpeg_executable() -> str:
    try:
        import imageio_ffmpeg  # type: ignore
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe:
            return exe
    except Exception:
        pass
    return "ffmpeg"


def _get_ffprobe_executable() -> str:
    try:
        import imageio_ffmpeg  # type: ignore
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe:
            d = os.path.dirname(exe)
            probe = os.path.join(d, "ffprobe")
            if os.path.isfile(probe):
                return probe
            if os.name == "nt":
                probe = os.path.join(d, "ffprobe.exe")
                if os.path.isfile(probe):
                    return probe
    except Exception:
        pass
    return "ffprobe"


def get_audio_file_metadata(file_path: str) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    try:
        ffprobe = _get_ffprobe_executable()
        proc = subprocess.run(
            [ffprobe, "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", file_path],
            capture_output=True, timeout=8
        )
        if proc.returncode != 0:
            return result
        info = json.loads(proc.stdout)
        fmt = info.get("format", {})
        dur = fmt.get("duration")
        if dur is not None:
            try:
                result["duration"] = float(dur)
            except (TypeError, ValueError):
                pass
        streams = info.get("streams", [])
        for s in streams:
            if s.get("codec_type") == "audio":
                sr = s.get("sample_rate")
                if sr is not None:
                    try:
                        result["sample_rate"] = int(sr)
                    except (TypeError, ValueError):
                        pass
                ch = s.get("channels")
                if ch is not None:
                    try:
                        result["channels"] = int(ch)
                    except (TypeError, ValueError):
                        pass
                break
    except FileNotFoundError:
        pass
    except subprocess.TimeoutExpired:
        pass
    except Exception:
        pass
    return result

def get_audio_tooling_status() -> Dict[str, Any]:
    exe = _get_ffmpeg_executable()
    imageio_installed = False
    try:
        import imageio_ffmpeg  # type: ignore
        _ = imageio_ffmpeg.get_ffmpeg_exe()
        imageio_installed = True
    except Exception:
        imageio_installed = False

    try:
        result = subprocess.run([exe, "-version"], capture_output=True, timeout=8)
        ok = result.returncode == 0
    except FileNotFoundError:
        ok = False
    except Exception:
        ok = False

    return {
        "ffmpeg_available": ok,
        "ffmpeg_path": exe,
        "imageio_ffmpeg_installed": imageio_installed,
    }


def _preview_cache_dir() -> str:
    root = os.path.join(tempfile.gettempdir(), "QuickClip", "sfx-preview")
    os.makedirs(root, exist_ok=True)
    return root


def _preview_cache_stats() -> Dict[str, Any]:
    root = _preview_cache_dir()
    total = 0
    count = 0
    for name in os.listdir(root):
        if not name.endswith(".wav"):
            continue
        p = os.path.join(root, name)
        try:
            st = os.stat(p)
            total += st.st_size
            count += 1
        except Exception:
            pass
    return {"dir": root, "bytes": total, "count": count}


def prune_preview_cache(max_cache_mb: int = 512) -> None:
    if max_cache_mb <= 0:
        return
    root = _preview_cache_dir()
    max_bytes = int(max_cache_mb) * 1024 * 1024
    items = []
    total = 0
    for name in os.listdir(root):
        if not name.endswith(".wav"):
            continue
        p = os.path.join(root, name)
        try:
            st = os.stat(p)
            total += st.st_size
            items.append((st.st_mtime, p, st.st_size))
        except Exception:
            pass
    if total <= max_bytes:
        return
    items.sort(key=lambda x: x[0])
    for _, p, size in items:
        if total <= max_bytes:
            break
        try:
            os.remove(p)
            total -= size
        except Exception:
            pass


def clear_preview_cache() -> None:
    root = _preview_cache_dir()
    for name in os.listdir(root):
        if not name.endswith(".wav"):
            continue
        try:
            os.remove(os.path.join(root, name))
        except Exception:
            pass


def _clear_waveform_cache_library(library_paths: list, cache_dir_name: str = ".sfx_cache") -> int:
    """Remove waveform cache directories from library paths. Returns count removed."""
    deleted = 0
    for lib_path in library_paths:
        waveforms_dir = os.path.join(lib_path, cache_dir_name, "waveforms")
        if os.path.isdir(waveforms_dir):
            try:
                shutil.rmtree(waveforms_dir)
                deleted += 1
            except OSError:
                pass
    return deleted


def clear_waveform_cache(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    library_deleted_dirs = 0
    if config is None:
        config = load_sound_effects_config()
    library_path = (config or {}).get("library_path", "")
    cache_dir_name = str((config or {}).get("waveform_cache_library_dir", ".sfx_cache") or ".sfx_cache")
    if library_path:
        library_deleted_dirs = _clear_waveform_cache_library([library_path], cache_dir_name=cache_dir_name)
    return {"library_cache_dirs_removed": library_deleted_dirs}


def get_sound_library_cache_stats(library_path: str, cache_dir_name: str = ".sfx_cache") -> Dict[str, Any]:
    """获取音效库波形缓存的磁盘用量"""
    waveforms_dir = os.path.join(library_path, cache_dir_name, "waveforms")
    total_bytes = 0
    file_count = 0
    if os.path.isdir(waveforms_dir):
        for root, dirs, files in os.walk(waveforms_dir):
            for f in files:
                try:
                    total_bytes += os.path.getsize(os.path.join(root, f))
                    file_count += 1
                except OSError:
                    pass
    return {
        "waveform_cache_bytes": total_bytes,
        "waveform_cache_files": file_count,
        "cache_dir": waveforms_dir,
    }


def ensure_preview_wav(file_path: str, sample_rate: int = 44100, max_cache_mb: int = 512) -> Dict[str, Any]:
    if not os.path.exists(file_path):
        return {"status": "error", "message": "文件不存在"}

    ext = os.path.splitext(file_path)[1].lower()
    if ext == ".wav":
        return {"status": "success", "path": file_path}

    try:
        prune_preview_cache(max_cache_mb=max_cache_mb)
        stat = os.stat(file_path)
        key_src = f"{file_path}|{stat.st_mtime_ns}|{stat.st_size}".encode("utf-8")
        key = hashlib.sha1(key_src).hexdigest()
        out_path = os.path.join(_preview_cache_dir(), f"{key}.wav")
        if os.path.exists(out_path) and os.path.getsize(out_path) > 44:
            return {"status": "success", "path": out_path}

        ffmpeg = _get_ffmpeg_executable()
        result = subprocess.run(
            [
                ffmpeg,
                "-i",
                file_path,
                "-ac",
                "2",
                "-ar",
                str(sample_rate),
                "-acodec",
                "pcm_s16le",
                "-y",
                out_path,
            ],
            capture_output=True,
            timeout=60,
        )
        if result.returncode != 0 or not os.path.exists(out_path):
            return {"status": "error", "message": "ffmpeg 解码失败"}
        prune_preview_cache(max_cache_mb=max_cache_mb)
        return {"status": "success", "path": out_path}
    except FileNotFoundError:
        return {"status": "error", "message": "需要 ffmpeg 来解码此格式"}
    except Exception as e:
        return {"status": "error", "message": f"预览音频生成失败: {str(e)}"}


def generate_waveform_data(file_path: str, samples: int = 200, max_cache_mb: int = 512) -> Dict[str, Any]:
    """
    生成音效文件的波形数据（用于前端 canvas 渲染）

    Args:
        file_path: 音效文件路径
        samples: 采样点数（前端渲染的像素宽度）

    Returns:
        {status, data: [min, max, min, max, ...], duration, sample_rate}
    """
    if not os.path.exists(file_path):
        return {"status": "error", "message": "文件不存在"}

    ext = os.path.splitext(file_path)[1].lower()

    # 只支持 WAV 格式的原生解析
    if ext == '.wav':
        return _generate_waveform_wav(file_path, samples)

    # 非 WAV 格式：尝试使用 ffmpeg 转换后解析
    if max_cache_mb <= 0:
        return _generate_waveform_ffmpeg(file_path, samples)
    preview = ensure_preview_wav(file_path, sample_rate=22050, max_cache_mb=max_cache_mb)
    if preview.get("status") != "success":
        return preview
    return _generate_waveform_wav(preview["path"], samples)


def _read_pcm_sample(frame: bytes, bytes_per_sample: int, audio_format: int) -> Optional[float]:
    if len(frame) < bytes_per_sample:
        return None
    if audio_format == 3 and bytes_per_sample == 4:
        return max(-1.0, min(1.0, float(struct.unpack('<f', frame[:4])[0])))
    if bytes_per_sample == 1:
        return (frame[0] - 128) / 128.0
    if bytes_per_sample == 2:
        return struct.unpack('<h', frame[:2])[0] / 32768.0
    if bytes_per_sample == 3:
        raw = int.from_bytes(frame[:3], byteorder='little', signed=False)
        if raw & 0x800000:
            raw -= 0x1000000
        return raw / 8388608.0
    if bytes_per_sample == 4:
        return struct.unpack('<i', frame[:4])[0] / 2147483648.0
    return None


def _generate_waveform_wav(file_path: str, samples: int) -> Dict[str, Any]:
    """解析 WAV 文件生成波形数据"""
    try:
        with open(file_path, 'rb') as f:
            # 读取 WAV 头
            riff = f.read(4)
            if riff != b'RIFF':
                return _generate_waveform_ffmpeg(file_path, samples)

            f.read(4)  # file size
            wave = f.read(4)
            if wave != b'WAVE':
                return _generate_waveform_ffmpeg(file_path, samples)

            # 解析 fmt chunk
            fmt_data = None
            data_chunk_offset = None
            data_chunk_size = 0
            while True:
                chunk_id = f.read(4)
                if not chunk_id or len(chunk_id) < 4:
                    return _generate_waveform_ffmpeg(file_path, samples)
                chunk_size_raw = f.read(4)
                if not chunk_size_raw or len(chunk_size_raw) < 4:
                    return _generate_waveform_ffmpeg(file_path, samples)
                chunk_size = struct.unpack('<I', chunk_size_raw)[0]
                if chunk_id == b'fmt ':
                    fmt_data = f.read(chunk_size)
                    if len(fmt_data) < chunk_size:
                        return _generate_waveform_ffmpeg(file_path, samples)
                elif chunk_id == b'data':
                    data_chunk_offset = f.tell()
                    data_chunk_size = chunk_size
                    break
                else:
                    skipped = f.read(chunk_size)
                    if len(skipped) < chunk_size:
                        return _generate_waveform_ffmpeg(file_path, samples)

            if not fmt_data or data_chunk_offset is None:
                return _generate_waveform_ffmpeg(file_path, samples)

            audio_format = struct.unpack('<H', fmt_data[0:2])[0]
            num_channels = struct.unpack('<H', fmt_data[2:4])[0]
            sample_rate = struct.unpack('<I', fmt_data[4:8])[0]
            bits_per_sample = struct.unpack('<H', fmt_data[14:16])[0]

            if audio_format not in {1, 3}:  # PCM / IEEE float
                return _generate_waveform_ffmpeg(file_path, samples)

            bytes_per_sample = bits_per_sample // 8
            f.seek(data_chunk_offset)

            # 只读取 data chunk 声明的实际音频数据，避免读到末尾的 LIST/id3 等元数据块
            pcm_data = f.read(data_chunk_size)

        # 解析采样数据
        total_samples = len(pcm_data) // (bytes_per_sample * num_channels)
        if total_samples == 0:
            return {"status": "error", "message": "空音频文件"}

        waveform = []
        
        if total_samples < samples:
            # 如果音频极短（比如只有几十个采样点），则插值/重复拉伸，填满整个渲染宽度
            for i in range(samples):
                # 映射回原始数据的索引
                orig_idx = int((i / samples) * total_samples)
                j = orig_idx * bytes_per_sample * num_channels
                val = _read_pcm_sample(pcm_data[j:j + bytes_per_sample], bytes_per_sample, audio_format)
                if val is None:
                    val = 0.0
                    
                waveform.append(round(val, 4)) # min
                waveform.append(round(val, 4)) # max
        else:
            # 正常音频，进行下采样压缩
            samples_per_pixel = total_samples // samples

            for i in range(samples):
                start = i * samples_per_pixel * bytes_per_sample * num_channels
                end = min(start + samples_per_pixel * bytes_per_sample * num_channels, len(pcm_data))

                min_val = 1.0
                max_val = -1.0

                for j in range(start, end - bytes_per_sample + 1, bytes_per_sample * num_channels):
                    # 只取第一个声道
                    val = _read_pcm_sample(pcm_data[j:j + bytes_per_sample], bytes_per_sample, audio_format)
                    if val is None:
                        continue

                    if val < min_val:
                        min_val = val
                    if val > max_val:
                        max_val = val

                if min_val > max_val:
                    min_val = 0.0
                    max_val = 0.0

                waveform.append(round(min_val, 4))
                waveform.append(round(max_val, 4))

        duration = total_samples / sample_rate if sample_rate > 0 else 0

        return {
            "status": "success",
            "data": waveform,
            "duration": round(duration, 2),
            "sample_rate": sample_rate,
            "samples": samples,
        }

    except Exception as e:
        # 回退到 ffmpeg
        return _generate_waveform_ffmpeg(file_path, samples)


def _generate_waveform_ffmpeg(file_path: str, samples: int) -> Dict[str, Any]:
    """使用 ffmpeg 解码后生成波形数据（支持所有格式）"""
    try:
        # 使用 ffmpeg 转为临时 WAV
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
            tmp_path = tmp.name

        try:
            ffmpeg = _get_ffmpeg_executable()
            result = subprocess.run(
                [ffmpeg, '-i', file_path, '-ac', '1', '-ar', '22050', '-acodec', 'pcm_s16le', '-y', tmp_path],
                capture_output=True, timeout=30
            )
            if result.returncode != 0:
                return {"status": "error", "message": "ffmpeg 解码失败"}

            wav_result = _generate_waveform_wav(tmp_path, samples)
            return wav_result
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    except FileNotFoundError:
        return {"status": "error", "message": "需要 ffmpeg 来解码此格式"}
    except Exception as e:
        return {"status": "error", "message": f"波形生成失败: {str(e)}"}


# ==================== 文件夹层级映射 ====================

def compute_davinci_target_folder(
    source_relative_path: str,
    davinci_base_folder: str,
    folder_depth: int = 1,
    direction: str = "forward",
) -> str:
    """
    根据音效文件在音效库中的相对路径和映射层级深度，计算在达芬奇媒体池中的目标文件夹。

    例如：
    - 音效库路径: /Volumes/SFX/HIT/Big/boom.wav
    - 相对路径: HIT/Big/boom.wav
    - davinci_base_folder: "音效"
    - folder_depth=1 → "音效/HIT"（只映射第一层文件夹）
    - folder_depth=2 → "音效/HIT/Big"（映射两层）
    - folder_depth=0 → "音效"（不映射任何层级，全部平铺）

    Args:
        source_relative_path: 音效文件相对于音效库根目录的路径（如 "HIT/Big/boom.wav"）
        davinci_base_folder: 达芬奇媒体池中的基础文件夹（如 "音效" 或 "音频/音效"）
        folder_depth: 映射层级深度

    Returns:
        达芬奇媒体池中的目标文件夹路径
    """
    if folder_depth <= 0:
        return davinci_base_folder

    # 提取文件夹部分（去掉文件名）
    parts = source_relative_path.replace("\\", "/").split("/")
    if len(parts) <= 1:
        # 文件直接在根目录下
        return davinci_base_folder

    # 文件夹层级（不含文件名）
    folder_parts = parts[:-1]

    d = str(direction or "forward").lower()
    if d == "reverse":
        mapped_parts = folder_parts[-folder_depth:]
    else:
        mapped_parts = folder_parts[:folder_depth]

    # 拼接：base_folder/层级1/层级2/...
    if davinci_base_folder:
        return davinci_base_folder + "/" + "/".join(mapped_parts)
    else:
        return "/".join(mapped_parts)


def compute_local_save_subpath(
    source_relative_path: str,
    folder_depth: int = 1,
    direction: str = "forward",
) -> str:
    """
    根据映射层级深度，计算在项目本地保存时的子路径。

    例如：
    - source_relative_path: "HIT/Big/boom.wav", folder_depth=1 → "HIT/boom.wav"
    - source_relative_path: "HIT/Big/boom.wav", folder_depth=2 → "HIT/Big/boom.wav"
    - source_relative_path: "HIT/Big/boom.wav", folder_depth=0 → "boom.wav"

    Args:
        source_relative_path: 音效文件相对于音效库根目录的路径
        folder_depth: 映射层级深度

    Returns:
        项目本地保存的子路径
    """
    parts = source_relative_path.replace("\\", "/").split("/")
    filename = parts[-1]

    if folder_depth <= 0 or len(parts) <= 1:
        return filename

    folder_parts_all = parts[:-1]
    d = str(direction or "forward").lower()
    if d == "reverse":
        folder_parts = folder_parts_all[-folder_depth:]
    else:
        folder_parts = folder_parts_all[:folder_depth]
    return "/".join(folder_parts) + "/" + filename
