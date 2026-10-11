import json
import os
from collections import Counter
from datetime import datetime
from typing import Any, Dict, List, Optional

from folder_config_manager import load_folder_config

PROJECT_REGISTRY_FILE = os.path.join(
    os.path.dirname(os.path.dirname(__file__)),
    "data",
    "project_registry.json",
)

EXPORT_KEYWORDS = ("输出", "导出", "交付", "render", "export", "deliver")


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _default_registry() -> Dict[str, Any]:
    return {"projects": {}}


def normalize_path(path: Optional[str]) -> str:
    if not path:
        return ""
    return os.path.normpath(os.path.abspath(os.path.expanduser(path)))


def _deep_merge(base: Dict[str, Any], updates: Dict[str, Any]) -> Dict[str, Any]:
    merged = dict(base)
    for key, value in updates.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_project_registry() -> Dict[str, Any]:
    if os.path.exists(PROJECT_REGISTRY_FILE):
        try:
            with open(PROJECT_REGISTRY_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict) and "projects" in data:
                    return data
        except Exception:
            pass
    return _default_registry()


def save_project_registry(registry: Dict[str, Any]) -> bool:
    try:
        os.makedirs(os.path.dirname(PROJECT_REGISTRY_FILE), exist_ok=True)
        with open(PROJECT_REGISTRY_FILE, "w", encoding="utf-8") as f:
            json.dump(registry, f, ensure_ascii=False, indent=2)
        return True
    except Exception:
        return False


def get_project_record(project_name: str) -> Dict[str, Any]:
    registry = load_project_registry()
    return registry.get("projects", {}).get(project_name, {})


def infer_export_dir(local_path: Optional[str], local_folders: Optional[List[str]] = None) -> str:
    project_path = normalize_path(local_path)
    if not project_path:
        return ""

    if local_folders is None:
        folder_config = load_folder_config()
        local_folders = folder_config.get("local_folders", [])

    preferred = [folder for folder in (local_folders or []) if any(word in folder.lower() for word in EXPORT_KEYWORDS)]
    for folder in preferred:
        candidate = normalize_path(os.path.join(project_path, folder))
        if os.path.exists(candidate):
            return candidate

    if preferred:
        return normalize_path(os.path.join(project_path, preferred[0]))

    try:
        children = [name for name in os.listdir(project_path) if os.path.isdir(os.path.join(project_path, name))]
    except Exception:
        children = []

    dynamic_match = next((name for name in children if any(word in name.lower() for word in EXPORT_KEYWORDS)), None)
    if dynamic_match:
        return normalize_path(os.path.join(project_path, dynamic_match))

    return project_path


def detect_structure_info(local_path: Optional[str], local_folders: Optional[List[str]] = None) -> Dict[str, Any]:
    project_path = normalize_path(local_path)
    if not project_path or not os.path.exists(project_path):
        return {"is_standard": False, "matched_folders": [], "missing_folders": []}

    if local_folders is None:
        folder_config = load_folder_config()
        local_folders = folder_config.get("local_folders", [])

    matched: List[str] = []
    missing: List[str] = []

    for folder in local_folders or []:
        full_path = os.path.join(project_path, folder)
        if os.path.exists(full_path):
            matched.append(folder)
        else:
            missing.append(folder)

    threshold = min(3, max(1, len(local_folders or []) // 4))
    return {
        "is_standard": len(matched) >= threshold,
        "matched_folders": matched,
        "missing_folders": missing,
    }


def update_project_record(project_name: str, updates: Dict[str, Any]) -> Dict[str, Any]:
    registry = load_project_registry()
    projects = registry.setdefault("projects", {})
    current = projects.get(project_name, {})

    merged = _deep_merge(current, updates)
    merged["project_name"] = project_name
    merged["updated_at"] = _now_iso()
    merged.setdefault("created_at", current.get("created_at") or merged["updated_at"])

    local_path = normalize_path(merged.get("local_path"))
    if local_path:
        merged["local_path"] = local_path
        folder_config = load_folder_config()
        local_folders = folder_config.get("local_folders", [])
        merged["default_export_dir"] = infer_export_dir(local_path, local_folders)
        merged["structure"] = detect_structure_info(local_path, local_folders)

    projects[project_name] = merged
    if merged.get("local_path"):
        registry["active_project"] = {"project_name": project_name, "local_path": merged["local_path"]}
    save_project_registry(registry)
    return merged


def append_project_history(project_name: str, history_key: str, item: Dict[str, Any], limit: int = 10) -> Dict[str, Any]:
    current = get_project_record(project_name)
    history = list(current.get(history_key, []))
    payload = dict(item)
    payload.setdefault("updated_at", _now_iso())
    history.insert(0, payload)
    current[history_key] = history[:limit]
    return update_project_record(project_name, current)


def choose_root_from_media_paths(paths: List[str], local_folders: Optional[List[str]] = None) -> str:
    normalized = [normalize_path(p) for p in paths if p]
    parents = [os.path.dirname(p) for p in normalized]
    parents = [p for p in parents if p]
    if not parents:
        return ""

    if local_folders is None:
        folder_config = load_folder_config()
        local_folders = folder_config.get("local_folders", [])

    top_folder_names = []
    for folder in local_folders or []:
        first = folder.replace("\\", "/").split("/")[0].strip()
        if first:
            top_folder_names.append(first)

    candidates: List[str] = []
    for parent in parents:
        parts = [part for part in parent.split(os.sep) if part]
        for top_name in top_folder_names:
            if top_name in parts:
                idx = parts.index(top_name)
                if idx > 0:
                    prefix = os.sep + os.path.join(*parts[:idx]) if parent.startswith(os.sep) else os.path.join(*parts[:idx])
                    candidates.append(normalize_path(prefix))
                break

    if candidates:
        return Counter(candidates).most_common(1)[0][0]

    try:
        return normalize_path(os.path.commonpath(parents))
    except Exception:
        return parents[0]
