import os
import shutil
import traceback
from typing import Any, Dict, List, Optional, Set, Tuple

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from project_registry import get_project_record

router = APIRouter(prefix="/api/pack", tags=["pack"])

MAX_PARSE_DEPTH = 5


def _safe_call(fn, default=None, label: str = ""):
    try:
        return fn()
    except Exception as exc:
        if label:
            print(f"[PACK] _safe_call 异常 [{label}]: {exc}")
        return default


def _normalize_path(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    value = value.strip()
    if not value:
        return ""
    if value.startswith("Composition://"):
        return ""
    return value


def _normalize_name(value: str) -> str:
    if not isinstance(value, str):
        return ""
    return "".join(ch.lower() for ch in value.strip() if ch not in " \t\r\n-_")


def _looks_like_media_path(value: str) -> bool:
    if not value:
        return False
    if "/" in value or "\\" in value:
        return True
    lowered = value.lower()
    if "%" in lowered or "#" in lowered:
        return True
    base_name = os.path.basename(lowered)
    _, ext = os.path.splitext(base_name)
    if ext and len(ext) <= 8:
        return True
    known_exts = (
        ".mov", ".mp4", ".mxf", ".avi", ".wav", ".mp3", ".aif", ".aiff",
        ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".exr", ".dpx", ".braw", ".r3d"
    )
    return lowered.endswith(known_exts)


def _flatten_possible_strings(value: Any) -> List[str]:
    results: List[str] = []
    if isinstance(value, str):
        normalized = _normalize_path(value)
        if normalized:
            results.append(normalized)
        return results
    if isinstance(value, (list, tuple, set)):
        for item in value:
            results.extend(_flatten_possible_strings(item))
        return results
    if isinstance(value, dict):
        for item in value.values():
            results.extend(_flatten_possible_strings(item))
        return results
    return results


def _safe_media_pool_item(clip):
    return _safe_call(lambda: clip.GetMediaPoolItem(), None, label="GetMediaPoolItem")


def _safe_clip_property(media_pool_item, key: str, default: str = "") -> str:
    if not media_pool_item:
        return default
    value = _safe_call(lambda: media_pool_item.GetClipProperty(key), default, label=f"GetClipProperty.{key}")
    if isinstance(value, dict):
        return default
    return value or default


def _safe_clip_property_map(media_pool_item) -> Dict[str, Any]:
    if not media_pool_item:
        return {}
    value = _safe_call(lambda: media_pool_item.GetClipProperty(), {}, label="GetClipProperty.map")
    return value if isinstance(value, dict) else {}


def _safe_item_property_map(clip) -> Dict[str, Any]:
    value = _safe_call(lambda: clip.GetProperty(), {}, label="GetProperty.map")
    return value if isinstance(value, dict) else {}


def _safe_track_items(timeline, track_type: str, track_index: int):
    return _safe_call(
        lambda: timeline.GetItemListInTrack(track_type, track_index),
        [],
        label=f"GetItemListInTrack.{track_type}.{track_index}"
    ) or []


def _safe_track_type_and_index(clip, fallback_track_type: str = "", fallback_track_index: int = 0) -> Tuple[str, int]:
    result = _safe_call(lambda: clip.GetTrackTypeAndIndex(), None, label="GetTrackTypeAndIndex")
    if isinstance(result, (list, tuple)) and len(result) >= 2:
        track_type = str(result[0] or fallback_track_type)
        try:
            track_index = int(result[1] or fallback_track_index)
        except Exception:
            track_index = fallback_track_index
        return track_type, track_index
    return fallback_track_type, fallback_track_index


def _build_timeline_item_key(
    clip,
    timeline_name: str,
    depth: int,
    track_type: str,
    track_index: int,
    start: int,
    end: int,
) -> str:
    unique_id = _safe_call(lambda: clip.GetUniqueId(), "", label="GetUniqueId") or ""
    if unique_id:
        return f"{timeline_name}:{unique_id}"

    clip_name = _safe_call(lambda: clip.GetName(), "", label="GetName") or "未命名片段"
    media_pool_item = _safe_media_pool_item(clip)
    clip_path = _normalize_path(_safe_clip_property(media_pool_item, "File Path", ""))
    return f"{timeline_name}:{depth}:{track_type}:{track_index}:{start}:{end}:{clip_name}:{clip_path}"


def _find_media_pool_path_by_name(project, file_name: str) -> str:
    if not project or not isinstance(file_name, str):
        return ""

    target_name = os.path.basename(file_name.strip())
    if not target_name:
        return ""

    media_pool = _safe_call(lambda: project.GetMediaPool(), None)
    root_folder = _safe_call(lambda: media_pool.GetRootFolder(), None) if media_pool else None
    if not root_folder:
        return ""

    def walk(folder) -> str:
        clips = _safe_call(lambda: folder.GetClipList(), []) or []
        for media_item in clips:
            media_path = _normalize_path(_safe_clip_property(media_item, "File Path", ""))
            media_name = _safe_call(lambda: media_item.GetName(), "") or ""
            if os.path.basename(media_path) == target_name or media_name == target_name:
                return media_path

        sub_folders = _safe_call(lambda: folder.GetSubFolderList(), []) or []
        for sub_folder in sub_folders:
            found = walk(sub_folder)
            if found:
                return found
        return ""

    return walk(root_folder)


def _resolve_media_reference(candidate: str, project, known_paths: Set[str]) -> str:
    normalized = _normalize_path(candidate)
    if not normalized:
        return ""

    if os.path.exists(normalized):
        return normalized

    if "/" in normalized or "\\" in normalized:
        return normalized

    target_name = os.path.basename(normalized)
    if not target_name:
        return ""

    for known_path in known_paths:
        if os.path.basename(known_path) == target_name:
            return known_path

    return _find_media_pool_path_by_name(project, target_name)


def _extract_fusion_tool_paths(tool, project, known_paths: Set[str]) -> List[str]:
    candidates: Set[str] = set()
    getters: List[Tuple[str, Any]] = [
        ("Clip", lambda: tool.GetInput("Clip")),
        ("Filename", lambda: tool.GetInput("Filename")),
        ("File", lambda: tool.GetInput("File")),
        ("MediaPath", lambda: tool.GetInput("MediaPath")),
        ("OutputFilename", lambda: tool.GetInput("OutputFilename")),
    ]

    for _, getter in getters:
        raw_value = _safe_call(getter, None)
        for path in _flatten_possible_strings(raw_value):
            if _looks_like_media_path(path):
                candidates.add(path)

    attrs = _safe_call(lambda: tool.GetAttrs(), {}) or {}
    for path in _flatten_possible_strings(attrs):
        if _looks_like_media_path(path):
            candidates.add(path)

    resolved_paths: Set[str] = set()
    for candidate in candidates:
        resolved = _resolve_media_reference(candidate, project, known_paths)
        if resolved:
            resolved_paths.add(resolved)

    return sorted(resolved_paths)


def _collect_fusion_media_from_host(host, project, known_paths: Set[str]) -> List[str]:
    fusion_paths: Set[str] = set()
    fusion_count = _safe_call(lambda: int(host.GetFusionCompCount() or 0), 0)
    if fusion_count <= 0:
        return []

    for comp_index in range(1, fusion_count + 1):
        comp = _safe_call(lambda idx=comp_index: host.GetFusionCompByIndex(idx), None)
        if not comp:
            continue

        tool_map = _safe_call(lambda: comp.GetToolList(), None)
        if not isinstance(tool_map, dict):
            continue

        for tool in tool_map.values():
            for path in _extract_fusion_tool_paths(tool, project, known_paths):
                fusion_paths.add(path)

    return sorted(fusion_paths)


def _collect_fusion_media(clip, media_pool_item, project, known_paths: Set[str]) -> List[str]:
    """尽量收集 Fusion 依赖素材；失败时忽略，不让整体扫描报错。"""
    fusion_paths: Set[str] = set()
    for host in (clip, media_pool_item):
        if not host or not hasattr(host, "GetFusionCompCount"):
            continue
        for path in _collect_fusion_media_from_host(host, project, known_paths):
            fusion_paths.add(path)
    return sorted(fusion_paths)


def _infer_clip_type(clip, media_pool_item) -> str:
    for key in ("Type", "Clip Type"):
        value = _safe_clip_property(media_pool_item, key, "")
        if value:
            return str(value)

    clip_type = _safe_call(lambda: clip.GetProperty("Type"), "")
    if isinstance(clip_type, str) and clip_type:
        return clip_type
    return "Clip"


def _extract_possible_timeline_names(clip, media_pool_item) -> List[str]:
    candidates: List[str] = []
    raw_candidates: List[Any] = [
        _safe_call(lambda: clip.GetName(), ""),
        _safe_call(lambda: media_pool_item.GetName(), "") if media_pool_item else "",
        _safe_call(lambda: clip.GetProperty("Name"), ""),
        _safe_call(lambda: clip.GetProperty("Clip Name"), ""),
        _safe_call(lambda: clip.GetProperty("Timeline"), ""),
        _safe_call(lambda: clip.GetProperty("Timeline Name"), ""),
    ]

    media_properties = _safe_clip_property_map(media_pool_item)
    for key, value in media_properties.items():
        lowered_key = str(key).lower()
        if "timeline" in lowered_key or lowered_key in {"name", "clip name"}:
            raw_candidates.append(value)

    item_properties = _safe_item_property_map(clip)
    for key, value in item_properties.items():
        lowered_key = str(key).lower()
        if "timeline" in lowered_key or lowered_key in {"name", "clip name"}:
            raw_candidates.append(value)

    seen: Set[str] = set()
    for raw_value in raw_candidates:
        if not isinstance(raw_value, str):
            continue
        value = raw_value.strip()
        if not value or _looks_like_media_path(value):
            continue
        normalized = _normalize_name(value)
        if normalized and normalized not in seen:
            seen.add(normalized)
            candidates.append(value)

    return candidates


def _find_timeline_by_name(project, current_timeline_name: str, lookup_names: List[str]) -> Optional[Any]:
    if not project or not lookup_names:
        return None

    normalized_lookup_names = {_normalize_name(name) for name in lookup_names if _normalize_name(name)}
    timeline_count = _safe_call(lambda: int(project.GetTimelineCount() or 0), 0)
    fallback: Optional[Any] = None
    fuzzy_fallback: Optional[Any] = None

    for idx in range(1, timeline_count + 1):
        candidate = _safe_call(lambda i=idx: project.GetTimelineByIndex(i), None)
        if not candidate:
            continue
        candidate_name = _safe_call(lambda c=candidate: c.GetName(), "")
        if candidate_name == current_timeline_name:
            continue
        normalized_candidate_name = _normalize_name(candidate_name)
        if candidate_name in lookup_names or normalized_candidate_name in normalized_lookup_names:
            return candidate

        if any(
            normalized_candidate_name and lookup_name and (
                normalized_candidate_name in lookup_name or lookup_name in normalized_candidate_name
            )
            for lookup_name in normalized_lookup_names
        ):
            fuzzy_fallback = fuzzy_fallback or candidate
        elif any(name.lower() == candidate_name.lower() for name in lookup_names):
            fallback = fallback or candidate

    return fallback or fuzzy_fallback


def _is_compound_like(clip_type: str) -> bool:
    clip_type_lower = str(clip_type or "").lower()
    return any(token in clip_type_lower for token in ("compound", "timeline", "subtimeline"))


def _is_fusion_like(clip_type: str, clip) -> bool:
    clip_type_lower = str(clip_type or "").lower()
    if "fusion" in clip_type_lower:
        return True
    fusion_count = _safe_call(lambda: int(clip.GetFusionCompCount() or 0), 0)
    return fusion_count > 0


def _clip_overlaps_selected_window(parent_clip, child_clip: Dict[str, Any]) -> bool:
    parent_source_start = _safe_call(lambda: parent_clip.GetSourceStartFrame(), 0) or 0
    parent_source_end = _safe_call(lambda: parent_clip.GetSourceEndFrame(), 0) or 0

    if parent_source_end <= parent_source_start:
        parent_duration = _safe_call(lambda: parent_clip.GetDuration(), 0) or 0
        parent_source_end = parent_source_start + parent_duration

    child_start = child_clip.get("start", 0)
    child_end = child_clip.get("end", 0)
    child_timeline_start = child_clip.get("timeline_start_frame", 0) or 0
    offset_start = child_start - child_timeline_start
    offset_end = child_end - child_timeline_start

    return offset_end > parent_source_start and offset_start < parent_source_end


def _collect_linked_items(
    clip,
    current_item_key: str,
    timeline_name: str,
    depth: int,
    fallback_track_type: str,
    fallback_track_index: int,
) -> List[Dict[str, Any]]:
    linked_items = _safe_call(lambda: clip.GetLinkedItems(), []) or []
    if isinstance(linked_items, dict):
        linked_iterable = linked_items.values()
    elif isinstance(linked_items, (list, tuple, set)):
        linked_iterable = linked_items
    else:
        linked_iterable = []

    collected: List[Dict[str, Any]] = []
    seen_keys: Set[str] = set()
    for linked_clip in linked_iterable:
        if not linked_clip:
            continue
        linked_track_type, linked_track_index = _safe_track_type_and_index(
            linked_clip,
            fallback_track_type=fallback_track_type,
            fallback_track_index=fallback_track_index,
        )
        linked_start = _safe_call(lambda: linked_clip.GetStart(), 0) or 0
        linked_end = _safe_call(lambda: linked_clip.GetEnd(), 0) or 0
        linked_item_key = _build_timeline_item_key(
            linked_clip,
            timeline_name=timeline_name,
            depth=depth,
            track_type=linked_track_type,
            track_index=linked_track_index,
            start=linked_start,
            end=linked_end,
        )
        if not linked_item_key or linked_item_key == current_item_key or linked_item_key in seen_keys:
            continue

        linked_media_pool_item = _safe_media_pool_item(linked_clip)
        collected.append(
            {
                "item_key": linked_item_key,
                "track_type": linked_track_type,
                "track_index": linked_track_index,
                "name": _safe_call(lambda: linked_clip.GetName(), "") or "未命名片段",
                "path": _normalize_path(_safe_clip_property(linked_media_pool_item, "File Path", "")),
                "start": linked_start,
                "end": linked_end,
            }
        )
        seen_keys.add(linked_item_key)

    return collected


def _build_clip_info(
    clip,
    track_type: str,
    track_index: int,
    clip_index: int,
    project,
    timeline_name: str,
    timeline_start_frame: int,
    depth: int,
    warnings: List[str],
    clip_folder_map: Dict[str, str] = None,
) -> Dict[str, Any]:
    media_pool_item = _safe_media_pool_item(clip)
    clip_name = _safe_call(lambda: clip.GetName(), "", label="GetName") or "未命名片段"
    clip_type = _infer_clip_type(clip, media_pool_item)
    raw_clip_path = _normalize_path(_safe_clip_property(media_pool_item, "File Path", ""))

    # 获取媒体池文件夹路径
    media_pool_folder = ""
    if clip_folder_map and clip_name:
        media_pool_folder = clip_folder_map.get(clip_name, "")
        if not media_pool_folder and raw_clip_path:
            media_pool_folder = clip_folder_map.get(os.path.basename(raw_clip_path), "")

    start = _safe_call(lambda: clip.GetStart(), 0, label="GetStart") or 0
    end = _safe_call(lambda: clip.GetEnd(), 0, label="GetEnd") or 0
    duration = _safe_call(lambda: clip.GetDuration(), 0, label="GetDuration") or max(0, end - start)
    is_compound_clip = _is_compound_like(clip_type)
    is_fusion_clip = _is_fusion_like(clip_type, clip)
    packaging_supported = not is_compound_clip and not is_fusion_clip
    clip_path = raw_clip_path if packaging_supported else ""
    item_key = _build_timeline_item_key(
        clip,
        timeline_name=timeline_name,
        depth=depth,
        track_type=track_type,
        track_index=track_index,
        start=start,
        end=end,
    )
    linked_items = _collect_linked_items(
        clip,
        current_item_key=item_key,
        timeline_name=timeline_name,
        depth=depth,
        fallback_track_type=track_type,
        fallback_track_index=track_index,
    )
    known_paths: Set[str] = set()
    if raw_clip_path:
        known_paths.add(raw_clip_path)
    for linked_item in linked_items:
        linked_path = _normalize_path(linked_item.get("path"))
        if linked_path:
            known_paths.add(linked_path)
    fusion_paths = []
    if packaging_supported:
        fusion_paths = _collect_fusion_media(clip, media_pool_item, project, known_paths)

    clip_info: Dict[str, Any] = {
        "id": item_key,
        "item_key": item_key,
        "name": clip_name,
        "type": clip_type,
        "track_type": track_type,
        "track_index": track_index,
        "path": clip_path,
        "start": start,
        "end": end,
        "duration": duration,
        "timeline_start_frame": timeline_start_frame,
        "sub_clips": [],
        "fusion_clips": fusion_paths,
        "linked_items": linked_items,
        "packaging_supported": packaging_supported,
        "source_path": raw_clip_path,
        "media_pool_folder": media_pool_folder,
        "is_compound_clip": is_compound_clip,
        "is_fusion_clip": is_fusion_clip,
        "packaging_disabled_reason": "复合片段暂不支持打包" if is_compound_clip else ("Fusion 片段暂不支持打包" if is_fusion_clip else ""),
    }

    if depth >= MAX_PARSE_DEPTH or not is_compound_clip or not packaging_supported:
        return clip_info

    lookup_names = _extract_possible_timeline_names(clip, media_pool_item)
    sub_timeline = _find_timeline_by_name(project, timeline_name, lookup_names)
    if not sub_timeline:
        warnings.append(f"{track_type.upper()}{track_index} 复合片段未匹配到子时间线: {clip_name}")
        return clip_info

    nested_tracks = _parse_timeline(
        sub_timeline,
        project=project,
        depth=depth + 1,
        timeline_name=_safe_call(lambda: sub_timeline.GetName(), "") or clip_name,
        warnings=warnings,
        clip_folder_map=clip_folder_map,
    )
    for nested_track in nested_tracks:
        for nested_clip in nested_track.get("clips", []):
            if _clip_overlaps_selected_window(clip, nested_clip):
                clip_info["sub_clips"].append(nested_clip)

    return clip_info


def _parse_timeline(timeline, project, depth: int, timeline_name: str, warnings: List[str], clip_folder_map: Dict[str, str] = None) -> List[Dict[str, Any]]:
    tracks: List[Dict[str, Any]] = []
    if not timeline:
        return tracks
    timeline_start_frame = _safe_call(lambda: int(timeline.GetStartFrame() or 0), 0, label="GetStartFrame")

    for track_type in ("video", "audio"):
        track_count = _safe_call(
            lambda tt=track_type: int(timeline.GetTrackCount(tt) or 0),
            0,
            label=f"GetTrackCount.{track_type}"
        )
        print(f"[PACK]   时间线 {timeline_name}: {track_type} 轨道数 = {track_count}")
        for track_index in range(1, track_count + 1):
            clips = _safe_track_items(timeline, track_type, track_index)
            if not clips:
                print(f"[PACK]     {track_type}{track_index}: 无片段，跳过")
                continue

            print(f"[PACK]     {track_type}{track_index}: {len(clips)} 个原始片段项")
            parsed_clips: List[Dict[str, Any]] = []
            for clip_index, clip in enumerate(clips, start=1):
                try:
                    parsed_clips.append(
                        _build_clip_info(
                            clip,
                            track_type=track_type,
                            track_index=track_index,
                            clip_index=clip_index,
                            project=project,
                            timeline_name=timeline_name,
                            timeline_start_frame=timeline_start_frame,
                            depth=depth,
                            warnings=warnings,
                            clip_folder_map=clip_folder_map,
                        )
                    )
                except Exception as exc:
                    warnings.append(f"{track_type.upper()}{track_index} 第 {clip_index} 个片段解析失败: {exc}")
                    print(f"[PACK]     解析失败 {track_type}{track_index}#{clip_index}: {exc}")

            if parsed_clips:
                tracks.append(
                    {
                        "track_type": track_type,
                        "track_index": track_index,
                        "clips": parsed_clips,
                    }
                )

    return tracks


def _collect_paths_from_clip(clip: Dict[str, Any], collected: Set[str]) -> None:
    path = _normalize_path(clip.get("path"))
    if path:
        collected.add(path)

    for fusion_path in clip.get("fusion_clips", []) or []:
        normalized = _normalize_path(fusion_path)
        if normalized:
            collected.add(normalized)

    for sub_clip in clip.get("sub_clips", []) or []:
        _collect_paths_from_clip(sub_clip, collected)


def parse_timeline_materials(timeline, project) -> Dict[str, Any]:
    if not timeline:
        return {"status": "idle", "message": "当前没有可用时间线", "tracks": []}

    warnings: List[str] = []
    timeline_name = _safe_call(lambda: timeline.GetName(), "", label="timeline.GetName") or "未命名时间线"

    # === 构建媒体池文件夹映射 ===
    clip_folder_map: Dict[str, str] = {}
    if project:
        media_pool = _safe_call(lambda: project.GetMediaPool(), None)
        root_folder = _safe_call(lambda: media_pool.GetRootFolder(), None) if media_pool else None
        if root_folder:
            def _walk_folder(folder, current_path: str):
                sub_folders = _safe_call(lambda: folder.GetSubFolderList(), []) or []
                for sub in sub_folders:
                    name = _safe_call(lambda: sub.GetName(), "") or ""
                    next_path = f"{current_path}/{name}" if current_path else name
                    _walk_folder(sub, next_path)
                clips = _safe_call(lambda: folder.GetClipList(), []) or []
                for item in clips:
                    item_name = _safe_call(lambda: item.GetName(), "") or ""
                    item_path = _normalize_path(_safe_clip_property(item, "File Path", ""))
                    if item_name:
                        clip_folder_map[item_name] = current_path
                    if item_path:
                        clip_folder_map[os.path.basename(item_path)] = current_path
            _walk_folder(root_folder, "")
    # === 映射构建完成 ===

    # Diagnostic: log timeline and project info
    print(f"[PACK] 开始解析时间线: {timeline_name}")
    project_base_path = ""
    if project:
        proj_name = _safe_call(lambda: project.GetName(), "", label="project.GetName") or "unknown"
        print(f"[PACK] 当前项目: {proj_name}")
        if proj_name:
            record = get_project_record(proj_name)
            project_base_path = record.get("local_path", "")
            if project_base_path:
                print(f"[PACK] 项目基准路径: {project_base_path}")
    else:
        print(f"[PACK] 警告: project 对象为 None")

    tracks = _parse_timeline(
        timeline,
        project=project,
        depth=0,
        timeline_name=timeline_name,
        warnings=warnings,
        clip_folder_map=clip_folder_map,
    )
    
    print(f"[PACK] 解析完成: {len(tracks)} 条轨道, {len(warnings)} 条警告")

    unique_paths: Set[str] = set()
    clip_count = 0
    for track in tracks:
        track_clip_count = len(track.get("clips", []))
        clip_count += track_clip_count
        print(f"[PACK]   {track['track_type']} 轨道 {track['track_index']}: {track_clip_count} 个片段")
        for clip in track.get("clips", []):
            _collect_paths_from_clip(clip, unique_paths)

    print(f"[PACK] 汇总: {len(tracks)} 轨道, {clip_count} 片段, {len(unique_paths)} 个独立素材")

    return {
        "status": "success",
        "timeline_name": timeline_name,
        "project_base_path": project_base_path,
        "tracks": tracks,
        "summary": {
            "track_count": len(tracks),
            "clip_count": clip_count,
            "asset_count": len(unique_paths),
            "warning_count": len(warnings),
        },
        "warnings": warnings,
    }


def _resolve_pack_source_path(path: str, project) -> str:
    normalized = _normalize_path(path)
    if not normalized:
        return ""
    if os.path.exists(normalized):
        return normalized

    target_name = os.path.basename(normalized)
    if not target_name:
        return normalized

    fallback_path = _find_media_pool_path_by_name(project, target_name) if project else ""
    if fallback_path and os.path.exists(fallback_path):
        return fallback_path
    return normalized


def resolve_pack_subdir(source_path: str, folder_config: dict) -> str:
    """
    根据 folder_config 计算目标子目录。

    folder_config:
        source: "mediapool" | "filesystem"
        direction: "forward" | "reverse"
        depth: int (0 = 平铺)

    返回空字符串表示平铺到 dest_dir 根目录。
    """
    if not folder_config or not isinstance(folder_config, dict):
        return ""
    depth = folder_config.get("depth", 0)
    if depth <= 0:
        return ""
    if not source_path or not isinstance(source_path, str):
        return ""
    parts = [p for p in source_path.replace("\\", "/").split("/") if p]
    if not parts:
        return ""
    direction = str(folder_config.get("direction", "forward")).lower()
    if direction == "reverse":
        parts = parts[-depth:]
    else:
        parts = parts[:depth]
    return "/".join(parts)



def build_hierarchy_tree(
    selected_paths: List[str],
    folder_config: dict,
    clip_path_map: Dict[str, Dict[str, str]],
    project_base_path: str = "",  # 项目本地路径，文件系统模式以它为基准
) -> Dict[str, Any]:
    """
    根据选中的文件路径和 folder_config 构建层级树。

    clip_path_map: { normalized_path: { "media_pool_folder": "...", "source_path": "..." } }
    """
    source_type = str(folder_config.get("source", "filesystem")).lower()
    depth = folder_config.get("depth", 0)

    tree_root: Dict[str, Any] = {}
    file_count = 0
    folder_count = 0
    conflict_count = 0
    total_size = 0

    for path in sorted(set(selected_paths)):
        norm_path = _normalize_path(path)
        if not norm_path:
            continue
        filename = os.path.basename(norm_path)

        # 确定层级来源路径
        if source_type == "mediapool":
            clip_info = clip_path_map.get(norm_path, {})
            hierarchy_path = clip_info.get("media_pool_folder", "")
        else:
            dirname = os.path.dirname(norm_path)
            if project_base_path and dirname.startswith(project_base_path):
                rel = os.path.relpath(dirname, project_base_path)
                hierarchy_path = "" if rel == "." else rel
            else:
                hierarchy_path = dirname

        if depth <= 0 or not hierarchy_path:
            # 平铺：直接放在根下
            files_list = tree_root.setdefault("__files__", [])
            if any(f.get("name") == filename for f in files_list):
                conflict_count += 1
            else:
                files_list.append({
                    "name": filename,
                    "type": "file",
                    "source_path": norm_path,
                    "size_bytes": os.path.getsize(norm_path) if os.path.exists(norm_path) else 0,
                })
                file_count += 1
                if os.path.exists(norm_path):
                    total_size += os.path.getsize(norm_path)
            continue

        # 计算子目录
        subdir = resolve_pack_subdir(hierarchy_path, folder_config)
        if not subdir:
            files_list = tree_root.setdefault("__files__", [])
            if any(f.get("name") == filename for f in files_list):
                conflict_count += 1
            else:
                files_list.append({
                    "name": filename,
                    "type": "file",
                    "source_path": norm_path,
                    "size_bytes": os.path.getsize(norm_path) if os.path.exists(norm_path) else 0,
                })
                file_count += 1
                if os.path.exists(norm_path):
                    total_size += os.path.getsize(norm_path)
            continue

        # 按 subdir 层级插入树
        parts = subdir.split("/")
        node = tree_root
        for i, part in enumerate(parts):
            is_last = (i == len(parts) - 1)
            node.setdefault(part, {"__type": "folder", "__children": {}, "__file_count": 0})
            if is_last:
                folder_node = node[part]
                files_list = folder_node["__children"].setdefault("__files__", [])
                if any(f.get("name") == filename for f in files_list):
                    conflict_count += 1
                else:
                    files_list.append({
                        "name": filename,
                        "type": "file",
                        "source_path": norm_path,
                        "size_bytes": os.path.getsize(norm_path) if os.path.exists(norm_path) else 0,
                    })
                    folder_node["__file_count"] += 1
                    file_count += 1
                    if os.path.exists(norm_path):
                        total_size += os.path.getsize(norm_path)
            else:
                node = node[part]["__children"]

    # 将内部 dict 结构转为 list 树
    def _dict_to_tree(d: dict) -> list:
        result = []
        for key, value in sorted(d.items()):
            if key.startswith("__"):
                continue
            item = {
                "name": key,
                "type": "folder",
                "children": _dict_to_tree(value.get("__children", {})),
                "file_count": value.get("__file_count", 0),
            }
            result.append(item)
        # 根级文件
        if "__files__" in d:
            result.extend(d["__files__"])
        return result

    tree = _dict_to_tree(tree_root)

    # 统计文件夹数
    def _count_folders(nodes: list) -> int:
        count = 0
        for n in nodes:
            if n.get("type") == "folder":
                count += 1
                count += _count_folders(n.get("children", []))
        return count

    folder_count = _count_folders(tree)

    return {
        "tree": tree,
        "file_count": file_count,
        "folder_count": folder_count,
        "conflict_count": conflict_count,
        "total_size_bytes": total_size,
    }


def execute_pack(
    selected_paths: List[str],
    dest_dir: str,
    project=None,
    folder_config: dict = None,
    clip_folder_map: dict = None,
    project_base_path: str = "",  # 项目本地路径，文件系统模式以它为基准
) -> Dict[str, Any]:
    if not dest_dir:
        raise ValueError("目标目录不能为空")

    os.makedirs(dest_dir, exist_ok=True)

    packed: List[str] = []
    failed: List[Dict[str, str]] = []
    unique_paths = sorted({_normalize_path(path) for path in selected_paths if _normalize_path(path)})

    clip_folder_map = clip_folder_map or {}

    for path in unique_paths:
        source_path = _resolve_pack_source_path(path, project)
        if not os.path.exists(source_path):
            failed.append({"path": path, "resolved_path": source_path, "error": "文件不存在"})
            continue

        filename = os.path.basename(source_path)

        # 计算目标子目录
        subdir = ""
        if folder_config and folder_config.get("depth", 0) > 0:
            norm_path = _normalize_path(path)
            source_type = str(folder_config.get("source", "filesystem")).lower()
            if source_type == "mediapool":
                hierarchy_path = clip_folder_map.get(norm_path, {}).get("media_pool_folder", "")
            else:
                dirname = os.path.dirname(norm_path)
                if project_base_path and dirname.startswith(project_base_path):
                    rel = os.path.relpath(dirname, project_base_path)
                    hierarchy_path = "" if rel == "." else rel
                else:
                    hierarchy_path = dirname
            subdir = resolve_pack_subdir(hierarchy_path, folder_config)

        if subdir:
            dest_path = os.path.join(dest_dir, subdir, filename)
        else:
            dest_path = os.path.join(dest_dir, filename)

        os.makedirs(os.path.dirname(dest_path), exist_ok=True)

        try:
            if not os.path.exists(dest_path):
                shutil.copy2(source_path, dest_path)
            packed.append(dest_path)
        except Exception as exc:
            failed.append({"path": path, "resolved_path": source_path, "error": str(exc)})

    return {
        "status": "success",
        "packed_count": len(packed),
        "failed_count": len(failed),
        "packed": packed,
        "failed": failed,
    }


class PreviewHierarchyRequest(BaseModel):
    selected_paths: List[str]
    folder_config: dict  # { source, direction, depth }
    clip_path_map: Optional[dict] = {}  # path -> { media_pool_folder, source_path }
    project_base_path: Optional[str] = ""


class PackExecuteRequest(BaseModel):
    selected_paths: List[str]
    dest_dir: str
    folder_config: Optional[dict] = None
    clip_folder_map: Optional[dict] = {}
    project_base_path: Optional[str] = ""


def init_pack_routes(app, resolve_controller):
    @router.get("/timeline_materials")
    async def get_timeline_materials():
        try:
            print("[PACK API] 收到扫描请求")
            if not resolve_controller.resolve:
                print("[PACK API] resolve_controller.resolve 为 None，返回 idle")
                return {"status": "idle", "message": "未连接达芬奇，请先打开达芬奇并进入项目", "tracks": []}

            refreshed = resolve_controller._refresh_context()
            if not refreshed or not resolve_controller.project:
                print(f"[PACK API] _refresh_context 失败: refreshed={refreshed}, project={resolve_controller.project is not None}")
                return {
                    "status": "idle",
                    "message": "无法获取达芬奇项目，请确认达芬奇已打开项目。如果问题持续，请尝试切换到达芬奇编辑页面后重试。",
                    "tracks": [],
                }

            timeline = resolve_controller._get_active_timeline()
            project = resolve_controller.project
            print(f"[PACK API] timeline={timeline is not None}, project={project is not None}")
            if not timeline:
                proj_name = _safe_call(lambda: project.GetName(), "", label="project.GetName") if project else ""
                print(f"[PACK API] 时间线未找到 (项目: {proj_name})，返回 idle")
                return {
                    "status": "idle",
                    "message": f"未找到当前时间线。请在达芬奇中打开时间线后重试。如已打开，请尝试点击时间线窗口使其激活。",
                    "tracks": [],
                }
            if not project:
                print(f"[PACK API] 项目未找到，返回 idle")
                return {
                    "status": "idle",
                    "message": "未找到当前项目，请确保已在达芬奇中打开项目",
                    "tracks": [],
                }
            result = parse_timeline_materials(timeline, project)
            print(f"[PACK API] 返回结果: status={result['status']}, track_count={result.get('summary', {}).get('track_count', 0)}")
            return result
        except Exception as exc:
            print(f"[PACK API] 异常: {exc}")
            import traceback
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"扫描时间线素材失败: {exc}")

    @router.post("/preview_hierarchy")
    async def preview_hierarchy(req: PreviewHierarchyRequest):
        try:
            tree_data = build_hierarchy_tree(
                req.selected_paths,
                req.folder_config,
                req.clip_path_map or {},
                project_base_path=req.project_base_path or "",
            )
            return {"status": "success", **tree_data}
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

    @router.post("/execute")
    async def do_pack_materials(req: PackExecuteRequest):
        try:
            resolve_controller._refresh_context()
            return execute_pack(
                req.selected_paths,
                req.dest_dir,
                project=resolve_controller.project,
                folder_config=req.folder_config,
                clip_folder_map=req.clip_folder_map,
                project_base_path=req.project_base_path or "",
            )
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

    app.include_router(router)
