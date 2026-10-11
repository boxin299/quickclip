"""
DaVinci Resolve API 控制器
通过 Python API 与 DaVinci Resolve 进行交互
"""

import json
import math
import re
from typing import Dict, Any, List, Optional, Tuple
import os
from folder_config_manager import load_folder_config
from project_registry import (
    choose_root_from_media_paths,
    get_project_record,
    infer_export_dir,
    normalize_path,
    update_project_record,
)


def natural_path_key(path: str) -> list:
    key = []
    for part in str(path).split("/"):
        chunks = re.split(r"(\d+)", part)
        key.append(tuple((0, int(chunk)) if chunk.isdigit() else (1, chunk.lower()) for chunk in chunks))
    return key

try:
    import DaVinciResolveScript as dvr_script
    RESOLVE_AVAILABLE = True
except ImportError:
    try:
        # Fallback for Mac default installation path
        import sys
        mac_path = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules"
        if mac_path not in sys.path:
            sys.path.append(mac_path)
        import DaVinciResolveScript as dvr_script
        RESOLVE_AVAILABLE = True
    except ImportError:
        RESOLVE_AVAILABLE = False
        print("[WARNING] DaVinci Resolve Script API 未找到，将使用模拟模式")


class ResolveController:
    """DaVinci Resolve 控制器类"""
    
    def __init__(self):
        """初始化 Resolve 控制器"""
        self.resolve = None
        self.project_manager = None
        self.project = None
        self.media_pool = None
        self.media_storage = None
        self.last_project_name = None
        
        if RESOLVE_AVAILABLE:
            self._init_resolve(quiet=True)
            
    def _is_placeholder_project_name(self, name: Optional[str]) -> bool:
        if not name:
            return True
        n = str(name).strip().lower()
        if not n:
            return True
        if n.startswith("untitled project"):
            return True
        if "未命名" in n or "无标题" in n:
            return True
        return False

    def _list_project_names(self) -> List[str]:
        pm = self.project_manager
        if not pm:
            return []
        for method_name in ("GetProjectListInCurrentFolder", "GetProjectList", "GetProjectNameList"):
            fn = getattr(pm, method_name, None)
            if not callable(fn):
                continue
            try:
                res = fn()
                if isinstance(res, list):
                    return [str(x) for x in res if x]
            except Exception:
                continue
        return []

    def _init_resolve(self, quiet: bool = False) -> bool:
        """初始化 Resolve 连接"""
        try:
            self.resolve = dvr_script.scriptapp("Resolve")
            if not self.resolve:
                if not quiet:
                    print("[INFO] 达芬奇未连接，请确保达芬奇已启动且外部脚本控制已开启")
                return False
                
            self.project_manager = self.resolve.GetProjectManager()
            self.project = self.project_manager.GetCurrentProject()
            self.media_storage = self.resolve.GetMediaStorage()
            
            if self.project:
                self.media_pool = self.project.GetMediaPool()
                
            print("[INFO] 已连接到 DaVinci Resolve")
            return True
        except Exception as e:
            if not quiet:
                print(f"[ERROR] 连接 Resolve 失败: {e}")
            self.resolve = None
            return False

    def get_status(self) -> Dict[str, Any]:
        """获取当前达芬奇连接状态和项目名称"""
        if not self.resolve:
            if RESOLVE_AVAILABLE and self._init_resolve(quiet=True):
                pass
            else:
                return {"connected": False, "project": None}
            
        try:
            refreshed = self._refresh_context()
            if not refreshed and not self.project:
                try:
                    test_pm = self.resolve.GetProjectManager()
                    if test_pm is None:
                        self.resolve = None
                        self.project_manager = None
                        self.project = None
                        self.media_pool = None
                        self.media_storage = None
                        return {"connected": False, "project": None}
                except Exception:
                    self.resolve = None
                    self.project_manager = None
                    self.project = None
                    self.media_pool = None
                    self.media_storage = None
                    return {"connected": False, "project": None}
            proj_name = self.project.GetName() if self.project else None
            if self._is_placeholder_project_name(proj_name):
                self.last_project_name = None
                return {"connected": True, "project": None}
            if proj_name:
                self.last_project_name = proj_name
            return {"connected": True, "project": proj_name}
        except Exception:
            self.resolve = None
            self.project_manager = None
            self.project = None
            self.media_pool = None
            self.media_storage = None
            return {"connected": False, "project": None}

    def get_render_presets(self) -> List[str]:
        if not self.resolve or not self._refresh_context() or not self.project:
            return []
        try:
            preset_list = self.project.GetRenderPresetList()
            if preset_list:
                return [p.get("PresetName", "") if isinstance(p, dict) else str(p) for p in preset_list]
            return []
        except Exception:
            return []

    def get_media_pool_folders(self) -> List[str]:
        """获取媒体池中所有的文件夹路径"""
        if not self.resolve or not self._refresh_context() or not self.project:
            return []
            
        try:
            media_pool = self.project.GetMediaPool()
            if not media_pool:
                return []
                
            root_folder = media_pool.GetRootFolder()
            if not root_folder:
                return []
                
            all_paths = []
            
            def walk_folders(folder, current_path=""):
                sub_folders = folder.GetSubFolderList()
                if not sub_folders:
                    return
                    
                for sub_folder in sub_folders:
                    name = sub_folder.GetName()
                    # Skip internal/system folders if necessary
                    if name in ["时间线备份", "SmartBins"]:
                        continue
                        
                    folder_path = f"{current_path}/{name}" if current_path else name
                    all_paths.append(folder_path)
                    walk_folders(sub_folder, folder_path)
            
            walk_folders(root_folder)
            return all_paths
            
        except Exception as e:
            print(f"[ERROR] 获取达芬奇媒体池文件夹失败: {e}")
            return []

    def reconnect(self) -> Dict[str, Any]:
        """尝试重新连接到达芬奇"""
        if not RESOLVE_AVAILABLE:
            return {"connected": False, "project": None, "message": "达芬奇脚本模块不可用"}
            
        try:
            self.resolve = dvr_script.scriptapp("Resolve")
            if not self.resolve:
                self.project_manager = None
                self.project = None
                self.media_pool = None
                self.media_storage = None
                return {"connected": False, "project": None, "message": "无法连接到达芬奇，请确保达芬奇已启动"}
                
            self.project_manager = self.resolve.GetProjectManager()
            self.project = self.project_manager.GetCurrentProject()
            self.media_storage = self.resolve.GetMediaStorage()
            
            if self.project:
                self.media_pool = self.project.GetMediaPool()
                self._build_project_context(include_media=False, persist=True)
                
            proj_name = self.project.GetName() if self.project else None
            self.last_project_name = proj_name
            return {"connected": True, "project": proj_name, "message": "已成功连接到达芬奇"}
        except Exception as e:
            self.resolve = None
            self.project_manager = None
            self.project = None
            self.media_pool = None
            self.media_storage = None
            return {"connected": False, "project": None, "message": f"连接失败: {str(e)}"}

    def _refresh_context(self) -> bool:
        if not self.resolve:
            return False
        try:
            if not self.project_manager:
                self.project_manager = self.resolve.GetProjectManager()
        except Exception as exc:
            print(f"[RESOLVE] GetProjectManager 失败: {exc}")
            self.resolve = None
            self.project_manager = None
            self.project = None
            self.media_pool = None
            self.media_storage = None
            return False

        try:
            self.media_storage = self.resolve.GetMediaStorage()
        except Exception as exc:
            print(f"[RESOLVE] GetMediaStorage 失败 (非致命): {exc}")
            self.media_storage = None

        try:
            self.project = self.project_manager.GetCurrentProject() if self.project_manager else None
        except Exception as exc:
            print(f"[RESOLVE] GetCurrentProject 失败: {exc}")
            self.project = None
            self.project_manager = None

        try:
            self.media_pool = self.project.GetMediaPool() if self.project else None
        except Exception as exc:
            print(f"[RESOLVE] GetMediaPool 失败 (非致命): {exc}")
            self.media_pool = None

        return bool(self.project)

    def _get_or_create_davinci_folder(self, parent, path_str: str):
        parts = [p for p in path_str.replace("\\", "/").split("/") if p]
        if parent is None:
            current = self.media_pool.GetRootFolder() if self.media_pool else None
        else:
            current = parent
        if current is None:
            return None
        for part in parts:
            found = False
            for folder in current.GetSubFolderList():
                if folder.GetName() == part:
                    current = folder
                    found = True
                    break
            if not found:
                new_folder = self.media_pool.AddSubFolder(current, part)
                if not new_folder:
                    return current
                current = new_folder
        return current

    def _extract_local_path_from_timeline(self, timeline) -> str:
        if not timeline:
            return ""
        try:
            markers = timeline.GetMarkers() or {}
            for marker in markers.values():
                if marker.get("name") in ("LocalPath", "ProjectPath"):
                    return normalize_path(marker.get("note", ""))
        except Exception:
            pass
        return ""

    def _timeline_has_media(self, timeline) -> bool:
        if not timeline:
            return False
        tl_name = self._safe_get_name(timeline)
        for track_type in ("video", "audio"):
            try:
                track_count = timeline.GetTrackCount(track_type) or 0
            except Exception as exc:
                print(f"[RESOLVE] _timeline_has_media: '{tl_name}' GetTrackCount({track_type}) 异常: {exc}")
                track_count = 0
            for track_idx in range(1, track_count + 1):
                try:
                    items = timeline.GetItemListInTrack(track_type, track_idx) or []
                    if items:
                        return True
                except Exception as exc:
                    print(f"[RESOLVE] _timeline_has_media: '{tl_name}' GetItemListInTrack({track_type}, {track_idx}) 异常: {exc}")
                    continue
        return False

    def _get_timeline_names(self) -> List[str]:
        if not self.project:
            return []
        names = []
        try:
            for i in range(1, self.project.GetTimelineCount() + 1):
                timeline = self.project.GetTimelineByIndex(i)
                if timeline:
                    names.append(timeline.GetName())
        except Exception:
            pass
        return names

    def _get_active_timeline(self, allow_fallback: bool = True):
        if not self._refresh_context() or not self.project:
            print("[RESOLVE] _get_active_timeline: _refresh_context 失败或 project 为 None")
            return None

        try:
            timeline = self.project.GetCurrentTimeline()
        except Exception as exc:
            print(f"[RESOLVE] GetCurrentTimeline 异常: {exc}")
            timeline = None

        if timeline:
            return timeline

        if not allow_fallback:
            print("[RESOLVE] _get_active_timeline: GetCurrentTimeline 返回 None, 不允许回退")
            return None

        print("[RESOLVE] _get_active_timeline: GetCurrentTimeline 返回 None, 尝试回退...")
        fallback = None
        try:
            timeline_count = self.project.GetTimelineCount()
            print(f"[RESOLVE] _get_active_timeline: 项目共有 {timeline_count} 个时间线")
            for i in range(1, timeline_count + 1):
                candidate = self.project.GetTimelineByIndex(i)
                if not candidate:
                    continue
                if fallback is None:
                    fallback = candidate
                if self._timeline_has_media(candidate):
                    candidate_name = self._safe_get_name(candidate)
                    print(f"[RESOLVE] _get_active_timeline: 回退选中 '{candidate_name}' (有媒体)")
                    return candidate
        except Exception as exc:
            print(f"[RESOLVE] _get_active_timeline: 回退遍历异常: {exc}")

        if fallback:
            fallback_name = self._safe_get_name(fallback)
            print(f"[RESOLVE] _get_active_timeline: 回退到首个时间线 '{fallback_name}' (可能无媒体)")
        else:
            print("[RESOLVE] _get_active_timeline: 回退失败, 项目中没有时间线")
        return fallback

    def _safe_get_name(self, obj) -> str:
        try:
            return obj.GetName() or "未命名"
        except Exception:
            return "未知"

    def _collect_media_paths_from_folder(self, folder, limit: int = 500) -> List[str]:
        if not folder or limit <= 0:
            return []

        paths: List[str] = []

        def walk(current_folder):
            if len(paths) >= limit:
                return

            try:
                clips = current_folder.GetClipList() or []
            except Exception:
                clips = []

            for clip in clips:
                if len(paths) >= limit:
                    return
                try:
                    file_path = clip.GetClipProperty("File Path")
                    if file_path:
                        paths.append(file_path)
                except Exception:
                    continue

            try:
                subfolders = current_folder.GetSubFolderList() or []
            except Exception:
                subfolders = []

            for subfolder in subfolders:
                walk(subfolder)

        walk(folder)
        return paths

    def _collect_imported_videos(self, limit: int = 300) -> List[Dict[str, Any]]:
        if not self.media_pool:
            return []

        videos: List[Dict[str, Any]] = []
        root_folder = self.media_pool.GetRootFolder()
        if not root_folder:
            return videos

        def walk(folder):
            if len(videos) >= limit:
                return

            try:
                clips = folder.GetClipList() or []
            except Exception:
                clips = []

            for clip in clips:
                if len(videos) >= limit:
                    return
                try:
                    clip_type = clip.GetClipProperty("Type")
                    if clip_type not in ("Video", "Video + Audio"):
                        continue
                    file_path = clip.GetClipProperty("File Path")
                    videos.append({
                        "name": clip.GetName(),
                        "path": file_path,
                        "id": clip.GetMediaId(),
                    })
                except Exception:
                    continue

            try:
                subfolders = folder.GetSubFolderList() or []
            except Exception:
                subfolders = []

            for subfolder in subfolders:
                walk(subfolder)

        walk(root_folder)
        return videos

    def _detect_project_local_path(self) -> Tuple[str, str]:
        if not self._refresh_context() or not self.project:
            return "", "unavailable"

        record = get_project_record(self.project.GetName())
        saved_local_path = normalize_path(record.get("local_path"))
        if saved_local_path:
            return saved_local_path, "project_registry"

        current_timeline = self.project.GetCurrentTimeline()
        local_path = self._extract_local_path_from_timeline(current_timeline)
        if local_path:
            return local_path, "timeline_marker_current"

        try:
            for i in range(1, self.project.GetTimelineCount() + 1):
                timeline = self.project.GetTimelineByIndex(i)
                local_path = self._extract_local_path_from_timeline(timeline)
                if local_path:
                    return local_path, "timeline_marker_any"
        except Exception:
            pass

        root_folder = self.media_pool.GetRootFolder() if self.media_pool else None
        media_paths = self._collect_media_paths_from_folder(root_folder, limit=400)
        inferred = choose_root_from_media_paths(media_paths)
        if inferred:
            return inferred, "media_pool_inference"

        return "", "unknown"

    def _build_project_context(self, include_media: bool = False, persist: bool = False) -> Dict[str, Any]:
        if not self._refresh_context() or not self.project:
            return {"connected": False, "project_name": None}

        project_name = self.project.GetName()
        if self._is_placeholder_project_name(project_name):
            return {"connected": True, "project_name": None, "local_path": "", "path_source": "placeholder"}
        record = get_project_record(project_name)
        local_path, path_source = self._detect_project_local_path()
        timeline = self._get_active_timeline()
        folder_config = load_folder_config()
        local_folders = folder_config.get("local_folders", [])

        context = {
            "connected": True,
            "project_name": project_name,
            "local_path": local_path or record.get("local_path", ""),
            "path_source": path_source,
            "current_timeline": timeline.GetName() if timeline else None,
            "timeline_names": self._get_timeline_names(),
            "default_export_dir": infer_export_dir(local_path or record.get("local_path", ""), local_folders)
            if (local_path or record.get("local_path"))
            else record.get("default_export_dir", ""),
        }

        if include_media:
            context["imported_videos"] = self._collect_imported_videos(limit=300)

        return update_project_record(project_name, context) if persist else {**record, **context}

    def get_project_context(self, include_media: bool = True) -> Dict[str, Any]:
        return self._build_project_context(include_media=include_media, persist=True)

    def get_project_frame_rate(self) -> float:
        """获取当前项目的帧率"""
        if self.project:
            try:
                fps = float(self.project.GetSetting("timelineFrameRate") or 24)
                return fps
            except Exception:
                pass
        return 24.0

    def _frame_to_timecode(self, frame: int, fps: float, start_timecode: str = "00:00:00:00") -> str:
        try:
            parts = [int(part) for part in str(start_timecode or "00:00:00:00").split(":")]
            if len(parts) != 4:
                parts = [0, 0, 0, 0]
        except Exception:
            parts = [0, 0, 0, 0]

        base_frames = int(round(((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * fps + parts[3]))
        absolute_frames = base_frames + int(frame)

        hours = int(absolute_frames // round(fps * 3600))
        remaining = absolute_frames % round(fps * 3600)
        minutes = int(remaining // round(fps * 60))
        remaining = remaining % round(fps * 60)
        seconds = int(remaining // round(fps))
        frames = int(remaining % round(fps))
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}:{frames:02d}"

    def locate_timeline_frame(self, frame: int, frame_is_absolute: bool = False) -> Dict[str, Any]:
        if not self.resolve:
            return {"status": "success", "mode": "mock", "message": "模拟模式 - 已定位到问题位置"}

        try:
            self._refresh_context()
            timeline = self._get_active_timeline()
            if not timeline:
                return {"status": "error", "message": "当前工程中没有可用时间线"}

            self.project.SetCurrentTimeline(timeline)
            self.resolve.OpenPage("edit")

            fps = float(timeline.GetSetting("timelineFrameRate") or self.project.GetSetting("timelineFrameRate") or 24)
            start_timecode = timeline.GetStartTimecode() or "00:00:00:00"

            relative_frame = max(0, frame - int(timeline.GetStartFrame() or 0)) if frame_is_absolute else frame
            display_tc = self._frame_to_timecode(relative_frame, fps, start_timecode)

            positioned = False
            try:
                positioned = bool(timeline.SetCurrentTimecode(display_tc))
            except Exception:
                positioned = False

            return {
                "status": "success" if positioned else "partial",
                "timeline_name": timeline.GetName(),
                "frame": int(frame),
                "timecode": display_tc,
                "message": "已在时间线上定位到目标位置" if positioned else "已切换到编辑页，但未能精确移动播放头",
            }
        except Exception as e:
            return {"status": "error", "message": f"定位失败: {str(e)}"}

    def add_issue_markers(self, issues: List[Dict[str, Any]], clear_existing: bool = False) -> Dict[str, Any]:
        if not self.resolve:
            return {"status": "success", "mode": "mock", "message": "模拟模式 - 已添加问题标签", "added_count": len(issues)}

        try:
            self._refresh_context()
            timeline = self._get_active_timeline()
            if not timeline:
                return {"status": "error", "message": "当前工程中没有可用时间线"}

            self.project.SetCurrentTimeline(timeline)
            self.resolve.OpenPage("edit")
            timeline_start_frame = int(timeline.GetStartFrame() or 0)

            existing_markers = timeline.GetMarkers() or {}
            if clear_existing:
                for frame_id, marker in list(existing_markers.items()):
                    if str(marker.get("customData", "")).startswith("check_issue:"):
                        try:
                            timeline.DeleteMarkerAtFrame(frame_id)
                        except Exception:
                            pass
                existing_markers = timeline.GetMarkers() or {}

            added_count = 0
            skipped_count = 0
            placed_markers = []

            for issue in issues:
                absolute_frame = int(issue.get("start", 0))
                frame = max(0, absolute_frame - timeline_start_frame)
                duration = max(1, int(issue.get("duration", 1)))
                issue_type = issue.get("type", "issue")
                track = issue.get("track", "All")
                label = {
                    "flash_frame": "夹帧",
                    "black_frame": "黑帧",
                    "black_border": "黑边",
                }.get(issue_type, "问题")
                color = {
                    "flash_frame": "Yellow",
                    "black_frame": "Red",
                    "black_border": "Purple",
                }.get(issue_type, "Blue")
                custom_data = f"check_issue:{issue_type}:{track}:{issue.get('start')}:{issue.get('end')}"
                marker_name = f"{label} V{track}" if track != "All" else label
                marker_note = issue.get("description", "")

                target_frame = frame
                if target_frame in existing_markers:
                    for offset in range(1, 11):
                        if (frame + offset) not in existing_markers:
                            target_frame = frame + offset
                            break

                if target_frame in existing_markers:
                    skipped_count += 1
                    continue

                created = False
                try:
                    created = bool(timeline.AddMarker(target_frame, color, marker_name, marker_note, duration, custom_data))
                except Exception:
                    created = False

                if not created:
                    try:
                        created = bool(timeline.AddMarker(target_frame, color, marker_name, marker_note, duration))
                    except Exception:
                        created = False

                if not created and color != "Blue":
                    try:
                        created = bool(timeline.AddMarker(target_frame, "Blue", marker_name, marker_note, duration, custom_data))
                        if created:
                            color = "Blue"
                    except Exception:
                        try:
                            created = bool(timeline.AddMarker(target_frame, "Blue", marker_name, marker_note, duration))
                            if created:
                                color = "Blue"
                        except Exception:
                            created = False

                if created:
                    existing_markers[target_frame] = {
                        "color": color,
                        "name": marker_name,
                        "note": marker_note,
                        "duration": duration,
                        "customData": custom_data,
                    }
                    added_count += 1
                    placed_markers.append({
                        "frame": target_frame,
                        "absolute_frame": absolute_frame,
                        "name": marker_name,
                        "color": color,
                    })
                else:
                    skipped_count += 1

            return {
                "status": "success",
                "timeline_name": timeline.GetName(),
                "added_count": added_count,
                "skipped_count": skipped_count,
                "markers": placed_markers,
                "message": f"已添加 {added_count} 个问题标签" + (f"，跳过 {skipped_count} 个冲突位置" if skipped_count else ""),
            }
        except Exception as e:
            return {"status": "error", "message": f"添加标签失败: {str(e)}"}

    def clear_check_markers(self, issue_types: List[str] = None) -> Dict[str, Any]:
        if not self.resolve:
            return {"status": "success", "message": "模拟模式 - 已清除检测标签"}

        try:
            self._refresh_context()
            timeline = self._get_active_timeline()
            if not timeline:
                return {"status": "error", "message": "当前工程中没有可用时间线"}

            type_prefixes = {
                "black_border": "check_issue:black_border:",
                "flash_frame": "check_issue:flash_frame:",
                "black_frame": "check_issue:black_frame:",
            }

            existing_markers = timeline.GetMarkers() or {}
            cleared_count = 0
            for frame_id, marker in list(existing_markers.items()):
                custom_data = str(marker.get("customData", ""))
                if not custom_data.startswith("check_issue:"):
                    continue
                if issue_types:
                    should_clear = False
                    for t in issue_types:
                        if custom_data.startswith(type_prefixes.get(t, "")):
                            should_clear = True
                            break
                    if not should_clear:
                        continue
                try:
                    timeline.DeleteMarkerAtFrame(frame_id)
                    cleared_count += 1
                except Exception:
                    pass

            return {
                "status": "success",
                "timeline_name": timeline.GetName(),
                "cleared_count": cleared_count,
                "message": f"已清除 {cleared_count} 个检测标签",
            }
        except Exception as e:
            return {"status": "error", "message": f"清除标签失败: {str(e)}"}

    def _safe_float(self, value, default=None):
        try:
            if value in (None, ""):
                return default
            return float(value)
        except (TypeError, ValueError):
            return default

    def _parse_resolution(self, resolution: str):
        if not resolution:
            return None, None
        normalized = str(resolution).lower().replace(" ", "")
        if "x" not in normalized:
            return None, None
        try:
            width_str, height_str = normalized.split("x", 1)
            return float(width_str), float(height_str)
        except (TypeError, ValueError):
            return None, None

    def _get_rotation_degrees(self, item):
        for prop_name in ("RotationAngle", "Rotation", "ZRotationAngle", "ZRotation"):
            rotation = self._safe_float(item.GetProperty(prop_name))
            if rotation is not None:
                return rotation
        return 0.0

    def _get_anchor_point(self, item) -> Tuple[float, float]:
        x_names = ("AnchorPointX", "AnchorX", "PivotX", "Anchor Point X", "Pivot Point X")
        y_names = ("AnchorPointY", "AnchorY", "PivotY", "Anchor Point Y", "Pivot Point Y")

        def read_first(names):
            for prop_name in names:
                value = self._safe_float(item.GetProperty(prop_name))
                if value is not None:
                    return value
            return 0.0

        return read_first(x_names), read_first(y_names)

    def _normalize_mismatch_behavior(self, *values):
        for value in values:
            if value in (None, ""):
                continue
            raw = str(value).strip()
            if not raw:
                continue
            key = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", raw.lower())
            aliases = {
                "scaletofit": "scaleToFit",
                "fit": "scaleToFit",
                "fittoframe": "scaleToFit",
                "scaleentireimagetofit": "scaleToFit",
                "entireimagetofit": "scaleToFit",
                "缩放整个图像以适配": "scaleToFit",
                "缩放整个图像到适合": "scaleToFit",
                "scaletocrop": "scaleToCrop",
                "crop": "scaleToCrop",
                "scalefullframewithcrop": "scaleToCrop",
                "fullframewithcrop": "scaleToCrop",
                "缩放全帧并裁切": "scaleToCrop",
                "缩放全帧裁切": "scaleToCrop",
                "centercrop": "centerCrop",
                "none": "centerCrop",
                "noscale": "centerCrop",
                "centercropwithnoresizing": "centerCrop",
                "centerwithnoresizing": "centerCrop",
                "居中裁切不缩放": "centerCrop",
                "stretchtofit": "stretchToFit",
                "stretch": "stretchToFit",
                "stretchframetoallcorners": "stretchToFit",
                "拉伸帧至所有角": "stretchToFit",
                "拉伸到适合": "stretchToFit",
            }
            if key in aliases:
                return aliases[key]

            if "stretch" in key or "拉伸" in key:
                return "stretchToFit"
            if ("fullframe" in key or "全帧" in key or "缩放" in key) and ("crop" in key or "裁" in key):
                return "scaleToCrop"
            if "fit" in key or "适配" in key or "适合" in key:
                return "scaleToFit"
            if "noresiz" in key or "none" in key or "不缩放" in key or "无缩放" in key:
                return "centerCrop"
        return None

    def _resolve_effective_scaling(self, raw_scaling, mismatch_behavior: str):
        normalized_mismatch = self._normalize_mismatch_behavior(mismatch_behavior)
        mismatch_mapping = {
            "centerCrop": 1,
            "scaleToFit": 2,
            "scaleToCrop": 3,
            "stretchToFit": 4,
        }
        scaling_num = self._safe_float(raw_scaling)
        if scaling_num is not None:
            scaling_num = int(scaling_num)
            if scaling_num == 0:
                return mismatch_mapping.get(normalized_mismatch, 2)
            return scaling_num

        scaling_str = str(raw_scaling or "").strip()
        normalized_scaling = self._normalize_mismatch_behavior(scaling_str)
        if normalized_scaling:
            return mismatch_mapping.get(normalized_scaling, 2)
        if re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", scaling_str.lower()) in ("projectsettings", "项目设置", "useprojectsettings"):
            return mismatch_mapping.get(normalized_mismatch, 2)
        return mismatch_mapping.get(normalized_mismatch, 2)

    def _get_crop_values(self, item, clip_w: float, clip_h: float) -> Dict[str, float]:
        crop_left = max(0.0, min(clip_w, self._safe_float(item.GetProperty("CropLeft"), 0.0) or 0.0))
        crop_right = max(0.0, min(clip_w, self._safe_float(item.GetProperty("CropRight"), 0.0) or 0.0))
        crop_top = max(0.0, min(clip_h, self._safe_float(item.GetProperty("CropTop"), 0.0) or 0.0))
        crop_bottom = max(0.0, min(clip_h, self._safe_float(item.GetProperty("CropBottom"), 0.0) or 0.0))

        visible_w = max(1.0, clip_w - crop_left - crop_right)
        visible_h = max(1.0, clip_h - crop_top - crop_bottom)
        return {
            "left": crop_left,
            "right": crop_right,
            "top": crop_top,
            "bottom": crop_bottom,
            "visible_w": visible_w,
            "visible_h": visible_h,
        }

    def _compute_display_dimensions(
        self,
        clip_w: float,
        clip_h: float,
        effective_scaling: int,
        timeline_w: float,
        timeline_h: float,
        zoom_x: float,
        zoom_y: float,
        crop_values: Optional[Dict[str, float]] = None,
    ):
        if not clip_w or not clip_h or not timeline_w or not timeline_h:
            return None, None

        visible_w = crop_values.get("visible_w", clip_w) if crop_values else clip_w
        visible_h = crop_values.get("visible_h", clip_h) if crop_values else clip_h

        if effective_scaling == 4:  # stretchToFit
            base_w = 1.0
            base_h = 1.0
        elif effective_scaling == 0 or effective_scaling == 1:  # no scale / centerCrop
            base_w = visible_w / timeline_w
            base_h = visible_h / timeline_h
        elif effective_scaling == 3:  # scaleToCrop
            scale = max(timeline_w / visible_w, timeline_h / visible_h)
            base_w = (visible_w * scale) / timeline_w
            base_h = (visible_h * scale) / timeline_h
        else:  # scaleToFit
            scale = min(timeline_w / visible_w, timeline_h / visible_h)
            base_w = (visible_w * scale) / timeline_w
            base_h = (visible_h * scale) / timeline_h

        return base_w * (zoom_x or 1.0), base_h * (zoom_y or 1.0)

    def _compute_visible_display_rect(
        self,
        clip_w: float,
        clip_h: float,
        effective_scaling: int,
        timeline_w: float,
        timeline_h: float,
        zoom_x: float,
        zoom_y: float,
        crop_values: Optional[Dict[str, float]] = None,
    ):
        if not clip_w or not clip_h or not timeline_w or not timeline_h:
            return None

        if effective_scaling == 4:
            base_w = 1.0
            base_h = 1.0
        elif effective_scaling == 0 or effective_scaling == 1:
            base_w = clip_w / timeline_w
            base_h = clip_h / timeline_h
        elif effective_scaling == 3:
            scale = max(timeline_w / clip_w, timeline_h / clip_h)
            base_w = (clip_w * scale) / timeline_w
            base_h = (clip_h * scale) / timeline_h
        elif effective_scaling == 2:
            scale = min(timeline_w / clip_w, timeline_h / clip_h)
            base_w = (clip_w * scale) / timeline_w
            base_h = (clip_h * scale) / timeline_h
        else:
            return None

        zoom_x = zoom_x or 1.0
        zoom_y = zoom_y or 1.0
        crop_values = crop_values or {}
        crop_left = crop_values.get("left", 0.0)
        crop_right = crop_values.get("right", 0.0)
        crop_top = crop_values.get("top", 0.0)
        crop_bottom = crop_values.get("bottom", 0.0)

        px_w = base_w / clip_w
        px_h = base_h / clip_h
        display_w = max(0.0001, (base_w - (crop_left + crop_right) * px_w) * zoom_x)
        display_h = max(0.0001, (base_h - (crop_top + crop_bottom) * px_h) * zoom_y)
        crop_offset_x = ((crop_left - crop_right) * 0.5) * px_w * zoom_x
        crop_offset_y = ((crop_bottom - crop_top) * 0.5) * px_h * zoom_y

        base_w_px = base_w * timeline_w
        base_h_px = base_h * timeline_h
        px_w_in_timeline = base_w_px / clip_w
        px_h_in_timeline = base_h_px / clip_h
        display_w_px = max(0.0001, (base_w_px - (crop_left + crop_right) * px_w_in_timeline) * zoom_x)
        display_h_px = max(0.0001, (base_h_px - (crop_top + crop_bottom) * px_h_in_timeline) * zoom_y)
        crop_offset_x_px = ((crop_left - crop_right) * 0.5) * px_w_in_timeline * zoom_x
        crop_offset_y_px = ((crop_bottom - crop_top) * 0.5) * px_h_in_timeline * zoom_y
        visible_left_px = -base_w_px / 2.0 + crop_left * px_w_in_timeline
        visible_right_px = base_w_px / 2.0 - crop_right * px_w_in_timeline
        visible_top_px = -base_h_px / 2.0 + crop_top * px_h_in_timeline
        visible_bottom_px = base_h_px / 2.0 - crop_bottom * px_h_in_timeline
        visible_polygon_px = [
            (visible_left_px, visible_top_px),
            (visible_right_px, visible_top_px),
            (visible_right_px, visible_bottom_px),
            (visible_left_px, visible_bottom_px),
        ]

        return {
            "display_w": display_w,
            "display_h": display_h,
            "crop_offset_x": crop_offset_x,
            "crop_offset_y": crop_offset_y,
            "base_w": base_w * zoom_x,
            "base_h": base_h * zoom_y,
            "display_w_px": display_w_px,
            "display_h_px": display_h_px,
            "crop_offset_x_px": crop_offset_x_px,
            "crop_offset_y_px": crop_offset_y_px,
            "base_w_px": base_w_px * zoom_x,
            "base_h_px": base_h_px * zoom_y,
            "visible_polygon_px": visible_polygon_px,
        }

    def _rotated_rect_covers_viewport(self, display_w: float, display_h: float, rotation_degrees: float) -> bool:
        if not display_w or not display_h:
            return False
        theta = math.radians(rotation_degrees % 180)
        cos_theta = math.cos(theta)
        sin_theta = math.sin(theta)
        half_w = display_w / 2.0
        half_h = display_h / 2.0
        for x, y in ((-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)):
            local_x = x * cos_theta + y * sin_theta
            local_y = -x * sin_theta + y * cos_theta
            if abs(local_x) > half_w + 1e-4 or abs(local_y) > half_h + 1e-4:
                return False
        return True

    def _compute_required_uniform_scale(self, display_w: float, display_h: float, rotation_degrees: float) -> float:
        if not display_w or not display_h:
            return 1.0
        if self._rotated_rect_covers_viewport(display_w, display_h, rotation_degrees):
            return 1.0

        low = 1.0
        high = 1.0
        while high < 32.0 and not self._rotated_rect_covers_viewport(display_w * high, display_h * high, rotation_degrees):
            high *= 1.5

        for _ in range(32):
            mid = (low + high) / 2.0
            if self._rotated_rect_covers_viewport(display_w * mid, display_h * mid, rotation_degrees):
                high = mid
            else:
                low = mid
        return high

    def _rect_covers_viewport(self, display_w: float, display_h: float, offset_x: float, offset_y: float, rotation_deg: float, safe_zone_x: float = 0.0, safe_zone_y: float = 0.0) -> bool:
        if not display_w or not display_h:
            return False
        half_w = display_w / 2.0
        half_h = display_h / 2.0
        theta = math.radians(rotation_deg % 360)
        cos_theta = math.cos(theta)
        sin_theta = math.sin(theta)
        for vx, vy in ((-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)):
            tx = vx - offset_x
            ty = vy - offset_y
            local_x = tx * cos_theta + ty * sin_theta
            local_y = -tx * sin_theta + ty * cos_theta
            if abs(local_x) > half_w + safe_zone_x + 1e-4 or abs(local_y) > half_h + safe_zone_y + 1e-4:
                return False
        return True

    def _rect_covers_viewport_pixels(
        self,
        display_w_px: float,
        display_h_px: float,
        offset_x_px: float,
        offset_y_px: float,
        rotation_deg: float,
        viewport_w_px: float,
        viewport_h_px: float,
        safe_zone_px: float = 0.0,
    ) -> bool:
        if not display_w_px or not display_h_px or not viewport_w_px or not viewport_h_px:
            return False
        half_w = display_w_px / 2.0
        half_h = display_h_px / 2.0
        theta = math.radians(rotation_deg % 360)
        cos_theta = math.cos(theta)
        sin_theta = math.sin(theta)
        safe_zone_px = max(0.0, float(safe_zone_px or 0.0))
        for vx, vy in (
            (-viewport_w_px / 2.0, -viewport_h_px / 2.0),
            (viewport_w_px / 2.0, -viewport_h_px / 2.0),
            (viewport_w_px / 2.0, viewport_h_px / 2.0),
            (-viewport_w_px / 2.0, viewport_h_px / 2.0),
        ):
            tx = vx - offset_x_px
            ty = vy - offset_y_px
            local_x = tx * cos_theta + ty * sin_theta
            local_y = -tx * sin_theta + ty * cos_theta
            if abs(local_x) > half_w + safe_zone_px + 1e-4 or abs(local_y) > half_h + safe_zone_px + 1e-4:
                return False
        return True

    def _transform_polygon_pixels(
        self,
        polygon: List[Tuple[float, float]],
        anchor_x: float,
        anchor_y: float,
        zoom_x: float,
        zoom_y: float,
        rotation_deg: float,
        position_x: float,
        position_y: float,
    ) -> List[Tuple[float, float]]:
        theta = math.radians(rotation_deg % 360)
        cos_theta = math.cos(theta)
        sin_theta = math.sin(theta)
        transformed = []
        for x, y in polygon:
            scaled_x = anchor_x + (x - anchor_x) * (zoom_x or 1.0)
            scaled_y = anchor_y + (y - anchor_y) * (zoom_y or 1.0)
            dx = scaled_x - anchor_x
            dy = scaled_y - anchor_y
            transformed.append((
                anchor_x + dx * cos_theta - dy * sin_theta + position_x,
                anchor_y + dx * sin_theta + dy * cos_theta + position_y,
            ))
        return transformed

    def _point_in_convex_polygon(self, point: Tuple[float, float], polygon: List[Tuple[float, float]]) -> bool:
        if len(polygon) < 3:
            return False
        px, py = point
        sign = None
        for idx in range(len(polygon)):
            x1, y1 = polygon[idx]
            x2, y2 = polygon[(idx + 1) % len(polygon)]
            cross = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)
            if abs(cross) <= 1e-4:
                continue
            current_sign = cross > 0
            if sign is None:
                sign = current_sign
            elif sign != current_sign:
                return False
        return True

    def _polygon_covers_viewport_pixels(
        self,
        polygon: List[Tuple[float, float]],
        viewport_w_px: float,
        viewport_h_px: float,
        safe_zone_px: float = 0.0,
    ) -> bool:
        if not polygon or not viewport_w_px or not viewport_h_px:
            return False
        safe_zone_px = max(0.0, float(safe_zone_px or 0.0))
        half_w = max(0.0, viewport_w_px / 2.0 - safe_zone_px)
        half_h = max(0.0, viewport_h_px / 2.0 - safe_zone_px)
        for point in ((-half_w, -half_h), (half_w, -half_h), (half_w, half_h), (-half_w, half_h)):
            if not self._point_in_convex_polygon(point, polygon):
                return False
        return True

    def _compute_full_display_geometry(
        self,
        clip_w: float,
        clip_h: float,
        effective_scaling: int,
        timeline_w: float,
        timeline_h: float,
        crop_values: Optional[Dict[str, float]] = None,
    ):
        if not clip_w or not clip_h or not timeline_w or not timeline_h:
            return None

        if effective_scaling == 4:  # stretchToFit
            base_w_px = timeline_w
            base_h_px = timeline_h
        elif effective_scaling == 0 or effective_scaling == 1:  # no scale / centerCrop
            base_w_px = clip_w
            base_h_px = clip_h
        elif effective_scaling == 3:  # scaleToCrop
            scale = max(timeline_w / clip_w, timeline_h / clip_h)
            base_w_px = clip_w * scale
            base_h_px = clip_h * scale
        elif effective_scaling == 2:  # scaleToFit
            scale = min(timeline_w / clip_w, timeline_h / clip_h)
            base_w_px = clip_w * scale
            base_h_px = clip_h * scale
        else:
            return None

        crop_values = crop_values or {}
        crop_left = crop_values.get("left", 0.0)
        crop_right = crop_values.get("right", 0.0)
        crop_top = crop_values.get("top", 0.0)
        crop_bottom = crop_values.get("bottom", 0.0)
        px_w_in_timeline = base_w_px / clip_w
        px_h_in_timeline = base_h_px / clip_h

        visible_left_px = -base_w_px / 2.0 + crop_left * px_w_in_timeline
        visible_right_px = base_w_px / 2.0 - crop_right * px_w_in_timeline
        visible_top_px = -base_h_px / 2.0 + crop_top * px_h_in_timeline
        visible_bottom_px = base_h_px / 2.0 - crop_bottom * px_h_in_timeline
        visible_polygon_px = [
            (visible_left_px, visible_top_px),
            (visible_right_px, visible_top_px),
            (visible_right_px, visible_bottom_px),
            (visible_left_px, visible_bottom_px),
        ]

        return {
            "base_w_px": base_w_px,
            "base_h_px": base_h_px,
            "px_w_in_timeline": px_w_in_timeline,
            "px_h_in_timeline": px_h_in_timeline,
            "visible_bounds_px": {
                "left": visible_left_px,
                "right": visible_right_px,
                "top": visible_top_px,
                "bottom": visible_bottom_px,
            },
            "visible_polygon_px": visible_polygon_px,
        }

    def _inverse_transform_point_pixels(
        self,
        point: Tuple[float, float],
        anchor_x: float,
        anchor_y: float,
        zoom_x: float,
        zoom_y: float,
        rotation_deg: float,
        position_x: float,
        position_y: float,
    ) -> Optional[Tuple[float, float]]:
        zoom_x = zoom_x or 1.0
        zoom_y = zoom_y or 1.0
        if abs(zoom_x) < 1e-8 or abs(zoom_y) < 1e-8:
            return None

        x = point[0] - position_x
        y = point[1] - position_y
        dx = x - anchor_x
        dy = y - anchor_y
        theta = math.radians(rotation_deg % 360)
        cos_theta = math.cos(theta)
        sin_theta = math.sin(theta)
        unrotated_x = anchor_x + dx * cos_theta + dy * sin_theta
        unrotated_y = anchor_y - dx * sin_theta + dy * cos_theta
        return (
            anchor_x + (unrotated_x - anchor_x) / zoom_x,
            anchor_y + (unrotated_y - anchor_y) / zoom_y,
        )

    def _visible_bounds_cover_viewport_pixels(
        self,
        visible_bounds_px: Dict[str, float],
        viewport_w_px: float,
        viewport_h_px: float,
        safe_zone_px: float,
        anchor_x: float,
        anchor_y: float,
        zoom_x: float,
        zoom_y: float,
        rotation_deg: float,
        position_x: float,
        position_y: float,
    ) -> Tuple[bool, List[Dict[str, Any]]]:
        safe_zone_px = max(0.0, float(safe_zone_px or 0.0))
        full_half_w = viewport_w_px / 2.0
        full_half_h = viewport_h_px / 2.0
        half_w = max(0.0, full_half_w - safe_zone_px)
        half_h = max(0.0, full_half_h - safe_zone_px)
        viewport_points = [
            (-half_w, -half_h),
            (half_w, -half_h),
            (half_w, half_h),
            (-half_w, half_h),
        ]
        inverse_points = []
        covers = True
        for viewport_point in viewport_points:
            base_point = self._inverse_transform_point_pixels(
                viewport_point,
                anchor_x,
                anchor_y,
                zoom_x,
                zoom_y,
                rotation_deg,
                position_x,
                position_y,
            )
            inside = False
            if base_point is not None:
                inside = (
                    visible_bounds_px["left"] - 1e-4 <= base_point[0] <= visible_bounds_px["right"] + 1e-4
                    and visible_bounds_px["top"] - 1e-4 <= base_point[1] <= visible_bounds_px["bottom"] + 1e-4
                )
            inverse_points.append({
                "viewport": [viewport_point[0], viewport_point[1]],
                "base": [base_point[0], base_point[1]] if base_point is not None else None,
                "inside_visible_bounds": inside,
            })
            if not inside:
                covers = False
        return covers, inverse_points

    def _compute_required_uniform_scale_for_bounds(
        self,
        visible_bounds_px: Dict[str, float],
        viewport_w_px: float,
        viewport_h_px: float,
        safe_zone_px: float,
        anchor_x: float,
        anchor_y: float,
        zoom_x: float,
        zoom_y: float,
        rotation_deg: float,
        position_x: float,
        position_y: float,
    ) -> float:
        covers, _ = self._visible_bounds_cover_viewport_pixels(
            visible_bounds_px,
            viewport_w_px,
            viewport_h_px,
            safe_zone_px,
            anchor_x,
            anchor_y,
            zoom_x,
            zoom_y,
            rotation_deg,
            position_x,
            position_y,
        )
        if covers:
            return 1.0

        low = 1.0
        high = 1.0
        while high < 32.0:
            high *= 1.5
            covers, _ = self._visible_bounds_cover_viewport_pixels(
                visible_bounds_px,
                viewport_w_px,
                viewport_h_px,
                safe_zone_px,
                anchor_x,
                anchor_y,
                zoom_x * high,
                zoom_y * high,
                rotation_deg,
                position_x,
                position_y,
            )
            if covers:
                break
        if high >= 32.0:
            return high

        for _ in range(32):
            mid = (low + high) / 2.0
            covers, _ = self._visible_bounds_cover_viewport_pixels(
                visible_bounds_px,
                viewport_w_px,
                viewport_h_px,
                safe_zone_px,
                anchor_x,
                anchor_y,
                zoom_x * mid,
                zoom_y * mid,
                rotation_deg,
                position_x,
                position_y,
            )
            if covers:
                high = mid
            else:
                low = mid
        return high

    def _analyze_black_border_risk(self, item, timeline_w: float, timeline_h: float, mismatch_behavior: str, timeline_mismatch: str = None, project_mismatch: str = None, safe_zone: int = 0) -> Dict[str, Any]:
        zoom_x = self._safe_float(item.GetProperty("ZoomX"), 1.0) or 1.0
        zoom_y = self._safe_float(item.GetProperty("ZoomY"), 1.0) or 1.0
        rotation_deg = self._get_rotation_degrees(item)
        position_x = self._safe_float(item.GetProperty("PositionX"), 0.0) or 0.0
        position_y = self._safe_float(item.GetProperty("PositionY"), 0.0) or 0.0
        anchor_x, anchor_y = self._get_anchor_point(item)
        transform_rotation_deg = -rotation_deg
        transform_position_y = -position_y
        transform_anchor_y = -anchor_y

        mp_item = item.GetMediaPoolItem()
        if not mp_item:
            return {"has_black_border": False}

        clip_w, clip_h = self._parse_resolution(mp_item.GetClipProperty("Resolution"))
        if not clip_w or not clip_h:
            return {"has_black_border": False}

        resolved_mismatch = self._normalize_mismatch_behavior(mismatch_behavior, timeline_mismatch, project_mismatch) or "scaleToFit"
        scaling_mode = item.GetProperty("Scaling")
        effective_scaling = self._resolve_effective_scaling(scaling_mode, resolved_mismatch)
        crop_values = self._get_crop_values(item, clip_w, clip_h)
        display_geometry = self._compute_full_display_geometry(
            clip_w, clip_h, effective_scaling, timeline_w, timeline_h, crop_values
        )
        if not display_geometry:
            return {"has_black_border": False}

        safe_zone_px = max(0.0, self._safe_float(safe_zone, 0.0) or 0.0)
        visible_bounds_px = display_geometry["visible_bounds_px"]
        covers_viewport, inverse_viewport_points_px = self._visible_bounds_cover_viewport_pixels(
            visible_bounds_px,
            timeline_w,
            timeline_h,
            safe_zone_px,
            anchor_x,
            transform_anchor_y,
            zoom_x,
            zoom_y,
            transform_rotation_deg,
            position_x,
            transform_position_y,
        )
        has_black_border = not covers_viewport

        visible_center_x = (visible_bounds_px["left"] + visible_bounds_px["right"]) / 2.0
        visible_center_y = (visible_bounds_px["top"] + visible_bounds_px["bottom"]) / 2.0
        transformed_center_px = self._transform_polygon_pixels(
            [(visible_center_x, visible_center_y)],
            anchor_x,
            transform_anchor_y,
            zoom_x,
            zoom_y,
            transform_rotation_deg,
            position_x,
            transform_position_y,
        )[0]
        transformed_polygon_px = self._transform_polygon_pixels(
            display_geometry["visible_polygon_px"],
            anchor_x,
            transform_anchor_y,
            zoom_x,
            zoom_y,
            transform_rotation_deg,
            position_x,
            transform_position_y,
        )
        effective_w_px = max(0.0001, (visible_bounds_px["right"] - visible_bounds_px["left"]) * zoom_x)
        effective_h_px = max(0.0001, (visible_bounds_px["bottom"] - visible_bounds_px["top"]) * zoom_y)
        effective_w = effective_w_px / timeline_w
        effective_h = effective_h_px / timeline_h
        offset_x_px = transformed_center_px[0]
        offset_y_px = -transformed_center_px[1]
        offset_x = offset_x_px / timeline_w
        offset_y = offset_y_px / timeline_h

        required_scale = self._compute_required_uniform_scale_for_bounds(
            visible_bounds_px,
            timeline_w,
            timeline_h,
            safe_zone_px,
            anchor_x,
            transform_anchor_y,
            zoom_x,
            zoom_y,
            transform_rotation_deg,
            position_x,
            transform_position_y,
        )

        return {
            "has_black_border": has_black_border,
            "analysis": {
                "clip_resolution": [clip_w, clip_h],
                "timeline_resolution": [timeline_w, timeline_h],
                "mismatch_behavior": resolved_mismatch,
                "scaling_mode": scaling_mode,
                "effective_scaling": effective_scaling,
                "zoom_x": zoom_x,
                "zoom_y": zoom_y,
                "position_x": position_x,
                "position_y": position_y,
                "anchor_x": anchor_x,
                "anchor_y": anchor_y,
                "rotation_deg": rotation_deg,
                "transform_anchor_y": transform_anchor_y,
                "transform_rotation_deg": transform_rotation_deg,
                "transform_position_y": transform_position_y,
                "display_w": effective_w,
                "display_h": effective_h,
                "offset_x": offset_x,
                "offset_y": offset_y,
                "display_w_px": effective_w_px,
                "display_h_px": effective_h_px,
                "offset_x_px": offset_x_px,
                "offset_y_px": offset_y_px,
                "safe_zone_px": safe_zone_px,
                "base_w_px": display_geometry["base_w_px"],
                "base_h_px": display_geometry["base_h_px"],
                "px_w_in_timeline": display_geometry["px_w_in_timeline"],
                "px_h_in_timeline": display_geometry["px_h_in_timeline"],
                "visible_bounds_px": visible_bounds_px,
                "visible_polygon_px": display_geometry["visible_polygon_px"],
                "transformed_polygon_px": transformed_polygon_px,
                "inverse_viewport_points_px": inverse_viewport_points_px,
                "required_scale": required_scale,
                "crop": crop_values,
            },
            "reason": "画面可见区域未覆盖时间线安全区域" if has_black_border else "",
        }

    def _find_timeline_item(self, timeline, track_index: int, start_frame: int, end_frame: int):
        items = timeline.GetItemListInTrack("video", track_index) or []
        for item in items:
            if int(item.GetStart()) == int(start_frame) and int(item.GetEnd()) == int(end_frame):
                return item
        for item in items:
            if int(item.GetStart()) <= int(start_frame) < int(item.GetEnd()):
                return item
        return None

    def auto_scale_black_border_issue(self, issue: Dict[str, Any]) -> Dict[str, Any]:
        if not self.resolve:
            return {"status": "success", "mode": "mock", "message": "模拟模式 - 已自动缩放并添加复查标签"}

        try:
            self._refresh_context()
            timeline = self._get_active_timeline()
            if not timeline:
                return {"status": "error", "message": "当前工程中没有可用时间线"}

            track = int(issue.get("track", 0))
            start_frame = int(issue.get("start", 0))
            end_frame = int(issue.get("end", 0))
            if track <= 0:
                return {"status": "error", "message": "仅支持对视频轨道上的黑边问题自动缩放"}

            item = self._find_timeline_item(timeline, track, start_frame, end_frame)
            if not item:
                return {"status": "error", "message": "未找到对应的时间线片段"}

            timeline_w = float(self.project.GetSetting("timelineResolutionWidth") or 0)
            timeline_h = float(self.project.GetSetting("timelineResolutionHeight") or 0)
            mismatch_behavior = self.project.GetSetting("timelineInputResMismatchBehavior")
            analysis = self._analyze_black_border_risk(item, timeline_w, timeline_h, mismatch_behavior)
            required_scale = analysis.get("analysis", {}).get("required_scale", 1.0)
            if required_scale <= 1.01:
                return {"status": "success", "message": "当前片段无需额外缩放，建议人工复查确认", "applied": False}

            zoom_x = analysis["analysis"].get("zoom_x", 1.0)
            zoom_y = analysis["analysis"].get("zoom_y", 1.0)
            padding_multiplier = max(1.005, min(1.03, required_scale + 0.005))
            target_zoom_x = round(zoom_x * padding_multiplier, 4)
            target_zoom_y = round(zoom_y * padding_multiplier, 4)

            set_x = bool(item.SetProperty("ZoomX", target_zoom_x))
            set_y = bool(item.SetProperty("ZoomY", target_zoom_y))
            if not set_x or not set_y:
                return {"status": "error", "message": "自动缩放失败，达芬奇未接受缩放属性修改"}

            self.project.SetCurrentTimeline(timeline)
            self.resolve.OpenPage("edit")

            timeline_start_frame = int(timeline.GetStartFrame() or 0)
            marker_frame = max(0, start_frame - timeline_start_frame)
            marker_note = (
                f"已自动缩放到 ZoomX={target_zoom_x:.4f}, ZoomY={target_zoom_y:.4f}。"
                f" 原因: {analysis.get('reason') or '黑边风险'}。请人工复查。"
            )
            marker_created = False
            try:
                marker_created = bool(timeline.AddMarker(marker_frame, "Cyan", "自动缩放复查", marker_note, max(1, int(issue.get("duration", 1))), "check_issue:auto_scale_review"))
            except Exception:
                try:
                    marker_created = bool(timeline.AddMarker(marker_frame, "Blue", "自动缩放复查", marker_note, max(1, int(issue.get("duration", 1)))))
                except Exception:
                    marker_created = False

            return {
                "status": "success",
                "applied": True,
                "marker_created": marker_created,
                "new_zoom_x": target_zoom_x,
                "new_zoom_y": target_zoom_y,
                "required_scale": required_scale,
                "message": "已自动放大到无黑边范围，并添加复查标签，请人工检查最终画面",
            }
        except Exception as e:
            return {"status": "error", "message": f"自动缩放失败: {str(e)}"}

    def init_project(self, project_name: str, local_path: str) -> Dict[str, Any]:
        """
        初始化项目，包含创建达芬奇内部媒体池结构树、自动导入素材，并通过在达芬奇内创建一条带标记的时间线来记录本地关联路径
        """
        project_dir = local_path # 直接使用选择的路径，不再需要本地创建文件夹和写入权限
        
        # 加载自定义文件夹配置
        folder_config = load_folder_config()
        davinci_folders_config = folder_config.get("davinci_folders", [])
        folder_mapping = folder_config.get("mapping", {})

        if not self.resolve:
            existing = get_project_record(project_name)
            if existing and existing.get("local_path"):
                return {"status": "error", "code": "duplicate_project_name", "message": "项目名称已存在，请重命名后再创建"}
            update_project_record(project_name, {
                "project_name": project_name,
                "local_path": project_dir,
                "path_source": "manual_create_mock",
            })
            return {
                "status": "success", 
                "mode": "mock",
                "project_name": project_name, 
                "local_path": project_dir,
                "message": "模拟模式 - 成功初始化达芬奇结构并记录路径"
            }
            
        try:
            pm = self.project_manager or self.resolve.GetProjectManager()
            if not pm:
                return {"status": "error", "message": "无法获取达芬奇 ProjectManager"}
            self.project_manager = pm

            if self._is_placeholder_project_name(project_name):
                return {"status": "error", "message": "项目名称不可用，请输入有效名称"}

            existing_names = self._list_project_names()
            if existing_names and project_name in existing_names:
                return {"status": "error", "code": "duplicate_project_name", "message": "项目名称已存在，请重命名后再创建"}

            current = pm.GetCurrentProject()
            current_name = current.GetName() if current else None
            if current_name and current_name == project_name and not self._is_placeholder_project_name(current_name):
                return {"status": "error", "code": "duplicate_project_name", "message": "项目名称已存在，请重命名后再创建"}

            if not existing_names:
                prev_name = current_name
                loaded = None
                try:
                    loaded = pm.LoadProject(project_name)
                except Exception:
                    loaded = None
                if loaded:
                    if prev_name and prev_name != project_name:
                        try:
                            pm.LoadProject(prev_name)
                        except Exception:
                            pass
                    self.project = current
                    return {"status": "error", "code": "duplicate_project_name", "message": "项目名称已存在，请重命名后再创建"}
                if prev_name and prev_name != project_name:
                    try:
                        pm.LoadProject(prev_name)
                    except Exception:
                        pass

            project = pm.CreateProject(project_name)
            if not project:
                return {"status": "error", "message": "创建项目失败（可能重名或达芬奇拒绝创建）"}
            
            self.project = project
            self.media_pool = self.project.GetMediaPool()
            
            # 创建文件夹结构树
            root_folder = self.media_pool.GetRootFolder()
            
            # 1. 创建用户自定义的达芬奇文件夹结构
            for d_folder in davinci_folders_config:
                self._get_or_create_davinci_folder(root_folder, d_folder)
                
            # 强制创建时间线和时间线备份文件夹
            self._get_or_create_davinci_folder(root_folder, "时间线")
            self._get_or_create_davinci_folder(root_folder, "时间线备份")

            # 2. 自动扫描选择的本地目录并根据映射规则导入
            imported_videos = []
            
            # 遍历所选的本地根目录寻找媒体文件
            for root_dir, dirs, files in os.walk(local_path):
                if not files:
                    continue
                    
                # 计算相对路径，例如 "01原始素材/摄影机素材"
                rel_path = os.path.relpath(root_dir, local_path).replace('\\', '/')
                if rel_path == '.':
                    rel_path = ""
                    
                # 检查该本地路径是否在映射中
                target_davinci_path = None
                for local_mapped, mapping_config in folder_mapping.items():
                    # 兼容旧配置(直接是字符串)和新配置(字典 {target, include_sub})
                    target_val = mapping_config
                    include_sub = True
                    if isinstance(mapping_config, dict):
                        target_val = mapping_config.get("target")
                        include_sub = mapping_config.get("include_sub", True)

                    if rel_path == local_mapped:
                        target_davinci_path = target_val
                        break
                    elif include_sub and rel_path.startswith(local_mapped + '/'):
                        # 如果允许包含子文件夹，则自动附加相对路径后缀
                        sub_path = rel_path[len(local_mapped)+1:]
                        target_davinci_path = f"{target_val}/{sub_path}"
                        break
                
                # 如果没有映射，跳过该目录下的文件
                if not target_davinci_path:
                    continue
                
                target_folder = self._get_or_create_davinci_folder(root_folder, target_davinci_path)
                
                self.media_pool.SetCurrentFolder(target_folder)
                
                # 收集要导入的文件
                files_to_import = []
                for file in files:
                    file_path = os.path.join(root_dir, file)
                    file_lower = file.lower()
                    if file_lower.endswith(('.mp4', '.mov', '.mxf', '.avi', '.mkv', '.webm', '.wav', '.mp3', '.aac', '.m4a', '.flac', '.jpg', '.png', '.jpeg')):
                        files_to_import.append(file_path)
                
                if files_to_import:
                    items = self.media_storage.AddItemListToMediaPool(files_to_import)
                    if items:
                        for item in items:
                            # 简单区分视频以返回前端
                            if item.GetClipProperty("Type") == "Video" or item.GetClipProperty("Type") == "Video + Audio":
                                imported_videos.append({
                                    "name": item.GetName(),
                                    "path": item.GetClipProperty("File Path"),
                                    "id": item.GetMediaId()
                                })
                            
            # 3. 创建初始时间线
            timeline_folder = self._get_or_create_davinci_folder(root_folder, "时间线")
            self.media_pool.SetCurrentFolder(timeline_folder)

            info_timeline_name = project_name
            info_timeline = self.media_pool.CreateEmptyTimeline(info_timeline_name)

            # 4. 记录项目路径到注册表
            project_record = update_project_record(self.project.GetName(), {
                "local_path": project_dir,
                "path_source": "manual_create",
                "imported_videos": imported_videos,
                "current_timeline": info_timeline.GetName() if info_timeline else None,
                "timeline_names": self._get_timeline_names(),
            })
                
            return {
                "status": "success",
                "project_name": self.project.GetName(),
                "local_path": project_dir,
                "imported_videos": imported_videos,
                "default_export_dir": project_record.get("default_export_dir", ""),
                "message": "达芬奇结构树初始化完成，已自动导入素材，并记录了项目路径信息"
            }
        except Exception as e:
            return {"status": "error", "message": f"初始化达芬奇项目失败: {str(e)}"}

    def import_video(self, file_path: str, target_folder_name: str = "Video") -> Dict[str, Any]:
        """
        将视频导入到指定的媒体池文件夹中
        """
        if not os.path.exists(file_path):
            return {"status": "error", "message": "文件不存在"}
            
        if not self.resolve:
            return {"status": "success", "mode": "mock", "message": "模拟模式 - 导入成功", "media_id": "mock_id"}
            
        try:
            self._refresh_context()
            root_folder = self.media_pool.GetRootFolder()
            subfolders = root_folder.GetSubFolderList()
            
            target_folder = root_folder
            for folder in subfolders:
                if folder.GetName() == target_folder_name:
                    target_folder = folder
                    break
                    
            self.media_pool.SetCurrentFolder(target_folder)
            
            items = self.media_storage.AddItemListToMediaPool([file_path])
            if items and len(items) > 0:
                media_item = items[0]
                return {
                    "status": "success", 
                    "media_name": media_item.GetName(),
                    "media_id": media_item.GetMediaId(),
                    "message": "视频导入成功"
                }
            else:
                return {"status": "error", "message": "达芬奇 API 未能返回导入的媒体项"}
                
        except Exception as e:
            return {"status": "error", "message": f"导入视频失败: {str(e)}"}

    def apply_timeline(self, timeline_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        根据生成的时间线 JSON 调用 API 自动生成时间线并剪辑
        """
        if not self.resolve:
            return self._mock_apply_timeline(timeline_data)
            
        try:
            video_path = timeline_data.get("video_path")
            clips = timeline_data.get("clips", [])
            
            # 1. 查找源媒体
            root_folder = self.media_pool.GetRootFolder()
            media_item = self._find_media_item(root_folder, os.path.basename(video_path))
            
            if not media_item:
                # 尝试重新导入
                import_res = self.import_video(video_path)
                if import_res["status"] == "error":
                    raise Exception("媒体池中未找到该视频，且重新导入失败")
                media_item = self._find_media_item(root_folder, os.path.basename(video_path))
                
            if not media_item:
                raise Exception("无法在媒体池定位视频项")
                
            # 2. 创建新时间线（归入时间线文件夹）
            timeline_name = "Text-Driven Edit " + os.path.basename(video_path)
            timeline_folder = self._get_or_create_davinci_folder(root_folder, "时间线")
            self.media_pool.SetCurrentFolder(timeline_folder)
            timeline = self.media_pool.CreateEmptyTimeline(timeline_name)
            if not timeline:
                # 若名字重复可能创建失败，尝试加时间戳
                import time
                timeline = self.media_pool.CreateEmptyTimeline(f"{timeline_name}_{int(time.time())}")
                if not timeline:
                    raise Exception("无法创建时间线")
                    
            self.project.SetCurrentTimeline(timeline)
            
            # 3. 准备批量片段数据
            clip_infos = []
            for clip in clips:
                clip_infos.append({
                    "mediaPoolItem": media_item,
                    "startFrame": int(clip["source_start_frame"]),
                    "endFrame": int(clip["source_end_frame"])
                })
                
            # 4. 调用 AppendToTimeline 批量插入片段
            added_items = self.media_pool.AppendToTimeline(clip_infos)
            
            return {
                "status": "success",
                "total_clips": len(clips),
                "added_clips": len(added_items) if added_items else 0,
                "timeline_name": timeline.GetName(),
                "message": "时间线剪辑应用成功"
            }
            
        except Exception as e:
            return {
                "status": "error",
                "message": f"应用时间线失败: {str(e)}"
            }
            
    def _find_folder_by_path(self, parent_folder, path_str: str):
        """按路径字符串查找文件夹"""
        parts = [p for p in path_str.replace('\\', '/').split('/') if p]
        current = parent_folder
        for part in parts:
            found = False
            for f in current.GetSubFolderList():
                if f.GetName() == part:
                    current = f
                    found = True
                    break
            if not found:
                return None
        return current

    def _find_media_item(self, folder, file_name: str):
        """递归查找指定名称的媒体项"""
        for clip in folder.GetClipList():
            if clip.GetName() == file_name or os.path.basename(clip.GetClipProperty("File Path")) == file_name:
                return clip
        for subfolder in folder.GetSubFolderList():
            found = self._find_media_item(subfolder, file_name)
            if found:
                return found
        return None

    def _find_media_item_by_path(self, folder, file_path: str):
        target = os.path.normpath(str(file_path or ""))
        if not target:
            return None
        try:
            clips = folder.GetClipList() or []
        except Exception:
            clips = []
        for clip in clips:
            try:
                p = clip.GetClipProperty("File Path")
            except Exception:
                p = ""
            if not p:
                continue
            if os.path.normpath(p) == target:
                return clip
        try:
            subfolders = folder.GetSubFolderList() or []
        except Exception:
            subfolders = []
        for subfolder in subfolders:
            found = self._find_media_item_by_path(subfolder, target)
            if found:
                return found
        return None

    def _find_media_item_by_media_id(self, folder, media_id: str):
        target = str(media_id or "").strip()
        if not target:
            return None
        try:
            clips = folder.GetClipList() or []
        except Exception:
            clips = []
        for clip in clips:
            try:
                clip_media_id = str(clip.GetMediaId() or "").strip()
            except Exception:
                clip_media_id = ""
            if clip_media_id and clip_media_id == target:
                return clip
        try:
            subfolders = folder.GetSubFolderList() or []
        except Exception:
            subfolders = []
        for subfolder in subfolders:
            found = self._find_media_item_by_media_id(subfolder, target)
            if found:
                return found
        return None

    def _timecode_to_frames(self, timecode: str, fps: float) -> int:
        tc = str(timecode or "").strip()
        parts = tc.split(":")
        if len(parts) != 4:
            return 0
        try:
            h = int(parts[0])
            m = int(parts[1])
            s = int(parts[2])
            f = int(parts[3])
        except Exception:
            return 0
        fr = float(fps or 24)
        base = int(round(fr))
        if base == 23:
            fr = 23.976
            base = 24
        elif base == 29:
            fr = 29.97
            base = 30
        elif base == 59:
            fr = 59.94
            base = 60
        seconds = (h * 3600) + (m * 60) + s + (f / fr)
        return int(math.floor(base * seconds + 0.5))

    def _clip_property_frame_value(self, clip_prop: Dict[str, Any], key: str, fps: float) -> Optional[int]:
        value = (clip_prop or {}).get(key)
        if value is None or value == "":
            return None
        try:
            return int(float(value))
        except Exception:
            pass
        text = str(value).strip().replace(";", ":")
        if text.count(":") == 3:
            return self._timecode_to_frames(text, fps)
        return None

    def _describe_media_pool_item(self, item) -> Dict[str, Any]:
        if not item:
            return {}
        media_name = ""
        media_id = ""
        media_path = ""
        try:
            media_name = item.GetName() or ""
        except Exception:
            media_name = ""
        try:
            media_id = item.GetMediaId() or ""
        except Exception:
            media_id = ""
        try:
            media_path = item.GetClipProperty("File Path") or ""
        except Exception:
            media_path = ""
        return {
            "media_name": media_name,
            "media_id": media_id,
            "media_path": media_path,
        }

    def ensure_audio_media_pool_item(self, file_path: str, media_id: Optional[str] = None) -> Dict[str, Any]:
        if not file_path or not os.path.exists(file_path):
            return {"status": "error", "message": "文件不存在"}
        if not self.resolve:
            return {
                "status": "success",
                "mode": "mock",
                "created": False,
                "media_name": os.path.basename(file_path),
                "media_id": media_id or "mock_audio_id",
                "media_path": file_path,
            }
        try:
            self._refresh_context()
            if not self.project or not self.media_pool or not self.media_storage:
                return {"status": "error", "message": "未连接达芬奇项目"}
            root_folder = self.media_pool.GetRootFolder() if self.media_pool else None
            existing_item = None
            if root_folder and media_id:
                existing_item = self._find_media_item_by_media_id(root_folder, media_id)
            if not existing_item and root_folder:
                existing_item = self._find_media_item_by_path(root_folder, file_path)
            if not existing_item and root_folder:
                existing_item = self._find_media_item(root_folder, os.path.basename(file_path))
            if existing_item:
                payload = self._describe_media_pool_item(existing_item)
                payload.update({"status": "success", "created": False})
                return payload
            items = self.media_storage.AddItemListToMediaPool([file_path]) if self.media_storage else None
            if items and len(items) > 0:
                payload = self._describe_media_pool_item(items[0])
                payload.update({"status": "success", "created": True})
                return payload
            return {"status": "error", "message": "导入音频到媒体池失败"}
        except Exception as e:
            return {"status": "error", "message": f"导入音频到媒体池失败: {str(e)}"}

    def _resolve_audio_media_pool_item(self, file_path: str, media_id: Optional[str] = None):
        if not file_path or not os.path.exists(file_path):
            return None
        root_folder = self.media_pool.GetRootFolder() if self.media_pool else None
        item = self._find_media_item_by_media_id(root_folder, media_id) if root_folder and media_id else None
        if not item:
            item = self._find_media_item_by_path(root_folder, file_path) if root_folder else None
        if not item and root_folder:
            item = self._find_media_item(root_folder, os.path.basename(file_path))
        if item:
            return item
        if not self.media_storage:
            return None
        try:
            items = self.media_storage.AddItemListToMediaPool([file_path])
        except Exception:
            items = None
        if items and len(items) > 0:
            return items[0]
        return None

    def _build_audio_append_clip_info(
        self,
        item,
        fps: float,
        record_frame: int,
        track_index: int,
        in_point: Optional[float] = None,
        out_point: Optional[float] = None,
    ) -> Dict[str, Any]:
        clip_prop = {}
        try:
            clip_prop = item.GetClipProperty() or {}
        except Exception:
            clip_prop = {}

        base_start = self._clip_property_frame_value(clip_prop, "Start", fps) or 0
        base_end = self._clip_property_frame_value(clip_prop, "End", fps)
        if base_end is None:
            duration_frames = self._clip_property_frame_value(clip_prop, "Duration", fps)
            if duration_frames and duration_frames > 0:
                base_end = base_start + duration_frames
        if base_end is None:
            try:
                duration_frames = int(item.GetDuration())
            except Exception:
                duration_frames = 0
            if duration_frames > 0:
                base_end = base_start + duration_frames

        start_frame = base_start
        end_frame = base_end
        if isinstance(in_point, (int, float)) and float(in_point) >= 0:
            start_frame = base_start + int(math.floor(float(in_point) * fps + 0.5))
        if isinstance(out_point, (int, float)) and float(out_point) >= 0:
            end_frame = base_start + int(math.floor(float(out_point) * fps + 0.5))
        if end_frame is not None and end_frame < start_frame:
            start_frame, end_frame = end_frame, start_frame

        clip_info = {
            "mediaPoolItem": item,
            "startFrame": int(start_frame),
            "recordFrame": int(record_frame),
            "mediaType": 2,
            "trackIndex": int(max(1, int(track_index or 1))),
        }
        if end_frame is not None:
            clip_info["endFrame"] = int(end_frame)
        return clip_info

    def _estimate_audio_append_duration_frames(
        self,
        item,
        fps: float,
        in_point: Optional[float] = None,
        out_point: Optional[float] = None,
    ) -> int:
        clip_info = self._build_audio_append_clip_info(
            item,
            fps=fps,
            record_frame=0,
            track_index=1,
            in_point=in_point,
            out_point=out_point,
        )
        try:
            if "endFrame" in clip_info:
                return max(1, int(clip_info["endFrame"]) - int(clip_info.get("startFrame") or 0))
        except Exception:
            pass
        return 1

    def _append_audio_segment_at_record_frame(
        self,
        file_path: str,
        record_frame: int,
        track_index: int,
        in_point: Optional[float] = None,
        out_point: Optional[float] = None,
    ) -> Dict[str, Any]:
        if not self.project or not self.media_pool or not self.media_storage:
            return {"status": "error", "message": "未连接达芬奇项目"}
        timeline = self._get_active_timeline(allow_fallback=True)
        if not timeline:
            return {"status": "error", "message": "当前项目没有可用时间线"}
        try:
            fps = float(timeline.GetSetting("timelineFrameRate") or self.project.GetSetting("timelineFrameRate") or 24)
        except Exception:
            fps = 24.0

        item = self._resolve_audio_media_pool_item(file_path)
        if not item:
            return {"status": "error", "message": "无法导入音效到媒体池"}

        clip_info = self._build_audio_append_clip_info(
            item,
            fps=fps,
            record_frame=int(record_frame),
            track_index=int(track_index or 1),
            in_point=in_point,
            out_point=out_point,
        )
        added = self.media_pool.AppendToTimeline([clip_info])
        if not added:
            return {"status": "error", "message": "达芬奇未返回新增的时间线片段"}
        return {
            "status": "success",
            "added": len(added) if added else 0,
            "recordFrame": int(record_frame),
            "startFrame": int(clip_info.get("startFrame") or 0),
            "endFrame": int(clip_info.get("endFrame") or 0) if "endFrame" in clip_info else None,
        }

    def _find_audio_timeline_item(
        self,
        timeline,
        track_index: int,
        start_frame: int,
        end_frame: Optional[int] = None,
        file_path: Optional[str] = None,
        basename: Optional[str] = None,
        media_id: Optional[str] = None,
    ):
        if not timeline:
            return None
        try:
            items = timeline.GetItemListInTrack("audio", int(max(1, int(track_index or 1)))) or []
        except Exception:
            items = []

        normalized_path = os.path.normpath(str(file_path or "")) if file_path else ""
        normalized_basename = os.path.basename(str(basename or "")) if basename else ""
        normalized_media_id = str(media_id or "").strip()
        exact_matches = []
        relaxed_matches = []
        for item in items:
            try:
                item_start = int(item.GetStart())
                item_end = int(item.GetEnd())
            except Exception:
                continue
            if item_start != int(start_frame):
                continue

            clip_path = ""
            clip_basename = ""
            clip_media_id = ""
            try:
                mp_item = item.GetMediaPoolItem()
                clip_path = mp_item.GetClipProperty("File Path") if mp_item else ""
                clip_basename = os.path.basename(clip_path or "")
                clip_media_id = str(mp_item.GetMediaId() or "").strip() if mp_item else ""
            except Exception:
                clip_path = ""
                clip_basename = ""
                clip_media_id = ""

            exact_media_id = normalized_media_id and clip_media_id == normalized_media_id
            exact_path = normalized_path and clip_path and os.path.normpath(clip_path) == normalized_path
            exact_name = normalized_basename and clip_basename == normalized_basename
            score = 3 if exact_media_id else 2 if exact_path else 1 if exact_name else 0
            if end_frame is not None and item_end == int(end_frame):
                exact_matches.append((score, item))
            else:
                relaxed_matches.append((score, item))

        matches = exact_matches or relaxed_matches
        if not matches:
            return None
        matches.sort(key=lambda pair: pair[0], reverse=True)
        return matches[0][1]

    def replace_dropped_audio_with_trimmed_segment(
        self,
        file_path: str,
        track_index: int,
        record_frame: int,
        dropped_start_frame: int,
        dropped_end_frame: Optional[int] = None,
        in_point: Optional[float] = None,
        out_point: Optional[float] = None,
        source_path_hint: Optional[str] = None,
        source_media_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        if not file_path or not os.path.exists(file_path):
            return {"status": "error", "message": "文件不存在"}
        if not self.resolve:
            return {"status": "success", "mode": "mock", "message": "模拟模式 - 已替换为带 IO 片段", "trim_applied": True}
        try:
            self._refresh_context()
            if not self.project or not self.media_pool or not self.media_storage:
                return {"status": "error", "message": "未连接达芬奇项目"}
            timeline = self._get_active_timeline(allow_fallback=True)
            if not timeline:
                return {"status": "error", "message": "当前项目没有可用时间线"}

            has_in = isinstance(in_point, (int, float)) and float(in_point) >= 0
            has_out = isinstance(out_point, (int, float)) and float(out_point) >= 0
            if not has_in and not has_out:
                return {"status": "success", "trim_applied": False, "message": "未设置 IO，保留整段片段"}
            if has_in and has_out and float(out_point) <= float(in_point):
                return {"status": "error", "message": "IO 区间无效"}

            try:
                is_locked = bool(timeline.GetIsTrackLocked("audio", int(max(1, int(track_index or 1)))))
            except Exception:
                is_locked = False
            if is_locked:
                return {"status": "error", "message": f"目标音频轨 A{int(track_index or 1)} 已锁定"}

            target_item = self._find_audio_timeline_item(
                timeline,
                track_index=int(track_index or 1),
                start_frame=int(dropped_start_frame),
                end_frame=int(dropped_end_frame) if dropped_end_frame is not None else None,
                file_path=source_path_hint,
                basename=os.path.basename(source_path_hint or file_path),
                media_id=source_media_id,
            )
            if not target_item:
                target_item = self._find_audio_timeline_item(
                    timeline,
                    track_index=int(track_index or 1),
                    start_frame=int(dropped_start_frame),
                    end_frame=int(dropped_end_frame) if dropped_end_frame is not None else None,
                    file_path=file_path,
                    basename=os.path.basename(file_path),
                    media_id=source_media_id,
                )
            if not target_item:
                return {"status": "error", "message": "未找到刚拖入时间线的音频片段"}

            source_item = None
            try:
                source_item = target_item.GetMediaPoolItem()
            except Exception:
                source_item = None
            if not source_item:
                source_item = self._resolve_audio_media_pool_item(file_path, media_id=source_media_id)
            if not source_item:
                return {"status": "error", "message": "未找到可用于裁切插入的媒体池素材"}

            try:
                fps = float(timeline.GetSetting("timelineFrameRate") or self.project.GetSetting("timelineFrameRate") or 24)
            except Exception:
                fps = 24.0

            relinked = False
            relink_error = ""
            if file_path and os.path.exists(file_path):
                try:
                    source_item.ReplaceClip(file_path)
                    relinked = True
                except Exception as exc:
                    relink_error = str(exc)

            deleted = False
            try:
                deleted = bool(timeline.DeleteClips([target_item], False))
            except Exception as exc:
                return {"status": "error", "message": f"删除原始时间线片段失败: {str(exc)}"}
            if not deleted:
                return {"status": "error", "message": "未能删除原始整段片段"}

            clip_info = self._build_audio_append_clip_info(
                source_item,
                fps=fps,
                record_frame=int(record_frame),
                track_index=int(track_index or 1),
                in_point=in_point,
                out_point=out_point,
            )
            added = self.media_pool.AppendToTimeline([clip_info])
            append_result = {
                "status": "success",
                "added": len(added) if added else 0,
                "recordFrame": int(record_frame),
                "startFrame": int(clip_info.get("startFrame") or 0),
                "endFrame": int(clip_info.get("endFrame") or 0) if "endFrame" in clip_info else None,
                "sourceMediaId": source_item.GetMediaId() if source_item else "",
                "sourceMediaPath": source_item.GetClipProperty("File Path") if source_item else "",
            }
            if not added:
                return {"status": "error", "message": "删除原始整段后，达芬奇未返回新的裁切片段"}

            return {
                "status": "success",
                "trim_applied": True,
                "recordFrame": int(record_frame),
                "trackIndex": int(track_index or 1),
                "startFrame": append_result.get("startFrame"),
                "endFrame": append_result.get("endFrame"),
                "relinked": relinked,
                "relink_error": relink_error,
                "sourceMediaId": append_result.get("sourceMediaId"),
                "sourceMediaPath": append_result.get("sourceMediaPath"),
                "message": "已将拖入的整段片段替换为带 IO 的时间线片段",
            }
        except Exception as e:
            return {"status": "error", "message": f"替换拖入音频失败: {str(e)}"}

    def _find_best_audio_track(self, timeline, fps: float, record_frame: int, end_frame: int) -> int:
        """找到播放头位置不与已有片段重叠的音频轨道，若全占用则创建新轨道"""
        audio_track_count = 0
        try:
            audio_track_count = timeline.GetTrackCount("audio") or 0
        except Exception:
            pass

        for track_idx in range(1, audio_track_count + 1):
            try:
                clips = timeline.GetItemListInTrack("audio", track_idx) or []
            except Exception:
                clips = []
            overlaps = False
            for clip in clips:
                try:
                    clip_start = int(clip.GetStart())
                    clip_end = int(clip.GetEnd())
                except Exception:
                    continue
                if not (end_frame <= clip_start or record_frame >= clip_end):
                    overlaps = True
                    break
            if not overlaps:
                return track_idx

        try:
            timeline.AddTrack("audio")
        except Exception:
            pass
        return audio_track_count + 1

    def insert_audio_segment_to_timeline(self, file_path: str, in_point: Optional[float] = None, out_point: Optional[float] = None, track_index: int = 1, media_pool_item=None) -> Dict[str, Any]:
        if not file_path:
            return {"status": "error", "message": "文件路径为空"}
        if not self.resolve:
            return {"status": "success", "mode": "mock", "message": "模拟模式 - 已插入时间线"}
        try:
            if not self.project or not self.media_pool or not self.media_storage:
                self._refresh_context()
            if not self.project or not self.media_pool or not self.media_storage:
                return {"status": "error", "message": "未连接达芬奇项目"}

            # 优先不刷新获取时间线，避免 media_pool_item 因 _refresh_context 而过期
            timeline = None
            try:
                timeline = self.project.GetCurrentTimeline()
            except Exception:
                pass
            if not timeline:
                timeline = self._get_active_timeline(allow_fallback=True)
                # 刷新后 media_pool_item 可能已过期，按 media_id 重新查找
                if timeline and media_pool_item:
                    try:
                        item_id = str(media_pool_item.GetMediaId() or "")
                        root = self.media_pool.GetRootFolder()
                        media_pool_item = self._find_media_item_by_media_id(root, item_id) if item_id else None
                    except Exception:
                        media_pool_item = None
            if not timeline:
                return {"status": "error", "message": "当前项目没有可用时间线"}

            try:
                fps = float(timeline.GetSetting("timelineFrameRate") or self.project.GetSetting("timelineFrameRate") or 24)
            except Exception:
                fps = 24.0

            item = media_pool_item if media_pool_item else self._resolve_audio_media_pool_item(file_path)
            if not item:
                return {"status": "error", "message": "无法找到音效到媒体池"}

            tc = ""
            try:
                tc = timeline.GetCurrentTimecode()
            except Exception:
                tc = ""
            record_frame = self._timecode_to_frames(tc, fps)

            resolved_track_index = int(track_index) if track_index and int(track_index) > 0 else 0
            if resolved_track_index <= 0:
                # 估算插入片段的结束帧，用于智能轨道选择
                clip_duration_frames = self._estimate_audio_append_duration_frames(
                    item,
                    fps=fps,
                    in_point=in_point,
                    out_point=out_point,
                )
                estimated_end = record_frame + max(clip_duration_frames, 1)
                resolved_track_index = self._find_best_audio_track(timeline, fps, int(record_frame), int(estimated_end))

            clip_info = self._build_audio_append_clip_info(
                item,
                fps=fps,
                record_frame=int(record_frame),
                track_index=resolved_track_index,
                in_point=in_point,
                out_point=out_point,
            )

            added = self.media_pool.AppendToTimeline([clip_info])
            if not added:
                return {"status": "error", "message": "达芬奇未返回新增的时间线片段"}
            return {
                "status": "success",
                "added": len(added) if added else 0,
                "recordFrame": int(record_frame),
                "trackIndex": resolved_track_index,
                "startFrame": int(clip_info.get("startFrame") or 0),
                "endFrame": int(clip_info.get("endFrame") or 0) if "endFrame" in clip_info else None,
            }
        except Exception as e:
            return {"status": "error", "message": f"插入音效失败: {str(e)}"}

    def backup_timeline_only(self, file_name_template: str, timeline_name: Optional[str] = None, use_subfolder: bool = False, subfolder_name: Optional[str] = None) -> Dict[str, Any]:
        if not self.resolve:
            return {"status": "error", "message": "未连接达芬奇，请先打开达芬奇并确保脚本服务已启动"}

        try:
            self._refresh_context()

            if not self.project:
                return {"status": "error", "message": "未连接达芬奇，请先打开达芬奇并确保脚本服务已启动"}

            timeline = None
            if timeline_name:
                for i in range(1, self.project.GetTimelineCount() + 1):
                    tl = self.project.GetTimelineByIndex(i)
                    if tl.GetName() == timeline_name:
                        timeline = tl
                        self.project.SetCurrentTimeline(timeline)
                        break

            if not timeline:
                timeline = self._get_active_timeline()

            if not timeline:
                return {"status": "error", "message": "当前没有打开的时间线，请在达芬奇中打开一个时间线后再试"}

            import datetime
            now = datetime.datetime.now()
            resolved_name = file_name_template
            resolved_name = resolved_name.replace("%ProjectName%", self.project.GetName())
            resolved_name = resolved_name.replace("%TimelineName%", timeline.GetName())
            resolved_name = resolved_name.replace("%Date%", now.strftime("%Y%m%d"))
            resolved_name = resolved_name.replace("%Time%", now.strftime("%H%M%S"))

            import re
            datetime_pattern = re.compile(r'%DateTime:((?:%[A-Za-z]|[^%])+)%')
            for match in datetime_pattern.finditer(resolved_name):
                fmt = match.group(1)
                resolved_val = now.strftime(fmt)
                resolved_name = resolved_name.replace(match.group(0), resolved_val, 1)
            resolved_name = resolved_name.replace("%DateTime%", now.strftime("%Y%m%d"))

            backup_name = f"{resolved_name}_自主备份"

            backup_timeline = timeline.DuplicateTimeline(backup_name)
            if backup_timeline:
                root_folder = self.media_pool.GetRootFolder()
                backup_folder = self._find_folder_by_path(root_folder, "时间线备份")
                if backup_folder:
                    if use_subfolder and subfolder_name:
                        resolved_subfolder = subfolder_name
                        resolved_subfolder = resolved_subfolder.replace("%ProjectName%", self.project.GetName())
                        resolved_subfolder = resolved_subfolder.replace("%TimelineName%", timeline.GetName())
                        resolved_subfolder = resolved_subfolder.replace("%Date%", now.strftime("%Y%m%d"))
                        resolved_subfolder = resolved_subfolder.replace("%Time%", now.strftime("%H%M%S"))
                        for match in datetime_pattern.finditer(resolved_subfolder):
                            fmt = match.group(1)
                            resolved_subfolder = resolved_subfolder.replace(match.group(0), now.strftime(fmt), 1)
                        resolved_subfolder = resolved_subfolder.replace("%DateTime%", now.strftime("%Y%m%d"))
                        backup_folder = self._get_or_create_davinci_folder(backup_folder, resolved_subfolder)

                    backup_item = None
                    folders_to_search = [root_folder]
                    for folder in list(folders_to_search):
                        sub_folders = folder.GetSubFolderList()
                        if sub_folders:
                            folders_to_search.extend(sub_folders)
                    for folder in folders_to_search:
                        for clip in folder.GetClipList():
                            if clip.GetName() == backup_name:
                                backup_item = clip
                                break
                        if backup_item:
                            break
                    if backup_item:
                        self.media_pool.MoveClips([backup_item], backup_folder)

            self.project.SetCurrentTimeline(timeline)

            return {
                "status": "success",
                "message": f"已备份时间线: {backup_name}",
                "resolved_name": backup_name,
                "timeline_name": timeline.GetName(),
            }

        except Exception as e:
            return {"status": "error", "message": f"备份失败: {str(e)}"}

    def export_timeline(self, target_dir: str, file_name_template: str, preset_name: Optional[str] = None, timeline_name: Optional[str] = None, use_subfolder: bool = False, subfolder_name: Optional[str] = None) -> Dict[str, Any]:
        if not self.resolve:
            return {"status": "error", "message": "未连接达芬奇，请先打开达芬奇并确保脚本服务已启动"}

        try:
            self._refresh_context()

            if not self.project:
                return {"status": "error", "message": "未连接达芬奇，请先打开达芬奇并确保脚本服务已启动"}

            timeline = None
            if timeline_name:
                for i in range(1, self.project.GetTimelineCount() + 1):
                    tl = self.project.GetTimelineByIndex(i)
                    if tl.GetName() == timeline_name:
                        timeline = tl
                        self.project.SetCurrentTimeline(timeline)
                        break

            if not timeline:
                timeline = self._get_active_timeline()

            if not timeline:
                return {"status": "error", "message": "当前没有打开的时间线，请在达芬奇中打开一个时间线后再试"}

            import datetime
            now = datetime.datetime.now()
            resolved_name = file_name_template
            resolved_name = resolved_name.replace("%ProjectName%", self.project.GetName())
            resolved_name = resolved_name.replace("%TimelineName%", timeline.GetName())
            resolved_name = resolved_name.replace("%Date%", now.strftime("%Y%m%d"))
            resolved_name = resolved_name.replace("%Time%", now.strftime("%H%M%S"))

            import re
            datetime_pattern = re.compile(r'%DateTime:((?:%[A-Za-z]|[^%])+)%')
            for match in datetime_pattern.finditer(resolved_name):
                fmt = match.group(1)
                resolved_name = resolved_name.replace(match.group(0), now.strftime(fmt), 1)
            resolved_name = resolved_name.replace("%DateTime%", now.strftime("%Y%m%d"))

            if not target_dir:
                context = self._build_project_context(include_media=False, persist=True)
                target_dir = context.get("default_export_dir", "") or context.get("local_path", "")

            if not target_dir:
                return {"status": "error", "message": "未设置导出路径，请选择一个导出目录"}

            resolved_dir = target_dir
            resolved_dir = resolved_dir.replace("%ProjectName%", self.project.GetName())
            resolved_dir = resolved_dir.replace("%TimelineName%", timeline.GetName())
            resolved_dir = resolved_dir.replace("%Date%", now.strftime("%Y%m%d"))
            resolved_dir = resolved_dir.replace("%Time%", now.strftime("%H%M%S"))
            for match in datetime_pattern.finditer(resolved_dir):
                fmt = match.group(1)
                resolved_dir = resolved_dir.replace(match.group(0), now.strftime(fmt), 1)
            resolved_dir = resolved_dir.replace("%DateTime%", now.strftime("%Y%m%d"))

            backup_timeline = timeline.DuplicateTimeline(resolved_name)
            if backup_timeline:
                root_folder = self.media_pool.GetRootFolder()
                backup_folder = self._find_folder_by_path(root_folder, "时间线备份")
                if backup_folder:
                    if use_subfolder and subfolder_name:
                        resolved_subfolder = subfolder_name
                        resolved_subfolder = resolved_subfolder.replace("%ProjectName%", self.project.GetName())
                        resolved_subfolder = resolved_subfolder.replace("%TimelineName%", timeline.GetName())
                        resolved_subfolder = resolved_subfolder.replace("%Date%", now.strftime("%Y%m%d"))
                        resolved_subfolder = resolved_subfolder.replace("%Time%", now.strftime("%H%M%S"))
                        for match in datetime_pattern.finditer(resolved_subfolder):
                            fmt = match.group(1)
                            resolved_subfolder = resolved_subfolder.replace(match.group(0), now.strftime(fmt), 1)
                        resolved_subfolder = resolved_subfolder.replace("%DateTime%", now.strftime("%Y%m%d"))
                        backup_folder = self._get_or_create_davinci_folder(backup_folder, resolved_subfolder)

                    backup_item = None
                    folders_to_search = [root_folder]
                    for folder in list(folders_to_search):
                        sub_folders = folder.GetSubFolderList()
                        if sub_folders:
                            folders_to_search.extend(sub_folders)
                    for folder in folders_to_search:
                        for clip in folder.GetClipList():
                            if clip.GetName() == resolved_name:
                                backup_item = clip
                                break
                        if backup_item:
                            break
                    if backup_item:
                        self.media_pool.MoveClips([backup_item], backup_folder)

            self.project.SetCurrentTimeline(timeline)

            if preset_name:
                success = self.project.LoadRenderPreset(preset_name)
                if not success:
                    print(f"[WARNING] 加载渲染预设 {preset_name} 失败，将使用当前设置")

            self.project.SetRenderSettings({
                "TargetDir": resolved_dir,
                "CustomName": resolved_name
            })

            job_id = self.project.AddRenderJob()
            if not job_id:
                return {"status": "error", "message": "添加渲染任务失败，请检查达芬奇渲染设置是否正确"}

            self.project.StartRendering(job_id)

            # 等待渲染完成（检测取消/失败状态，带超时保护）
            import time
            print(f"[RENDER] 等待达芬奇渲染完成 (job: {job_id})...", flush=True)
            deadline = time.time() + 7200  # 最长等 2 小时
            idle_ticks = 0
            while time.time() < deadline:
                if not self.project.IsRenderingInProgress():
                    status = "Unknown"
                    try:
                        status = self.project.GetRenderJobStatus(job_id)
                    except Exception as e:
                        print(f"[RENDER] GetRenderJobStatus 失败: {e}, 视为渲染完成", flush=True)
                        break
                    if status in ("Completed",):
                        print(f"[RENDER] 渲染完成", flush=True)
                        break
                    elif status in ("Cancelled", "Failed"):
                        try:
                            self.project.DeleteAllRenderJobs()
                        except Exception:
                            pass
                        return {"status": "error", "message": f"达芬奇渲染被{'取消' if status == 'Cancelled' else '中断'}{'，请重试' if status == 'Cancelled' else ''} (状态: {status})"}
                    else:
                        idle_ticks += 1
                        if idle_ticks > 6:
                            print(f"[RENDER] 渲染已结束但状态未知 ({status}), 视为完成", flush=True)
                            break
                        print(f"[RENDER] 渲染非活跃状态: {status}, 继续等待...", flush=True)
                else:
                    idle_ticks = 0
                time.sleep(0.5)
            else:
                # 超时
                try:
                    self.project.DeleteAllRenderJobs()
                except Exception:
                    pass
                return {"status": "error", "message": "渲染超时（超过 2 小时），请检查达芬奇渲染队列"}

            # 清理渲染任务
            try:
                self.project.DeleteAllRenderJobs()
            except Exception:
                pass

            return {
                "status": "success",
                "message": f"渲染完成: {resolved_name}",
                "job_id": job_id,
                "resolved_name": resolved_name,
                "resolved_dir": resolved_dir,
                "timeline_name": timeline.GetName(),
            }

        except PermissionError as e:
            return {"status": "error", "message": f"没有写入权限，请在系统设置中授予本应用对导出目录的访问权限（路径: {e.filename or ''}）"}
        except FileNotFoundError as e:
            return {"status": "error", "message": f"导出路径不存在: {e.filename or ''}，请检查路径是否正确"}
        except OSError as e:
            if "Operation not permitted" in str(e) or e.errno == 1:
                return {"status": "error", "message": f"没有操作权限，请在系统设置 > 隐私与安全性 > 文件和文件夹 中授予本应用对导出目录的访问权限"}
            return {"status": "error", "message": f"导出失败: {str(e)}"}
        except Exception as e:
            return {"status": "error", "message": f"导出失败: {str(e)}"}

    def check_timeline(self, flash_frame_threshold: int = 3, check_black_frames: bool = True, check_black_borders: bool = True, black_border_safe_zone: int = 2) -> Dict[str, Any]:
        """
        检查当前时间线中的夹帧、黑帧和黑边
        """
        if not self.resolve:
            return {"status": "success", "mode": "mock", "message": "模拟模式 - 检查指令已接收", "issues": []}
            
        try:
            self._refresh_context()
            timeline = self._get_active_timeline()
            if not timeline:
                return {"status": "error", "message": "当前工程中没有可用时间线"}
                
            issues = []
            flash_frame_threshold = max(1, int(flash_frame_threshold or 1))

            def safe_float(value, default=None):
                try:
                    if value in (None, ""):
                        return default
                    return float(value)
                except (TypeError, ValueError):
                    return default

            def parse_resolution(resolution: str):
                if not resolution:
                    return None, None
                normalized = str(resolution).lower().replace(" ", "")
                if "x" not in normalized:
                    return None, None
                try:
                    width_str, height_str = normalized.split("x", 1)
                    return float(width_str), float(height_str)
                except (TypeError, ValueError):
                    return None, None

            def get_rotation_degrees(item):
                for prop_name in ("RotationAngle", "Rotation", "ZRotationAngle", "ZRotation"):
                    rotation = safe_float(item.GetProperty(prop_name))
                    if rotation is not None:
                        return abs(rotation)
                return 0.0

            def resolve_effective_scaling(raw_scaling):
                scaling_num = safe_float(raw_scaling)
                if scaling_num is not None:
                    scaling_num = int(scaling_num)
                    if scaling_num == 0:
                        if mismatch_behavior == "scaleToFit":
                            return 2
                        if mismatch_behavior in ("centerCrop", "none"):
                            return 1
                        if mismatch_behavior == "scaleToCrop":
                            return 3
                        if mismatch_behavior in ("stretchToFit", "stretch"):
                            return 4
                    return scaling_num

                scaling_str = str(raw_scaling or "").strip()
                mapping = {
                    "scaleToFit": 2,
                    "centerCrop": 1, "none": 1,
                    "scaleToCrop": 3,
                    "stretchToFit": 4, "stretch": 4,
                }
                return mapping.get(scaling_str, 2 if mismatch_behavior == "scaleToFit" else 0)

            def rotated_rect_covers_viewport(display_w, display_h, rotation_degrees):
                if not display_w or not display_h:
                    return False
                theta = math.radians(rotation_degrees % 180)
                cos_theta = math.cos(theta)
                sin_theta = math.sin(theta)
                half_w = display_w / 2.0
                half_h = display_h / 2.0
                # 检查视口四角在逆旋转后是否仍落在片段矩形内
                for x, y in ((-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)):
                    local_x = x * cos_theta + y * sin_theta
                    local_y = -x * sin_theta + y * cos_theta
                    if abs(local_x) > half_w + 1e-4 or abs(local_y) > half_h + 1e-4:
                        return False
                return True

            def build_issue(issue_type, track, start, end, duration, description, extra=None):
                payload = {
                    "issue_id": f"{issue_type}:{track}:{start}:{end}",
                    "type": issue_type,
                    "track": track,
                    "start": start,
                    "end": end,
                    "duration": duration,
                    "description": description,
                }
                if extra:
                    payload.update(extra)
                return payload

            def get_uncovered_sub_intervals(start_frame: int, end_frame: int, covering_intervals: List[Tuple[int, int]]) -> List[Tuple[int, int]]:
                if not covering_intervals:
                    return [(start_frame, end_frame)]
                uncovered = []
                current_start = start_frame
                sorted_covering = sorted(covering_intervals, key=lambda x: x[0])
                for cover_start, cover_end in sorted_covering:
                    if cover_end <= current_start:
                        continue
                    if cover_start >= end_frame:
                        break
                    if cover_start > current_start:
                        uncovered.append((current_start, min(end_frame, cover_start)))
                    current_start = max(current_start, cover_end)
                    if current_start >= end_frame:
                        break
                if current_start < end_frame:
                    uncovered.append((current_start, end_frame))
                return uncovered

            def get_item_opacity(item):
                for prop_name in ("Opacity", "CompositeOpacity"):
                    opacity = safe_float(item.GetProperty(prop_name))
                    if opacity is None:
                        continue
                    # 有的属性用 0-100，有的可能用 0-1，统一换算
                    if opacity > 1.0:
                        opacity = opacity / 100.0
                    return max(0.0, min(1.0, opacity))
                return 1.0

            def is_effectively_opaque(item):
                opacity = get_item_opacity(item)
                if opacity < 0.995:
                    return False

                for prop_name in ("CompositeMode", "BlendMode"):
                    mode_value = item.GetProperty(prop_name)
                    if mode_value in (None, "", 0, "0", "Normal", "normal"):
                        continue
                    return False

                return True
            
            # 获取时间线设置（优先使用时间线自身设置，而非项目设置）
            try:
                timeline_w = float(timeline.GetSetting("timelineResolutionWidth") or self.project.GetSetting("timelineResolutionWidth") or 1920)
                timeline_h = float(timeline.GetSetting("timelineResolutionHeight") or self.project.GetSetting("timelineResolutionHeight") or 1080)
                timeline_ar = timeline_w / timeline_h if timeline_h > 0 else 1.777
            except:
                timeline_ar = 1.777
                
            mismatch_behavior = timeline.GetSetting("timelineInputResMismatchBehavior") or self.project.GetSetting("timelineInputResMismatchBehavior")
            timeline_mismatch = timeline.GetSetting("timelineInputResMismatchBehavior")
            project_mismatch = self.project.GetSetting("timelineInputResMismatchBehavior")
            
            # 遍历所有视频轨道
            track_count = timeline.GetTrackCount("video")
            all_intervals = [] # 用于计算黑帧
            track_items: Dict[int, List[Any]] = {}
            track_intervals: Dict[int, List[Tuple[int, int]]] = {}
            track_opaque_intervals: Dict[int, List[Tuple[int, int]]] = {}

            for t_idx in range(1, track_count + 1):
                items = timeline.GetItemListInTrack("video", t_idx)
                if not items:
                    continue
                track_items[t_idx] = items
                track_intervals[t_idx] = []
                track_opaque_intervals[t_idx] = []
                for item in items:
                    item_interval = (item.GetStart(), item.GetEnd())
                    track_intervals[t_idx].append(item_interval)
                    if is_effectively_opaque(item):
                        track_opaque_intervals[t_idx].append(item_interval)
            
            for t_idx in range(1, track_count + 1):
                items = track_items.get(t_idx)
                if not items:
                    continue
                    
                for item in items:
                    start_frame = item.GetStart()
                    end_frame = item.GetEnd()
                    duration = end_frame - start_frame
                    
                    all_intervals.append((start_frame, end_frame))
                    
                    # 1. 检查夹帧
                    if duration > 0 and duration <= flash_frame_threshold:
                        issues.append(build_issue(
                            "flash_frame",
                            t_idx,
                            start_frame,
                            end_frame,
                            duration,
                            f"V{t_idx} 轨道存在夹帧 (时长 {duration} 帧，小于等于阈值 {flash_frame_threshold})"
                        ))
                        
                    # 2. 检查黑边
                    if check_black_borders:
                        upper_intervals = []
                        if t_idx < track_count:
                            for upper_track in range(t_idx + 1, track_count + 1):
                                upper_intervals.extend(track_opaque_intervals.get(upper_track, []))
                        
                        uncovered_intervals = get_uncovered_sub_intervals(start_frame, end_frame, upper_intervals)
                        if not uncovered_intervals:
                            continue
                        
                        border_analysis = self._analyze_black_border_risk(item, timeline_w, timeline_h, mismatch_behavior, timeline_mismatch, project_mismatch, black_border_safe_zone)
                        if border_analysis.get("has_black_border"):
                            for uncovered_start, uncovered_end in uncovered_intervals:
                                uncovered_duration = uncovered_end - uncovered_start
                                issues.append(build_issue(
                                    "black_border",
                                    t_idx,
                                    uncovered_start,
                                    uncovered_end,
                                    uncovered_duration,
                                    f"V{t_idx} 轨道存在黑边风险",
                                ))

            # 3. 检查黑帧 (轨道间隙)
            if check_black_frames and all_intervals:
                # 合并所有区段
                all_intervals.sort(key=lambda x: x[0])
                merged = []
                for interval in all_intervals:
                    if not merged:
                        merged.append(list(interval))
                    else:
                        last = merged[-1]
                        if interval[0] <= last[1]: # 有重叠或相接
                            last[1] = max(last[1], interval[1])
                        else:
                            merged.append(list(interval))
                            
                # 寻找合并区段之间的间隙
                for i in range(len(merged) - 1):
                    gap_start = merged[i][1]
                    gap_end = merged[i+1][0]
                    gap_duration = gap_end - gap_start
                    if gap_duration > 0:
                        issues.append(build_issue(
                            "black_frame",
                            "All",
                            gap_start,
                            gap_end,
                            gap_duration,
                            f"时间线存在黑帧 (时长 {gap_duration} 帧)"
                        ))

            try:
                fps = float(timeline.GetSetting("timelineFrameRate") or self.project.GetSetting("timelineFrameRate") or 24)
            except Exception:
                fps = 24.0
            start_timecode = timeline.GetStartTimecode() or "00:00:00:00"
            timeline_start_frame = int(timeline.GetStartFrame() or 0)
            issues.sort(key=lambda issue: (int(issue.get("start", 0)), int(issue.get("end", 0)), str(issue.get("track", "")), issue.get("type", "")))
            for issue in issues:
                relative_frame = max(0, issue["start"] - timeline_start_frame)
                issue["timecode"] = self._frame_to_timecode(relative_frame, fps, start_timecode)
                        
            return {
                "status": "success",
                "message": "检查完成",
                "issues": issues,
                "total_issues": len(issues)
            }
            
        except Exception as e:
            import traceback
            print(traceback.format_exc())
            return {"status": "error", "message": f"检查失败: {str(e)}"}

    def _mock_apply_timeline(self, timeline_data: Dict[str, Any]) -> Dict[str, Any]:
        """模拟模式"""
        return {
            "status": "success",
            "mode": "mock",
            "message": "模拟模式 - 时间线剪辑指令已接收（未实际操作达芬奇）",
            "total_clips": timeline_data.get("total_clips", 0),
            "timeline_name": "Mock Timeline"
        }

    def get_folder_hierarchy_tree(self) -> Dict[str, Any]:
        """
        获取媒体池中所有文件夹的层级树，包含每个文件夹中的素材信息。
        返回树形结构，每个节点包含：
        - name: 文件夹名称
        - path: 完整路径（相对于媒体池根目录）
        - depth: 层级深度（根目录子文件夹为第1层）
        - clip_count: 该文件夹内的素材总数
        - clip_types: 按类型统计的素材数量 { "Video": 5, "Audio": 3, "Image": 2, ... }
        - clips: 素材列表
        - children: 子文件夹列表
        """
        if not self.resolve:
            return {"status": "error", "message": "未连接达芬奇，请先打开达芬奇"}
        try:
            self._refresh_context()
            if not self.project or not self.media_pool:
                return {"status": "error", "message": "未连接达芬奇项目"}
            root_folder = self.media_pool.GetRootFolder()
            if not root_folder:
                return {"status": "error", "message": "无法获取媒体池根目录"}

            # 用于去重：达芬奇 API 有时可能返回相同路径的文件夹
            seen_paths = set()

            def build_tree(folder, current_path="", depth=0):
                # 去重：如果路径已存在，跳过
                path_key = current_path or "__root__"
                if path_key in seen_paths:
                    return None
                seen_paths.add(path_key)

                node = {
                    "name": folder.GetName() if depth > 0 else "媒体池根目录",
                    "path": current_path,
                    "depth": depth,
                    "clip_count": 0,
                    "clip_types": {},
                    "clips": [],
                    "children": []
                }

                # 收集当前文件夹中的素材
                try:
                    clip_list = folder.GetClipList() or []
                except Exception:
                    clip_list = []
                node["clip_count"] = len(clip_list)
                for clip in clip_list:
                    try:
                        clip_type = clip.GetClipProperty("Type") or "Other"
                        clip_name = clip.GetName() or ""
                        clip_path = clip.GetClipProperty("File Path") or ""
                        media_id = str(clip.GetMediaId() or "").strip()
                    except Exception:
                        clip_type = "Other"
                        clip_name = ""
                        clip_path = ""
                        media_id = ""
                    node["clip_types"][clip_type] = node["clip_types"].get(clip_type, 0) + 1
                    node["clips"].append({
                        "name": clip_name,
                        "type": clip_type,
                        "file_path": clip_path,
                        "media_id": media_id,
                    })

                # 跳过内部/系统文件夹
                skip_names = {"SmartBins"}
                try:
                    sub_folders = folder.GetSubFolderList() or []
                except Exception:
                    sub_folders = []
                for sub in sub_folders:
                    try:
                        sub_name = sub.GetName()
                    except Exception:
                        continue
                    if sub_name in skip_names:
                        continue
                    sub_path = f"{current_path}/{sub_name}" if current_path else sub_name
                    child_node = build_tree(sub, sub_path, depth + 1)
                    if child_node is not None:
                        node["children"].append(child_node)

                return node

            tree = build_tree(root_folder)
            return {"status": "success", "tree": tree}
        except Exception as e:
            import traceback
            print(traceback.format_exc())
            return {"status": "error", "message": f"获取层级树失败: {str(e)}"}

    def flatten_folder_hierarchy(self, folder_paths: List[str], keep_levels: int) -> Dict[str, Any]:
        """
        将指定文件夹中超过保留层级的素材移动到保留层级的最后一层。

        参数：
        - folder_paths: 要展平的文件夹路径列表（这些路径作为根，其子层级会被展平）
        - keep_levels: 保留的层级数量（相对于选中的文件夹路径）
        """
        if not self.resolve:
            return {"status": "success", "mode": "mock", "message": "模拟模式 - 已展平文件夹层级", "moved_count": 0}
        try:
            self._refresh_context()
            if not self.project or not self.media_pool:
                return {"status": "error", "message": "未连接达芬奇项目"}
            root_folder = self.media_pool.GetRootFolder()
            if not root_folder:
                return {"status": "error", "message": "无法获取媒体池根目录"}

            keep_levels = max(1, int(keep_levels))
            total_moved = 0
            details = []
            diag_msgs = []  # 收集诊断信息，拼入返回消息

            for folder_path in folder_paths:
                print(f"\n[展平] 处理文件夹: '{folder_path}', keep_levels={keep_levels}")

                sel_folder = self._find_folder_by_path(root_folder, folder_path)
                if not sel_folder:
                    print(f"[展平]   文件夹未找到")
                    details.append({"folder": folder_path, "status": "skipped", "reason": "文件夹未找到"})
                    continue

                path_parts = [p for p in folder_path.replace("\\", "/").split("/") if p]
                folder_own_depth = len(path_parts)
                print(f"[展平]   自身深度: {folder_own_depth}, path_parts={path_parts}")

                # 第一遍：只收集路径，不缓存文件夹对象（避免后续操作导致引用过期）
                deep_paths = []  # [(full_path, depth)]

                def collect_deep_paths(current_folder, current_path, current_depth):
                    for sub in (current_folder.GetSubFolderList() or []):
                        try:
                            sub_name = sub.GetName()
                        except Exception:
                            continue
                        sub_path = f"{current_path}/{sub_name}" if current_path else sub_name
                        sub_depth = current_depth + 1
                        rel_depth = sub_depth - folder_own_depth + 1  # 选中文件夹为第1层

                        if rel_depth > keep_levels:
                            deep_paths.append((sub_path, sub_depth))
                        # 无论是否超出，都继续递归（深层文件夹的子文件夹也需要处理）
                        collect_deep_paths(sub, sub_path, sub_depth)

                collect_deep_paths(sel_folder, folder_path, folder_own_depth)

                # 从深到浅排序（先处理最深层，删除后再处理父级）
                deep_paths.sort(key=lambda x: -x[1])

                print(f"[展平]   收集到 {len(deep_paths)} 个深层文件夹 (已按深度排序):")
                for dp, dd in deep_paths:
                    print(f"[展平]     - {dp} (depth={dd})")

                if not deep_paths:
                    details.append({"folder": folder_path, "status": "none", "reason": "没有超出保留层级的文件夹"})
                    continue

                # 第二遍：逐个处理每个深层文件夹
                moved_targets = {}
                total_moved_in_folder = 0
                move_errors = []
                deleted_folders = []
                folder_details = []

                # 记录当前文件夹
                try:
                    cur = self.media_pool.GetCurrentFolder()
                    diag_msgs.append(f"当前文件夹: {cur.GetName() if cur else 'None'}")
                except Exception:
                    pass

                for src_path, _ in deep_paths:
                    # 重新查找文件夹（每次用最新引用，避免过往操作导致的过期对象）
                    src_folder = self._find_folder_by_path(root_folder, src_path)
                    if not src_folder:
                        print(f"[展平]   src_folder 未找到: {src_path}，可能已被删除")
                        continue

                    # 计算目标路径
                    src_parts = [p for p in src_path.replace("\\", "/").split("/") if p]
                    tgt_parts = src_parts[:folder_own_depth + keep_levels - 1] if keep_levels > 0 else src_parts[:folder_own_depth]
                    tgt_path = "/".join(tgt_parts) if tgt_parts else folder_path

                    if tgt_path == src_path:
                        print(f"[展平]   跳过: {src_path} 的目标与自身相同")
                        continue

                    print(f"[展平]   处理: {src_path} → {tgt_path}")

                    # 获取素材（直接调 Folder 对象，不依赖当前文件夹）
                    try:
                        clips = list(src_folder.GetClipList() or [])
                    except Exception as e:
                        print(f"[展平]   GetClipList 失败: {e}")
                        continue

                    clip_count = len(clips)
                    folder_details.append({"source": src_path, "clip_count": clip_count})

                    if clips:
                        # 查找目标文件夹
                        tgt_folder = self._find_folder_by_path(root_folder, tgt_path)
                        if not tgt_folder:
                            msg = f"目标文件夹未找到: {tgt_path}"
                            print(f"[展平]   {msg}")
                            move_errors.append(msg)
                        else:
                            tgt_name = tgt_folder.GetName()
                            tgt_expected = tgt_path.split("/")[-1] if "/" in tgt_path else tgt_path
                            diag_msgs.append(f"目标: {tgt_expected} GetName={tgt_name} {'✓' if tgt_name == tgt_expected else '✗'}")
                            print(f"[展平]   tgt_folder.GetName() = '{tgt_name}' (expected='{tgt_expected}')")

                            # 切到目标文件夹
                            self.media_pool.SetCurrentFolder(tgt_folder)

                            # 一个文件夹的素材一次性批量移动
                            try:
                                self.media_pool.MoveClips(clips, tgt_folder)
                                moved_targets[tgt_path] = moved_targets.get(tgt_path, 0) + clip_count
                                total_moved_in_folder += clip_count
                                diag_msgs.append(f"移: {src_path.split('/')[-1]}→{tgt_name} {clip_count}")
                                print(f"[展平]   MoveClips 批量完成: {clip_count} 个素材 '{src_path}' → '{tgt_name}'")
                            except Exception as e:
                                print(f"[展平]   MoveClips 批量失败: {e}")
                                # 批量失败时逐个尝试
                                moved_ok = 0
                                for clip in clips:
                                    try:
                                        self.media_pool.MoveClips([clip], tgt_folder)
                                        moved_ok += 1
                                    except Exception:
                                        pass
                                if moved_ok > 0:
                                    moved_targets[tgt_path] = moved_targets.get(tgt_path, 0) + moved_ok
                                    total_moved_in_folder += moved_ok
                                diag_msgs.append(f"移: {src_path.split('/')[-1]}→{tgt_name} {moved_ok}/{clip_count}")
                                if moved_ok < clip_count:
                                    move_errors.append(f"{src_path}: 仅移动 {moved_ok}/{clip_count} 个素材")

                    # 尝试删除空文件夹（素材已移走，子文件夹已处理/删除）
                    # 重新查找文件夹（MoveClips 后原引用可能已过期）
                    src_folder_fresh = self._find_folder_by_path(root_folder, src_path)
                    if src_folder_fresh:
                        try:
                            remaining = src_folder_fresh.GetClipList() or []
                            remaining_subs = src_folder_fresh.GetSubFolderList() or []
                            if not remaining and not remaining_subs:
                                # 切到父文件夹再删除
                                parent_path = "/".join(src_parts[:-1]) if len(src_parts) > 1 else ""
                                parent_folder = self._find_folder_by_path(root_folder, parent_path) if parent_path else root_folder
                                if parent_folder:
                                    self.media_pool.SetCurrentFolder(parent_folder)
                                self.media_pool.DeleteFolders([src_folder_fresh])
                                deleted_folders.append(src_path)
                                print(f"[展平]   已删除空文件夹: {src_path}")
                            else:
                                print(f"[展平]   文件夹非空，跳过删除: {src_path} (clips={len(remaining)}, subs={len(remaining_subs)})")
                        except Exception as e:
                            print(f"[展平]   删除文件夹失败 ({src_path}): {e}")
                    else:
                        print(f"[展平]   删除时未找到文件夹: {src_path}（可能已被自动删除）")
                        deleted_folders.append(src_path)

                total_moved += total_moved_in_folder

                # 整理结果
                targets_list = [{"target": t, "moved_count": c} for t, c in moved_targets.items()]
                if targets_list:
                    details.append({
                        "folder": folder_path,
                        "status": "moved",
                        "targets": targets_list,
                        "moved_count": total_moved_in_folder,
                        "deleted_folders": deleted_folders,
                        "sources": folder_details,
                    })
                if move_errors:
                    details.append({
                        "folder": folder_path,
                        "status": "error",
                        "reason": "; ".join(move_errors),
                    })
                if not targets_list and not move_errors:
                    details.append({"folder": folder_path, "status": "none", "reason": "没有需要移动的素材"})

                # 恢复当前文件夹到根目录
                try:
                    self.media_pool.SetCurrentFolder(root_folder)
                except Exception:
                    pass

            return {
                "status": "success",
                "total_moved": total_moved,
                "details": details,
                "message": f"展平完成，共移动 {total_moved} 个素材到目标文件夹，清理 {sum(len(d.get('deleted_folders', [])) for d in details)} 个空文件夹",
            }
        except Exception as e:
            import traceback
            print(traceback.format_exc())
            return {"status": "error", "message": f"展平文件夹层级失败: {str(e)}"}

    def delete_images_from_folders(self, folder_paths: List[str], keep_levels: int = 1) -> Dict[str, Any]:
        """
        递归删除指定文件夹中的所有 Image 类型素材，
        并清理因删除而变空的子文件夹。
        """
        if not self.resolve:
            return {"status": "error", "message": "未连接达芬奇，请先打开达芬奇"}
        try:
            self._refresh_context()
            if not self.project or not self.media_pool:
                return {"status": "error", "message": "未连接达芬奇项目"}
            root_folder = self.media_pool.GetRootFolder()
            if not root_folder:
                return {"status": "error", "message": "无法获取媒体池根目录"}

            total_deleted = 0
            all_cleared_folders = []
            folder_details = []

            for folder_path in folder_paths:
                folder = self._find_folder_by_path(root_folder, folder_path)
                if not folder:
                    folder_details.append({
                        "folder": folder_path,
                        "image_count": 0,
                        "status": "not_found"
                    })
                    continue

                image_count = self._count_images_in_tree(folder)
                deleted, cleared = self._delete_images_recursive(
                    folder, root_folder, current_path=folder_path,
                    protect_path=folder_path, keep_levels=keep_levels,
                )
                total_deleted += deleted
                all_cleared_folders.extend(cleared)
                folder_details.append({
                    "folder": folder_path,
                    "image_count": image_count,
                    "deleted": deleted,
                    "status": "deleted" if deleted > 0 else "no_images"
                })

            return {
                "status": "success",
                "deleted_count": total_deleted,
                "deleted_folder_count": len(all_cleared_folders),
                "deleted_folders": all_cleared_folders,
                "folder_details": folder_details,
            }
        except Exception as e:
            import traceback
            print(traceback.format_exc())
            return {"status": "error", "message": f"删除图片失败: {str(e)}"}

    def _count_images_in_tree(self, folder) -> int:
        """递归统计文件夹树中的 Image 素材数量（不执行删除）"""
        count = 0
        clips = folder.GetClipList() or []
        for c in clips:
            try:
                if c.GetClipProperty("Type") in ("Image", "Still", "静帧"):
                    count += 1
            except Exception:
                pass
        for sub in (folder.GetSubFolderList() or []):
            count += self._count_images_in_tree(sub)
        return count

    def _delete_images_recursive(self, folder, root_folder, current_path="", protect_path=None, keep_levels=1):
        """递归遍历文件夹，删除 Image 类型素材，返回 (deleted_count, cleared_folder_paths)"""
        deleted = 0
        cleared_folders = []

        # 删除当前文件夹的 Image 素材
        clips = folder.GetClipList() or []
        image_clips = []
        seen_types = set()
        for c in clips:
            try:
                ct = c.GetClipProperty("Type")
                seen_types.add(str(ct))
                if c.GetClipProperty("Type") in ("Image", "Still", "静帧"):
                    image_clips.append(c)
            except Exception:
                pass

        if image_clips:
            self.media_pool.DeleteClips(image_clips)
            deleted += len(image_clips)

        # 递归处理子文件夹
        for sub in (folder.GetSubFolderList() or []):
            try:
                sub_name = sub.GetName()
            except Exception:
                continue
            sub_path = f"{current_path}/{sub_name}" if current_path else sub_name
            sub_deleted, sub_cleared = self._delete_images_recursive(
                sub, root_folder, current_path=sub_path,
                protect_path=protect_path, keep_levels=keep_levels,
            )
            deleted += sub_deleted
            cleared_folders.extend(sub_cleared)

        # 检查当前文件夹是否变空
        # 不删：根目录 / 用户勾选的文件夹 / 保留层级内的文件夹
        if current_path and current_path != protect_path:
            if protect_path:
                sel_depth = len(protect_path.split("/"))
                cur_depth = len(current_path.split("/"))
                rel_depth = cur_depth - sel_depth + 1  # 选中文件夹为第1层
                if rel_depth <= keep_levels:
                    return deleted, cleared_folders
            # DeleteClips 后原引用可能已过期，重新查找文件夹（与 flatten_folder_hierarchy 一致）
            folder_fresh = self._find_folder_by_path(root_folder, current_path)
            if folder_fresh:
                try:
                    remained = folder_fresh.GetClipList() or []
                    remained_subs = folder_fresh.GetSubFolderList() or []
                except Exception:
                    remained, remained_subs = [], []
                if not remained and not remained_subs:
                    parts = current_path.split("/")
                    parent_path = "/".join(parts[:-1]) if len(parts) > 1 else ""
                    parent = self._find_folder_by_path(root_folder, parent_path) if parent_path else root_folder
                    if parent:
                        self.media_pool.SetCurrentFolder(parent)
                        self.media_pool.DeleteFolders([folder_fresh])
                        cleared_folders.append(current_path)

        return deleted, cleared_folders
