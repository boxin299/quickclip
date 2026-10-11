import sys
import os

# 支持打包运行时：将同目录下的 lib/ 加入 sys.path
_RUNTIME_LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib')
if os.path.isdir(_RUNTIME_LIB):
    _site_packages = os.path.join(_RUNTIME_LIB, 'site-packages')
    if os.path.isdir(_site_packages):
        sys.path.insert(0, _site_packages)
    sys.path.insert(0, _RUNTIME_LIB)

import subprocess
import shutil
import tempfile
import asyncio
import gc
from contextlib import asynccontextmanager
from fastapi import FastAPI, UploadFile, File, BackgroundTasks, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict
from typing import List, Dict, Any, Optional, Union
import json
import time
import uuid
import re
import warnings
warnings.filterwarnings(
    "ignore",
    message=r"urllib3 v2 only supports OpenSSL 1\.1\.1\+",
)
import requests
import pwd
from resolve_api import ResolveController
from transcriber import TranscriberService, get_install_progress, TranscriptionModelMissingError
from config_manager import load_config, save_config
from folder_config_manager import load_folder_config, save_folder_config, generate_automator_workflow
from project_registry import append_project_history, update_project_record, normalize_path
from cache_manager import (
    get_cache_dir, list_transcript_projects, get_transcript_project,
    save_transcript_project, delete_transcript_project, delete_transcript_audio,
    delete_all_cache, generate_transcript_id, get_audio_export_dir,
    update_transcript_project_segments,
)
from subtitle_speed_tracker import speed_tracker, clip_snapshots_to_dicts, ClipSnapshot, strip_chinese_punctuation, to_simplified_chinese
from material_packager import init_pack_routes
from clip_import_manager import ClipImportManager
from update_service import check_github_update
from sound_effects_manager import (
    load_sound_effects_config, save_sound_effects_config,
    scan_sound_library, scan_all_libraries, get_library_folder_tree,
    get_sound_library_scan_data, get_sound_library_index_status,
    ensure_sound_library_scan_cache,
    summarize_sound_library_assets_index, browse_sound_library_assets_index,
    resolve_asset_keys_for_paths_index,
    copy_sound_to_project, copy_sound_to_dest_dir, delete_local_sound_file,
    compute_copy_destination,
    snapshot_audio_tracks, get_timeline_clip_paths,
    generate_waveform_data,
    ensure_preview_wav,
    get_audio_tooling_status,
    resolve_mapped_path,
    _preview_cache_stats,
    clear_preview_cache,
    clear_waveform_cache,
    get_sound_library_cache_stats,
    prune_preview_cache,
    get_waveform_cache_library,
    set_waveform_cache_library,
    get_asset_meta,
    set_asset_favorite,
    add_asset_tag,
    remove_asset_tag,
    bulk_add_asset_tag,
    bulk_remove_asset_tag,
    get_audio_file_metadata,
    increment_asset_used,
    compute_davinci_target_folder, compute_local_save_subpath,
    _get_ffmpeg_executable,
)

# 音效按下/释放会话存储（内存中）
_SFX_SESSION_TTL = 1800  # 30 分钟超时自动清理
_sound_sessions: Dict[str, Dict[str, Any]] = {}

# 波形预计算全局进度追踪
_precompute_state: Dict[str, Any] = {
    "running": False,
    "total": 0,
    "done": 0,
    "currentFile": "",
    "startedAt": 0.0,
}

def _cleanup_expired_sound_sessions() -> int:
    """清理过期的音效会话，返回清理数量"""
    now = time.time()
    expired_ids = [
        sid for sid, s in list(_sound_sessions.items())
        if now - s.get("created_at", 0) > _SFX_SESSION_TTL
    ]
    for sid in expired_ids:
        _sound_sessions.pop(sid, None)
    if expired_ids:
        print(f"[SFX] 自动清理了 {len(expired_ids)} 个过期会话 (TTL={_SFX_SESSION_TTL}s)")
    return len(expired_ids)

async def _periodic_sfx_session_cleanup(interval: int = 600):
    """后台定期清理过期音效会话（每 10 分钟执行一次）"""
    while True:
        await asyncio.sleep(interval)
        try:
            _cleanup_expired_sound_sessions()
        except Exception:
            pass

async def _periodic_cache_cleanup(interval: int = 600):
    """后台定期清理预览和波形缓存（每 10 分钟执行一次）"""
    while True:
        await asyncio.sleep(interval)
        try:
            config = load_sound_effects_config()
            prune_preview_cache(max_cache_mb=int(config.get("preview_cache_max_mb", 512) or 512))
            gc.collect()
        except Exception:
            pass

@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动后台清理任务"""
    # 启动时运行一次缓存清理
    try:
        config = load_sound_effects_config()
        max_preview_mb = int(config.get("preview_cache_max_mb", 512) or 512)
        prune_preview_cache(max_cache_mb=max_preview_mb)
        print(f"  缓存清理完成: preview_cache_max={max_preview_mb}MB")
    except Exception as e:
        print(f"  缓存清理跳过: {e}")

    asyncio.create_task(_periodic_sfx_session_cleanup())
    asyncio.create_task(_periodic_cache_cleanup())
    print("  后台清理任务已启动\n")
    yield

app = FastAPI(title="DaVinci Text-Driven Editor API", lifespan=lifespan)

# 配置 CORS，允许前端访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 初始化控制器
resolve_controller = ResolveController()
transcriber = TranscriberService()
clip_import_manager = ClipImportManager(resolve_controller)


def sync_current_project_context(include_media: bool = False) -> Dict[str, Any]:
    try:
        return resolve_controller.get_project_context(include_media=include_media)
    except Exception:
        return {"connected": False}


async def get_project_context_with_timeout(
    include_media: bool = False,
    timeout_seconds: float = 2.0,
) -> Dict[str, Any]:
    # Resolve/Fusion calls occasionally hang after transcription finishes.
    # Do not block the HTTP response forever when project context is non-critical.
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(sync_current_project_context, include_media),
            timeout=timeout_seconds,
        )
    except Exception:
        return {"connected": False}


def _normalize_sound_effect_io_range(in_point: Optional[float], out_point: Optional[float]) -> Dict[str, Any]:
    normalized_in = None
    normalized_out = None
    try:
        if isinstance(in_point, (int, float)) and float(in_point) >= 0:
            normalized_in = float(in_point)
    except Exception:
        normalized_in = None
    try:
        if isinstance(out_point, (int, float)) and float(out_point) >= 0:
            normalized_out = float(out_point)
    except Exception:
        normalized_out = None

    if normalized_in is not None and normalized_out is not None and normalized_out <= normalized_in:
        return {
            "in_point": None,
            "out_point": None,
            "has_io_range": False,
            "invalid": True,
        }
    return {
        "in_point": normalized_in,
        "out_point": normalized_out,
        "has_io_range": normalized_in is not None or normalized_out is not None,
        "invalid": False,
    }


def _iter_snapshot_audio_clips(snapshot: Dict[str, Any]):
    for track in list((snapshot or {}).get("tracks") or []):
        track_index = int(track.get("track_index") or 0)
        for clip in list(track.get("clips") or []):
            clip_path = str(clip.get("clip_path") or "")
            clip_basename = os.path.basename(clip_path) if clip_path else ""
            yield {
                "track_index": track_index,
                "clip_name": str(clip.get("clip_name") or ""),
                "clip_path": clip_path,
                "clip_basename": clip_basename,
                "start_frame": int(clip.get("start_frame") or 0),
                "end_frame": int(clip.get("end_frame") or 0),
                "media_id": clip.get("media_id"),
            }


def _snapshot_clip_identity(clip: Dict[str, Any]):
    clip_path = str(clip.get("clip_path") or "")
    normalized_path = os.path.normpath(clip_path) if clip_path else ""
    return (
        int(clip.get("track_index") or 0),
        int(clip.get("start_frame") or 0),
        int(clip.get("end_frame") or 0),
        normalized_path,
        str(clip.get("media_id") or ""),
    )


def _match_new_timeline_audio_clip(
    before_snapshot: Dict[str, Any],
    after_snapshot: Dict[str, Any],
    exact_paths: set,
    candidate_names: set,
    probe_tokens: Optional[set] = None,
    preferred_media_ids: Optional[set] = None,
) -> Dict[str, Any]:
    before_keys = {_snapshot_clip_identity(clip) for clip in _iter_snapshot_audio_clips(before_snapshot)}
    new_clips = []
    for clip in _iter_snapshot_audio_clips(after_snapshot):
        if _snapshot_clip_identity(clip) not in before_keys:
            new_clips.append(clip)

    normalized_probe_tokens = {str(token).strip().lower() for token in list(probe_tokens or set()) if str(token).strip()}
    normalized_media_ids = {str(media_id).strip() for media_id in list(preferred_media_ids or set()) if str(media_id).strip()}

    def score(clip: Dict[str, Any]) -> int:
        clip_path = str(clip.get("clip_path") or "")
        clip_path_lower = clip_path.lower()
        normalized_path = os.path.normpath(clip_path) if clip_path else ""
        clip_media_id = str(clip.get("media_id") or "").strip()
        clip_basename = str(clip.get("clip_basename") or "")
        clip_basename_lower = clip_basename.lower()
        clip_name = str(clip.get("clip_name") or "")
        clip_name_lower = clip_name.lower()
        clip_name_no_ext = os.path.splitext(clip_name)[0]
        clip_basename_no_ext = os.path.splitext(clip_basename)[0]
        if normalized_media_ids and clip_media_id and clip_media_id in normalized_media_ids:
            return 5
        if normalized_probe_tokens and any(
            token in clip_path_lower or token in clip_basename_lower or token in clip_name_lower
            for token in normalized_probe_tokens
        ):
            return 4
        if normalized_path and normalized_path in exact_paths:
            return 3
        if clip_basename in candidate_names or clip_basename_no_ext in candidate_names:
            return 2
        if clip_name in candidate_names or clip_name_no_ext in candidate_names:
            return 1
        return 0

    matched = [clip for clip in new_clips if score(clip) > 0]
    if not matched:
        if len(new_clips) == 1:
            return {
                "new_clips": new_clips,
                "matched_candidates": [],
                "matched_clip": new_clips[0],
                "ambiguous": False,
                "fallback_unique": True,
            }
        return {
            "new_clips": new_clips,
            "matched_candidates": [],
            "matched_clip": None,
            "ambiguous": False,
            "fallback_unique": False,
        }

    max_score = max(score(clip) for clip in matched)
    best_matches = [clip for clip in matched if score(clip) == max_score]
    best_matches.sort(key=lambda clip: (
        int(clip.get("start_frame") or 0),
        int(clip.get("end_frame") or 0),
        int(clip.get("track_index") or 0),
    ))
    return {
        "new_clips": new_clips,
        "matched_candidates": matched,
        "matched_clip": best_matches[-1],
        "ambiguous": len(best_matches) > 1,
        "fallback_unique": False,
    }


async def _wait_for_new_timeline_audio_clip(
    before_snapshot: Dict[str, Any],
    exact_paths: set,
    candidate_names: set,
    probe_tokens: set,
    preferred_media_ids: set,
    fps: float,
    attempts: int = 6,
    delay_seconds: float = 0.25,
):
    latest_snapshot = {"timestamp": 0, "tracks": [], "total_clips": 0}
    latest_match = {
        "new_clips": [],
        "matched_candidates": [],
        "matched_clip": None,
        "ambiguous": False,
        "fallback_unique": False,
    }
    for attempt in range(max(1, int(attempts))):
        resolve_controller._refresh_context()
        timeline = resolve_controller._get_active_timeline()
        latest_snapshot = snapshot_audio_tracks(timeline, fps) if timeline else {"timestamp": 0, "tracks": [], "total_clips": 0}
        latest_match = _match_new_timeline_audio_clip(
            before_snapshot,
            latest_snapshot,
            exact_paths,
            candidate_names,
            probe_tokens,
            preferred_media_ids,
        )
        if latest_match.get("matched_clip") is not None:
            latest_match["attempt"] = attempt + 1
            return latest_snapshot, latest_match
        if attempt < int(attempts) - 1:
            await asyncio.sleep(delay_seconds)
    latest_match["attempt"] = max(1, int(attempts))
    return latest_snapshot, latest_match


def _get_sfx_drag_log_path() -> str:
    real_home = ""
    try:
        real_home = pwd.getpwuid(os.getuid()).pw_dir
    except Exception:
        real_home = ""
    if not real_home:
        real_home = os.path.expanduser("~")
    log_dir = os.path.join(real_home, "Library", "Logs", "DaVinciTextEditor")
    try:
        os.makedirs(log_dir, exist_ok=True)
    except Exception:
        runtime_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        fallback_dir = os.path.join(runtime_root, "data", "logs")
        try:
            os.makedirs(fallback_dir, exist_ok=True)
            log_dir = fallback_dir
        except Exception:
            log_dir = tempfile.gettempdir()
    return os.path.join(log_dir, "sfx_drag_debug.log")


def _append_sfx_drag_log(event: str, payload: Dict[str, Any]) -> None:
    log_path = _get_sfx_drag_log_path()
    record = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "event": str(event or "unknown"),
        "payload": payload or {},
    }
    try:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as exc:
        print(f"[SFX drag log] 写入失败: {exc} path={log_path}")


def _snapshot_all_media_pool_folders(media_pool):
    """递归扫描媒体池所有文件夹（非仅当前选中文件夹），返回 { count, paths }。"""
    result = {"count": 0, "paths": []}
    if not media_pool:
        return result
    try:
        root = media_pool.GetRootFolder()
    except Exception:
        return result
    if not root:
        return result

    def walk(folder):
        try:
            clips = folder.GetClipList() or []
        except Exception:
            clips = []
        for clip in clips:
            try:
                p = clip.GetClipProperty("File Path") or ""
            except Exception:
                p = ""
            if p:
                result["paths"].append(os.path.basename(p))
        result["count"] += len(clips)
        try:
            subfolders = folder.GetSubFolders() or []
        except Exception:
            subfolders = []
        for sub in list(subfolders):
            walk(sub)

    walk(root)
    return result


def _remove_empty_parent_dirs(file_path: str) -> int:
    """删除文件后向上遍历清理空目录，直到遇到非空目录为止。返回移除的空目录数。"""
    removed = 0
    if not file_path:
        return removed
    parent = os.path.dirname(os.path.abspath(file_path))
    while parent and os.path.isdir(parent):
        try:
            entries = os.listdir(parent)
            if entries:
                break
            os.rmdir(parent)
            removed += 1
            parent = os.path.dirname(parent)
        except Exception:
            break
    return removed


def _ensure_sound_session_media_pool_item(session_id: str, local_copy_path: str, session: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    target_session = session or _sound_sessions.get(session_id)
    if not target_session:
        return {"status": "error", "message": "会话不存在"}
    media_result = resolve_controller.ensure_audio_media_pool_item(
        local_copy_path,
        media_id=target_session.get("media_id"),
    )
    _append_sfx_drag_log("press_media_pool", {
        "session_id": session_id,
        "local_copy_path": local_copy_path,
        "media_result": media_result,
    })
    if media_result.get("status") == "success":
        target_session["media_id"] = str(media_result.get("media_id") or "")
        target_session["media_name"] = str(media_result.get("media_name") or "")
        target_session["media_path"] = str(media_result.get("media_path") or local_copy_path)
        target_session["media_pool_created"] = bool(media_result.get("created"))
    return media_result

# ====== 路由模型 ======

class ProjectCreateRequest(BaseModel):
    project_name: str
    local_path: str

class TimelineRequest(BaseModel):
    video_path: str
    segments: List[Dict[str, Any]]

class SubtitleInsertRequest(BaseModel):
    segments: List[Dict[str, Any]]
    source_start_sec: Optional[float] = None
    target_start_frame: Optional[int] = None

class ExportRequest(BaseModel):
    timeline_name: Optional[str] = None
    target_dir: str
    file_name_template: str
    preset_name: Optional[str] = None
    use_subfolder: bool = False
    subfolder_name: Optional[str] = None

class CheckTimelineRequest(BaseModel):
    flash_frame_threshold: int = 3
    check_black_frames: bool = True
    check_black_borders: bool = True
    black_border_safe_zone: int = 2

class TimelineDebugRequest(BaseModel):
    include_video: bool = True
    include_audio: bool = True

class TimelineIssueRequest(BaseModel):
    issue: Optional[Dict[str, Any]] = None
    frame: Optional[int] = None

class TimelineIssuesMarkerRequest(BaseModel):
    issues: List[Dict[str, Any]]
    clear_existing: bool = False

class TimelineBlackBorderFixRequest(BaseModel):
    issue: Dict[str, Any]

class FolderConfigRequest(BaseModel):
    local_folders: List[str]
    davinci_folders: List[str]
    mapping: Dict[str, Any]  # Changed to Dict[str, Any] to accept { target: str, include_sub: bool }


class ModelInstallRequest(BaseModel):
    profile_key: Optional[str] = None
    force: bool = False


# ── 内嵌技能清单 ──────────────────────────────
# 软件内置的技能列表，路径相对于项目根目录

_BUNDLED_SKILLS = [
    {
        "key": "quickclip-dev",
        "name": "QuickClip Skill",
        "description": "QuickClip 官方技能 — 提供 DaVinci Resolve 全功能 CLI，支持转录、时间线剪辑、字幕编辑和导出渲染",
        "relative_path": ".claude/skills/quickclip-dev",
    }
]

# 支持的安装目标平台（按优先级排序）
_SKILL_INSTALL_TARGETS = [
    {"id": "claude",  "label": "Claude Code",   "dir": "~/.claude/skills"},
    {"id": "agent",   "label": "通用 Agent",     "dir": "~/.agent/skills"},
    {"id": "codex",   "label": "Codex CLI",      "dir": "~/.codex/skills"},
    {"id": "gemini",  "label": "Gemini CLI",     "dir": "~/.gemini/skills"},
    {"id": "openclaw","label": "OpenClaw",       "dir": "~/.openclaw/skills"},
    {"id": "codebuddy","label": "CodeBuddy",     "dir": "~/.codebuddy/skills"},
]


# ── 全局配置 API ──────────────────────────────

class AppConfigRequest(BaseModel):
    feishu_app_id: str = ""
    feishu_app_secret: str = ""
    feishu_uid: str = ""


@app.get("/api/config")
async def get_app_config():
    """获取全局应用配置（飞书等）"""
    config = load_config()
    return {
        "feishu_app_id": config.get("feishu_app_id", ""),
        "feishu_app_secret": config.get("feishu_app_secret", ""),
        "feishu_uid": config.get("feishu_uid", ""),
    }


@app.post("/api/config")
async def set_app_config(request: AppConfigRequest):
    """保存全局应用配置（飞书等）"""
    data = {
        "feishu_app_id": request.feishu_app_id,
        "feishu_app_secret": request.feishu_app_secret,
        "feishu_uid": request.feishu_uid,
    }
    ok = save_config(data)
    if ok:
        return {"status": "success", "message": "配置已保存"}
    raise HTTPException(status_code=500, detail="配置保存失败")


# ── 技能安装 API ──────────────────────────────


def _resolve_project_root() -> str:
    return os.path.realpath(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


@app.get("/api/skills/bundled")
async def get_bundled_skills():
    """返回软件内置的技能清单及各平台安装状态。"""
    skills = []
    for s in _BUNDLED_SKILLS:
        skill_name = os.path.basename(s["relative_path"])
        platforms = []
        for t in _SKILL_INSTALL_TARGETS:
            dest = os.path.join(os.path.expanduser(t["dir"]), skill_name)
            inst = os.path.isdir(dest) and os.path.exists(os.path.join(dest, "SKILL.md"))
            platforms.append({
                "id": t["id"],
                "label": t["label"],
                "installed": inst,
                "dir": dest if inst else None,
            })
        skills.append({
            "key": s["key"],
            "name": s["name"],
            "description": s["description"],
            "platforms": platforms,
        })

    return {"skills": skills}


class SkillInstallRequest(BaseModel):
    key: str
    target: str = "claude"  # 安装目标平台 ID，默认 claude


@app.post("/api/skills/install")
async def install_skill(request: SkillInstallRequest):
    """将指定技能的整个目录复制到目标 agent 平台的 skills 目录。"""
    project_root = _resolve_project_root()

    skill = next((s for s in _BUNDLED_SKILLS if s["key"] == request.key), None)
    if not skill:
        raise HTTPException(status_code=404, detail=f"技能 '{request.key}' 不在内置清单中")

    target_platform = next((t for t in _SKILL_INSTALL_TARGETS if t["id"] == request.target), None)
    if not target_platform:
        raise HTTPException(status_code=400, detail=f"不支持的目标平台: {request.target}")

    src_dir = os.path.realpath(os.path.join(project_root, skill["relative_path"]))
    if not src_dir.startswith(project_root + os.sep):
        raise HTTPException(status_code=400, detail="技能路径无效")
    if not os.path.isdir(src_dir):
        raise HTTPException(status_code=404, detail=f"技能源路径不存在: {src_dir}")

    skill_name = os.path.basename(skill["relative_path"])
    dest_dir = os.path.join(os.path.expanduser(target_platform["dir"]), skill_name)

    try:
        os.makedirs(os.path.dirname(dest_dir), exist_ok=True)
        shutil.copytree(src_dir, dest_dir, dirs_exist_ok=True)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"复制技能文件失败: {e}")

    return {
        "ok": True,
        "message": f"技能 {skill['name']} 已安装到 {target_platform['label']} ({dest_dir})",
        "dest_dir": dest_dir,
    }


class SkillUninstallRequest(BaseModel):
    key: str
    target: str = "claude"


@app.post("/api/skills/uninstall")
async def uninstall_skill(request: SkillUninstallRequest):
    """从目标 agent 平台的 skills 目录删除指定技能。"""
    skill = next((s for s in _BUNDLED_SKILLS if s["key"] == request.key), None)
    if not skill:
        raise HTTPException(status_code=404, detail=f"技能 '{request.key}' 不在内置清单中")

    target_platform = next((t for t in _SKILL_INSTALL_TARGETS if t["id"] == request.target), None)
    if not target_platform:
        raise HTTPException(status_code=400, detail=f"不支持的目标平台: {request.target}")

    skill_name = os.path.basename(skill["relative_path"])
    dest_dir = os.path.join(os.path.expanduser(target_platform["dir"]), skill_name)

    if not os.path.isdir(dest_dir):
        raise HTTPException(status_code=404, detail=f"技能未安装在此平台: {dest_dir}")

    try:
        shutil.rmtree(dest_dir)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"卸载技能失败: {e}")

    return {"ok": True, "message": f"技能 {skill['name']} 已从 {target_platform['label']} 卸载"}


@app.get("/api/folder_config")
async def get_folder_config():
    return load_folder_config()

@app.get("/api/update/check")
async def check_update(
    platform: str = "macos",
    arch: str = "aarch64",
    current_version: str = "0.0.0",
):
    return check_github_update(current_version=current_version, platform=platform, arch=arch)

@app.post("/api/folder_config")
async def set_folder_config(request: FolderConfigRequest):
    data = {
        "local_folders": request.local_folders,
        "davinci_folders": request.davinci_folders,
        "mapping": request.mapping
    }
    success = save_folder_config(data)
    if success:
        return {"status": "success", "message": "文件夹结构配置已保存"}
    raise HTTPException(status_code=500, detail="文件夹结构配置保存失败")

@app.post("/api/folder_config/install_workflow")
async def install_automator_workflow():
    config = load_folder_config()
    result = generate_automator_workflow(config.get("local_folders", []))
    if result.get("status") == "error":
        raise HTTPException(status_code=500, detail=result.get("message"))
    return result

# ====== 达芬奇控制 API ======

@app.get("/")
async def root():
    return {"status": "ok", "message": "DaVinci Resolve 剪辑助手后端服务运行中"}

@app.get("/api/yueliu/resolve")
async def resolve_yueliu_link(url: str):
    """解析阅流短链接，返回 share code"""
    import re
    try:
        resp = requests.get(url, allow_redirects=False, timeout=10,
            headers={"User-Agent": "Mozilla/5.0"})
        location = resp.headers.get("Location", "")
        # 从重定向 URL 提取 share code
        m = re.search(r'/share/(?:list/)?([a-f0-9]+)', location)
        if m:
            return {"ok": True, "shareCode": m.group(1), "redirectUrl": location}
        # 也尝试从原始 URL 直接提取
        m = re.search(r'/share/(?:list/)?([a-f0-9]+)', url)
        if m:
            return {"ok": True, "shareCode": m.group(1), "redirectUrl": url}
        return {"ok": False, "error": "无法从链接中提取分享码"}
    except Exception as e:
        return {"ok": False, "error": f"请求失败: {str(e)}"}


@app.get("/api/yueliu/comments")
async def get_yueliu_comments(url: str):
    """完整流程：解析短链接 → 获取文件列表 → 拉取所有时间戳评论"""
    import hashlib
    import time as _time

    API_BASE = "https://pub.yueliu.cloud"
    APP_SECRET = os.environ.get("YUE_LIU_APP_SECRET", "").strip()
    if not APP_SECRET:
        raise HTTPException(status_code=503, detail="Set YUE_LIU_APP_SECRET to use YueLiu comments.")
    # ── 1. 解析 share code ─────────────────────
    share_code = None
    m = re.search(r'/share/(?:list/)?([a-f0-9]+)', url)
    if m:
        share_code = m.group(1)
    m = re.search(r'/share/file/[^/]+/([a-f0-9]+)', url)
    if m:
        share_code = m.group(1)
    if not share_code:
        try:
            resp = requests.get(url, allow_redirects=False, timeout=10,
                headers={"User-Agent": "Mozilla/5.0"})
            location = resp.headers.get("Location", "")
            m = re.search(r'/share/(?:list/)?([a-f0-9]+)', location)
            if m:
                share_code = m.group(1)
        except Exception:
            pass
    if not share_code:
        return {"ok": False, "error": "无法从链接中提取分享码"}

    # ── 2. 构建签名 ──────────────────────────
    def _make_headers(code, path_suffix="list"):
        ts = int(_time.time() * 1000)
        token = hashlib.md5(f"{APP_SECRET}{ts}".encode()).hexdigest()
        return {
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json, text/plain, */*",
            "Referer": "https://yueliu.cn/",
            "Origin": "https://yueliu.cn",
            "x-platform": "1",
            "timestamp": str(ts),
            "x-path": f"#/share/{path_suffix}/{code}",
            "app-canary": "-1",
            "appserecttoken": token,
            "share-verify": "null",
            "x-device-id": "quickclip-backend",
        }, token

    # ── 3. 递归获取所有文件（支持目录嵌套） ──
    def _fmt_time(ms):
        ms = float(ms) if ms else 0
        total_sec = int(ms / 1000)
        return f"{total_sec // 60:02d}:{total_sec % 60:02d}"

    def _fetch_files(code, top_id=0, depth=0):
        """递归获取文件列表，展开目录（type ≠ 1 视为目录）"""
        if depth > 3:  # 最大嵌套深度
            return []
        h, token = _make_headers(code)
        verify_val = hashlib.md5(f"{token}{code}".encode()).hexdigest()
        resp = requests.get(f"{API_BASE}/api/v1/share/files", params={
            "code": code, "verify": verify_val,
            "curr_page": 1, "page_size": 200, "top_id": top_id,
        }, headers=h)
        if resp.status_code != 200:
            return []
        data = resp.json()
        if data.get("code") != 1000:
            return []
        results = []
        for f in data["data"]["list"]:
            ftype = f.get("type", 1)
            if ftype != 1 and f.get("comment_count", 0) == 0:
                # 目录：递归获取子文件
                children = _fetch_files(code, f["id"], depth + 1)
                if children:
                    results.extend(children)
                else:
                    # 空目录也展示
                    results.append(f)
            else:
                results.append(f)
        return results

    files = _fetch_files(share_code)
    if not files:
        return {"ok": False, "error": "该分享中没有文件"}

    # ── 4. 获取评论 ──────────────────────────
    all_files = []

    for f in files:
        doc_id = f["id"]
        cc = f.get("comment_count", 0)
        file_info = {
            "fileId": doc_id,
            "fileName": f["name"],
            "duration": f.get("time", 0),
            "size": f.get("size", 0),
            "commentCount": cc,
            "comments": [],
        }
        if cc > 0:
            h2, token2 = _make_headers(share_code, "file/xxx")
            verify2 = hashlib.md5(f"{token2}{doc_id}".encode()).hexdigest()
            try:
                cr = requests.get(f"{API_BASE}/api/v1/project/comment", params={
                    "code": share_code, "doc_id": doc_id, "verify": verify2,
                }, headers=h2)
                if cr.status_code == 200:
                    cd = cr.json()
                    if cd.get("code") == 1000:
                        raw = cd["data"]["list"]
                        raw.sort(key=lambda c: float(c.get("media_time", 0)))
                        file_info["comments"] = [{
                            "id": c["id"],
                            "timeMs": float(c.get("media_time", 0)),
                            "timeFormatted": _fmt_time(c.get("media_time", 0)),
                            "content": c.get("content", ""),
                            "user": c.get("userinfo", {}).get("real_name", ""),
                            "userId": c.get("userinfo", {}).get("user_id", 0),
                            "createdAt": c.get("created_at", 0),
                            "replyCount": c.get("count", 0),
                            "duration": c.get("duration", 0),
                        } for c in raw]
                    else:
                        file_info["error"] = cd.get("msg", "未知")
            except Exception as e:
                file_info["error"] = str(e)
        all_files.append(file_info)

    # ── 5. 分享名称 ──────────────────────────
    share_name = files[0]["name"] if files else "未命名"
    try:
        h3, token3 = _make_headers(share_code)
        verify3 = hashlib.md5(f"{token3}{share_code}".encode()).hexdigest()
        sr = requests.get(f"{API_BASE}/api/v1/share", params={
            "code": share_code, "verify": verify3,
        }, headers=h3)
        if sr.status_code == 200 and sr.json().get("code") == 1000:
            share_name = sr.json()["data"].get("name", share_name)
    except Exception:
        pass

    return {"ok": True, "shareCode": share_code, "shareName": share_name, "files": all_files}


class ReviewMarkerRequest(BaseModel):
    comments: List[Dict[str, Any]]
    fileName: str = ""
    fileId: Optional[Union[str, int]] = ""


class ReviewMarkerDeleteRequest(BaseModel):
    commentIds: List[Union[int, str]] = []


def _parse_review_marker_custom(custom: str):
    """解析 review_sync customData，返回 dict 或 None。
    支持格式：
      - review_sync:fileId:commentId (旧格式)
      - review_sync:fileId:commentId:trackIdx:mediaId:sourceOffset (新格式)
      - review_sync:commentId (旧旧格式)
    """
    if not custom or not custom.startswith("review_sync:"):
        return None
    payload = custom.split(":", 1)[1] if ":" in custom else ""
    parts = payload.split(":")
    if len(parts) >= 5:
        return {"fileId": parts[0], "commentId": parts[1], "trackIdx": parts[2], "mediaId": parts[3], "sourceOffset": parts[4]}
    elif len(parts) == 2:
        return {"fileId": parts[0], "commentId": parts[1], "trackIdx": "", "mediaId": "", "sourceOffset": ""}
    elif len(parts) == 1:
        return {"fileId": "", "commentId": parts[0], "trackIdx": "", "mediaId": "", "sourceOffset": ""}
    return None


def _get_review_marker_ids(timeline):
    """扫描时间线上 review_sync: 标记，返回 {commentId: fileId} 映射。"""
    result = {}
    try:
        markers = timeline.GetMarkers() or {}
    except Exception:
        return result
    for _, marker in markers.items():
        info = _parse_review_marker_custom(str(marker.get("customData", "")))
        if info and info["commentId"]:
            result[info["commentId"]] = info["fileId"]
    return result


@app.get("/api/yueliu/markers/status")
async def check_marker_status(commentIds: str = ""):
    """检查哪些评论 ID 在时间线上已有标记"""
    if not resolve_controller.resolve:
        return {"status": "ok", "existingIds": [], "existingMap": {}}
    try:
        resolve_controller._refresh_context()
        timeline = resolve_controller._get_active_timeline()
        if not timeline:
            return {"status": "ok", "existingIds": [], "existingMap": {}}
        ids = [i.strip() for i in commentIds.split(",") if i.strip()]
        existing = _get_review_marker_ids(timeline)
        matched_ids = [cid for cid in ids if cid in existing]
        matched_map = {cid: existing[cid] for cid in matched_ids}
        return {"status": "ok", "existingIds": matched_ids, "existingMap": matched_map}
    except Exception:
        return {"status": "ok", "existingIds": [], "existingMap": {}}


def _get_clip_source_start(item):
    """获取 clip 的源素材起始帧号，优先使用 GetSourceStartFrame，fallback 到 GetLeftOffset + mediaStart"""
    try:
        if hasattr(item, 'GetSourceStartFrame'):
            ssf = item.GetSourceStartFrame()
            if ssf is not None:
                return int(ssf)
    except Exception:
        pass
    # fallback: mediaStart + leftOffset
    try:
        mp_item = item.GetMediaPoolItem()
        if mp_item:
            media_start = int(float(mp_item.GetClipProperty("Start") or 0))
            try:
                if hasattr(item, 'GetLeftOffset'):
                    lo = item.GetLeftOffset()
                    if lo is not None:
                        return int(media_start + int(lo))
            except Exception:
                pass
            return int(media_start)
    except Exception:
        pass
    return None


def _get_clip_source_end(item, source_start, clip_duration):
    """获取 clip 的源素材结束帧号"""
    try:
        if hasattr(item, 'GetSourceEndFrame'):
            sef = item.GetSourceEndFrame()
            if sef is not None:
                return int(sef)
    except Exception:
        pass
    return int(source_start + clip_duration) if source_start is not None else None


def _find_clip_binding(timeline, frame: int, frame_rate: float = 24.0):
    """遍历视频轨道 V1→Vn，找到时间线帧 frame 所在的首个 clip，返回绑定信息。
    frame 是审阅评论 timeMs 换算得到的时间线物理帧（即评论在导出视频中的位置）。
    返回: (track_index, media_id, source_offset, timeline_frame) 或 None
    - source_offset: 该时间线帧位置对应在源素材中的帧号（用于后续同步时重新定位）
    - timeline_frame: 恒等于输入的 frame，可直接用于 AddMarker

    关键认知：review timeMs 是审阅者在导出视频中看到的时间，不是源素材时间。
    frame = timeMs / 1000 * frame_rate 已经是在时间线上的正确物理位置。
    """
    try:
        video_track_count = timeline.GetTrackCount("video") or 0
    except Exception:
        return None

    try:
        timeline_start = int(timeline.GetStartFrame() or 0)
    except Exception:
        timeline_start = 0

    # 将物理帧转为绝对帧（加上 timecode 偏移），匹配 item.GetStart() 的坐标系统
    absolute_frame = frame + timeline_start

    for track_idx in range(1, video_track_count + 1):
        try:
            items = timeline.GetItemListInTrack("video", track_idx) or []
        except Exception:
            continue
        for item in items:
            try:
                item_start = int(item.GetStart())
                item_end = int(item.GetEnd())
            except Exception:
                continue

            # 按时间线位置匹配：绝对帧是否落在该 clip 的时间线范围内
            if item_start <= absolute_frame < item_end:
                source_start = _get_clip_source_start(item)
                if source_start is None:
                    continue
                clip_duration = max(1, item_end - item_start)
                source_end = _get_clip_source_end(item, source_start, clip_duration)
                if source_end is None:
                    continue
                source_duration = max(1, source_end - source_start)
                speed = source_duration / clip_duration

                # 从时间线位置反推源素材帧偏移（用于后续同步）
                clip_start_relative = item_start - timeline_start
                source_offset = source_start + int((frame - clip_start_relative) * speed)

                media_id = ""
                try:
                    mp_item = item.GetMediaPoolItem()
                    if mp_item:
                        media_id = str(mp_item.GetMediaId() or "")
                except Exception:
                    pass

                return (track_idx, media_id, source_offset, frame)
    return None


@app.post("/api/yueliu/mark-timeline")
async def mark_review_to_timeline(request: ReviewMarkerRequest):
    """将审阅评论添加到时间线标记"""
    if not resolve_controller.resolve:
        return {"status": "error", "message": "达芬奇未连接"}

    try:
        resolve_controller._refresh_context()
        timeline = resolve_controller._get_active_timeline()
        if not timeline:
            return {"status": "error", "message": "当前项目中没有可用时间线"}

        project = resolve_controller.project
        project.SetCurrentTimeline(timeline)
        resolve_controller.resolve.OpenPage("edit")

        frame_rate = float(timeline.GetSetting("timelineFrameRate") or 24)
        file_id_str = str(request.fileId) if request.fileId is not None and request.fileId != "" else ""

        # 清除旧的同批标记：扫描所有 review_sync 标记，匹配 fileId:commentId 前缀
        old_prefix = f"review_sync:{file_id_str}:"
        raw_markers = timeline.GetMarkers() or {}
        for frame_key, marker in list(raw_markers.items()):
            custom = str(marker.get("customData", ""))
            if custom.startswith(old_prefix):
                try:
                    timeline.DeleteMarkerByCustomData(custom)
                except Exception:
                    try:
                        timeline.DeleteMarkerAtFrame(int(frame_key))
                    except Exception:
                        pass

        # 加载已有标记（GetMarkers 返回 {float_frame: {marker}} 格式）
        raw_markers = timeline.GetMarkers() or {}
        existing = {}
        for k, v in raw_markers.items():
            try:
                existing[int(k)] = v
            except (ValueError, TypeError):
                pass

        added = 0
        skipped = 0
        binding_count = 0
        for c in request.comments:
            ms = float(c.get("timeMs", 0))
            frame = int(ms / 1000.0 * frame_rate)

            note = c.get("content", "")[:200]
            user = c.get("user", "")
            marker_name = user or "审阅"
            marker_name = marker_name.replace("\n", " ").replace("\r", " ").replace("\t", " ").strip() or "审阅"

            comment_id = str(c.get("id", ""))
            if not comment_id:
                skipped += 1
                continue

            # frame = timeMs/1000*frameRate 已是在时间线上的正确物理帧位置
            # _find_clip_binding 仅用于记录源素材绑定信息（供后续同步使用）
            target = frame
            binding = _find_clip_binding(timeline, frame, frame_rate)
            if binding:
                track_idx, media_id, source_offset, _ = binding
                custom_data = f"review_sync:{file_id_str}:{comment_id}:{track_idx}:{media_id}:{source_offset}"
                binding_count += 1
            else:
                custom_data = f"review_sync:{file_id_str}:{comment_id}"

            # 同帧冲突：依次尝试后续帧
            start_frame = target
            while target in existing:
                target += 1
                if target - start_frame > 300:
                    break
            else:
                created = False
                try:
                    created = bool(timeline.AddMarker(target, "Green", marker_name, note, 1, custom_data))
                except Exception:
                    pass
                if not created:
                    try:
                        created = bool(timeline.AddMarker(target, "Green", marker_name, note, 1))
                    except Exception:
                        pass

                if created:
                    existing[target] = True
                    added += 1
                else:
                    skipped += 1
                continue

            skipped += 1  # while-break

        return {
            "status": "success",
            "added": added,
            "skipped": skipped,
            "total": len(request.comments),
            "binding_count": binding_count,
            "message": f"已添加 {added} 个标记" + (f"，{skipped} 个跳过" if skipped else ""),
        }

    except Exception as e:
        print(f"[review-sync] 异常: {e}")
        return {"status": "error", "message": f"添加失败: {str(e)}"}


@app.post("/api/yueliu/mark-timeline/remove")
async def remove_review_markers(request: ReviewMarkerDeleteRequest):
    """移除时间线上的审阅标记"""
    if not resolve_controller.resolve:
        return {"status": "success", "removed": 0, "message": "达芬奇未连接"}

    try:
        resolve_controller._refresh_context()
        timeline = resolve_controller._get_active_timeline()
        if not timeline:
            return {"status": "success", "removed": 0, "message": "没有可用时间线"}

        project = resolve_controller.project
        project.SetCurrentTimeline(timeline)
        resolve_controller.resolve.OpenPage("edit")

        target_ids = set(str(cid) for cid in (request.commentIds or []))
        removed = 0

        existing = timeline.GetMarkers() or {}
        for frame_id, marker in list(existing.items()):
            custom = str(marker.get("customData", ""))
            info = _parse_review_marker_custom(custom)
            if not info:
                continue
            marker_cid = info["commentId"]
            if not target_ids or marker_cid in target_ids:
                try:
                    if timeline.DeleteMarkerByCustomData(custom):
                        removed += 1
                except Exception:
                    try:
                        timeline.DeleteMarkerAtFrame(int(frame_id))
                    except Exception:
                        try:
                            timeline.DeleteMarkerAtFrame(str(frame_id))
                        except Exception:
                            pass

        return {"status": "success", "removed": removed, "message": f"已移除 {removed} 个标记"}
    except Exception as e:
        return {"status": "error", "message": f"移除失败: {str(e)}"}


class ReviewMarkerSyncRequest(BaseModel):
    fileId: Optional[Union[str, int]] = ""


@app.post("/api/yueliu/mark-timeline/sync")
async def sync_review_markers(request: ReviewMarkerSyncRequest):
    """同步审阅标记：当绑定的视频素材移动/裁切/删除后，调整标记位置。
    规则：
      - 素材拖动 → 标记跟随
      - 素材裁切但标记仍在范围内 → 标记跟随
      - 素材裁切导致标记超出范围 → 标记保持原位
      - V1 素材被删除 → 尝试 V2→V3→... 绑定相同 mediaPoolId 的素材
      - 所有轨道无匹配 → 标记保持原位
    安全：先创建新标记，成功后才删除旧标记，避免标记丢失。
    """
    if not resolve_controller.resolve:
        return {"status": "error", "message": "达芬奇未连接"}

    try:
        resolve_controller._refresh_context()
        timeline = resolve_controller._get_active_timeline()
        if not timeline:
            return {"status": "error", "message": "没有可用时间线"}

        project = resolve_controller.project
        project.SetCurrentTimeline(timeline)
        resolve_controller.resolve.OpenPage("edit")

        file_id_str = str(request.fileId) if request.fileId is not None and request.fileId != "" else ""

        # 收集所有 review_sync 标记及其绑定信息
        raw_markers = timeline.GetMarkers() or {}
        markers = []
        for frame_key, marker in raw_markers.items():
            custom = str(marker.get("customData", ""))
            info = _parse_review_marker_custom(custom)
            if not info:
                continue
            if file_id_str and info["fileId"] != file_id_str:
                continue
            markers.append({
                "frame_key": frame_key,
                "frame": int(frame_key),
                "custom": custom,
                "info": info,
                "marker": marker,
            })

        if not markers:
            return {"status": "success", "moved": 0, "kept": 0, "message": "没有可同步的标记"}

        # 构建 mediaPoolId → [{trackIdx, itemStart, itemEnd, sourceStart, sourceEnd, speed}] 映射
        # 使用与 _find_clip_binding 一致的 helper 函数确保坐标系统一致
        # 关键：item.GetStart() 返回绝对帧号，需减去 timeline_start 转为相对帧（AddMarker 使用相对帧）
        try:
            timeline_start = int(timeline.GetStartFrame() or 0)
        except Exception:
            timeline_start = 0

        clip_map = {}
        video_track_count = timeline.GetTrackCount("video") or 0
        for track_idx in range(1, video_track_count + 1):
            try:
                items = timeline.GetItemListInTrack("video", track_idx) or []
            except Exception:
                continue
            for item in items:
                source_start = _get_clip_source_start(item)
                if source_start is None:
                    continue
                try:
                    item_start = int(item.GetStart()) - timeline_start
                    item_end = int(item.GetEnd()) - timeline_start
                except Exception:
                    continue
                clip_duration = max(1, item_end - item_start)
                source_end = _get_clip_source_end(item, source_start, clip_duration)
                if source_end is None:
                    continue
                source_duration = max(1, source_end - source_start)
                speed = source_duration / clip_duration
                media_id = ""
                try:
                    mp_item = item.GetMediaPoolItem()
                    if mp_item:
                        media_id = str(mp_item.GetMediaId() or "")
                except Exception:
                    pass
                if not media_id:
                    continue
                entry = {
                    "trackIdx": track_idx,
                    "itemStart": item_start,
                    "itemEnd": item_end,
                    "sourceStart": source_start,
                    "sourceEnd": source_end,
                    "speed": speed,
                }
                clip_map.setdefault(media_id, []).append(entry)

        # 收集当前所有标记帧位置用于冲突检测
        occupied_frames = {}
        for fk, mv in raw_markers.items():
            try:
                f = int(fk)
                if f not in occupied_frames:
                    occupied_frames[f] = mv
            except (ValueError, TypeError):
                pass

        moved = 0
        kept = 0
        for m in markers:
            info = m["info"]
            media_id = info.get("mediaId", "")
            if not media_id:
                kept += 1
                continue

            try:
                source_offset = int(info.get("sourceOffset", 0))
            except (ValueError, TypeError):
                kept += 1
                continue

            candidates = clip_map.get(media_id, [])
            if not candidates:
                kept += 1
                continue

            # 找到标记在源素材偏移量所处范围内的 clip（按轨道从低到高）
            best = None
            for entry in candidates:
                if entry["sourceStart"] <= source_offset < entry["sourceEnd"]:
                    best = entry
                    break

            if not best:
                kept += 1
                continue

            # 计算新帧位置
            new_frame = best["itemStart"] + int((source_offset - best["sourceStart"]) / best["speed"])

            if new_frame == m["frame"]:
                kept += 1
                continue

            # 同帧冲突：新位置已有其他标记（非自身），微调帧号
            conflict_frame = new_frame
            while conflict_frame in occupied_frames:
                conflict_marker = occupied_frames[conflict_frame]
                conflict_custom = str(conflict_marker.get("customData", ""))
                if conflict_custom == m["custom"]:
                    break  # 同一个标记
                conflict_frame += 1
                if conflict_frame - new_frame > 10:
                    break
            else:
                new_frame = conflict_frame

            # 安全策略：先创建新标记，成功后才删除旧标记
            old_marker = m["marker"]
            note = str(old_marker.get("note", ""))[:200]
            name = str(old_marker.get("name", "审阅")).replace("\n", " ").replace("\r", " ").replace("\t", " ").strip() or "审阅"
            color = str(old_marker.get("color", "Green"))

            created = False
            try:
                created = bool(timeline.AddMarker(new_frame, color, name, note, 1, m["custom"]))
            except Exception:
                pass
            if not created:
                try:
                    created = bool(timeline.AddMarker(new_frame, color, name, note, 1))
                except Exception:
                    pass

            if not created:
                # 创建新标记失败，保留旧标记不动
                kept += 1
                continue

            # 新标记创建成功，安全删除旧标记
            try:
                timeline.DeleteMarkerByCustomData(m["custom"])
            except Exception:
                try:
                    timeline.DeleteMarkerAtFrame(int(m["frame_key"]))
                except Exception:
                    pass

            occupied_frames[new_frame] = m["marker"]
            try:
                del occupied_frames[m["frame"]]
            except KeyError:
                pass
            moved += 1

        return {
            "status": "success",
            "moved": moved,
            "kept": kept,
            "total": len(markers),
            "message": f"已同步 {moved} 个标记" + (f"，{kept} 个保持原位" if kept else ""),
        }

    except Exception as e:
        print(f"[review-sync] 同步异常: {e}")
        return {"status": "error", "message": f"同步失败: {str(e)}"}


@app.get("/api/status")
async def get_status():
    """获取达芬奇连接状态及当前项目和时间线"""
    return resolve_controller.get_status()

@app.get("/api/backend/health")
async def backend_health():
    """后端运行时健康检查：语音识别、ffmpeg 等依赖状态"""
    transcriber_status = transcriber.get_model_status()
    ffmpeg_exe = _get_ffmpeg_executable()
    ffmpeg_ok = False
    try:
        ffmpeg_ok = subprocess.run([ffmpeg_exe, "-version"], capture_output=True, timeout=8).returncode == 0
    except Exception:
        pass
    return {
        "backend": "running",
        "python": {
            "available": True,
            "version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "executable": sys.executable,
        },
        "funasr": {  # 保留旧 key 兼容已有前端
            "available": transcriber_status.get("ready", False),
            "model_loaded": transcriber.recognizer is not None,
            "error": transcriber.init_error if transcriber.recognizer is None else None,
            "preset": transcriber_status.get("preset"),
            "models_ready": transcriber_status.get("ready"),
            "missing_labels": transcriber_status.get("missing_labels", []),
        },
        "transcription": {
            "available": transcriber_status.get("ready", False),
            "model_loaded": transcriber.recognizer is not None,
            "error": transcriber.init_error if transcriber.recognizer is None else None,
            "preset": transcriber_status.get("preset"),
            "models_ready": transcriber_status.get("ready"),
            "missing_labels": transcriber_status.get("missing_labels", []),
        },
        "ffmpeg": {
            "available": ffmpeg_ok,
            "path": ffmpeg_exe,
        },
    }


@app.get("/api/backend/funasr/models")
async def get_funasr_models_status():
    """获取语音识别运行时与模型安装状态"""
    return transcriber.get_model_status()


@app.post("/api/backend/funasr/models/install")
async def install_funasr_models(request: ModelInstallRequest, background_tasks: BackgroundTasks):
    """安装语音识别工具包及当前字幕功能所需依赖（后台执行，通过 progress 端点轮询状态）"""
    from transcriber import _progress
    if _progress[0].get("running"):
        raise HTTPException(status_code=409, detail="安装正在进行中，请等待完成")
    background_tasks.add_task(_run_install, request.force, request.profile_key)
    return {"status": "accepted", "message": "安装已开始"}


def _run_install(force: bool, profile_key: Optional[str] = None):
    try:
        transcriber.install_runtime_and_models(force=force, profile_key=profile_key)
    except Exception:
        pass  # 错误已写入 _install_progress


@app.get("/api/backend/funasr/models/install/progress")
async def get_install_progress_endpoint():
    """轮询安装进度"""
    return get_install_progress()


@app.post("/api/backend/funasr/models/delete")
async def delete_funasr_models(request: ModelInstallRequest):
    """删除当前字幕功能使用的 语音识别工具包模型"""
    try:
        result = transcriber.delete_model_package()
        return {
            "status": "success",
            "message": "语音识别工具包已删除",
            "preset": result.get("profile"),
            "removed_items": result.get("removed_items", []),
            "model_status": result.get("status"),
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/backend/transcription/release-memory")
async def release_transcription_memory():
    """卸载语音识别模型以释放内存"""
    transcriber.release_memory()
    return {"status": "success", "message": "模型已卸载，内存已释放"}


@app.get("/api/timeline/current")
async def get_current_timeline():
    """获取当前时间线信息"""
    try:
        timeline = resolve_controller.project.GetCurrentTimeline()
        if not timeline:
            return {"status": "idle", "timeline_name": None, "timeline_resolution": None}
        
        timeline_w = timeline.GetSetting("timelineResolutionWidth")
        timeline_h = timeline.GetSetting("timelineResolutionHeight")
        mismatch_behavior = timeline.GetSetting("timelineInputResMismatchBehavior")
        
        return {
            "status": "success",
            "timeline_name": timeline.GetName(),
            "timeline_resolution": {
                "width": timeline_w,
                "height": timeline_h
            },
            "mismatch_behavior": mismatch_behavior
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.get("/api/project/context")
async def get_project_context():
    """获取当前项目上下文，包括本地路径、导出目录和已导入素材"""
    context = sync_current_project_context(include_media=True)
    if not context.get("connected") or not context.get("project_name"):
        return {"status": "idle", "project": None}
    return {"status": "success", "project": context.get("project_name"), "context": context}

@app.get("/api/project/media_pool_folders")
async def get_media_pool_folders():
    status = resolve_controller.get_status()
    if not status.get("connected") or not status.get("project"):
        raise HTTPException(status_code=400, detail="未连接到达芬奇项目")
        
    folders = resolve_controller.get_media_pool_folders()
    return {"status": "success", "folders": folders}

@app.get("/api/project/folder_hierarchy")
async def get_folder_hierarchy():
    """获取媒体池文件夹层级树（含素材类型统计）"""
    status = resolve_controller.get_status()
    if not status.get("connected") or not status.get("project"):
        raise HTTPException(status_code=400, detail="未连接到达芬奇项目")
    result = resolve_controller.get_folder_hierarchy_tree()
    if result.get("status") == "error":
        raise HTTPException(status_code=500, detail=result.get("message"))
    return result

class FlattenFolderRequest(BaseModel):
    folder_paths: List[str]  # 要展平的文件夹路径列表
    keep_levels: int    # 保留的层级数量

@app.post("/api/project/folder_hierarchy/flatten")
async def flatten_folder_hierarchy(request: FlattenFolderRequest):
    """展平指定文件夹的层级"""
    status = resolve_controller.get_status()
    if not status.get("connected") or not status.get("project"):
        raise HTTPException(status_code=400, detail="未连接到达芬奇项目")
    result = resolve_controller.flatten_folder_hierarchy(request.folder_paths, request.keep_levels)
    if result.get("status") == "error":
        raise HTTPException(status_code=500, detail=result.get("message"))
    return result

class DeleteImagesRequest(BaseModel):
    folder_paths: List[str]  # 要删除图片的文件夹路径列表
    keep_levels: int = 1    # 保留层级，该层级内的空文件夹不会被删除

@app.post("/api/project/folder_hierarchy/delete-images")
async def delete_images_from_folders(request: DeleteImagesRequest):
    """删除指定文件夹中的所有 Image 类型素材，并清理空文件夹"""
    status = resolve_controller.get_status()
    if not status.get("connected") or not status.get("project"):
        raise HTTPException(status_code=400, detail="未连接到达芬奇项目")
    result = resolve_controller.delete_images_from_folders(request.folder_paths, request.keep_levels)
    if result.get("status") == "error":
        raise HTTPException(status_code=500, detail=result.get("message"))
    return result

@app.get("/api/project/current-timeline")
async def get_current_timeline():
    status = resolve_controller.get_status()
    if not status.get("connected"):
        return {"timeline": None}
    timeline = resolve_controller._get_active_timeline()
    return {"timeline": timeline.GetName() if timeline else None}

class SetLocalPathRequest(BaseModel):
    local_path: str

@app.post("/api/project/set-local-path")
async def set_local_path(request: SetLocalPathRequest):
    status = resolve_controller.get_status()
    if not status.get("connected") or not status.get("project"):
        return {"status": "error", "message": "未连接达芬奇"}
    project_name = status["project"]
    folder_config = load_folder_config()
    local_folders = folder_config.get("local_folders", [])
    local_path = normalize_path(request.local_path)
    if not local_path or not os.path.isdir(local_path):
        return {"status": "error", "message": "路径不存在"}
    record = update_project_record(project_name, {"local_path": local_path})
    subdirs = []
    try:
        subdirs = [d for d in os.listdir(local_path)
                   if os.path.isdir(os.path.join(local_path, d)) and not d.startswith('.')]
        subdirs.sort()
    except Exception:
        pass
    return {
        "status": "success",
        "local_path": local_path,
        "default_export_dir": record.get("default_export_dir", ""),
        "subdirs": subdirs,
        "structure": record.get("structure", {})
    }

@app.get("/api/project/path")
async def get_project_path():
    """获取当前项目的本地路径"""
    context = sync_current_project_context(include_media=False)
    local_path = context.get("local_path", "")
    subdirs = []
    path_error = ""
    if local_path:
        if os.path.isdir(local_path):
            try:
                subdirs = [d for d in os.listdir(local_path)
                           if os.path.isdir(os.path.join(local_path, d)) and not d.startswith('.')]
                subdirs.sort()
            except PermissionError:
                path_error = f"没有读取权限: {local_path}，请在系统设置中授予该目录的访问权限"
            except Exception as e:
                path_error = f"无法读取目录: {str(e)}"
        else:
            path_error = f"路径不存在: {local_path}"
    return {
        "project_path": local_path,
        "default_export_dir": context.get("default_export_dir", ""),
        "path_source": context.get("path_source", ""),
        "project": context.get("project_name"),
        "subdirs": subdirs,
        "path_error": path_error,
    }

@app.post("/api/reconnect")
async def reconnect_resolve():
    """尝试重新连接到达芬奇"""
    result = resolve_controller.reconnect()
    return result

@app.post("/api/project/create")
async def create_project(request: ProjectCreateRequest):
    result = resolve_controller.init_project(request.project_name, request.local_path)
    if result.get("status") == "error":
        code = result.get("code")
        status_code = 409 if code == "duplicate_project_name" else 500
        raise HTTPException(status_code=status_code, detail=result.get("message"))
    return result

@app.get("/api/export/presets")
async def get_render_presets():
    presets = resolve_controller.get_render_presets()
    return {"presets": presets}

@app.post("/api/export/render")
async def export_render(request: ExportRequest):
    result = resolve_controller.export_timeline(
        request.target_dir,
        request.file_name_template,
        request.preset_name,
        request.timeline_name,
        request.use_subfolder,
        request.subfolder_name
    )
    if result.get("status") == "error":
        raise HTTPException(status_code=500, detail=result.get("message"))
    project_name = resolve_controller.project.GetName() if resolve_controller.project else None
    if project_name:
        export_info = {
            "timeline_name": result.get("timeline_name"),
            "target_dir": result.get("resolved_dir") or request.target_dir,
            "file_name_template": request.file_name_template,
            "resolved_name": result.get("resolved_name"),
            "preset_name": request.preset_name,
            "job_id": result.get("job_id"),
        }
        update_project_record(project_name, {"latest_export": export_info})
        append_project_history(project_name, "export_history", export_info)
    return result

@app.post("/api/export/backup-only")
async def export_backup_only(request: ExportRequest):
    result = resolve_controller.backup_timeline_only(
        request.file_name_template,
        request.timeline_name,
        request.use_subfolder,
        request.subfolder_name
    )
    if result.get("status") == "error":
        raise HTTPException(status_code=500, detail=result.get("message"))
    return result

# ======= 转录 API =======

@app.post("/api/transcribe/path")
async def transcribe_path(video_path: str):
    """
    通过本地文件路径转录
    """
    if not os.path.exists(video_path):
        raise HTTPException(status_code=404, detail="文件不存在")
        
    try:
        result = await transcriber.transcribe(video_path)
        context = sync_current_project_context(include_media=False)
        project_name = context.get("project_name")
        if project_name:
            update_project_record(project_name, {
                "latest_transcript": {
                    "source_path": video_path,
                    "segment_count": len(result.get("segments", [])),
                    "transcript": result,
                }
            })
        return {"status": "success", "transcript": result}
    except TranscriptionModelMissingError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ======= 字幕生成 API =======

class SubtitleTranscribeRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    video_path: str
    language: str = "zh"
    model_profile: Optional[str] = None
    source_type: str = "file"  # "file" 或 "timeline"
    original_filename: str = ""
    transcript_id: Optional[str] = None  # 指定已有转录项目 ID
    clip_mapping: Optional[List[Dict[str, Any]]] = None  # 时间码映射表
    frame_rate: float = 24.0
    hotwords: Optional[List[str]] = None
    enable_speaker: bool = False  # 是否开启说话人分离
    speaker_threshold: float = 0.5  # 说话人聚类阈值 (0.1-1.0, 越低越倾向合并为更少说话人)
    max_chars_per_line: int = 16  # 转录后自动断句的字数上限，0 表示不断句
    word_timestamps: bool = True  # 文本剪辑需要词级时间戳，默认保留

class SubtitleAIOptimizeRequest(BaseModel):
    subtitle_text: str
    api_key: str
    base_url: str = "https://api.poixe.com/v1"
    model: str = "gpt-5-mini:free"
    enable_typo_fix: bool = True
    enable_sentence_break: bool = True
    enable_proper_noun: bool = True
    proper_nouns: List[str] = []

@app.post("/api/subtitle/export-audio")
async def subtitle_export_audio():
    """从达芬奇时间线导出音频，同时构建时间码映射表"""
    
    if not resolve_controller.resolve:
        raise HTTPException(status_code=500, detail="未连接达芬奇")
    
    try:
        resolve_controller._refresh_context()
        project = resolve_controller.project
        timeline = resolve_controller._get_active_timeline()
        if not timeline:
            raise HTTPException(status_code=500, detail="当前工程中没有可用时间线")
        
        timeline_name = timeline.GetName()
        project_name = project.GetName()
        
        # 获取帧率
        fps = float(timeline.GetSetting("timelineFrameRate") or project.GetSetting("timelineFrameRate") or 24)
        
        # 构建时间码映射表
        clip_mapping = build_clip_mapping(timeline, fps)
        
        audio_dir = get_audio_export_dir(project_name, timeline_name)
        audio_dir.mkdir(parents=True, exist_ok=True)
        audio_path = str(audio_dir / f"{timeline_name}_audio.wav")
        
        # 查找 Audio Only 预设
        presets = resolve_controller.get_render_presets()
        audio_preset = next((p for p in presets if "Audio Only" in p), None) \
                    or next((p for p in presets if "audio" in p.lower()), None)

        if not audio_preset:
            raise HTTPException(
                status_code=500,
                detail="未找到「Audio Only」渲染预设，请在达芬奇 Deliver 页面中确认该预设存在（系统自带），或手动导出音频后使用本地文件模式"
            )

        project.SetCurrentTimeline(timeline)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            lambda: resolve_controller.export_timeline(
                target_dir=str(audio_dir),
                file_name_template=f"{timeline_name}_audio",
                preset_name=audio_preset,
            )
        )
        
        # 如果导出成功，查找音频文件
        exported_files = []
        if audio_dir.exists():
            audio_exts = ('.wav', '.mp3', '.aac', '.m4a', '.mov')
            exported_files = [f for f in os.listdir(audio_dir) if f.endswith(audio_exts) and timeline_name in f]
        
        if exported_files:
            audio_path = str(audio_dir / exported_files[0])
            return {
                "audio_path": audio_path,
                "timeline_name": timeline_name,
                "clip_mapping": clip_snapshots_to_dicts(clip_mapping, fps),
                "original_filename": timeline_name,
                "source_type": "timeline",
                "frame_rate": fps,
            }

        if isinstance(result, dict) and result.get("status") == "error":
            raise HTTPException(status_code=500, detail=result.get("message") or "从时间线导出音频失败")
        
        ffmpeg = _get_ffmpeg_executable()
        try:
            ffmpeg_ok = subprocess.run([ffmpeg, "-version"], capture_output=True, timeout=8).returncode == 0
        except Exception:
            ffmpeg_ok = False
        
        if not ffmpeg_ok:
            raise HTTPException(status_code=500, detail="达芬奇未能导出音频文件，且系统缺少音频提取组件。请尝试：\n1. 在达芬奇中手动将时间线导出为 WAV 音频\n2. 回到应用选择「本地文件」模式进行转录")
        
        # 降级方案：用 ffmpeg 从时间线 clip 逐个提取
        video_track_count = timeline.GetTrackCount("video")
        audio_track_count = timeline.GetTrackCount("audio")
        
        for track_idx in range(1, max(video_track_count, audio_track_count) + 1):
            for track_type in ["video", "audio"]:
                if track_type == "video" and track_idx > video_track_count:
                    continue
                if track_type == "audio" and track_idx > audio_track_count:
                    continue
                clips = timeline.GetItemListInTrack(track_type, track_idx)
                if clips:
                    for clip in clips:
                        mp_item = clip.GetMediaPoolItem()
                        if mp_item:
                            clip_path = mp_item.GetClipProperty("File Path")
                            if clip_path and os.path.exists(clip_path):
                                subprocess.run([
                                    ffmpeg, "-y", "-i", clip_path,
                                    "-vn", "-acodec", "pcm_s16le",
                                    "-ar", "16000", "-ac", "1",
                                    audio_path
                                ], capture_output=True, timeout=300)
                                
                                if os.path.exists(audio_path):
                                    return {
                                        "audio_path": audio_path,
                                        "timeline_name": timeline_name,
                                        "clip_mapping": clip_snapshots_to_dicts(clip_mapping, fps),
                                        "original_filename": timeline_name,
                                        "source_type": "timeline",
                                        "frame_rate": fps,
                                    }

        raise HTTPException(status_code=500, detail="无法从时间线导出音频，请尝试手动导出音频文件后使用本地文件模式")
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def build_clip_mapping(timeline, frame_rate, track_type: str = "", track_index: int = 0) -> List[ClipSnapshot]:
    """采集时间线快照（List[ClipSnapshot]）。
    若指定 track_type + track_index，只采集该轨道；否则优先音频轨，音频为空时 fallback 到视频轨。
    """
    mapping: List[ClipSnapshot] = []
    timeline_start_frame = int(timeline.GetStartFrame()) if hasattr(timeline, 'GetStartFrame') else 0
    fps = float(frame_rate or 24)

    # 收集 clips
    clips_by_track = []
    if track_type and track_index > 0:
        # 锁定指定轨道
        try:
            items = timeline.GetItemListInTrack(track_type, track_index) or []
            for item in items:
                clips_by_track.append((item, track_type, track_index))
        except Exception:
            pass
    else:
        # 优先音频轨，音频为空时 fallback 到视频轨
        for tt in ("audio", "video"):
            try:
                tc_count = timeline.GetTrackCount(tt) or 0
            except Exception:
                tc_count = 0
            for ti in range(1, tc_count + 1):
                items = timeline.GetItemListInTrack(tt, ti) or []
                if items:
                    for item in items:
                        clips_by_track.append((item, tt, ti))
            if clips_by_track and tt == "audio":
                break

    for item, track_type, track_index in clips_by_track:
        mp_item = item.GetMediaPoolItem()
        if not mp_item:
            continue

        try:
            clip_name = item.GetName() or ""
            clip_path = mp_item.GetClipProperty("File Path") or ""
            media_id = str(mp_item.GetMediaId() or "")

            t_start = (int(item.GetStart()) - timeline_start_frame) / fps
            t_end = (int(item.GetEnd()) - timeline_start_frame) / fps

            # 源帧率
            source_fps = float(
                mp_item.GetClipProperty("FPS") or
                mp_item.GetClipProperty("Frame Rate") or
                fps or 24.0
            )

            # 源范围
            if hasattr(item, 'GetSourceStartFrame'):
                s_start = int(item.GetSourceStartFrame()) / source_fps
                s_end = int(item.GetSourceEndFrame()) / source_fps
            else:
                media_start = int(float(mp_item.GetClipProperty("Start") or 0))
                if hasattr(item, 'GetLeftOffset'):
                    s_start = (media_start + int(item.GetLeftOffset())) / source_fps
                else:
                    s_start = media_start / source_fps
                s_end = s_start + (t_end - t_start)

            duration = t_end - t_start
            speed = (s_end - s_start) / duration if duration > 0 else 1.0

            mapping.append(ClipSnapshot(
                clip_name=clip_name,
                clip_path=clip_path,
                media_id=media_id,
                timeline_start=round(t_start, 3),
                timeline_end=round(t_end, 3),
                source_start=round(s_start, 3),
                source_end=round(s_end, 3),
                speed=round(speed, 4),
                source_frame_rate=round(source_fps, 2),
                track_type=track_type,
                track_index=track_index,
            ))
        except Exception as e:
            print(f"[WARN] build_clip_mapping skip clip: {e}")

    mapping.sort(key=lambda c: c.timeline_start)
    return mapping

@app.post("/api/subtitle/transcribe")
async def subtitle_transcribe(request: SubtitleTranscribeRequest):
    """使用 SenseVoiceSmall 进行语音转录"""
    if not os.path.exists(request.video_path):
        raise HTTPException(status_code=404, detail="文件不存在")
    try:
        result = await transcriber.transcribe(
            request.video_path,
            request.language,
            request.hotwords,
            request.model_profile,
            enable_speaker=request.enable_speaker,
            speaker_threshold=request.speaker_threshold,
            word_timestamps=request.word_timestamps,
        )
        context = await get_project_context_with_timeout(include_media=False)
        project_name = context.get("project_name")
        
        segments = result.get("segments", [])

        # 自动断句：按 max_chars_per_line 将长句拆分为短片段
        max_chars = request.max_chars_per_line
        if max_chars > 0 and segments:
            from subtitle_speed_tracker import smart_split_segment, _count_effective_chars
            split_segments = []
            for seg in segments:
                text = seg.get("text", "").strip()
                if not text:
                    split_segments.append(seg)
                    continue
                # 快速预检：有效字符未超限则跳过拆分，避免为每个片段创建 tracker
                if _count_effective_chars(text) <= max_chars:
                    split_segments.append(seg)
                    continue
                subs = smart_split_segment(
                    text=text,
                    words=seg.get("words"),
                    start_time=float(seg.get("start", 0)),
                    end_time=float(seg.get("end", 0)),
                    max_chars=max_chars,
                )
                for sub in subs:
                    meta = {k: v for k, v in seg.items()
                            if k not in ("id", "text", "raw_text", "start", "end", "words")}
                    split_segments.append({
                        **meta,
                        "id": seg.get("id", 0) if sub["piece_index"] == 0 else f"{seg.get('id', 's')}_{sub['piece_index']}",
                        "text": sub["text"],
                        "raw_text": sub["text"],
                        "start": sub["start"],
                        "end": sub["end"],
                        "words": sub.get("words", []),
                    })
            segments = split_segments
            print(f"[INFO] 转录后自动断句: {len(result.get('segments', []))} → {len(segments)} 段 (max_chars={max_chars})", flush=True)

        # 最终输出前去除中文标点（断句阶段已使用标点做切分线索）
        for seg in segments:
            if seg.get("text"):
                seg["text"] = to_simplified_chinese(strip_chinese_punctuation(seg["text"]))

        # 生成转录项目 ID（用于缓存和锚点绑定）
        source_name = request.original_filename or os.path.basename(request.video_path)
        transcript_id = request.transcript_id or generate_transcript_id(source_name)

        # 建立源时间锚点绑定（供后续 sync-timeline 使用）
        frame_rate = request.frame_rate or 24.0
        if request.clip_mapping and segments:
            # 从 dict 重建 ClipSnapshot 列表
            snapshots: List[ClipSnapshot] = []
            for mp in request.clip_mapping:
                try:
                    snapshots.append(ClipSnapshot(
                        clip_name=str(mp.get("clip_name", "")),
                        clip_path=str(mp.get("clip_path", "")),
                        media_id=str(mp.get("media_id", "")),
                        timeline_start=float(mp.get("timeline_start", 0)),
                        timeline_end=float(mp.get("timeline_end", 0)),
                        source_start=float(mp.get("source_start", 0)),
                        source_end=float(mp.get("source_end", 0)),
                        speed=float(mp.get("speed", 1.0)),
                        source_frame_rate=float(mp.get("source_frame_rate", frame_rate)),
                    ))
                except Exception:
                    continue

            if snapshots:
                # 使用 transcript_id 作为 session_id
                session_id = transcript_id if transcript_id else (
                    request.original_filename or os.path.basename(request.video_path)
                )
                speed_tracker.create_session(
                    session_id, frame_rate,
                    track_type="audio",
                    track_index=1,
                )
                speed_tracker.create_bindings(
                    segments, snapshots,
                    fps=frame_rate,
                    session_id=session_id,
                )

        # 生成转录项目 ID 并保存到缓存
        if project_name:
            
            metadata = {
                "id": transcript_id,
                "name": source_name,
                "created_at": __import__('datetime').datetime.now().isoformat(),
                "source_type": request.source_type,
                "frame_rate": request.frame_rate,
                "source_info": {
                    "timeline_name": source_name if request.source_type == "timeline" else None,
                    "original_filename": request.original_filename or os.path.basename(request.video_path),
                    "audio_path": request.video_path,
                },
                "language": request.language,
                "model_profile": request.model_profile or result.get("model_profile") or "core",
                "hotwords": request.hotwords or [],
                "segment_count": len(segments),
                "duration": result.get("duration", 0),
                "elapsed_seconds": result.get("elapsed_seconds", 0),
            }
            
            # 构建清洗后的转录结果用于磁盘缓存（已去标点+繁转简），
            # 避免后续从磁盘恢复时拿到带标点的原始文本
            cleaned_result = dict(result)
            cleaned_result["segments"] = segments

            save_transcript_project(
                project_name=project_name,
                transcript_id=transcript_id,
                metadata=metadata,
                transcript=cleaned_result,
                clip_mapping=request.clip_mapping,
                audio_path=request.video_path if request.source_type == "timeline" else None,
            )
            
            update_project_record(project_name, {
                "latest_subtitle_transcription": {
                    "source_path": request.video_path,
                    "language": request.language,
                    "model_profile": request.model_profile or result.get("model_profile") or "core",
                    "segment_count": len(segments),
                    "segments": segments,
                    "transcript_id": transcript_id,
                }
            })
            
            return {
                "segments": segments,
                "transcript_id": transcript_id,
                "elapsed_seconds": result.get("elapsed_seconds", 0),
            }
        else:
            update_project_record("default", {
                "latest_subtitle_transcription": {
                    "source_path": request.video_path,
                    "language": request.language,
                    "model_profile": request.model_profile or result.get("model_profile") or "core",
                    "segment_count": len(segments),
                    "segments": segments,
                }
            })
            return {
                "segments": segments,
                "transcript_id": transcript_id,
                "elapsed_seconds": result.get("elapsed_seconds", 0),
            }
    except TranscriptionModelMissingError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/subtitle/ai-optimize")
async def subtitle_ai_optimize(request: SubtitleAIOptimizeRequest):
    """使用 AI 优化字幕：错别字修正、断句优化、专有名词优化"""
    try:
        from openai import OpenAI
        
        client = OpenAI(
            api_key=request.api_key,
            base_url=request.base_url
        )

        prompt_parts = ["请优化以下字幕文本，保持原始时间戳格式不变。"]
        
        if request.enable_typo_fix:
            prompt_parts.append("修正错别字和语法错误。")
        
        if request.enable_sentence_break:
            prompt_parts.append("优化断句，使每句话更完整自然，但不要改变时间戳。")
        
        if request.enable_proper_noun and request.proper_nouns:
            nouns_str = "、".join(request.proper_nouns)
            prompt_parts.append(f"确保以下专有名词正确拼写：{nouns_str}。如果字幕中有类似发音但拼写错误的词，请修正为正确的专有名词。")
        
        prompt_parts.append("""
输出格式要求：每行格式为 [开始时间-结束时间] 字幕文本，与输入格式完全一致。
只输出优化后的字幕，不要添加任何解释或额外内容。

原始字幕：
""" + request.subtitle_text)

        system_prompt = "".join(prompt_parts)

        completion = client.chat.completions.create(
            model=request.model,
            messages=[
                {"role": "system", "content": "你是一个专业的字幕编辑助手，擅长修正错别字、优化断句和确保专有名词正确。"},
                {"role": "user", "content": system_prompt}
            ],
            temperature=0.3
        )

        optimized_text = completion.choices[0].message.content.strip()
        
        # 解析优化后的字幕
        optimized_segments = []
        for line in optimized_text.split('\n'):
            line = line.strip()
            if not line or not line.startswith('['):
                continue
            try:
                bracket_end = line.index(']')
                time_part = line[1:bracket_end]
                text_part = line[bracket_end + 1:].strip()
                
                times = time_part.split('-')
                if len(times) == 2:
                    start = float(times[0])
                    end = float(times[1])
                    optimized_segments.append({
                        "start": start,
                        "end": end,
                        "text": text_part,
                        "deleted": False,
                        "bold": False
                    })
            except (ValueError, IndexError):
                continue
        
        if not optimized_segments:
            return {"optimized_segments": [], "raw_response": optimized_text}
        
        return {"optimized_segments": optimized_segments}
        
    except ImportError:
        raise HTTPException(status_code=500, detail="openai 库未安装，请运行 pip install openai")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class SubtitleSyncRequest(BaseModel):
    segments: List[Dict[str, Any]]
    clip_mapping: Optional[List[Dict[str, Any]]] = None
    source_type: str = "file"
    original_filename: str = ""
    frame_rate: float = 24.0
    transcript_id: str = ""       # 用于查找 Tracker session
    track_type: str = "audio"     # 锁定轨道类型
    track_index: int = 1          # 锁定轨道索引（1-based）
    min_gap_sec: float = 1.0
    dry_run: bool = False


class SmartSplitRequest(BaseModel):
    segments: List[Dict[str, Any]]
    max_chars_per_line: int = 20


@app.post("/api/subtitle/sync-timeline")
async def subtitle_sync_timeline(request: SubtitleSyncRequest):
    """
    同步字幕：基于源时间锚点重映射到当前时间线位置。
    自动处理变速、裁剪、移动、分割等场景。仅补齐空缺，已有字幕原样保留。
    """
    if not resolve_controller.resolve:
        return {"status": "success", "mode": "mock", "message": "模拟模式"}

    try:
        resolve_controller._refresh_context()
        timeline = resolve_controller._get_active_timeline()
        if not timeline:
            raise HTTPException(status_code=500, detail="当前没有活跃时间线")

        fps = float(timeline.GetSetting("timelineFrameRate") or
                    resolve_controller.project.GetSetting("timelineFrameRate") or 24)
        timeline_start = int(timeline.GetStartFrame()) if hasattr(timeline, "GetStartFrame") else 0

        segments = request.segments
        transcript_id = request.transcript_id or ""
        track_type = request.track_type or "audio"
        track_index = request.track_index or 1
        dry_run = request.dry_run

        # 内存中没有 session 时，尝试从磁盘缓存恢复
        if transcript_id and not speed_tracker.has_session(transcript_id):
            project_name = resolve_controller.project.GetName() if resolve_controller.project else ""
            if project_name:
                cached = get_transcript_project(project_name, transcript_id)
                clip_mapping_dicts = (cached or {}).get("clip_mapping") or []
                transcript_data = (cached or {}).get("transcript") or {}
                cached_segments = transcript_data.get("segments") or []
                # 兼容旧磁盘缓存：早期转录结果可能含标点/繁体，此处做一次安全清洗
                if cached_segments:
                    for cs in cached_segments:
                        if cs.get("text"):
                            cs["text"] = to_simplified_chinese(strip_chinese_punctuation(cs["text"]))
                if clip_mapping_dicts:
                    snapshots: List[ClipSnapshot] = []
                    for mp in clip_mapping_dicts:
                        try:
                            snapshots.append(ClipSnapshot(
                                clip_name=str(mp.get("clip_name", "")),
                                clip_path=str(mp.get("clip_path", "")),
                                media_id=str(mp.get("media_id", "")),
                                timeline_start=float(mp.get("timeline_start", 0)),
                                timeline_end=float(mp.get("timeline_end", 0)),
                                source_start=float(mp.get("source_start", 0)),
                                source_end=float(mp.get("source_end", 0)),
                                speed=float(mp.get("speed", 1.0)),
                                source_frame_rate=float(mp.get("source_frame_rate", fps)),
                                track_type=str(mp.get("track_type", track_type)),
                                track_index=int(mp.get("track_index", track_index)),
                            ))
                        except Exception:
                            continue
                    if snapshots:
                        speed_tracker.create_session(transcript_id, fps, track_type=track_type, track_index=track_index)
                        speed_tracker.create_bindings(
                            cached_segments or segments, snapshots,
                            fps=fps, session_id=transcript_id,
                        )
                        print(f"[INFO] sync: 从磁盘恢复 session={transcript_id} bindings={len(snapshots)}", flush=True)

        if not transcript_id or not speed_tracker.has_session(transcript_id):
            raise HTTPException(
                status_code=400,
                detail="未找到转录绑定会话，请重新执行转录或传入有效的 transcript_id"
            )

        # 1. 采集当前时间线快照（优先锁定轨道）
        current_snapshots = build_clip_mapping(timeline, fps, track_type=track_type, track_index=track_index)
        # 锁定轨无 clip 时回退全轨扫描
        if not current_snapshots:
            current_snapshots = build_clip_mapping(timeline, fps)

        # 2. 调用 Tracker 重算
        synced_segments, change_log = speed_tracker.recalculate_subtitles(
            segments, current_snapshots, transcript_id
        )

        # 3. 过滤掉 hidden 的 segment
        visible_segments = [s for s in synced_segments if not s.get("hidden", False)]

        print(
            f"[INFO] sync: total={len(synced_segments)} visible={len(visible_segments)} "
            f"changes={len(change_log)}",
            flush=True,
        )

        # 4. 读取时间线现有字幕（仅统计有实际文本内容的字幕）
        existing_segments = []
        occupied = []
        for ti in range(1, (timeline.GetTrackCount("subtitle") or 0) + 1):
            items = timeline.GetItemListInTrack("subtitle", ti) or []
            for item in items:
                s = round((int(item.GetStart()) - timeline_start) / fps, 3)
                e = round((int(item.GetEnd()) - timeline_start) / fps, 3)
                t = (item.GetName() or "").strip()
                if not t:
                    continue  # 跳过空字幕条目，不占用时间区间
                existing_segments.append({"start": s, "end": e, "text": t})
                occupied.append((s, e))
        existing_segments.sort(key=lambda r: r["start"])
        occupied.sort(key=lambda r: r[0])
        existing_count = len(existing_segments)
        has_existing_subtitles = existing_count > 0

        # 5. 补齐空缺区间
        # 间隔（min_gap_sec）的语义：保护已有字幕不被过近的新字幕挤压。
        # 只有当时间线上已有字幕时，间隔才起作用——跳过与已有字幕距离 < min_gap_sec 的微小空缺。
        # 如果时间线上没有任何字幕，则全部同步结果直接插入，间隔不生效。
        min_gap_sec = request.min_gap_sec if request.min_gap_sec > 0 else 1.0
        gap_segments = []
        skipped_count = 0
        for seg in visible_segments:
            seg_start = seg["start"]
            seg_end = seg["end"]
            seg_text = to_simplified_chinese(strip_chinese_punctuation(str(seg.get("text", ""))))
            if not seg_text or seg_end - seg_start <= 0:
                continue
            if not has_existing_subtitles:
                # 时间线上无现有字幕 → 直接加入，不走间隔过滤
                gap_segments.append({
                    "start": seg_start,
                    "end": seg_end,
                    "text": seg_text,
                    "words": seg.get("words", []),
                })
                continue
            free_ranges = _subtract_occupied_ranges(seg_start, seg_end, occupied, min_gap_sec)
            for free_s, free_e in free_ranges:
                gap_duration = free_e - free_s
                untouched = (abs(free_s - seg_start) < 0.001 and abs(free_e - seg_end) < 0.001)
                if untouched or gap_duration >= min_gap_sec:
                    gap_segments.append({
                        "start": round(free_s, 3),
                        "end": round(free_e, 3),
                        "text": seg_text,
                        "words": seg.get("words", []),
                    })
                else:
                    skipped_count += 1

        print(
            f"[INFO] sync: existing={existing_count} synced={len(visible_segments)} "
            f"gaps={len(gap_segments)} skipped={skipped_count}",
            flush=True,
        )

        if dry_run:
            merged = existing_segments + gap_segments
            merged.sort(key=lambda r: r["start"])
            merged = _deduplicate_overlapping_segments(merged)
            return {
                "status": "success",
                "synced_segments": synced_segments,
                "visible_segments": visible_segments,
                "existing_segments": existing_segments,
                "gap_segments": gap_segments,
                "merged_segments": merged,
                "synced_count": len(gap_segments),
                "existing_count": existing_count,
                "skipped_count": skipped_count,
                "total_count": len(merged),
                "change_log": change_log,
            }

        # 6. 合并：已有字幕 + 空缺补齐 → 只追加新增，skip_delete=True 保证旧字幕原样保留
        merged = existing_segments + gap_segments
        merged.sort(key=lambda r: r["start"])
        merged = _deduplicate_overlapping_segments(merged)
        # 仅插入空缺补齐的新字幕，不重写已有字幕（避免删光重写破坏原字幕）
        result = None
        if gap_segments:
            result = _insert_subtitles_to_timeline(
                timeline, gap_segments, fps, skip_delete=True
            )
            _record_subtitle_insert(resolve_controller.project, timeline, gap_segments)

        return {
            "status": "success",
            "synced_count": len(gap_segments),
            "existing_count": existing_count,
            "skipped_count": skipped_count,
            "total_count": len(merged),
            "change_log": change_log,
            "insert_result": result,
            "message": f"共 {len(merged)} 条字幕 (保留 {existing_count} 条，补缺 {len(gap_segments)} 条，跳过 {skipped_count} 条短空缺)",
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/subtitle/smart-split")
async def subtitle_smart_split(request: SmartSplitRequest):
    try:
        from subtitle_speed_tracker import smart_split_segment

        result_segments = []
        for seg in request.segments:
            text = seg.get("text", "").strip()
            if not text:
                result_segments.append(seg)
                continue

            start = float(seg.get("start", 0))
            end = float(seg.get("end", 0))
            words = seg.get("words", None)

            sub_segs = smart_split_segment(
                text=text,
                words=words,
                start_time=start,
                end_time=end,
                max_chars=request.max_chars_per_line,
            )

            for sub in sub_segs:
                meta = {k: v for k, v in seg.items()
                        if k not in ("id", "text", "raw_text", "start", "end", "words")}
                result_segments.append({
                    **meta,
                    "id": f"{seg.get('id', 'sub')}_{sub['piece_index']}",
                    "text": sub["text"],
                    "raw_text": sub["text"],
                    "start": sub["start"],
                    "end": sub["end"],
                    "words": sub.get("words", []),
                })

        return {"segments": result_segments, "count": len(result_segments)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/subtitle/insert-timeline")
async def subtitle_insert_timeline(request: SubtitleInsertRequest):
    """
    将字幕插入到达芬奇时间线

    多策略导入：
    1. 尝试 SRT 文件导入媒体池（DaVinci Studio 18.5+ 支持）
    2. 尝试生成 FCPXML 时间线导入
    3. 如果自动导入失败，保存 SRT 文件到项目目录，指导用户手动导入
    """
    if not resolve_controller.resolve:
        return {"status": "success", "mode": "mock", "message": "模拟模式：字幕已生成并准备插入时间线"}

    try:
        resolve_controller._refresh_context()
        project = resolve_controller.project
        timeline = resolve_controller._get_active_timeline()
        if not timeline:
            raise HTTPException(status_code=500, detail="当前工程中没有可用时间线，请先在达芬奇中打开或创建一个时间线")

        # 获取帧率
        fps = float(timeline.GetSetting("timelineFrameRate") or
                    project.GetSetting("timelineFrameRate") or 24)

        segments_for_insert = request.segments
        if request.source_start_sec is not None and request.target_start_frame is not None:
            target_start_sec = request.target_start_frame / fps
            offset = target_start_sec - request.source_start_sec
            segments_for_insert = []
            for seg in request.segments:
                adjusted = dict(seg)
                adjusted["start"] = seg["start"] + offset
                adjusted["end"] = seg["end"] + offset
                segments_for_insert.append(adjusted)
            print(
                f"[INFO] 字幕时间码重算: source_start={request.source_start_sec}s, "
                f"target_frame={request.target_start_frame}, fps={fps}, "
                f"offset={offset:.3f}s"
            )

        result = _insert_subtitles_to_timeline(timeline, segments_for_insert, fps)
        _record_subtitle_insert(project, timeline, segments_for_insert)
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _deduplicate_overlapping_segments(segments: list, tolerance: float = 0.01) -> list:
    """合并时间线位置真正重叠的字幕条目，保留文本较长者。

    当同一段字幕因映射到多个重叠 clip 而产生重复条目时，
    去重并保留最完整的一条，避免 SRT 中出现重叠条目导致达芬奇只显示最后一条。

    注意：首尾相接的连续字幕（seg.start == prev.end）是正常的，不能合并；
    只有后一条明显侵入前一条（seg.start < prev.end - tolerance）才算重叠。
    """
    if not segments:
        return segments
    result = []
    skipped = 0
    for seg in segments:
        if not result:
            result.append(dict(seg))
            continue
        prev = result[-1]
        # 仅当后一条的起点明显早于前一条的终点（真正重叠）才去重；
        # 相接或仅浮点误差级别的重叠（seg.start ~ prev.end）视为正常连续字幕。
        if seg["start"] < prev["end"] - tolerance:
            # 重叠 → 保留文本较长的一条
            if len(str(seg.get("text", ""))) > len(str(prev.get("text", ""))):
                result[-1] = dict(seg)
            skipped += 1
        else:
            result.append(dict(seg))
    if skipped:
        print(f"[INFO] dedup: 合并 {skipped} 条重叠字幕")
    return result


def _subtract_occupied_ranges(start: float, end: float, occupied: list, min_gap: float) -> list:
    """从 [start, end] 中扣除已占用区间，返回剩余的空缺片段列表 [(s,e), ...]。
    occupied 是已排序的 [(start, end), ...] 列表。
    """
    free_ranges = []
    cursor = start
    for occ_s, occ_e in occupied:
        if occ_e <= cursor:
            continue
        if occ_s > cursor:
            free_ranges.append((cursor, min(occ_s, end)))
        cursor = max(cursor, occ_e)
        if cursor >= end:
            break
    if cursor < end:
        free_ranges.append((cursor, end))
    return free_ranges


def _ensure_subtitle_track(timeline) -> bool:
    """确保当前时间线至少有一个字幕轨道。

    DaVinci Resolve 的 MediaPool.AppendToTimeline() 在没有字幕轨道时
    对 SRT clip 会静默失败甚至导致崩溃，所以必须在导入前确保轨道存在。

    Returns:
        True 如果轨道已存在或创建成功。
        False 如果 AddTrack 失败（时间线锁定等罕见情况）。
    """
    try:
        existing = timeline.GetTrackCount("subtitle") or 0
    except Exception:
        existing = 0
    if existing >= 1:
        return True
    try:
        ok = timeline.AddTrack("subtitle")
    except Exception as e:
        print(f"[ERROR] 创建字幕轨道时异常: {e}")
        return False
    if not ok:
        print("[ERROR] 无法创建字幕轨道: AddTrack 返回 False（时间线可能被锁定）")
        return False
    for attempt in range(1, 11):
        try:
            refreshed = timeline.GetTrackCount("subtitle") or 0
        except Exception:
            refreshed = 0
        if refreshed >= 1:
            print(f"[INFO] 已自动创建字幕轨道（原时间线无 subtitle track，刷新 {attempt} 次后可见）")
            return True
        time.sleep(0.1)
    print("[ERROR] 已调用 AddTrack 创建字幕轨道，但达芬奇未返回可用的字幕轨道")
    return False


def _delete_timeline_subtitle_clips(timeline) -> bool:
    """删除时间线上所有字幕轨道中的字幕 clip"""
    try:
        subtitle_track_count = timeline.GetTrackCount("subtitle") or 0
        deleted_any = False
        for track_idx in range(1, subtitle_track_count + 1):
            items = timeline.GetItemListInTrack("subtitle", track_idx)
            if items:
                # 必须传入 False 以防止波纹删除影响其他轨道（比如视频轨道）
                result = timeline.DeleteClips(items, False)
                print(f"[DEBUG] DeleteClips 字幕轨道 {track_idx}: items={len(items)}, result={result}")
                if result:
                    deleted_any = True
                else:
                    # DeleteClips 返回 False，尝试逐个删除，也必须是非波纹删除
                    for item in items:
                        try:
                            single_result = timeline.DeleteClips([item], False)
                            print(f"[DEBUG] DeleteClips 单个 item: result={single_result}")
                            if single_result:
                                deleted_any = True
                        except Exception as inner_e:
                            print(f"[WARN] 删除单个字幕 item 失败: {inner_e}")
        return deleted_any
    except Exception as e:
        print(f"[WARN] 删除字幕 clip 失败: {e}")
        return False


def _get_subtitle_cache_paths(base_name: str = "subtitle_sync") -> Dict[str, str]:
    """统一字幕缓存路径，避免散落在临时目录。"""
    from pathlib import Path
    import tempfile

    context = sync_current_project_context(include_media=False)
    project_name = context.get("project_name") or "default"

    candidate_dirs = []

    try:
        candidate_dirs.append(get_cache_dir(project_name).parent / "subtitles")
    except Exception:
        pass

    candidate_dirs.append(Path(os.path.expanduser("~/Library/Caches/QuickClip/subtitles")))
    candidate_dirs.append(Path(os.path.expanduser("~/.quickclip/opt/subtitles")))
    candidate_dirs.append(Path(tempfile.gettempdir()) / "quickclip" / "subtitles")

    subtitle_dir = None
    last_error = None
    for candidate in candidate_dirs:
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            test_file = candidate / ".write_test"
            with open(test_file, "w", encoding="utf-8") as f:
                f.write("ok")
            test_file.unlink(missing_ok=True)
            subtitle_dir = candidate
            break
        except Exception as e:
            last_error = e
            continue

    if subtitle_dir is None:
        raise RuntimeError(f"无法创建可写的字幕缓存目录: {last_error}")

    print(f"[INFO] 使用字幕缓存目录: {subtitle_dir}")

    srt_path = subtitle_dir / f"{base_name}.srt"
    unique_srt_path = subtitle_dir / f"{base_name}_{uuid.uuid4().hex[:8]}.srt"
    fcpxml_path = subtitle_dir / f"{base_name}.fcpxml"

    return {
        "project_name": project_name,
        "subtitle_dir": str(subtitle_dir),
        "srt_path": str(srt_path),
        "unique_srt_path": str(unique_srt_path),
        "fcpxml_path": str(fcpxml_path),
    }


def _safe_remove_file(file_path: Optional[str]) -> bool:
    if not file_path:
        return False
    try:
        if os.path.isfile(file_path):
            os.remove(file_path)
            return True
    except Exception as e:
        print(f"[WARN] 删除文件失败: {file_path}, error={e}")
    return False


def _cleanup_subtitle_export_files(subtitle_dir: Optional[str], base_name: str = "subtitle_sync", keep_paths: Optional[List[str]] = None) -> None:
    if not subtitle_dir or not os.path.isdir(subtitle_dir):
        return

    keep = {
        os.path.abspath(path)
        for path in (keep_paths or [])
        if path
    }

    try:
        for name in os.listdir(subtitle_dir):
            should_delete = False
            if name == f"{base_name}.fcpxml":
                should_delete = True
            elif name == f"{base_name}.srt":
                should_delete = True
            elif name.startswith(f"{base_name}_") and name.endswith(".srt"):
                should_delete = True

            if not should_delete:
                continue

            file_path = os.path.abspath(os.path.join(subtitle_dir, name))
            if file_path in keep:
                continue
            _safe_remove_file(file_path)
    except Exception as e:
        print(f"[WARN] 清理字幕导出缓存失败: {subtitle_dir}, error={e}")


def _restore_timeline_playhead(timeline, timecode: Optional[str]) -> None:
    if not timeline or not timecode or not hasattr(timeline, "SetCurrentTimecode"):
        return
    try:
        restored = bool(timeline.SetCurrentTimecode(timecode))
        print(f"[INFO] 恢复播放头位置: {timecode}, result={restored}")
    except Exception as e:
        print(f"[WARN] 恢复播放头位置失败: {e}")


def _timecode_to_seconds(timecode: str, fps: float) -> float:
    tc = str(timecode or "").strip()
    parts = tc.split(":")
    if len(parts) != 4:
        return 0.0
    try:
        h = int(parts[0])
        m = int(parts[1])
        s = int(parts[2])
        f = int(parts[3])
    except Exception:
        return 0.0
    fr = float(fps or 24)
    if fr <= 0:
        fr = 24.0
    return (h * 3600) + (m * 60) + s + (f / fr)


def _delete_timeline_items(items: List[Any]) -> bool:
    if not items:
        return True
    timeline = resolve_controller._get_active_timeline()
    if not timeline:
        return False
    try:
        deleted = timeline.DeleteClips(items, False)
        if deleted:
            return True
    except Exception:
        pass

    any_deleted = False
    for item in items:
        try:
            if timeline.DeleteClips([item], False):
                any_deleted = True
        except Exception:
            continue
    return any_deleted


def _format_time_srt(seconds: float) -> str:
    """将秒数格式化为 SRT 时间码 HH:MM:SS,mmm。"""
    import math
    seconds = max(0.0, seconds)
    h = math.floor(seconds / 3600)
    m = math.floor((seconds % 3600) / 60)
    s = math.floor(seconds % 60)
    ms = round((seconds % 1) * 1000)
    if ms >= 1000:
        ms -= 1000
        s += 1
        if s >= 60:
            s -= 60
            m += 1
            if m >= 60:
                m -= 60
                h += 1
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _build_subtitle_artifacts(timeline, segments: List[Dict[str, Any]], fps: float, base_name: str = "subtitle_sync", max_chars_per_line: Optional[int] = None) -> Dict[str, Any]:
    """生成字幕 SRT 文件。

    segments 存储的是物理时间（相对于时间线零点），无论时间线从 00、01 还是其他
    时间码开始。SRT 直接使用这些物理时间，不做任何偏移调整。
    达芬奇 AppendToTimeline 将 SRT 时间码解释为相对时间线物理零点的位置，
    因此直接使用物理时间即可正确定位。
    """
    import math

    paths = _get_subtitle_cache_paths(base_name)
    # 保留调试用的固定路径 SRT，只清理其他历史文件
    _cleanup_subtitle_export_files(paths["subtitle_dir"], base_name=base_name, keep_paths=[paths["srt_path"]])

    visible_segments = [seg for seg in segments if not seg.get("deleted") and not seg.get("hidden")]

    if max_chars_per_line and max_chars_per_line > 0 and visible_segments:
        from subtitle_speed_tracker import smart_split_segment
        split_segments = []
        for seg in visible_segments:
            subs = smart_split_segment(
                text=seg.get("text", "").strip(),
                words=seg.get("words"),
                start_time=float(seg.get("start", 0)),
                end_time=float(seg.get("end", 0)),
                max_chars=max_chars_per_line,
            )
            for sub in subs:
                split_segments.append({**{k: v for k, v in seg.items() if k not in ("text", "raw_text", "start", "end", "words")},
                                       "text": sub["text"], "start": sub["start"], "end": sub["end"],
                                       "words": sub.get("words", [])})
        visible_segments = split_segments

    if visible_segments:
        first_seg = visible_segments[0]
        print(f"[DEBUG] 第一条字幕时间: {_format_time_srt(float(first_seg['start']))}")

    srt_lines = []
    for idx, seg in enumerate(visible_segments):
        start_sec = max(0.0, float(seg["start"]))
        end_sec = max(start_sec, float(seg["end"]))
        text = to_simplified_chinese(strip_chinese_punctuation(seg.get("text", "")))
        srt_lines.append(f"{idx + 1}")
        srt_lines.append(f"{_format_time_srt(start_sec)} --> {_format_time_srt(end_sec)}")
        srt_lines.append(text)
        srt_lines.append("")

    srt_content = "\n".join(srt_lines) + "\n"

    # 写入固定路径（便于调试查看）+ 唯一路径（达芬奇导入用，避免缓存）
    debug_path = paths["srt_path"]
    with open(debug_path, "w", encoding="utf-8") as f:
        f.write(srt_content)
    print(f"[INFO] 已生成字幕 SRT（调试用）: {debug_path}")

    srt_path = paths["unique_srt_path"]
    with open(srt_path, "w", encoding="utf-8") as f:
        f.write(srt_content)
    print(f"[INFO] 已生成字幕 SRT（导入用）: {srt_path}")

    max_end = max((seg["end"] for seg in visible_segments), default=0)
    total_frames = int(max_end * fps) + int(fps)

    srt_file_name = os.path.basename(srt_path)
    preview = srt_content[:400] if len(srt_content) > 400 else srt_content
    print(f"[DEBUG] 第一条字幕时间(验证): {_format_time_srt(float(visible_segments[0]['start'])) if visible_segments else 'N/A'}")
    print(f"[DEBUG] SRT 内容预览:\n{preview}")

    return {
        **paths,
        "srt_path": srt_path,
        "debug_srt_path": str(debug_path),
        "srt_file_name": srt_file_name,
        "segment_count": len(visible_segments),
        "total_frames": total_frames,
    }


def _collect_media_pool_clips_named(folder, name: str) -> list:
    """递归遍历 media-pool 文件夹树，收集所有名称完全匹配的 clip。"""
    matches = []
    for clip in (folder.GetClipList() or []):
        if clip.GetName() == name:
            matches.append(clip)
    for sub in (folder.GetSubFolderList() or []):
        matches.extend(_collect_media_pool_clips_named(sub, name))
    return matches


def _cleanup_stale_srt_clips_in_media_pool(root_folder) -> None:
    """递归清理媒体池中所有残留的 SRT clip（文件名含 .srt 后缀的）。

    每次插入字幕使用唯一文件名，历史残留不会自动消失，需要主动清理。
    """
    if root_folder is None:
        return
    try:
        to_delete = []
        _collect_srt_clips(root_folder, to_delete)
        if to_delete:
            print(f"[INFO] 媒体池中找到 {len(to_delete)} 个残留 SRT clip，正在清理")
            resolve_controller.media_pool.DeleteClips(to_delete)
    except Exception as e:
        print(f"[WARN] 清理媒体池残留 SRT 失败: {e}")


def _collect_srt_clips(folder, out: list) -> None:
    """递归收集所有名称以 .srt 结尾的 clip。"""
    for clip in (folder.GetClipList() or []):
        try:
            if clip.GetName().lower().endswith(".srt"):
                out.append(clip)
        except Exception:
            continue
    for sub in (folder.GetSubFolderList() or []):
        _collect_srt_clips(sub, out)


def _insert_subtitles_to_timeline(timeline, segments: List[Dict[str, Any]], fps: float, skip_delete: bool = False) -> dict:
    """将字幕插入达芬奇时间线。

    完整流程（参考 字幕变速匹配.lua）：
    1. 删除时间线上现有字幕（可通过 skip_delete 跳过）
    2. 从当前 segments 生成唯一路径的 SRT 文件
    3. 将 SRT 插入达芬奇媒体池（ImportMedia，每次唯一路径防止缓存）
    4. 从媒体池追加到时间线（AppendToTimeline）
    5. 删除本地 SRT 缓存及媒体池中的临时字幕
    """
    media_pool = resolve_controller.media_pool
    original_timecode = None
    try:
        if timeline and hasattr(timeline, "GetCurrentTimecode"):
            original_timecode = timeline.GetCurrentTimecode()
    except Exception:
        pass

    # Step 1: 生成最新字幕 SRT（唯一路径）
    artifacts = _build_subtitle_artifacts(timeline, segments, fps)
    srt_path = artifacts["srt_path"]
    subtitle_dir = artifacts.get("subtitle_dir")

    if artifacts["segment_count"] == 0:
        _restore_timeline_playhead(timeline, original_timecode)
        _cleanup_subtitle_export_files(subtitle_dir, keep_paths=[])
        return {"status": "partial", "message": "当前没有可导出的可见字幕，已跳过", "srt_path": srt_path}

    # 确保字幕轨道存在
    if not _ensure_subtitle_track(timeline):
        _restore_timeline_playhead(timeline, original_timecode)
        _cleanup_subtitle_export_files(subtitle_dir, keep_paths=[])
        return {
            "status": "partial",
            "message": "时间线无字幕轨道且自动创建失败，请先在达芬奇中手动添加一条字幕轨道",
            "srt_path": srt_path,
        }

    # 先删除时间线上现有字幕（sync-timeline 可跳过以保留其他来源的字幕）
    if not skip_delete:
        pre_delete_count = 0
        try:
            for i in range(1, (timeline.GetTrackCount("subtitle") or 0) + 1):
                items = timeline.GetItemListInTrack("subtitle", i)
                if items:
                    pre_delete_count += len(items)
            deleted_ok = _delete_timeline_subtitle_clips(timeline)
            print(f"[INFO] 删除前时间线有 {pre_delete_count} 条字幕, DeleteClips 结果: {deleted_ok}")
        except Exception:
            pass

        # 验证删除后的数量
        post_delete_count = 0
        try:
            for i in range(1, (timeline.GetTrackCount("subtitle") or 0) + 1):
                items = timeline.GetItemListInTrack("subtitle", i)
                if items:
                    post_delete_count += len(items)
        except Exception:
            pass
        if post_delete_count > 0:
            print(f"[WARN] DeleteClips 后时间线仍有 {post_delete_count} 条字幕残留！")
        else:
            print(f"[INFO] 确认：DeleteClips 后时间线字幕已清空")
    else:
        print("[INFO] sync-timeline: 跳过已有字幕删除，仅追加新字幕")

    # Step 2-4: 导入媒体池 → 追加时间线 → 清理
    try:
        if media_pool is None:
            raise RuntimeError("无法获取媒体池")

        root_folder = media_pool.GetRootFolder()
        media_pool.SetCurrentFolder(root_folder)

        # 清理媒体池中残留的历史 SRT clip（按文件名模式匹配，防止累积）
        _cleanup_stale_srt_clips_in_media_pool(root_folder)

        # Step 2: 导入 SRT 到媒体池（唯一路径，达芬奇不会缓存）
        print(f"[INFO] 调用 media_pool.ImportMedia({srt_path})")
        media_items = media_pool.ImportMedia(srt_path)
        if not media_items or len(media_items) == 0:
            raise RuntimeError("ImportMedia 返回空，导入字幕文件到媒体池失败")

        print(f"[INFO] ImportMedia 返回 {len(media_items)} 个 media pool item(s)")

        # Step 3: 追加到时间线
        print(f"[INFO] 调用 media_pool.AppendToTimeline(media_items)")
        timeline_items = media_pool.AppendToTimeline(media_items)
        if not timeline_items or len(timeline_items) == 0:
            raise RuntimeError("AppendToTimeline 返回空，字幕未添加到时间线")

        print(f"[INFO] AppendToTimeline 成功，返回 {len(timeline_items)} 个 timeline item(s)")

        # Step 4: 从媒体池删除临时 SRT clip
        media_pool.DeleteClips(media_items)
        print("[INFO] 已从媒体池清理临时 SRT")

        # 统计实际插入的字幕数量，并打印前几条的位置验证
        count = 0
        first_positions = []
        for i in range(1, (timeline.GetTrackCount("subtitle") or 0) + 1):
            items = timeline.GetItemListInTrack("subtitle", i)
            if items:
                count += len(items)
                if not first_positions:
                    for item in items[:3]:
                        try:
                            sf = int(item.GetStart())
                            ef = int(item.GetEnd())
                            ss = sf / max(fps, 1.0)
                            es = ef / max(fps, 1.0)
                            name = str(item.GetName() or "")[:30]
                            first_positions.append(
                                f"'{name}' @ {_format_time_srt(ss)} → {_format_time_srt(es)} "
                                f"(帧 {sf}-{ef})"
                            )
                        except Exception:
                            pass
        print(f"[INFO] 时间线上现有 {count} 条字幕")
        if first_positions:
            for pos in first_positions:
                print(f"[DEBUG] 验证: {pos}")

        # Step 4: 清理本地 SRT 缓存文件
        _restore_timeline_playhead(timeline, original_timecode)
        _cleanup_subtitle_export_files(subtitle_dir, keep_paths=[])

        return {
            "status": "success",
            "message": f"字幕已插入时间线（{count} 条）",
            "import_method": "append_to_timeline",
            "final_subtitle_count": count,
        }

    except Exception as e:
        _restore_timeline_playhead(timeline, original_timecode)
        _cleanup_subtitle_export_files(subtitle_dir, keep_paths=[])
        print(f"[ERROR] 字幕插入失败: {e}")
        return {
            "status": "partial",
            "message": f"自动导入失败: {e}",
            "import_method": "manual_required",
            "srt_path": srt_path,
            "error_detail": str(e),
        }


def _record_subtitle_insert(project, timeline, segments):
    """记录字幕插入历史"""
    try:
        context = sync_current_project_context(include_media=False)
        project_name = context.get("project_name")
        if project_name:
            update_project_record(project_name, {
                "latest_timeline_subtitles": {
                    "timeline_name": timeline.GetName() if timeline else None,
                    "segment_count": len(segments),
                    "segments": segments,
                }
            })
    except Exception:
        pass


def _generate_subtitle_fcpxml(segments, fps, total_frames, output_path: Optional[str] = None):
    """
    生成包含字幕数据的 FCPXML 文件，用于导入达芬奇
    
    DaVinci Resolve 可以导入 FCPXML 格式的时间线，其中包含字幕轨
    """
    import math

    if not segments:
        return None

    # 计算时间线总时长（帧→秒→时间码）
    total_duration_sec = total_frames / fps if fps > 0 else 60

    def sec_to_fcpxml_time(seconds, fps):
        """将秒转为 FCPXML 的时间格式 (帧数/fps)s"""
        frames = int(round(seconds * fps))
        return f"{frames}/{int(fps)}s"

    # 生成字幕 caption 元素
    caption_elements = ""
    for idx, seg in enumerate(segments):
        start_time = sec_to_fcpxml_time(seg['start'], fps)
        end_time = sec_to_fcpxml_time(seg['end'], fps)
        duration_time = sec_to_fcpxml_time(seg['end'] - seg['start'], fps)
        text = seg.get('text', '').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')

        caption_elements += f"""
        <caption offset="{start_time}" name="字幕 {idx + 1}" duration="{duration_time}">
            <text>
                <text-style font="Open Sans" fontSize="42" fontColor="1 1 1 1" align="center">{text}</text-style>
            </text>
            <text-style-def id="ts{idx}">
                <text-style font="Open Sans" fontSize="42" fontColor="1 1 1 1" align="center"/>
            </text-style-def>
        </caption>"""

    total_duration = sec_to_fcpxml_time(total_duration_sec, fps)

    fcpxml = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
    <resources>
        <format id="r1" name="FFVideoFormat1080p{int(fps)}" frameDuration="1/{int(fps)}s" width="1920" height="1080"/>
    </resources>
    <library>
        <event name="字幕导入">
            <project name="字幕时间线">
                <sequence format="r1" duration="{total_duration}" tcStart="0s" tcFormat="NDF">
                    <spine>
                        {caption_elements}
                    </spine>
                </sequence>
            </project>
        </event>
    </library>
</fcpxml>"""

    # 保存 FCPXML 文件
    fcpxml_path = output_path
    if not fcpxml_path:
        temp_dir = tempfile.mkdtemp()
        fcpxml_path = os.path.join(temp_dir, "subtitle_import.fcpxml")
    with open(fcpxml_path, "w", encoding="utf-8") as f:
        f.write(fcpxml)

    return fcpxml_path

@app.get("/api/subtitle/fetch-from-resolve")
async def subtitle_fetch_from_resolve():
    """从达芬奇时间线字幕轨道读取字幕数据"""
    if not resolve_controller.resolve:
        raise HTTPException(status_code=500, detail="未连接达芬奇")

    try:
        resolve_controller._refresh_context()
        timeline = resolve_controller._get_active_timeline()
        if not timeline:
            raise HTTPException(status_code=500, detail="当前没有活跃时间线")

        # 获取帧率用于帧→秒转换
        fps = float(timeline.GetSetting("timelineFrameRate") or
                    resolve_controller.project.GetSetting("timelineFrameRate") or 24)

        # 获取时间线起始帧偏移：item.GetStart() 返回的是包含时间线起始偏移的绝对帧号，
        # 需要减去偏移量得到物理帧位置（相对于时间线零点）
        timeline_start_frame = 0
        if hasattr(timeline, "GetStartFrame"):
            try:
                tsf = timeline.GetStartFrame()
                if tsf:
                    timeline_start_frame = int(tsf)
                    print(f"[INFO] 时间线起始帧偏移: {timeline_start_frame} 帧")
            except Exception:
                pass

        # 遍历字幕轨道
        subtitle_track_count = timeline.GetTrackCount("subtitle") or 0
        segments = []

        for track_idx in range(1, subtitle_track_count + 1):
            items = timeline.GetItemListInTrack("subtitle", track_idx)
            if not items:
                continue
            for item in items:
                text = speed_tracker.get_timeline_item_text(item)
                raw_start = int(item.GetStart())
                raw_end = int(item.GetEnd())
                start_frame = raw_start - timeline_start_frame
                end_frame = raw_end - timeline_start_frame
                start_sec = start_frame / fps
                end_sec = end_frame / fps

                if not segments:  # 第一条字幕，打印调试信息
                    print(f"[DEBUG] fetch-from-resolve 第一条: "
                          f"GetStart()={raw_start}帧, "
                          f"timeline_start_frame={timeline_start_frame}帧, "
                          f"物理帧={start_frame}, "
                          f"物理时间={start_sec:.3f}s")

                segments.append({
                    "start": round(start_sec, 3),
                    "end": round(end_sec, 3),
                    "text": text.strip(),
                })

        # 按开始时间排序
        segments.sort(key=lambda s: s["start"])

        if not segments:
            raise HTTPException(status_code=404, detail="时间线上没有找到字幕（确保字幕位于字幕轨道上）")

        return {"status": "success", "segments": segments, "count": len(segments), "fps": fps}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ======= 时间线 API =======

@app.post("/api/timeline/generate")
async def generate_timeline(request: TimelineRequest):
    """
    根据前端传来的片段数据生成时间线并调用达芬奇剪辑
    （保留旧接口兼容）
    """
    timeline_data = {
        "video_path": request.video_path,
        "clips": request.segments
    }
    
    # 过滤出标记为 bold（选取）的片段
    timeline_data["clips"] = [seg for seg in timeline_data["clips"] if seg.get("bold", False)]
    
    result = resolve_controller.apply_timeline(timeline_data)
    if result["status"] == "error":
        raise HTTPException(status_code=500, detail=result["message"])
    context = sync_current_project_context(include_media=False)
    project_name = context.get("project_name")
    if project_name:
        update_project_record(project_name, {
            "latest_generated_timeline": {
                "source_video_path": request.video_path,
                "clip_count": len(timeline_data["clips"]),
                "timeline_name": result.get("timeline_name"),
            }
        })
        
    return {"status": "success", "timeline": result}


class ApplyEditRequest(BaseModel):
    segments: List[Dict[str, Any]]
    source_type: str = "file"  # "file" 或 "timeline"
    original_filename: str = ""
    video_path: str = ""  # 源文件完整路径，用于跨项目自动导入
    local_target_folder: str = ""  # 跨项目导入：本地保存子目录（相对于项目路径）
    davinci_folder: str = ""  # 跨项目导入：达芬奇媒体池目标文件夹
    clip_mapping: Optional[List[Dict[str, Any]]] = None
    apply_method: str = "new_timeline"  # "new_timeline" / "append" / "inplace_main" / "inplace_all"
    frame_rate: float = 24.0
    merge_gap_seconds: float = 0.5  # 原位模式：合并删除区间的最小间隙阈值（秒）

@app.post("/api/timeline/apply-edit")
async def apply_timeline_edit(request: ApplyEditRequest):
    """
    根据文本剪辑标记应用到时间线
    `new_timeline` / `append` 处理 bold=True（被选取）的片段，
    `inplace_*` 处理 deleted=True（被删除）的片段。
    """
    is_inplace_mode = request.apply_method in {"inplace_main", "inplace_all"}
    selected_segments = sorted(
        [s for s in request.segments if s.get("bold", False)],
        key=lambda item: (float(item.get("start", 0)), float(item.get("end", 0))),
    )
    deleted_segments = sorted(
        [s for s in request.segments if s.get("deleted", False)],
        key=lambda item: (float(item.get("start", 0)), float(item.get("end", 0))),
    )
    if is_inplace_mode:
        if not deleted_segments:
            raise HTTPException(status_code=400, detail="没有标记要删除的文稿片段")
        if request.source_type != "timeline" or not request.clip_mapping:
            raise HTTPException(status_code=400, detail="原位删减仅支持时间线转录结果")
    elif not selected_segments:
        raise HTTPException(status_code=400, detail="没有选中任何片段")
    
    if not resolve_controller.resolve:
        raise HTTPException(status_code=500, detail="未连接达芬奇")
    
    try:
        resolve_controller._refresh_context()
        project = resolve_controller.project
        if not project:
            raise HTTPException(status_code=500, detail="未检测到达芬奇项目")
        
        media_pool = resolve_controller.media_pool
        root_folder = media_pool.GetRootFolder()
        fps = request.frame_rate or float(project.GetSetting("timelineFrameRate") or 24)
        normalized_clip_mapping = _ensure_clip_mapping_source_frame_rates(
            request.clip_mapping or [],
            root_folder=root_folder,
            fallback_fps=float(fps or 24),
        )
        try:
            print(
                "[AUTO_EDIT_DEV] apply_edit",
                {
                    "frame_rate": float(fps or 24),
                    "source_type": request.source_type,
                    "apply_method": request.apply_method,
                    "clip_mapping_count": len(normalized_clip_mapping),
                },
            )
        except Exception:
            pass

        if is_inplace_mode:
            timeline = resolve_controller._get_active_timeline()
            if not timeline:
                raise HTTPException(status_code=500, detail="当前没有活跃时间线")
            result = _apply_inplace_transcript_edit(
                timeline=timeline,
                root_folder=root_folder,
                clip_mapping=normalized_clip_mapping,
                deleted_segments=deleted_segments,
                fps=float(fps or 24),
                apply_method=request.apply_method,
                merge_gap_seconds=request.merge_gap_seconds,
            )
            if result.get("status") != "success":
                raise HTTPException(status_code=500, detail=result.get("message") or "原位删减失败")
            return result

        if request.apply_method == "new_timeline":
            timeline_name = f"文本剪辑 {request.original_filename}"
            timeline_folder = resolve_controller._get_or_create_davinci_folder(root_folder, "时间线")
            media_pool.SetCurrentFolder(timeline_folder)
            timeline = media_pool.CreateEmptyTimeline(timeline_name)
            if not timeline:
                import time
                timeline = media_pool.CreateEmptyTimeline(f"{timeline_name}_{int(time.time())}")
            if not timeline:
                raise HTTPException(status_code=500, detail="无法创建新时间线")
            project.SetCurrentTimeline(timeline)
            timeline_start_frame = int(timeline.GetStartFrame()) if hasattr(timeline, "GetStartFrame") else 0
            record_frame_cursor = timeline_start_frame
        else:
            timeline = resolve_controller._get_active_timeline()
            if not timeline:
                raise HTTPException(status_code=500, detail="当前没有活跃时间线")
            timeline_start_frame = int(timeline.GetStartFrame()) if hasattr(timeline, "GetStartFrame") else 0
            record_frame_cursor = _get_timeline_record_start_frame(timeline)
        
        # 构建时间线 clip 列表
        clip_infos = []
        imported_media_cache = {}  # clip_path -> media_item，避免同素材重复导入

        if request.source_type == "timeline" and request.clip_mapping:
            # 时间线源：根据映射表定位源 clip
            for segment in selected_segments:
                seg_start_frame = _seconds_to_frame_index(segment.get("start", 0), fps)
                seg_end_frame = _seconds_to_frame_index(segment.get("end", 0), fps)
                
                # 查找 segment 落在哪个 clip 内
                matched = find_matching_clips(seg_start_frame, seg_end_frame, normalized_clip_mapping, fps)
                try:
                    segment_text = str(segment.get("text") or "").replace("\n", " ").strip()
                    print(
                        "[AUTO_EDIT_DEV] segment",
                        {
                            "text": segment_text[:80],
                            "start": round(float(segment.get("start", 0) or 0), 3),
                            "end": round(float(segment.get("end", 0) or 0), 3),
                            "matched": [
                                {
                                    "clip_name": mc.get("clip_name"),
                                    "source_frame_rate": mc.get("source_frame_rate"),
                                    "source_start_frame": mc.get("source_start_frame"),
                                    "source_end_frame": mc.get("source_end_frame"),
                                    "timeline_overlap_start_frame": mc.get("timeline_overlap_start_frame"),
                                    "timeline_overlap_end_frame": mc.get("timeline_overlap_end_frame"),
                                }
                                for mc in matched
                            ],
                        },
                    )
                except Exception:
                    pass
                
                for mc in matched:
                    # 在媒体池查找素材
                    media_item = None
                    if mc.get("media_id"):
                        try:
                            media_item = resolve_controller._find_media_item_by_media_id(root_folder, mc["media_id"])
                        except Exception:
                            media_item = None
                    if not media_item and mc.get("clip_path"):
                        try:
                            media_item = resolve_controller._find_media_item_by_path(root_folder, mc["clip_path"])
                        except Exception:
                            media_item = None
                    if not media_item:
                        media_item = resolve_controller._find_media_item(root_folder, mc["clip_name"])
                    if not media_item and mc.get("clip_path"):
                        media_item = resolve_controller._find_media_item(root_folder, os.path.basename(mc["clip_path"]))

                    if not media_item:
                        # 尝试导入
                        clip_path = mc.get("clip_path", "")
                        if clip_path and os.path.exists(clip_path):
                            # 检查缓存，避免同素材重复复制/导入
                            if clip_path in imported_media_cache:
                                media_item = imported_media_cache[clip_path]
                            else:
                                has_cross_settings = bool(request.local_target_folder or request.davinci_folder)
                                if has_cross_settings:
                                    # 跨项目：用用户选择的文件夹导入
                                    media_item = _auto_import_source_file(
                                        resolve_controller=resolve_controller,
                                        root_folder=root_folder,
                                        video_path=clip_path,
                                        original_filename=os.path.basename(clip_path),
                                        local_target_folder=request.local_target_folder,
                                        davinci_folder=request.davinci_folder,
                                    )
                                else:
                                    import_res = resolve_controller.import_video(clip_path)
                                    if import_res["status"] == "success":
                                        media_item = resolve_controller._find_media_item(root_folder, os.path.basename(clip_path))
                                if media_item:
                                    imported_media_cache[clip_path] = media_item
                    
                    if media_item:
                        clip_infos.append({
                            "mediaPoolItem": media_item,
                            "startFrame": int(mc["source_start_frame"]),
                            "endFrame": int(mc["source_end_frame"]),
                        })
        else:
            # 文件源：从媒体池查找对应素材
            media_item = resolve_controller._find_media_item(root_folder, request.original_filename)

            if not media_item and request.video_path and os.path.exists(request.video_path):
                # 跨项目自动导入：将源文件复制到当前项目的本地文件夹，再导入达芬奇媒体池
                media_item = _auto_import_source_file(
                    resolve_controller=resolve_controller,
                    root_folder=root_folder,
                    video_path=request.video_path,
                    original_filename=request.original_filename,
                    local_target_folder=request.local_target_folder,
                    davinci_folder=request.davinci_folder,
                )

            if not media_item:
                raise HTTPException(status_code=400, detail=f"媒体池中未找到「{request.original_filename}」，请先将文件导入媒体池")

            source_fps = _extract_media_frame_rate(media_item, fps)
            for segment in selected_segments:
                start_frame = _seconds_to_frame_index(segment.get("start", 0), source_fps)
                end_frame = _seconds_to_frame_index(segment.get("end", 0), source_fps)
                clip_infos.append({
                    "mediaPoolItem": media_item,
                    "startFrame": start_frame,
                    "endFrame": end_frame,
                })
        
        if not clip_infos:
            raise HTTPException(status_code=500, detail="未能匹配到任何媒体素材")

        clip_infos = _merge_contiguous_clip_infos(clip_infos)
        
        # 应用到时间线
        # insertion_start_frame 是时间线显示层面的帧偏移（减去起始时间码）
        insertion_start_frame = record_frame_cursor - timeline_start_frame

        if request.apply_method == "new_timeline":
            # 逐条插入，确保 recordFrame 连续生效，避免批量追加产生空隙
            added_items = _append_clip_infos_sequentially(media_pool, clip_infos, start_frame=record_frame_cursor)

            return {
                "status": "success",
                "method": "new_timeline",
                "timeline_name": timeline.GetName(),
                "total_clips": len(clip_infos),
                "added_clips": len(added_items) if added_items else 0,
                "insertion_start_frame": insertion_start_frame,
                "frame_rate": fps,
                "message": f"已创建新时间线「{timeline.GetName()}」，包含 {len(clip_infos)} 个片段",
            }

        else:  # append
            added_items = _append_clip_infos_sequentially(media_pool, clip_infos, start_frame=record_frame_cursor)

            return {
                "status": "success",
                "method": "append",
                "timeline_name": timeline.GetName(),
                "total_clips": len(clip_infos),
                "added_clips": len(added_items) if added_items else 0,
                "insertion_start_frame": insertion_start_frame,
                "frame_rate": fps,
                "message": f"已追加 {len(clip_infos)} 个片段到时间线「{timeline.GetName()}」末尾",
            }
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"应用剪辑失败: {str(e)}")


def find_matching_clips(seg_start_frame, seg_end_frame, clip_mapping, timeline_fps: float):
    """将 segment 的帧范围映射到具体的 clip"""
    matched = []
    if seg_end_frame <= seg_start_frame:
        return matched

    reference_mapping = [clip for clip in (clip_mapping or []) if clip.get("is_reference_track")]
    source_mapping = reference_mapping or list(clip_mapping or [])

    for clip in source_mapping:
        clip_start = int(clip.get("timeline_start_frame_relative", clip.get("timeline_start_frame", 0)))
        clip_end = int(clip.get("timeline_end_frame_relative", clip.get("timeline_end_frame", 0)))
        overlap_start = max(int(seg_start_frame), clip_start)
        overlap_end = min(int(seg_end_frame), clip_end)
        if overlap_end <= overlap_start:
            continue

        source_start_frame = int(clip.get("source_in_frame", clip.get("source_start_frame", 0)))
        source_frame_rate = _get_clip_source_frame_rate(clip, timeline_fps)
        source_end_limit = clip.get("source_out_frame", clip.get("source_end_frame"))
        mapped_source_start, mapped_source_end = _map_timeline_range_to_source_frames(
            source_start_frame=source_start_frame,
            overlap_start_frame=overlap_start,
            overlap_end_frame=overlap_end,
            clip_timeline_start_frame=clip_start,
            timeline_fps=timeline_fps,
            source_fps=source_frame_rate,
            source_end_limit=int(source_end_limit) if source_end_limit not in (None, "") else None,
        )
        matched.append({
            "clip_name": clip["clip_name"],
            "clip_path": clip["clip_path"],
            "media_id": clip.get("media_id"),
            "track_type": clip.get("track_type"),
            "track_index": clip.get("track_index"),
            "timeline_overlap_start_frame": overlap_start,
            "timeline_overlap_end_frame": overlap_end,
            "source_start_frame": mapped_source_start,
            "source_end_frame": mapped_source_end,
        })

    if not matched:
        return matched

    matched.sort(key=lambda item: (item["timeline_overlap_start_frame"], item.get("track_index") or 0))
    deduped = []
    seen = set()
    for item in matched:
        key = (
            item.get("media_id") or item.get("clip_path") or item.get("clip_name"),
            item["source_start_frame"],
            item["source_end_frame"],
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def _append_clip_infos_sequentially(media_pool, clip_infos: List[Dict[str, Any]], start_frame: int = 0) -> List[Any]:
    """逐条追加片段，避免达芬奇批量追加时对 recordFrame 处理不稳定。"""
    added_items: List[Any] = []
    cursor = start_frame
    for clip_info in clip_infos or []:
        ci = dict(clip_info)
        ci["recordFrame"] = cursor
        source_duration = int(clip_info.get("endFrame", 0)) - int(clip_info.get("startFrame", 0))
        added = media_pool.AppendToTimeline([ci])
        if added:
            if isinstance(added, list):
                added_items.extend(added)
            else:
                added_items.append(added)
        timeline_duration = _get_inserted_clip_duration(added)
        cursor += timeline_duration if timeline_duration > 0 else max(source_duration, 1)
    return added_items


def _get_inserted_clip_duration(added) -> int:
    items = added if isinstance(added, list) else ([added] if added else [])
    total = 0
    for item in items:
        try:
            total += int(item.GetDuration())
        except Exception:
            pass
    return total


def _get_clip_info_media_key(clip_info: Dict[str, Any]) -> str:
    media_item = clip_info.get("mediaPoolItem")
    if not media_item:
        return ""
    try:
        media_id = media_item.GetMediaId() or ""
    except Exception:
        media_id = ""
    if media_id:
        return f"id:{media_id}"
    try:
        media_path = media_item.GetClipProperty("File Path") or ""
    except Exception:
        media_path = ""
    if media_path:
        return f"path:{media_path}"
    try:
        media_name = media_item.GetName() or ""
    except Exception:
        media_name = ""
    return f"name:{media_name}"


def _merge_contiguous_clip_infos(clip_infos: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """把同一素材上首尾相接的片段合并，避免连续选区被拆成很多小段。"""
    if not clip_infos:
        return []

    merged: List[Dict[str, Any]] = []
    for clip_info in clip_infos:
        if not merged:
            merged.append(dict(clip_info))
            continue

        previous = merged[-1]
        previous_key = _get_clip_info_media_key(previous)
        current_key = _get_clip_info_media_key(clip_info)
        previous_end = int(previous.get("endFrame") or 0)
        current_start = int(clip_info.get("startFrame") or 0)

        if previous_key and previous_key == current_key and current_start <= previous_end + 1:
            previous["endFrame"] = max(previous_end, int(clip_info.get("endFrame") or current_start))
            continue

        merged.append(dict(clip_info))

    return merged


def _auto_import_source_file(
    resolve_controller,
    root_folder,
    video_path: str,
    original_filename: str,
    local_target_folder: str = "",
    davinci_folder: str = "",
):
    """跨项目自动导入：将源文件复制到当前项目本地文件夹 → 导入达芬奇媒体池 → 返回 media_item"""
    from pathlib import Path
    from app.project_registry import load_project_registry, get_project_record

    filename = original_filename or os.path.basename(video_path)
    local_target = (local_target_folder or "").strip()
    davinci_target = (davinci_folder or "").strip()

    # 解析当前项目的本地路径
    project_local_path = ""
    try:
        resolve_controller._refresh_context()
        if resolve_controller.project:
            project_name = resolve_controller.project.GetName()
            record = get_project_record(project_name)
            project_local_path = normalize_path(record.get("local_path", ""))
    except Exception:
        pass

    if not project_local_path:
        try:
            path_from_api, _ = resolve_controller._detect_project_local_path()
            project_local_path = normalize_path(path_from_api or "")
        except Exception:
            pass

    if not project_local_path:
        try:
            reg = load_project_registry()
            active = reg.get("active_project") or {}
            project_local_path = normalize_path(active.get("local_path", ""))
        except Exception:
            pass

    if not project_local_path:
        return None

    # 确定目标本地文件夹
    target_dir = Path(project_local_path)
    if local_target:
        target_dir = target_dir / local_target
    target_dir.mkdir(parents=True, exist_ok=True)

    # 复制文件（防止重名覆盖）
    dest_path = target_dir / filename
    stem = Path(filename).stem
    suffix = Path(filename).suffix
    counter = 1
    while dest_path.exists():
        dest_path = target_dir / f"{stem}-{counter}{suffix}"
        counter += 1

    try:
        import shutil
        shutil.copy2(video_path, str(dest_path))
    except Exception:
        return None

    # 导入到达芬奇媒体池
    try:
        if davinci_target:
            target_folder = resolve_controller._get_or_create_davinci_folder(root_folder, davinci_target)
            if target_folder:
                resolve_controller.media_pool.SetCurrentFolder(target_folder)
        resolve_controller.media_pool.ImportMedia([str(dest_path)])
    except Exception:
        pass

    # 查找新导入的媒体项
    media_item = resolve_controller._find_media_item(root_folder, dest_path.name)
    if not media_item:
        media_item = resolve_controller._find_media_item_by_path(root_folder, str(dest_path))

    return media_item


def _seconds_to_frame_index(seconds: Any, fps: float) -> int:
    try:
        value = float(seconds or 0)
    except Exception:
        value = 0.0
    return int((value * float(fps or 24)) + 0.5)


def _frames_to_seconds(frame_count: Any, fps: float) -> float:
    try:
        frames = float(frame_count or 0)
    except Exception:
        frames = 0.0
    fps_value = float(fps or 0) or 24.0
    if fps_value <= 0:
        fps_value = 24.0
    return max(0.0, frames / fps_value)


def _seconds_to_start_frame(seconds: Any, fps: float) -> int:
    try:
        value = float(seconds or 0)
    except Exception:
        value = 0.0
    fps_value = float(fps or 0) or 24.0
    if fps_value <= 0:
        fps_value = 24.0
    return max(0, int(value * fps_value + 1e-6))


def _seconds_to_end_frame(seconds: Any, fps: float) -> int:
    try:
        value = float(seconds or 0)
    except Exception:
        value = 0.0
    fps_value = float(fps or 0) or 24.0
    if fps_value <= 0:
        fps_value = 24.0
    if value <= 0:
        return 0
    return max(1, int(value * fps_value + 0.999999))


def _parse_frame_rate_value(raw_value: Any) -> Optional[float]:
    if raw_value in (None, ""):
        return None
    if isinstance(raw_value, (int, float)):
        value = float(raw_value)
        return value if value > 0 else None
    text = str(raw_value).strip()
    if not text:
        return None
    match = re.search(r"\d+(?:\.\d+)?", text)
    if not match:
        return None
    try:
        value = float(match.group(0))
    except Exception:
        return None
    return value if value > 0 else None


def _extract_media_frame_rate(mp_item, fallback_fps: float) -> float:
    fps_candidates = []
    for key in ("FPS", "Frame Rate", "Video Frame Rate", "Clip Frame Rate", "FrameRate"):
        try:
            fps_candidates.append(mp_item.GetClipProperty(key))
        except Exception:
            continue
    for candidate in fps_candidates:
        parsed = _parse_frame_rate_value(candidate)
        if parsed:
            return parsed
    try:
        all_props = mp_item.GetClipProperty() or {}
    except Exception:
        all_props = {}
    if isinstance(all_props, dict):
        for key in ("FPS", "Frame Rate", "Video Frame Rate", "Clip Frame Rate", "FrameRate"):
            parsed = _parse_frame_rate_value(all_props.get(key))
            if parsed:
                return parsed
    fallback = _parse_frame_rate_value(fallback_fps)
    return fallback or 24.0


def _get_clip_source_frame_rate(clip: Dict[str, Any], fallback_fps: float) -> float:
    parsed = _parse_frame_rate_value(clip.get("source_frame_rate"))
    if parsed:
        return parsed
    fallback = _parse_frame_rate_value(fallback_fps)
    return fallback or 24.0


def _map_timeline_range_to_source_frames(
    source_start_frame: int,
    overlap_start_frame: int,
    overlap_end_frame: int,
    clip_timeline_start_frame: int,
    timeline_fps: float,
    source_fps: float,
    source_end_limit: Optional[int] = None,
) -> tuple[int, int]:
    offset_seconds = _frames_to_seconds(overlap_start_frame - clip_timeline_start_frame, timeline_fps)
    duration_seconds = _frames_to_seconds(overlap_end_frame - overlap_start_frame, timeline_fps)
    mapped_start = int(source_start_frame + _seconds_to_start_frame(offset_seconds, source_fps))
    mapped_end = int(source_start_frame + _seconds_to_end_frame(offset_seconds + duration_seconds, source_fps))
    if source_end_limit is not None:
        mapped_start = min(mapped_start, int(source_end_limit))
        mapped_end = min(mapped_end, int(source_end_limit))
    if mapped_end < mapped_start:
        mapped_end = mapped_start
    return mapped_start, mapped_end


def _collect_deleted_frame_ranges(segments: List[Dict[str, Any]], fps: float, merge_gap_seconds: float = 0.5) -> List[List[int]]:
    ranges: List[List[int]] = []
    for segment in segments or []:
        try:
            start_frame = _seconds_to_frame_index(segment.get("start", 0), fps)
            end_frame = _seconds_to_frame_index(segment.get("end", 0), fps)
        except Exception:
            continue
        if end_frame <= start_frame:
            continue
        ranges.append([start_frame, end_frame])
    if not ranges:
        return []
    ranges.sort(key=lambda item: (item[0], item[1]))
    # 第一遍：合并重叠或相邻区间
    merged: List[List[int]] = [ranges[0]]
    for start_frame, end_frame in ranges[1:]:
        last = merged[-1]
        if start_frame <= last[1]:
            last[1] = max(last[1], end_frame)
        else:
            merged.append([start_frame, end_frame])
    # 第二遍：合并间隙小于阈值的相邻区间
    if merge_gap_seconds > 0 and len(merged) > 1:
        merge_gap_frames = max(1, int(merge_gap_seconds * fps))
        gap_merged: List[List[int]] = [merged[0]]
        for start_frame, end_frame in merged[1:]:
            last = gap_merged[-1]
            if start_frame - last[1] <= merge_gap_frames:
                last[1] = max(last[1], end_frame)
            else:
                gap_merged.append([start_frame, end_frame])
        return gap_merged
    return merged


def _resolve_inplace_target_tracks(clip_mapping: List[Dict[str, Any]], apply_method: str) -> Dict[str, set]:
    video_tracks = sorted({
        int(item.get("track_index") or 0)
        for item in (clip_mapping or [])
        if item.get("track_type") == "video" and int(item.get("track_index") or 0) > 0
    })
    audio_tracks = sorted({
        int(item.get("track_index") or 0)
        for item in (clip_mapping or [])
        if item.get("track_type") == "audio" and int(item.get("track_index") or 0) > 0
    })
    if apply_method == "inplace_main":
        return {
            "video": {video_tracks[0]} if video_tracks else set(),
            "audio": {audio_tracks[0]} if audio_tracks else set(),
        }
    return {
        "video": set(video_tracks),
        "audio": set(audio_tracks),
    }


def _removed_duration_before(frame: int, deleted_ranges: List[List[int]]) -> int:
    total = 0
    for start_frame, end_frame in deleted_ranges:
        if end_frame <= frame:
            total += end_frame - start_frame
        elif start_frame < frame:
            total += frame - start_frame
            break
        else:
            break
    return total


def _subtract_deleted_ranges_from_clip(clip: Dict[str, Any], deleted_ranges: List[List[int]], timeline_fps: float) -> List[Dict[str, Any]]:
    clip_start = int(clip.get("timeline_start_frame_relative", clip.get("timeline_start_frame", 0)) or 0)
    clip_end = int(clip.get("timeline_end_frame_relative", clip.get("timeline_end_frame", 0)) or 0)
    source_start = int(clip.get("source_in_frame", clip.get("source_start_frame", 0)) or 0)
    source_fps = _get_clip_source_frame_rate(clip, timeline_fps)
    source_end_limit = clip.get("source_out_frame", clip.get("source_end_frame"))
    if clip_end <= clip_start:
        return []

    kept_ranges: List[List[int]] = [[clip_start, clip_end]]
    for delete_start, delete_end in deleted_ranges:
        next_ranges: List[List[int]] = []
        for range_start, range_end in kept_ranges:
            overlap_start = max(range_start, delete_start)
            overlap_end = min(range_end, delete_end)
            if overlap_end <= overlap_start:
                next_ranges.append([range_start, range_end])
                continue
            if range_start < overlap_start:
                next_ranges.append([range_start, overlap_start])
            if overlap_end < range_end:
                next_ranges.append([overlap_end, range_end])
        kept_ranges = next_ranges
        if not kept_ranges:
            break

    rebuilt: List[Dict[str, Any]] = []
    for range_start, range_end in kept_ranges:
        if range_end <= range_start:
            continue
        mapped_source_start, mapped_source_end = _map_timeline_range_to_source_frames(
            source_start_frame=source_start,
            overlap_start_frame=range_start,
            overlap_end_frame=range_end,
            clip_timeline_start_frame=clip_start,
            timeline_fps=timeline_fps,
            source_fps=source_fps,
            source_end_limit=int(source_end_limit) if source_end_limit not in (None, "") else None,
        )
        rebuilt.append({
            **clip,
            "kept_timeline_start_frame_relative": int(range_start),
            "kept_timeline_end_frame_relative": int(range_end),
            "source_start_frame": int(mapped_source_start),
            "source_end_frame": int(mapped_source_end),
        })
    return rebuilt


def _resolve_media_item_for_clip_mapping_entry(root_folder, clip: Dict[str, Any]):
    media_id = str(clip.get("media_id") or "")
    clip_path = str(clip.get("clip_path") or "")
    clip_name = str(clip.get("clip_name") or "")
    track_type = str(clip.get("track_type") or "")
    media_item = None
    if media_id:
        try:
            media_item = resolve_controller._find_media_item_by_media_id(root_folder, media_id)
        except Exception:
            media_item = None
    if not media_item and clip_path:
        try:
            media_item = resolve_controller._find_media_item_by_path(root_folder, clip_path)
        except Exception:
            media_item = None
    if not media_item and clip_name:
        try:
            media_item = resolve_controller._find_media_item(root_folder, clip_name)
        except Exception:
            media_item = None
    if not media_item and clip_path and os.path.exists(clip_path):
        if track_type == "audio":
            ensure_res = resolve_controller.ensure_audio_media_pool_item(clip_path, media_id=media_id or None)
            if ensure_res.get("status") == "success":
                try:
                    media_item = resolve_controller._find_media_item_by_path(root_folder, clip_path)
                except Exception:
                    media_item = None
        else:
            import_res = resolve_controller.import_video(clip_path)
            if import_res.get("status") == "success":
                try:
                    media_item = resolve_controller._find_media_item_by_media_id(root_folder, import_res.get("media_id") or "")
                except Exception:
                    media_item = None
                if not media_item:
                    try:
                        media_item = resolve_controller._find_media_item_by_path(root_folder, clip_path)
                    except Exception:
                        media_item = None
    return media_item


def _ensure_clip_mapping_source_frame_rates(
    clip_mapping: List[Dict[str, Any]],
    root_folder,
    fallback_fps: float,
) -> List[Dict[str, Any]]:
    normalized_mapping: List[Dict[str, Any]] = []
    for clip in clip_mapping or []:
        clip_copy = dict(clip)
        if _parse_frame_rate_value(clip_copy.get("source_frame_rate")):
            normalized_mapping.append(clip_copy)
            continue
        media_item = _resolve_media_item_for_clip_mapping_entry(root_folder, clip_copy)
        if media_item:
            clip_copy["source_frame_rate"] = _extract_media_frame_rate(media_item, fallback_fps)
        else:
            clip_copy["source_frame_rate"] = _parse_frame_rate_value(fallback_fps) or 24.0
        normalized_mapping.append(clip_copy)
    return normalized_mapping


def _build_retimed_clip_infos(
    clip_mapping: List[Dict[str, Any]],
    deleted_ranges: List[List[int]],
    target_tracks: Dict[str, set],
    apply_method: str,
    timeline_start_frame: int,
    timeline_fps: float,
    root_folder,
) -> List[Dict[str, Any]]:
    clip_infos: List[Dict[str, Any]] = []
    for clip in clip_mapping or []:
        track_type = str(clip.get("track_type") or "")
        track_index = int(clip.get("track_index") or 0)
        if track_type not in ("video", "audio") or track_index <= 0:
            continue
        if track_index not in target_tracks.get(track_type, set()):
            continue

        kept_segments = _subtract_deleted_ranges_from_clip(clip, deleted_ranges, timeline_fps)
        if not kept_segments:
            continue

        media_item = _resolve_media_item_for_clip_mapping_entry(root_folder, clip)
        if not media_item:
            raise RuntimeError(f"媒体池中未找到素材: {clip.get('clip_name') or clip.get('clip_path')}")

        media_type = 1 if track_type == "video" else 2
        for kept in kept_segments:
            kept_start = int(kept.get("kept_timeline_start_frame_relative") or 0)
            kept_end = int(kept.get("kept_timeline_end_frame_relative") or 0)
            removed_before = _removed_duration_before(kept_start, deleted_ranges)
            if apply_method == "inplace_all":
                record_frame = timeline_start_frame + kept_start - removed_before
            else:
                record_frame = timeline_start_frame + kept_start - removed_before
            clip_info = {
                "mediaPoolItem": media_item,
                "startFrame": int(kept.get("source_start_frame") or 0),
                "endFrame": int(kept.get("source_end_frame") or 0),
                "recordFrame": int(record_frame),
                "trackIndex": int(track_index),
                "mediaType": media_type,
            }
            clip_infos.append(clip_info)
    clip_infos.sort(key=lambda item: (int(item.get("recordFrame") or 0), int(item.get("mediaType") or 0), int(item.get("trackIndex") or 0)))
    return clip_infos


def _delete_track_items_for_inplace(timeline, target_tracks: Dict[str, set]) -> int:
    deleted_count = 0
    for track_type, track_indexes in target_tracks.items():
        for track_index in sorted(track_indexes):
            items = timeline.GetItemListInTrack(track_type, track_index) or []
            if not items:
                continue
            if _delete_timeline_items(list(items)):
                deleted_count += len(items)
    return deleted_count


def _apply_inplace_transcript_edit(
    timeline,
    root_folder,
    clip_mapping: List[Dict[str, Any]],
    deleted_segments: List[Dict[str, Any]],
    fps: float,
    apply_method: str,
    merge_gap_seconds: float = 1.0,
) -> Dict[str, Any]:
    deleted_ranges = _collect_deleted_frame_ranges(deleted_segments, fps, merge_gap_seconds)
    if not deleted_ranges:
        return {"status": "error", "message": "没有有效的删除区间"}

    target_tracks = _resolve_inplace_target_tracks(clip_mapping, apply_method)
    if not target_tracks["video"] and not target_tracks["audio"]:
        return {"status": "error", "message": "未找到可重建的目标轨道"}

    for track_type, track_indexes in target_tracks.items():
        for track_index in sorted(track_indexes):
            try:
                if timeline.GetIsTrackLocked(track_type, track_index):
                    return {"status": "error", "message": f"目标轨道已锁定：{track_type} {track_index}"}
            except Exception:
                continue

    backup_result = resolve_controller.backup_timeline_only(
        file_name_template="%TimelineName%_文稿删减_%Time%",
        timeline_name=timeline.GetName() if timeline else None,
        use_subfolder=False,
    )
    if backup_result.get("status") != "success":
        return {"status": "error", "message": backup_result.get("message") or "备份当前时间线失败"}

    timeline_start_frame = int(timeline.GetStartFrame() or 0) if hasattr(timeline, "GetStartFrame") else 0
    clip_infos = _build_retimed_clip_infos(
        clip_mapping=clip_mapping,
        deleted_ranges=deleted_ranges,
        target_tracks=target_tracks,
        apply_method=apply_method,
        timeline_start_frame=timeline_start_frame,
        timeline_fps=fps,
        root_folder=root_folder,
    )
    if not clip_infos:
        return {"status": "error", "message": "删除文稿后没有剩余片段可回填"}

    deleted_count = _delete_track_items_for_inplace(timeline, target_tracks)
    added_items = resolve_controller.media_pool.AppendToTimeline(clip_infos)
    rebuilt_duration = sum(
        max(0, int(item.get("endFrame") or 0) - int(item.get("startFrame") or 0))
        for item in clip_infos
    )
    scope_label = "主轨" if apply_method == "inplace_main" else "全联动轨道"
    return {
        "status": "success",
        "method": apply_method,
        "timeline_name": timeline.GetName(),
        "backup_timeline_name": backup_result.get("resolved_name") or "",
        "deleted_ranges": len(deleted_ranges),
        "rebuilt_clips": len(clip_infos),
        "deleted_original_clips": int(deleted_count),
        "added_clips": len(added_items) if added_items else 0,
        "message": f"已按删除文稿重建{scope_label}，并自动备份时间线「{backup_result.get('resolved_name') or ''}」",
        "warning": "重建轨道会回填源素材片段，目标轨道上的缩放、调色、特效等属性不会保留。",
        "rebuilt_duration_frames": int(rebuilt_duration),
    }


def _get_timeline_record_start_frame(timeline):
    """获取追加模式下新的 recordFrame 起点。"""
    if not timeline:
        return 0

    max_end_frame = int(timeline.GetStartFrame()) if hasattr(timeline, "GetStartFrame") else 0
    for track_type in ("video", "audio"):
        track_count = timeline.GetTrackCount(track_type) or 0
        for track_idx in range(1, track_count + 1):
            items = timeline.GetItemListInTrack(track_type, track_idx) or []
            for item in items:
                try:
                    max_end_frame = max(max_end_frame, int(item.GetEnd()))
                except Exception:
                    continue
    return max_end_frame

@app.post("/api/timeline/check")
async def check_timeline(request: CheckTimelineRequest):
    """
    检查当前时间线中的夹帧、黑帧和黑边
    """
    result = resolve_controller.check_timeline(
        flash_frame_threshold=request.flash_frame_threshold,
        check_black_frames=request.check_black_frames,
        check_black_borders=request.check_black_borders,
        black_border_safe_zone=request.black_border_safe_zone
    )
    if result.get("status") == "error":
        raise HTTPException(status_code=500, detail=result.get("message"))
    context = sync_current_project_context(include_media=False)
    project_name = context.get("project_name")
    if project_name:
        update_project_record(project_name, {
            "latest_timeline_check": {
                "flash_frame_threshold": request.flash_frame_threshold,
                "check_black_frames": request.check_black_frames,
                "check_black_borders": request.check_black_borders,
                "black_border_safe_zone": request.black_border_safe_zone,
                "total_issues": result.get("total_issues", 0),
                "issues": result.get("issues", []),
            }
        })
    return result


@app.post("/api/timeline/debug-clips")
async def debug_timeline_clips(request: TimelineDebugRequest):
    """返回当前时间线每条轨道上的片段与片段间空隙，用于排查文本剪辑落片问题。"""
    if not resolve_controller.resolve:
        raise HTTPException(status_code=500, detail="未连接达芬奇")

    try:
        resolve_controller._refresh_context()
        timeline = resolve_controller._get_active_timeline()
        if not timeline:
            raise HTTPException(status_code=500, detail="当前没有活跃时间线")

        try:
            fps = float(timeline.GetSetting("timelineFrameRate") or resolve_controller.project.GetSetting("timelineFrameRate") or 24)
        except Exception:
            fps = 24.0

        track_types = []
        if request.include_video:
            track_types.append("video")
        if request.include_audio:
            track_types.append("audio")

        tracks = []
        total_gap_frames = 0

        for track_type in track_types:
            try:
                track_count = int(timeline.GetTrackCount(track_type) or 0)
            except Exception:
                track_count = 0

            for track_index in range(1, track_count + 1):
                items = timeline.GetItemListInTrack(track_type, track_index) or []
                normalized_items = []

                for item in items:
                    try:
                        start_frame = int(item.GetStart())
                        end_frame = int(item.GetEnd())
                    except Exception:
                        continue

                    media_item = None
                    media_name = ""
                    media_path = ""
                    try:
                        media_item = item.GetMediaPoolItem()
                    except Exception:
                        media_item = None
                    if media_item:
                        try:
                            media_name = media_item.GetName() or ""
                        except Exception:
                            media_name = ""
                        try:
                            media_path = media_item.GetClipProperty("File Path") or ""
                        except Exception:
                            media_path = ""

                    normalized_items.append({
                        "name": item.GetName() if hasattr(item, "GetName") else media_name,
                        "start_frame": start_frame,
                        "end_frame": end_frame,
                        "duration_frames": max(0, end_frame - start_frame),
                        "media_name": media_name,
                        "media_path": media_path,
                    })

                normalized_items.sort(key=lambda clip: (clip["start_frame"], clip["end_frame"]))
                gaps = []
                previous_end = None
                for clip in normalized_items:
                    if previous_end is not None and clip["start_frame"] > previous_end:
                        gap_start = previous_end
                        gap_end = clip["start_frame"]
                        gap_duration = gap_end - gap_start
                        gaps.append({
                            "start_frame": gap_start,
                            "end_frame": gap_end,
                            "duration_frames": gap_duration,
                            "duration_seconds": round(gap_duration / fps, 3),
                        })
                        total_gap_frames += gap_duration
                    previous_end = max(previous_end or clip["end_frame"], clip["end_frame"])

                tracks.append({
                    "track_type": track_type,
                    "track_index": track_index,
                    "clip_count": len(normalized_items),
                    "clips": normalized_items,
                    "gaps": gaps,
                    "total_gap_frames": sum(gap["duration_frames"] for gap in gaps),
                })

        return {
            "status": "success",
            "timeline_name": timeline.GetName(),
            "frame_rate": fps,
            "tracks": tracks,
            "total_gap_frames": total_gap_frames,
            "total_gap_seconds": round(total_gap_frames / fps, 3) if fps else 0,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取时间线调试信息失败: {str(e)}")

@app.post("/api/timeline/locate")
async def locate_timeline_issue(request: TimelineIssueRequest):
    if request.frame is not None:
        frame = request.frame
        is_absolute = False
    elif request.issue:
        frame = int(request.issue.get("start", 0))
        is_absolute = True
    else:
        raise HTTPException(status_code=400, detail="请提供 frame 或 issue 参数")
    result = resolve_controller.locate_timeline_frame(frame, frame_is_absolute=is_absolute)
    if result.get("status") == "error":
        raise HTTPException(status_code=500, detail=result.get("message"))
    return result


class ReviewSeekRequest(BaseModel):
    timeMs: float = 0  # 评论时间戳（毫秒）


@app.post("/api/yueliu/seek")
async def seek_to_review_time(request: ReviewSeekRequest):
    """将达芬奇播放头移动到审阅评论对应时间"""
    if not resolve_controller.resolve:
        return {"status": "error", "message": "达芬奇未连接"}

    try:
        resolve_controller._refresh_context()
        timeline = resolve_controller._get_active_timeline()
        if not timeline:
            return {"status": "error", "message": "没有可用时间线"}

        frame_rate = float(timeline.GetSetting("timelineFrameRate") or 24)
        # timeMs 是审阅者在导出视频中看到的时间 → 直接换算即为时间线物理帧位置
        frame = int(request.timeMs / 1000.0 * frame_rate)
        result = resolve_controller.locate_timeline_frame(frame)
        return result
    except Exception as e:
        return {"status": "error", "message": f"跳转失败: {str(e)}"}

@app.post("/api/timeline/mark-issues")
async def mark_timeline_issues(request: TimelineIssuesMarkerRequest):
    result = resolve_controller.add_issue_markers(
        request.issues or [],
        clear_existing=request.clear_existing
    )
    if result.get("status") == "error":
        raise HTTPException(status_code=500, detail=result.get("message"))
    return result

@app.post("/api/timeline/clear-check-markers")
async def clear_check_markers(request: TimelineIssuesMarkerRequest = None):
    issue_types = None
    if request and request.issues:
        issue_types = list(set(issue.get("type") for issue in request.issues if issue.get("type")))
    result = resolve_controller.clear_check_markers(issue_types=issue_types)
    if result.get("status") == "error":
        raise HTTPException(status_code=500, detail=result.get("message"))
    return result

@app.post("/api/timeline/fix-black-border")
async def fix_black_border_issue(request: TimelineBlackBorderFixRequest):
    result = resolve_controller.auto_scale_black_border_issue(request.issue or {})
    if result.get("status") == "error":
        raise HTTPException(status_code=500, detail=result.get("message"))
    return result

# ======= 转录项目管理 API =======

class TranscriptProjectDeleteRequest(BaseModel):
    transcript_id: str
    audio_only: bool = False

class TranscriptProjectLoadRequest(BaseModel):
    transcript_id: str

class TranscriptProjectUpdateRequest(BaseModel):
    segments: List[Dict[str, Any]]

@app.get("/api/transcript/projects")
async def api_list_transcript_projects(all: bool = False):
    """列出转录项目。all=true 时列出所有达芬奇项目下的转录项目"""
    if all:
        from app.cache_manager import list_all_transcript_projects
        projects = list_all_transcript_projects()
        return {"projects": projects}
    context = sync_current_project_context(include_media=False)
    project_name = context.get("project_name")
    if not project_name:
        return {"projects": []}
    projects = list_transcript_projects(project_name)
    return {"projects": projects}

@app.get("/api/transcript/projects/{transcript_id}")
async def api_get_transcript_project(transcript_id: str):
    """获取转录项目详情"""
    context = sync_current_project_context(include_media=False)
    project_name = context.get("project_name")
    if not project_name:
        raise HTTPException(status_code=404, detail="未检测到达芬奇项目")
    data = get_transcript_project(project_name, transcript_id)
    if not data:
        raise HTTPException(status_code=404, detail="转录项目不存在")
    # 兼容旧磁盘缓存：早期转录结果可能含标点/繁体
    if data.get("transcript", {}).get("segments"):
        for s in data["transcript"]["segments"]:
            if s.get("text"):
                s["text"] = to_simplified_chinese(strip_chinese_punctuation(s["text"]))
    return data

@app.put("/api/transcript/projects/{transcript_id}")
async def api_update_transcript_project(transcript_id: str, request: TranscriptProjectUpdateRequest):
    """保存用户修改后的转录字幕到项目缓存。"""
    context = sync_current_project_context(include_media=False)
    project_name = context.get("project_name")
    if not project_name:
        raise HTTPException(status_code=404, detail="未检测到达芬奇项目")
    try:
        metadata = update_transcript_project_segments(project_name, transcript_id, request.segments)
        update_project_record(project_name, {
            "latest_subtitle_transcription": {
                "segment_count": len(request.segments),
                "segments": request.segments,
                "transcript_id": transcript_id,
            }
        })
        return {
            "status": "success",
            "metadata": metadata,
            "message": f"已保存 {len(request.segments)} 条字幕",
        }
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="转录项目不存在")

@app.delete("/api/transcript/projects/{transcript_id}")
async def api_delete_transcript_project(transcript_id: str, audio_only: bool = False):
    """删除转录项目或仅删除渲染音频"""
    context = sync_current_project_context(include_media=False)
    project_name = context.get("project_name")
    if not project_name:
        raise HTTPException(status_code=404, detail="未检测到达芬奇项目")
    if audio_only:
        if delete_transcript_audio(project_name, transcript_id):
            return {"status": "success", "message": "渲染音频已删除"}
        raise HTTPException(status_code=404, detail="未找到渲染音频文件")
    else:
        if delete_transcript_project(project_name, transcript_id):
            return {"status": "success", "message": "转录项目已删除"}
        raise HTTPException(status_code=404, detail="转录项目不存在")

@app.delete("/api/transcript/cache")
async def api_delete_all_cache():
    """删除所有缓存"""
    context = sync_current_project_context(include_media=False)
    project_name = context.get("project_name")
    count = delete_all_cache(project_name)
    return {"status": "success", "deleted_count": count}

@app.post("/api/transcript/projects/{transcript_id}/load")
async def api_load_transcript_project(transcript_id: str):
    """加载转录项目到前端（优先当前项目，找不到则跨所有项目查找）"""
    from app.cache_manager import find_transcript_project
    context = sync_current_project_context(include_media=False)
    project_name = context.get("project_name")
    if project_name:
        data = get_transcript_project(project_name, transcript_id)
        if data:
            if data.get("transcript", {}).get("segments"):
                for s in data["transcript"]["segments"]:
                    if s.get("text"):
                        s["text"] = to_simplified_chinese(strip_chinese_punctuation(s["text"]))
            return data
    # 当前项目找不到，尝试跨所有项目查找（支持全局转录项目）
    data = find_transcript_project(transcript_id)
    if not data:
        raise HTTPException(status_code=404, detail="转录项目不存在")
    if data.get("transcript", {}).get("segments"):
        for s in data["transcript"]["segments"]:
            if s.get("text"):
                s["text"] = to_simplified_chinese(strip_chinese_punctuation(s["text"]))
    return data

# ======= 自动同步字幕 API（保留 speed-match 路径兼容旧版前端） =======

class SpeedMatchStartRequest(BaseModel):
    track_type: str = "audio"       # "audio" 或 "video"
    track_index: int = 1            # 轨道索引（从1开始）
    frame_rate: float = 24.0        # 帧率
    phrase_dictionary: List[str] = []

class SpeedMatchPollRequest(BaseModel):
    segments: List[Dict[str, Any]] = []  # 保留兼容前端，实际从达芬奇字幕轨道读取

@app.get("/api/subtitle/speed-match/tracks")
async def get_audio_tracks():
    """获取当前时间线的音频/视频轨道列表，用于用户选择要追踪的轨道"""
    if not resolve_controller.resolve:
        raise HTTPException(status_code=500, detail="未连接达芬奇")

    try:
        resolve_controller._refresh_context()
        timeline = resolve_controller._get_active_timeline()
        if not timeline:
            raise HTTPException(status_code=500, detail="当前没有活跃时间线")

        tracks = speed_tracker.list_audio_tracks(timeline)
        return {"status": "success", "tracks": tracks}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/subtitle/speed-match/start")
async def speed_match_start(request: SpeedMatchStartRequest):
    """
    启动自动同步字幕追踪

    1. 创建追踪会话
    2. 采集初始快照
    3. 建立字幕与音频 clip 的绑定关系
    """
    if not resolve_controller.resolve:
        raise HTTPException(status_code=500, detail="未连接达芬奇")

    try:
        resolve_controller._refresh_context()
        timeline = resolve_controller._get_active_timeline()
        if not timeline:
            raise HTTPException(status_code=500, detail="当前没有活跃时间线")

        fps = request.frame_rate or float(timeline.GetSetting("timelineFrameRate") or
                     resolve_controller.project.GetSetting("timelineFrameRate") or 24)

        context = sync_current_project_context(include_media=False)
        project_name = context.get("project_name", "default")
        session_id = f"{project_name}:{timeline.GetName()}"

        speed_tracker.create_session(
            session_id, fps, request.track_type, request.track_index,
            phrase_dictionary=[],
        )

        # 从字幕轨道读取字幕
        timeline_subtitles = speed_tracker.read_timeline_subtitles(timeline, fps)
        if not timeline_subtitles:
            speed_tracker.destroy_session(session_id)
            raise HTTPException(status_code=500, detail="字幕轨道上没有找到字幕")

        # 采集音频快照
        snapshot = speed_tracker.collect_snapshot(
            timeline, fps, request.track_type, request.track_index, session_id
        )
        if not snapshot:
            speed_tracker.destroy_session(session_id)
            raise HTTPException(status_code=500, detail="指定轨道上没有找到任何片段")

        # 建立绑定
        bindings = speed_tracker.create_bindings_from_timeline(
            timeline_subtitles, snapshot, session_id
        )

        # 初始化音频/字幕哈希基准，避免首次 poll 误判为变化
        speed_tracker._last_audio_hash[session_id] = speed_tracker.get_audio_hash(
            timeline, request.track_type, request.track_index
        )
        speed_tracker._last_subtitle_hash[session_id] = speed_tracker.get_subtitle_hash(timeline)

        binding_infos = []
        for b in bindings:
            binding_infos.append({
                "subtitle_index": b.subtitle_index,
                "media_path": b.media_path,
                "sub_source_start": b.sub_source_start,
                "sub_source_end": b.sub_source_end,
            })

        return {
            "status": "success",
            "session_id": session_id,
            "track_type": request.track_type,
            "track_index": request.track_index,
            "subtitle_count": len(timeline_subtitles),
            "clip_count": len(snapshot),
            "binding_count": len(bindings),
            "timeline_subtitles": timeline_subtitles,
            "bindings": binding_infos,
            "message": f"已启动自动同步字幕，绑定 {len(bindings)} 条字幕到 {len(snapshot)} 个音频片段"
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/subtitle/speed-match/poll")
async def speed_match_poll(request: SpeedMatchPollRequest):
    """
    轮询快照对比，基于 Source Time 绝对映射
    """
    if not resolve_controller.resolve:
        return {"status": "disconnected", "has_changes": False, "timeline_subtitles": []}

    try:
        resolve_controller._refresh_context()
        timeline = resolve_controller._get_active_timeline()
        if not timeline:
            return {"status": "no_timeline", "has_changes": False, "timeline_subtitles": []}

        context = sync_current_project_context(include_media=False)
        project_name = context.get("project_name", "default")
        session_id = f"{project_name}:{timeline.GetName()}"

        if not speed_tracker.has_session(session_id):
            return {"status": "no_session", "has_changes": False, "timeline_subtitles": []}

        session = speed_tracker.get_session(session_id)
        fps = session["fps"]
        track_type = session["track_type"]
        track_index = session["track_index"]

        # 分别检测音频变化与字幕变化
        audio_hash = speed_tracker.get_audio_hash(timeline, track_type, track_index)
        subtitle_hash = speed_tracker.get_subtitle_hash(timeline)
        last_audio = speed_tracker._last_audio_hash.get(session_id)
        last_subtitle = speed_tracker._last_subtitle_hash.get(session_id)

        audio_changed = last_audio is None or audio_hash != last_audio
        subtitle_changed = last_subtitle is None or subtitle_hash != last_subtitle

        if not audio_changed and not subtitle_changed:
            timeline_subtitles = speed_tracker.read_timeline_subtitles(timeline, fps)
            return {
                "status": "success",
                "has_changes": False,
                "change_log": [],
                "timeline_subtitles": timeline_subtitles,
                "message": "无变化",
                "logs": speed_tracker.get_logs(20),
            }

        new_snapshot = speed_tracker.collect_snapshot(
            timeline, fps, track_type, track_index, session_id
        )
        timeline_subtitles = speed_tracker.read_timeline_subtitles(timeline, fps)

        # 字幕被用户改动（编辑/移动/新增回车）：以当前字幕为准重建绑定，记住最新状态。
        # 只有“新增回车切分”会写回达芬奇；剃刀/分割点不再触发自动断句。
        if subtitle_changed:
            split_subtitles, split_log = speed_tracker.realign_existing_subtitles(
                timeline_subtitles, new_snapshot, session_id
            )
            newline_log = [
                item for item in split_log
                if item.get("description") == "新增换行切分"
            ]
            sync_result = None
            if newline_log:
                try:
                    sync_result = _insert_subtitles_to_timeline(
                        timeline, split_subtitles, fps
                    )
                except Exception as e:
                    speed_tracker._logger.log("error", f"[分割写回] 异常: {e}")
                # 写回后重新读取，作为重建绑定的依据
                timeline_subtitles = speed_tracker.read_timeline_subtitles(timeline, fps)

            # 基于（可能已分好文字的）当前字幕重建绑定，各段独立记录源时间
            speed_tracker.create_bindings_from_timeline(
                timeline_subtitles, new_snapshot, session_id
            )
            speed_tracker._last_audio_hash[session_id] = speed_tracker.get_audio_hash(
                timeline, track_type, track_index
            )
            speed_tracker._last_subtitle_hash[session_id] = speed_tracker.get_subtitle_hash(timeline)
            return {
                "status": "success",
                "has_changes": len(newline_log) > 0,
                "change_log": newline_log,
                "timeline_subtitles": timeline_subtitles,
                "message": "字幕已更新，绑定已重建" + ("（含新增回车切分）" if newline_log else ""),
                "logs": speed_tracker.get_logs(20),
            }

        # 仅音频变化（移动/变速）：用现有绑定把字幕重映射到新位置，写回达芬奇。
        updated_subtitles, change_log = speed_tracker.realign_existing_subtitles(
            timeline_subtitles, new_snapshot, session_id
        )

        sync_result = None
        if change_log:
            try:
                sync_result = _insert_subtitles_to_timeline(timeline, updated_subtitles, fps)
                if sync_result and sync_result.get("status") == "success":
                    speed_tracker._logger.log("info", "[同步达芬奇] 字幕已同步")
            except Exception as e:
                speed_tracker._logger.log("error", f"[同步达芬奇] 同步异常: {e}")

        # 写入会改变字幕轨道状态（SRT 往返帧取整），写入「之后」重新记录两个哈希，
        # 避免下一轮把自己的写入误判为用户改动而触发无限刷新或误重建绑定。
        speed_tracker._last_audio_hash[session_id] = speed_tracker.get_audio_hash(
            timeline, track_type, track_index
        )
        speed_tracker._last_subtitle_hash[session_id] = speed_tracker.get_subtitle_hash(timeline)

        return {
            "status": "success",
            "has_changes": len(change_log) > 0,
            "change_log": change_log,
            "timeline_subtitles": updated_subtitles,
            "message": f"重算完成，更新了 {len(change_log)} 条字幕",
            "logs": speed_tracker.get_logs(20),
            "sync_result": sync_result,
        }
    except Exception as e:
        import traceback
        return {"status": "error", "message": str(e), "detail": traceback.format_exc()}

@app.get("/api/subtitle/speed-match/logs")
async def speed_match_logs():
    """获取自动同步字幕追踪日志"""
    try:
        logs = speed_tracker.get_logs(100)
        return {"status": "success", "logs": logs}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/subtitle/speed-match/stop")
async def speed_match_stop():
    """停止自动同步字幕追踪"""
    try:
        context = sync_current_project_context(include_media=False)
        project_name = context.get("project_name", "default")

        resolve_controller._refresh_context()
        timeline = resolve_controller._get_active_timeline()
        timeline_name = timeline.GetName() if timeline else "unknown"
        session_id = f"{project_name}:{timeline_name}"

        if speed_tracker.has_session(session_id):
            speed_tracker.destroy_session(session_id)
            return {"status": "success", "message": "自动同步字幕已停止"}
        else:
            return {"status": "success", "message": "无活跃的追踪会话"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/subtitle/speed-match/status")
async def speed_match_status():
    """获取当前自动同步字幕追踪状态"""
    try:
        context = sync_current_project_context(include_media=False)
        project_name = context.get("project_name", "default")

        resolve_controller._refresh_context()
        timeline = resolve_controller._get_active_timeline()
        timeline_name = timeline.GetName() if timeline else "unknown"
        session_id = f"{project_name}:{timeline_name}"

        if not speed_tracker.has_session(session_id):
            return {"status": "inactive", "active": False}

        session = speed_tracker.get_session(session_id)
        bindings = speed_tracker.get_bindings(session_id)

        return {
            "status": "active",
            "active": True,
            "session_id": session_id,
            "track_type": session.get("track_type"),
            "track_index": session.get("track_index"),
            "fps": session.get("fps"),
            "binding_count": len(bindings),
            "snapshot_count": 0,
            "has_timeline_hash": session_id in speed_tracker._last_hash,
        }
    except Exception as e:
        return {"status": "error", "active": False, "message": str(e)}

@app.post("/api/subtitle/speed-match/realign")
async def speed_match_realign(request: SpeedMatchPollRequest):
    """
    手动重新对齐字幕
    """
    if not resolve_controller.resolve:
        return {"status": "disconnected", "has_changes": False, "timeline_subtitles": []}

    try:
        resolve_controller._refresh_context()
        timeline = resolve_controller._get_active_timeline()
        if not timeline:
            return {"status": "no_timeline", "has_changes": False, "timeline_subtitles": []}

        context = sync_current_project_context(include_media=False)
        project_name = context.get("project_name", "default")
        session_id = f"{project_name}:{timeline.GetName()}"

        if not speed_tracker.has_session(session_id):
            return {"status": "no_session", "has_changes": False, "timeline_subtitles": []}

        session = speed_tracker.get_session(session_id)
        fps = session["fps"]
        track_type = session["track_type"]
        track_index = session["track_index"]

        new_snapshot = speed_tracker.collect_snapshot(
            timeline, fps, track_type, track_index, session_id
        )
        timeline_subtitles = speed_tracker.read_timeline_subtitles(timeline, fps)
        updated_subtitles, change_log = speed_tracker.realign_existing_subtitles(
            timeline_subtitles, new_snapshot, session_id
        )

        return {
            "status": "success",
            "has_changes": len(change_log) > 0,
            "change_log": change_log,
            "timeline_subtitles": updated_subtitles,
            "message": f"手动重新对齐完成，调整了 {len(change_log)} 条字幕",
            "logs": speed_tracker.get_logs(20),
        }
    except Exception as e:
        import traceback
        return {"status": "error", "message": str(e), "detail": traceback.format_exc()}

init_pack_routes(app, resolve_controller)

# ======= 音效库管理 API =======

class SoundEffectsConfigRequest(BaseModel):
    library_path: str = ""
    save_subfolder: str = "音效"
    davinci_folder: str = "音效"
    local_target_folder: str = ""
    davinci_archive_folder: str = ""
    folder_depth: int = 1
    folder_depth_direction: str = "forward"
    library_scan_depth: int = 20
    preview_cache_max_mb: int = 512
    waveform_cache_max_mb: int = 128
    waveform_cache_backend: str = "library"
    waveform_cache_library_dir: str = ".sfx_cache"
    waveform_cache_compress: bool = True
    path_mappings: List[Dict[str, str]] = []


class SoundEffectsMetaFavoriteRequest(BaseModel):
    asset_key: str
    favorite: bool


class SoundEffectsMetaTagRequest(BaseModel):
    asset_key: str
    tag: str


class SoundEffectsMetaBulkTagRequest(BaseModel):
    asset_keys: List[str] = []
    library_path: str = ""
    folder_paths: List[str] = []
    tag: str


class SoundEffectsCollectRequest(BaseModel):
    asset_keys: List[str] = []
    library_path: str = ""
    folder_paths: List[str] = []


class SoundLibrarySummaryRequest(BaseModel):
    library_path: str
    force_refresh: bool = False


class SoundLibraryIndexStatusRequest(BaseModel):
    library_path: str


class SoundLibraryBrowseRequest(BaseModel):
    library_path: str
    query: str = ""
    selected_folder: str = ""
    forced_tag: str = ""
    favorite_only: bool = False
    untagged_only: bool = False
    sort_mode: str = "name_asc"
    smart_rules: Dict[str, Any] = {}
    limit: int = 120
    offset: int = 0
    force_refresh: bool = False


class SoundLibraryBootstrapRequest(BaseModel):
    library_path: str
    query: str = ""
    selected_folder: str = ""
    forced_tag: str = ""
    favorite_only: bool = False
    untagged_only: bool = False
    sort_mode: str = "name_asc"
    smart_rules: Dict[str, Any] = {}
    limit: int = 120
    offset: int = 0
    force_refresh: bool = False


class SoundLibraryScanRequest(BaseModel):
    library_path: Optional[str] = None
    force_refresh: bool = False

class SoundEffectCreateLibraryRequest(BaseModel):
    parent_path: str
    folder_name: str

class SoundEffectPressRequest(BaseModel):
    source_path: str               # 音效库中的原始文件路径
    source_relative_path: str = "" # 相对于音效库根目录的路径
    in_point: Optional[float] = None
    out_point: Optional[float] = None
    drag_source: str = "detail_button"
    drag_probe_path: str = ""
    drag_probe_name: str = ""
    drag_probe_token: str = ""
    folder_depth_direction: Optional[str] = None  # 前端当前状态，优先于配置文件

class SoundEffectReleaseRequest(BaseModel):
    session_id: str                # 按下时返回的 session_id

class SoundEffectInsertRequest(BaseModel):
    source_path: str
    source_relative_path: str = ""
    in_point: Optional[float] = None
    out_point: Optional[float] = None
    track_index: int = 1

@app.get("/api/sound-effects/config")
async def get_sound_effects_config():
    """获取音效库配置"""
    config = load_sound_effects_config()
    folder_cfg = load_folder_config()
    result = {
        "status": "success",
        "config": config,
        "local_folder_options": folder_cfg.get("local_folders", []) if isinstance(folder_cfg, dict) else [],
        "davinci_folder_options": folder_cfg.get("davinci_folders", []) if isinstance(folder_cfg, dict) else [],
    }

    # 获取项目本地路径下的子文件夹列表（供下拉选择）
    context = sync_current_project_context(include_media=False)
    local_path = context.get("local_path", "")
    if local_path and os.path.isdir(local_path):
        try:
            subdirs = [d for d in os.listdir(local_path)
                       if os.path.isdir(os.path.join(local_path, d)) and not d.startswith('.')]
            subdirs.sort()
            result["subdirs"] = subdirs
            result["local_path"] = local_path
        except Exception:
            result["subdirs"] = []
            result["local_path"] = local_path
    else:
        result["subdirs"] = []
        result["local_path"] = local_path or ""

    return result

@app.post("/api/sound-effects/config")
async def set_sound_effects_config(request: SoundEffectsConfigRequest):
    """保存音效库配置"""
    config = {
        "library_path": request.library_path,
        "save_subfolder": request.save_subfolder,
        "davinci_folder": request.davinci_folder,
        "local_target_folder": request.local_target_folder,
        "davinci_archive_folder": request.davinci_archive_folder,
        "folder_depth": request.folder_depth,
        "folder_depth_direction": request.folder_depth_direction,
        "library_scan_depth": request.library_scan_depth,
        "preview_cache_max_mb": request.preview_cache_max_mb,
        "waveform_cache_max_mb": request.waveform_cache_max_mb,
        "waveform_cache_backend": request.waveform_cache_backend,
        "waveform_cache_library_dir": request.waveform_cache_library_dir,
        "waveform_cache_compress": request.waveform_cache_compress,
        "path_mappings": request.path_mappings,
    }
    success = save_sound_effects_config(config)
    if success:
        return {"status": "success", "message": "音效库配置已保存"}
    raise HTTPException(status_code=500, detail="配置保存失败")
def _get_sound_library_context() -> Dict[str, Any]:
    config = load_sound_effects_config()
    return {
        "config": config,
        "max_depth": int((config or {}).get("library_scan_depth", 20)),
        "ttl_seconds": int((config or {}).get("scan_cache_ttl_seconds", 300) or 300),
        "mappings": (config or {}).get("path_mappings", []),
    }


def _resolve_request_asset_keys(
    asset_keys: Optional[List[str]] = None,
    library_path: str = "",
    folder_paths: Optional[List[str]] = None,
    force_refresh: bool = False,
) -> List[str]:
    direct_keys = [str(key) for key in list(asset_keys or []) if str(key).strip()]
    normalized_library = str(library_path or "").strip()
    normalized_folders = [str(path) for path in list(folder_paths or []) if str(path).strip()]
    if not normalized_library or not normalized_folders:
        return direct_keys
    context = _get_sound_library_context()
    ensure_sound_library_scan_cache(
        normalized_library,
        max_depth=context["max_depth"],
        path_mappings=context["mappings"],
        ttl_seconds=context["ttl_seconds"],
        force_refresh=force_refresh,
    )
    return resolve_asset_keys_for_paths_index(
        normalized_library,
        max_depth=context["max_depth"],
        path_mappings=context["mappings"],
        asset_keys=direct_keys,
        folder_paths=normalized_folders,
    )


@app.post("/api/sound-effects/library-index-status")
async def get_sound_library_index_status_endpoint(request: SoundLibraryIndexStatusRequest):
    if not request.library_path:
        raise HTTPException(status_code=400, detail="缺少音效库路径")
    context = _get_sound_library_context()
    status_info = get_sound_library_index_status(
        request.library_path,
        max_depth=context["max_depth"],
        path_mappings=context["mappings"],
        ttl_seconds=context["ttl_seconds"],
    )
    return {"status": "success", "status_info": status_info}


@app.post("/api/sound-effects/library-summary")
async def get_sound_library_summary(request: SoundLibrarySummaryRequest):
    if not request.library_path:
        raise HTTPException(status_code=400, detail="缺少音效库路径")
    context = _get_sound_library_context()
    ensured = await asyncio.to_thread(
        ensure_sound_library_scan_cache,
        request.library_path,
        context["max_depth"],
        context["mappings"],
        context["ttl_seconds"],
        bool(request.force_refresh),
        True,
    )
    summary = summarize_sound_library_assets_index(
        request.library_path,
        max_depth=context["max_depth"],
        path_mappings=context["mappings"],
    )
    return {
        "status": "success",
        "library_path": request.library_path,
        "folder_tree": ensured.get("folders") or [],
        "nav_counts": summary.get("nav_counts") or {},
        "top_tags": summary.get("top_tags") or [],
        "cached": bool(ensured.get("cached")),
        "stale": bool(ensured.get("stale")),
        "refreshing": bool(ensured.get("refreshing")),
        "generated_at": int(ensured.get("generated_at") or 0),
    }


@app.post("/api/sound-effects/library-browse")
async def browse_sound_library(request: SoundLibraryBrowseRequest):
    if not request.library_path:
        raise HTTPException(status_code=400, detail="缺少音效库路径")
    context = _get_sound_library_context()
    ensured = await asyncio.to_thread(
        ensure_sound_library_scan_cache,
        request.library_path,
        context["max_depth"],
        context["mappings"],
        context["ttl_seconds"],
        bool(request.force_refresh),
    )
    result = browse_sound_library_assets_index(
        request.library_path,
        max_depth=context["max_depth"],
        path_mappings=context["mappings"],
        query=request.query,
        selected_folder=request.selected_folder,
        forced_tag=request.forced_tag,
        favorite_only=bool(request.favorite_only),
        untagged_only=bool(request.untagged_only),
        sort_mode=request.sort_mode,
        smart_rules=request.smart_rules or {},
        limit=int(request.limit or 120),
        offset=int(request.offset or 0),
    )
    return {
        "status": "success",
        "library_path": request.library_path,
        "items": result.get("items") or [],
        "total": int(result.get("total") or 0),
        "offset": int(result.get("offset") or 0),
        "limit": int(result.get("limit") or 0),
        "has_more": bool(result.get("has_more")),
        "cached": bool(ensured.get("cached")),
        "stale": bool(ensured.get("stale")),
        "refreshing": bool(ensured.get("refreshing")),
        "generated_at": int(ensured.get("generated_at") or 0),
    }


@app.post("/api/sound-effects/library-bootstrap")
async def bootstrap_sound_library(request: SoundLibraryBootstrapRequest):
    if not request.library_path:
        raise HTTPException(status_code=400, detail="缺少音效库路径")
    context = _get_sound_library_context()
    ensured = await asyncio.to_thread(
        ensure_sound_library_scan_cache,
        request.library_path,
        context["max_depth"],
        context["mappings"],
        context["ttl_seconds"],
        bool(request.force_refresh),
        True,
    )
    summary = summarize_sound_library_assets_index(
        request.library_path,
        max_depth=context["max_depth"],
        path_mappings=context["mappings"],
    )
    browse_result = browse_sound_library_assets_index(
        request.library_path,
        max_depth=context["max_depth"],
        path_mappings=context["mappings"],
        query=request.query,
        selected_folder=request.selected_folder,
        forced_tag=request.forced_tag,
        favorite_only=bool(request.favorite_only),
        untagged_only=bool(request.untagged_only),
        sort_mode=request.sort_mode,
        smart_rules=request.smart_rules or {},
        limit=int(request.limit or 120),
        offset=int(request.offset or 0),
    )
    status_info = get_sound_library_index_status(
        request.library_path,
        max_depth=context["max_depth"],
        path_mappings=context["mappings"],
        ttl_seconds=context["ttl_seconds"],
    )
    return {
        "status": "success",
        "library_path": request.library_path,
        "folder_tree": ensured.get("folders") or [],
        "nav_counts": summary.get("nav_counts") or {},
        "top_tags": summary.get("top_tags") or [],
        "items": browse_result.get("items") or [],
        "total": int(browse_result.get("total") or 0),
        "offset": int(browse_result.get("offset") or 0),
        "limit": int(browse_result.get("limit") or 0),
        "has_more": bool(browse_result.get("has_more")),
        "cached": bool(ensured.get("cached")),
        "stale": bool(ensured.get("stale")),
        "refreshing": bool(ensured.get("refreshing")),
        "generated_at": int(ensured.get("generated_at") or 0),
        "status_info": status_info,
    }


@app.post("/api/sound-effects/meta/favorite")
async def set_sound_effect_favorite(request: SoundEffectsMetaFavoriteRequest):
    set_asset_favorite(request.asset_key, request.favorite)
    return {"status": "success"}


@app.post("/api/sound-effects/meta/tag/add")
async def add_sound_effect_tag(request: SoundEffectsMetaTagRequest):
    add_asset_tag(request.asset_key, request.tag)
    return {"status": "success"}


@app.post("/api/sound-effects/meta/tag/remove")
async def remove_sound_effect_tag(request: SoundEffectsMetaTagRequest):
    remove_asset_tag(request.asset_key, request.tag)
    return {"status": "success"}


@app.post("/api/sound-effects/meta/tag/bulk-add")
async def bulk_add_sound_effect_tag(request: SoundEffectsMetaBulkTagRequest):
    asset_keys = _resolve_request_asset_keys(
        asset_keys=request.asset_keys,
        library_path=request.library_path,
        folder_paths=request.folder_paths,
    )
    bulk_add_asset_tag(asset_keys, request.tag)
    return {"status": "success"}


@app.post("/api/sound-effects/meta/tag/bulk-remove")
async def bulk_remove_sound_effect_tag(request: SoundEffectsMetaBulkTagRequest):
    asset_keys = _resolve_request_asset_keys(
        asset_keys=request.asset_keys,
        library_path=request.library_path,
        folder_paths=request.folder_paths,
    )
    bulk_remove_asset_tag(asset_keys, request.tag)
    return {"status": "success"}


@app.get("/api/sound-effects/meta/audio-info")
async def get_audio_file_info(path: str):
    if not path or not os.path.isfile(path):
        raise HTTPException(status_code=400, detail="文件不存在")
    meta = get_audio_file_metadata(path)
    dur = meta.get("duration")
    duration_str = None
    if isinstance(dur, (int, float)) and dur > 0:
        s = int(dur)
        h = s // 3600
        m = (s % 3600) // 60
        sec = s % 60
        if h > 0:
            duration_str = f"{h}:{m:02d}:{sec:02d}"
        else:
            duration_str = f"{m}:{sec:02d}"
    return {
        "status": "success",
        "duration": duration_str,
        "duration_seconds": round(dur, 1) if isinstance(dur, (int, float)) else None,
        "sample_rate": meta.get("sample_rate"),
        "channels": meta.get("channels"),
    }


@app.post("/api/sound-effects/collect")
async def collect_sound_effects_to_project(request: SoundEffectsCollectRequest):
    if not resolve_controller.resolve:
        raise HTTPException(status_code=500, detail="未连接达芬奇")
    resolve_controller._refresh_context()
    project = resolve_controller.project
    if not project:
        raise HTTPException(status_code=500, detail="未检测到达芬奇项目")

    context = resolve_controller.get_project_context(include_media=False)
    local_path = context.get("local_path", "")
    if not local_path:
        raise HTTPException(status_code=500, detail="未设置项目本地路径，请先初始化项目")

    config = load_sound_effects_config()
    subfolder = (config.get("local_target_folder") or config.get("save_subfolder", "音效") or "音效")
    subfolder = str(subfolder).lstrip("/").replace("..", "").replace("\\", "/")
    folder_depth = int(config.get("folder_depth", 1))
    folder_depth_direction = str(config.get("folder_depth_direction", "forward") or "forward")
    mappings = config.get("path_mappings", [])

    # 达芬奇媒体池目标文件夹配置
    davinci_base_folder = (config.get("davinci_archive_folder") or config.get("davinci_folder", "音效") or "音效")
    davinci_base_folder = str(davinci_base_folder).lstrip("/").replace("..", "").replace("\\", "/")

    resolved_keys = _resolve_request_asset_keys(
        asset_keys=request.asset_keys,
        library_path=request.library_path,
        folder_paths=request.folder_paths,
    )

    def _import_to_davinci_media_pool(local_dest_path: str, rel: str):
        """将已复制到本地的音效文件导入达芬奇媒体池并移动到目标文件夹"""
        try:
            mp = resolve_controller.media_pool
            ms = resolve_controller.media_storage
            if not mp or not ms:
                return
            root_folder = mp.GetRootFolder()
            if not root_folder:
                return
            # 计算达芬奇媒体池目标文件夹路径
            target_folder_path = compute_davinci_target_folder(
                rel, davinci_base_folder, folder_depth, direction=folder_depth_direction
            )
            # 导入文件到媒体池
            items = ms.AddItemListToMediaPool([local_dest_path])
            if not items or len(items) == 0:
                return
            media_item = items[0]
            # 创建目标文件夹层级结构
            target_folder = root_folder
            for part in target_folder_path.split("/"):
                if part:
                    target_folder = resolve_controller._get_or_create_davinci_folder(target_folder, part)
            # 移动到目标文件夹
            mp.MoveClips([media_item], target_folder)
            print(f"[SFX collect] 已导入达芬奇媒体池: {local_dest_path} -> {target_folder_path}")
        except Exception as e:
            # 导入达芬奇媒体池失败不影响整体打包结果，仅记录日志
            print(f"[SFX collect] 导入达芬奇媒体池失败: {local_dest_path} -> {e}")

    ok = []
    failed = []
    for k in resolved_keys:
        if "::" not in k:
            failed.append({"asset_key": k, "reason": "asset_key 格式错误"})
            continue
        lib_path, rel = k.split("::", 1)
        actual_root = resolve_mapped_path(lib_path, mappings)
        source_path = os.path.join(actual_root, rel.replace("\\", "/"))
        if not os.path.exists(source_path):
            failed.append({"asset_key": k, "reason": "源文件不存在或不可访问"})
            continue

        try:
            local_dest_path = None
            if rel and folder_depth > 0:
                sub_rel = compute_local_save_subpath(rel, folder_depth, direction=folder_depth_direction)
                dest_dir = os.path.join(local_path, subfolder, os.path.dirname(sub_rel))
                r = copy_sound_to_dest_dir(source_path, dest_dir)
                if r.get("status") != "success":
                    fallback_dir = os.path.join(local_path, subfolder)
                    r = copy_sound_to_dest_dir(source_path, fallback_dir)
                if r.get("status") == "success":
                    local_dest_path = r.get("local_path")
                    ok.append({"asset_key": k, "local_path": local_dest_path})
                else:
                    failed.append({"asset_key": k, "reason": r.get("message", "复制失败")})
            else:
                r = copy_sound_to_project(source_path, local_path, subfolder)
                if r.get("status") == "success":
                    local_dest_path = r.get("local_path")
                    ok.append({"asset_key": k, "local_path": local_dest_path})
                else:
                    failed.append({"asset_key": k, "reason": r.get("message", "复制失败")})

            # 如果本地复制成功，同步导入到达芬奇媒体池
            if local_dest_path and os.path.exists(local_dest_path):
                _import_to_davinci_media_pool(local_dest_path, rel)
        except Exception as e:
            failed.append({"asset_key": k, "reason": str(e)})

    return {"status": "success", "copied": ok, "failed": failed}

@app.post("/api/sound-effects/create-library")
async def create_sound_library(request: SoundEffectCreateLibraryRequest):
    """新建音效库文件夹"""
    if not os.path.isdir(request.parent_path):
        raise HTTPException(status_code=400, detail="父目录不存在或不可访问")

    folder_name = request.folder_name.strip().replace("/", "").replace("\\", "").replace("..", "")
    if not folder_name:
        raise HTTPException(status_code=400, detail="文件夹名称无效")

    new_path = os.path.join(request.parent_path, folder_name)

    if os.path.exists(new_path):
        if os.path.isdir(new_path):
            return {"status": "success", "path": new_path, "message": "文件夹已存在", "created": False}
        else:
            raise HTTPException(status_code=400, detail="该路径已存在同名文件")

    try:
        os.makedirs(new_path, exist_ok=True)
        return {"status": "success", "path": new_path, "message": f"音效库「{folder_name}」已创建", "created": True}
    except PermissionError:
        raise HTTPException(status_code=403, detail="没有权限在该目录下创建文件夹")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"创建文件夹失败: {str(e)}")

@app.post("/api/sound-effects/scan")
async def scan_sound_library_endpoint(request: SoundLibraryScanRequest):
    """扫描音效库文件"""
    config = load_sound_effects_config()
    max_depth = int((config or {}).get("library_scan_depth", 20))
    ttl_seconds = int((config or {}).get("scan_cache_ttl_seconds", 300) or 300)
    mappings = (config or {}).get("path_mappings", [])

    if request.library_path:
        scan_result = await asyncio.to_thread(
            get_sound_library_scan_data,
            request.library_path,
            max_depth,
            mappings,
            ttl_seconds,
            bool(request.force_refresh),
        )
        files = scan_result.get("files") or []
        folders = scan_result.get("folders") or []
        keys = []
        for f in files:
            rel = str(f.get("relative_path") or "")
            keys.append(f"{request.library_path}::{rel}")
        meta_map = get_asset_meta(keys)
        for f in files:
            rel = str(f.get("relative_path") or "")
            k = f"{request.library_path}::{rel}"
            m = meta_map.get(k) or {}
            f["asset_key"] = k
            f["favorite"] = bool(m.get("favorite", False))
            f["tags"] = m.get("tags", [])
            f["used_count"] = int(m.get("used_count", 0))
            f["last_used_at"] = int(m.get("last_used_at", 0))
        return {
            "status": "success",
            "library_path": request.library_path,
            "files": files,
            "folders": folders,
            "total_count": len(files),
            "cached": bool(scan_result.get("cached")),
            "generated_at": int(scan_result.get("generated_at") or 0),
        }
    else:
        all_results = scan_all_libraries(config, force_refresh=bool(request.force_refresh))
        total = sum(len(v) for v in all_results.values())
        return {
            "status": "success",
            "libraries": {k: {"files": v, "count": len(v)} for k, v in all_results.items()},
            "total_count": total,
        }

class PrecomputeWaveformsRequest(BaseModel):
    library_path: str
    samples: int = 160
    limit: int = 0  # 0 = all files
    workers: int = 8

@app.post("/api/sound-effects/precompute-waveforms")
async def precompute_waveforms_endpoint(request: PrecomputeWaveformsRequest, background_tasks: BackgroundTasks):
    """预计算音效库文件的波形峰值（并行），后续浏览秒加载"""
    config = load_sound_effects_config()
    samples = int(request.samples or 160)
    mappings = (config or {}).get("path_mappings", [])
    ttl_seconds = int((config or {}).get("scan_cache_ttl_seconds", 300) or 300)
    max_depth = int((config or {}).get("library_scan_depth", 20))
    waveform_cache_library_dir = str((config or {}).get("waveform_cache_library_dir", ".sfx_cache") or ".sfx_cache")
    waveform_cache_compress = bool((config or {}).get("waveform_cache_compress", True))
    workers = max(1, min(int(getattr(request, 'workers', 0) or 3), 8))

    if not request.library_path:
        raise HTTPException(status_code=400, detail="library_path 必填")

    lib_path = resolve_mapped_path(request.library_path, mappings)
    if not lib_path or not os.path.isdir(lib_path):
        raise HTTPException(status_code=400, detail="音效库路径不存在")

    scan_data = get_sound_library_scan_data(lib_path, max_depth, mappings, ttl_seconds, force_refresh=False)
    files = scan_data.get("files") or []
    if not files:
        return {"status": "success", "precomputed": 0, "total": 0, "message": "没有需要处理的文件"}

    limit = int(getattr(request, 'limit', 0) or 0)
    files_to_process = files if limit <= 0 else files[:limit]
    preview_cache_mb = int((config or {}).get("preview_cache_max_mb", 0))
    sem = asyncio.Semaphore(workers)
    processed_count = [0]
    skipped_count = [0]

    async def _process_one(f):
        rel = str(f.get("relative_path") or "")
        _precompute_state["currentFile"] = rel
        try:
            asset_key = f"{request.library_path}::{rel}"
            full_path = os.path.join(lib_path, rel)
            if not os.path.exists(full_path):
                skipped_count[0] += 1
                return

            mtime_ns, size = _stat_waveform_source(full_path)
            cached = get_waveform_cache_library(asset_key, mtime_ns, size, samples, mappings,
                                                cache_dir_name=waveform_cache_library_dir,
                                                compress=waveform_cache_compress)
            if cached:
                skipped_count[0] += 1
                return

            async with sem:
                result = await _load_or_generate_waveform(
                    full_path, full_path, asset_key, mtime_ns, size, samples,
                    mappings, waveform_cache_library_dir, waveform_cache_compress, preview_cache_mb
                )
                if result.get("cached"):
                    skipped_count[0] += 1
                elif result.get("status") == "success" and isinstance(result.get("data"), list) and result.get("data"):
                    processed_count[0] += 1
                else:
                    skipped_count[0] += 1
        except Exception:
            skipped_count[0] += 1
        finally:
            _precompute_state["done"] = min(int(_precompute_state.get("done") or 0) + 1, len(files_to_process))
            done = int(_precompute_state.get("done") or 0)
            if done % 50 == 0:
                print(f"[waveform-precompute] {done}/{len(files_to_process)} 并行完成...")

    async def _precompute():
        _precompute_state["running"] = True
        _precompute_state["total"] = len(files_to_process)
        _precompute_state["done"] = 0
        _precompute_state["startedAt"] = time.time()
        try:
            try:
                batch_size = workers * 3
                for i in range(0, len(files_to_process), batch_size):
                    batch = files_to_process[i:i + batch_size]
                    await asyncio.gather(*[_process_one(f) for f in batch])
                    await asyncio.sleep(0.1)
            except Exception as e:
                print(f"[waveform-precompute] 异常终止: {e}")
        finally:
            _precompute_state["running"] = False
        print(f"[waveform-precompute] 完成: {processed_count[0]} 个生成, {skipped_count[0]} 个跳过 (共 {len(files_to_process)} 个文件, {workers} 线程)")

    background_tasks.add_task(_precompute)
    return {
        "status": "success",
        "precomputed": 0,
        "total": len(files_to_process),
        "workers": workers,
        "message": f"后台 {workers} 线程并行预计算 {len(files_to_process)} 个文件的波形峰值"
    }

@app.get("/api/sound-effects/precompute-status")
async def get_precompute_status():
    """获取当前预计算进度"""
    state = dict(_precompute_state)
    elapsed = max(time.time() - state.get("startedAt", 0), 0.1)
    speed = state["done"] / elapsed if elapsed > 0 and state["done"] > 0 else 0
    state["speed"] = round(speed, 1)
    return {"status": "success", **state}

@app.get("/api/sound-effects/library-tree")
async def get_library_tree_endpoint(library_path: str):
    """获取音效库文件夹树"""
    if not library_path or not os.path.isdir(library_path):
        raise HTTPException(status_code=400, detail="路径不存在或不可访问")
    config = load_sound_effects_config()
    max_depth = int((config or {}).get("library_scan_depth", 20))
    ttl_seconds = int((config or {}).get("scan_cache_ttl_seconds", 300) or 300)
    mappings = (config or {}).get("path_mappings", [])
    tree = get_library_folder_tree(
        library_path,
        max_depth=max_depth,
        path_mappings=mappings,
        ttl_seconds=ttl_seconds,
    )
    return {"status": "success", "tree": tree}

# We use a Semaphore instead of a Lock to allow concurrent ffmpeg processes (max 10)
# instead of just 1, so it's stay fast but controlled.
_waveform_generation_lock: Optional[asyncio.Semaphore] = None


def _get_waveform_generation_lock() -> asyncio.Semaphore:
    global _waveform_generation_lock
    if _waveform_generation_lock is None:
        _waveform_generation_lock = asyncio.Semaphore(6)
    return _waveform_generation_lock


def _build_waveform_asset_key(mapped_path: str, config: Dict[str, Any], mappings: List[Dict[str, Any]]) -> str:
    asset_key = mapped_path
    lib = (config or {}).get("library_path", "")
    if lib:
        actual_lib = resolve_mapped_path(lib, mappings)
        prefix = actual_lib.rstrip("/") + "/" if actual_lib else ""
        if prefix and mapped_path.startswith(prefix):
            rel = mapped_path[len(prefix):]
            asset_key = f"{lib}::{rel}"
    return asset_key


def _stat_waveform_source(path: str) -> tuple[int, int]:
    try:
        st = os.stat(path)
        return (
            int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1_000_000_000))),
            int(st.st_size),
        )
    except Exception:
        return 0, 0


async def _load_or_generate_waveform(
    raw_path: str,
    mapped_path: str,
    asset_key: str,
    mtime_ns: int,
    size: int,
    samples: int,
    mappings: List[Dict[str, Any]],
    cache_dir_name: str,
    compress: bool,
    preview_cache_mb: int,
) -> Dict[str, Any]:
    cached = get_waveform_cache_library(
        asset_key, mtime_ns, size, samples, mappings,
        cache_dir_name=cache_dir_name, compress=compress
    )
    if cached:
        return cached

    async with _get_waveform_generation_lock():
        cached = get_waveform_cache_library(
            asset_key, mtime_ns, size, samples, mappings,
            cache_dir_name=cache_dir_name, compress=compress
        )
        if cached:
            return cached

        result = await asyncio.to_thread(generate_waveform_data, mapped_path, samples, preview_cache_mb)

    if result.get("status") == "success" and isinstance(result.get("data"), list) and result.get("data"):
        data = result.get("data") or []
        dur = float(result.get("duration") or 0)
        sr = int(result.get("sample_rate") or 0)
        act_samples = int(result.get("samples") or samples)
        set_waveform_cache_library(
            asset_key, mtime_ns, size, act_samples, data, dur, sr,
            mappings, cache_dir_name=cache_dir_name, compress=compress
        )
        return {
            "status": "success",
            "data": data,
            "duration": dur,
            "sample_rate": sr,
            "samples": act_samples,
            "cached": False,
        }

    return {
        "status": "success",
        "data": [],
        "duration": 0,
        "samples": samples,
        "fallback": True,
        "error": result.get("message", "waveform_failed"),
        "source_path": raw_path,
    }

@app.get("/api/sound-effects/waveform")
async def get_sound_waveform(path: str, samples: int = 200):
    """获取音效文件的波形数据"""
    config = load_sound_effects_config()
    mappings = (config or {}).get("path_mappings", [])
    mapped_path = resolve_mapped_path(path, mappings)
    if not mapped_path or not os.path.exists(mapped_path):
        raise HTTPException(status_code=400, detail="文件不存在")

    ext = os.path.splitext(mapped_path)[1].lower()
    if ext not in {'.wav', '.mp3', '.aac', '.m4a', '.flac', '.ogg', '.wma', '.aiff', '.aif'}:
        raise HTTPException(status_code=400, detail="不支持的音频格式")

    mtime_ns, size = _stat_waveform_source(mapped_path)
    asset_key = _build_waveform_asset_key(mapped_path, config, mappings)

    waveform_cache_library_dir = str((config or {}).get("waveform_cache_library_dir", ".sfx_cache") or ".sfx_cache")
    waveform_cache_compress = bool((config or {}).get("waveform_cache_compress", True))
    normalized_samples = min(max(samples, 50), 500)
    preview_cache_mb = int((config or {}).get("preview_cache_max_mb", 0))
    return await _load_or_generate_waveform(
        path, mapped_path, asset_key, mtime_ns, size, normalized_samples,
        mappings, waveform_cache_library_dir, waveform_cache_compress, preview_cache_mb
    )


class BatchWaveformRequest(BaseModel):
    paths: List[str]
    samples: int = 160


@app.post("/api/sound-effects/waveforms/batch")
async def get_sound_waveforms_batch(request: BatchWaveformRequest):
    """批量获取波形数据——对已缓存文件从磁盘秒读，未缓存的现场生成"""
    config = load_sound_effects_config()
    mappings = (config or {}).get("path_mappings", [])
    cache_dir_name = str((config or {}).get("waveform_cache_library_dir", ".sfx_cache") or ".sfx_cache")
    compress = bool((config or {}).get("waveform_cache_compress", True))
    samples = min(max(int(request.samples or 160), 50), 500)
    preview_cache_mb = int((config or {}).get("preview_cache_max_mb", 0))
    batch_limit = 80

    waveforms: Dict[str, Any] = {}
    jobs = []

    for raw_path in list(request.paths or [])[:batch_limit]:
        mapped = resolve_mapped_path(raw_path, mappings)
        if not mapped or not os.path.exists(mapped):
            waveforms[raw_path] = {"status": "error", "message": "文件不存在"}
            continue

        mtime_ns, size = _stat_waveform_source(mapped)
        asset_key = _build_waveform_asset_key(mapped, config, mappings)
        jobs.append((
            raw_path,
            _load_or_generate_waveform(
                raw_path, mapped, asset_key, mtime_ns, size, samples,
                mappings, cache_dir_name, compress, preview_cache_mb
            )
        ))

    if jobs:
        results = await asyncio.gather(*[job for _, job in jobs], return_exceptions=True)
        for (raw_path, _), result in zip(jobs, results):
            if isinstance(result, Exception):
                waveforms[raw_path] = {"status": "error", "message": str(result) or "waveform_failed"}
            else:
                waveforms[raw_path] = result

    return {"status": "success", "waveforms": waveforms}


@app.get("/api/sound-effects/preview")
async def preview_sound_effect(path: str, background_tasks: BackgroundTasks):
    config = load_sound_effects_config()
    mapped_path = resolve_mapped_path(path, (config or {}).get("path_mappings", []))
    if not mapped_path or not os.path.exists(mapped_path):
        raise HTTPException(status_code=400, detail="文件不存在")
    ext = os.path.splitext(mapped_path)[1].lower()
    if ext not in {'.wav', '.mp3', '.aac', '.m4a', '.flac', '.ogg', '.wma', '.aiff', '.aif'}:
        raise HTTPException(status_code=400, detail="不支持的音频格式")

    max_cache_mb = int((config or {}).get("preview_cache_max_mb", 0))
    if ext == ".wav":
        return FileResponse(mapped_path, media_type="audio/wav", filename=os.path.basename(mapped_path), headers={"Content-Disposition": "inline"})

    if max_cache_mb <= 0:
        tools = get_audio_tooling_status()
        if not tools.get("ffmpeg_available"):
            raise HTTPException(status_code=500, detail="需要 ffmpeg 来解码此格式")
        ffmpeg = tools.get("ffmpeg_path") or "ffmpeg"
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp_path = tmp.name
        tmp.close()
        try:
            result = subprocess.run(
                [ffmpeg, "-i", mapped_path, "-ac", "2", "-ar", "44100", "-acodec", "pcm_s16le", "-y", tmp_path],
                capture_output=True,
                timeout=60,
            )
            if result.returncode != 0 or not os.path.exists(tmp_path):
                raise HTTPException(status_code=500, detail="ffmpeg 解码失败")
        except HTTPException:
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except Exception:
                pass
            raise
        except Exception:
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except Exception:
                pass
            raise HTTPException(status_code=500, detail="预览生成失败")

        background_tasks.add_task(os.remove, tmp_path)
        return FileResponse(tmp_path, media_type="audio/wav", filename=os.path.basename(tmp_path), headers={"Content-Disposition": "inline"})

    preview = ensure_preview_wav(mapped_path, sample_rate=44100, max_cache_mb=max_cache_mb)
    if preview.get("status") != "success":
        raise HTTPException(status_code=500, detail=preview.get("message", "预览生成失败"))

    preview_path = preview["path"]
    return FileResponse(preview_path, media_type="audio/wav", filename=os.path.basename(preview_path), headers={"Content-Disposition": "inline"})


@app.get("/api/sound-effects/raw")
async def raw_sound_effect(request: Request, path: str):
    config = load_sound_effects_config()
    mapped_path = resolve_mapped_path(path, (config or {}).get("path_mappings", []))
    if not mapped_path or not os.path.exists(mapped_path):
        raise HTTPException(status_code=400, detail="文件不存在")
    ext = os.path.splitext(mapped_path)[1].lower()
    media_type = {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".aac": "audio/aac",
        ".aiff": "audio/aiff",
        ".aif": "audio/aiff",
        ".flac": "audio/flac",
        ".ogg": "audio/ogg",
        ".wma": "audio/x-ms-wma",
    }.get(ext, "application/octet-stream")

    size = os.path.getsize(mapped_path)
    range_header = request.headers.get("range") or request.headers.get("Range")
    if not range_header:
        return FileResponse(mapped_path, media_type=media_type, filename=os.path.basename(mapped_path), headers={"Content-Disposition": "inline", "Accept-Ranges": "bytes"})

    if not range_header.startswith("bytes="):
        return FileResponse(mapped_path, media_type=media_type, filename=os.path.basename(mapped_path), headers={"Content-Disposition": "inline", "Accept-Ranges": "bytes"})

    spec = range_header.replace("bytes=", "", 1).strip()
    if "," in spec:
        spec = spec.split(",", 1)[0].strip()
    start_s, end_s = (spec.split("-", 1) + [""])[:2]
    start = int(start_s) if start_s else None
    end = int(end_s) if end_s else None
    if start is None and end is None:
        return FileResponse(mapped_path, media_type=media_type, filename=os.path.basename(mapped_path), headers={"Content-Disposition": "inline", "Accept-Ranges": "bytes"})
    if start is None:
        length = min(size, end)
        start = max(0, size - length)
        end = size - 1
    elif end is None or end >= size:
        end = size - 1
    if start < 0 or start > end:
        raise HTTPException(status_code=416, detail="Range 不合法")

    def iterfile():
        with open(mapped_path, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        "Content-Range": f"bytes {start}-{end}/{size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(end - start + 1),
        "Content-Disposition": "inline",
    }
    return StreamingResponse(iterfile(), status_code=206, media_type=media_type, headers=headers)


@app.get("/api/sound-effects/diagnostics")
async def sound_effects_diagnostics():
    config = load_sound_effects_config()
    stats = _preview_cache_stats()
    lib = (config or {}).get("library_path", "")
    cache_dir_name = str((config or {}).get("waveform_cache_library_dir", ".sfx_cache") or ".sfx_cache")
    wstats = get_sound_library_cache_stats(lib, cache_dir_name=cache_dir_name) if lib else {"waveform_cache_bytes": 0, "waveform_cache_files": 0}
    return {
        "status": "success",
        "tools": get_audio_tooling_status(),
        "preview_cache": {
            "dir": stats.get("dir"),
            "count": stats.get("count", 0),
            "size_mb": round(float(stats.get("bytes", 0)) / (1024 * 1024), 2),
            "max_mb": int((config or {}).get("preview_cache_max_mb", 0)),
        },
        "waveform_cache": {
            "count": int(wstats.get("waveform_cache_files", 0)),
            "size_mb": round(float(wstats.get("waveform_cache_bytes", 0)) / (1024 * 1024), 2),
            "max_mb": int((config or {}).get("waveform_cache_max_mb", 128)),
        },
    }


@app.post("/api/sound-effects/preview-cache/clear")
async def clear_sound_effects_preview_cache():
    clear_preview_cache()
    return {"status": "success"}


@app.post("/api/sound-effects/waveform-cache/clear")
async def clear_sound_effects_waveform_cache():
    """删除所有波形缓存（库内文件）"""
    config = load_sound_effects_config()
    result = clear_waveform_cache(config)
    return {"status": "success", "result": result}


@app.get("/api/sound-effects/cache-stats")
async def get_sound_effects_cache_stats(library_path: str = ""):
    """获取波形缓存磁盘用量"""
    config = load_sound_effects_config()
    lib = library_path or (config or {}).get("library_path", "")
    if not lib or not os.path.isdir(lib):
        return {"status": "success", "waveform_cache_bytes": 0, "waveform_cache_files": 0}
    cache_dir_name = str((config or {}).get("waveform_cache_library_dir", ".sfx_cache") or ".sfx_cache")
    stats = get_sound_library_cache_stats(lib, cache_dir_name=cache_dir_name)
    return {"status": "success", **stats}


@app.post("/api/sound-effects/press")
async def sound_effect_press(request: SoundEffectPressRequest):
    """
    音效按下：
    1. 计算并创建项目内本地副本
    2. 采集当前时间线音频轨道快照
    3. 返回 session_id 和 local_copy_path
    """
    if not resolve_controller.resolve:
        raise HTTPException(status_code=500, detail="未连接达芬奇")

    try:
        resolve_controller._refresh_context()
        project = resolve_controller.project
        if not project:
            raise HTTPException(status_code=500, detail="未检测到达芬奇项目")

        # 获取项目本地路径
        context = resolve_controller.get_project_context(include_media=False)
        local_path = context.get("local_path", "")
        if not local_path:
            raise HTTPException(status_code=500, detail="未设置项目本地路径，请先初始化项目")

        io_range = _normalize_sound_effect_io_range(request.in_point, request.out_point)

        # 1. 计算项目本地文件夹路径
        config = load_sound_effects_config()
        subfolder = (config.get("local_target_folder") or config.get("save_subfolder", "音效") or "音效")
        subfolder = str(subfolder).lstrip("/").replace("..", "").replace("\\", "/")
        folder_depth = config.get("folder_depth", 1)
        folder_depth_direction = str(request.folder_depth_direction or config.get("folder_depth_direction", "forward") or "forward")
        mappings = config.get("path_mappings", [])

        asset_key = ""
        lib = config.get("library_path", "")
        if lib:
            actual_lib = resolve_mapped_path(lib, mappings)
            prefix = actual_lib.rstrip("/") + "/"
            if request.source_path.startswith(prefix):
                rel = request.source_path[len(prefix):]
                asset_key = f"{lib}::{rel}"

        filename = os.path.basename(request.source_path)
        dest_dir = os.path.join(local_path, subfolder)
        if request.source_relative_path and folder_depth > 0:
            # 使用层级映射保存
            sub_path = compute_local_save_subpath(request.source_relative_path, folder_depth, direction=folder_depth_direction)
            dest_dir = os.path.join(local_path, subfolder, os.path.dirname(sub_path))
            
        dest_path = os.path.join(dest_dir, filename)

        # 2. 采集时间线快照
        timeline = resolve_controller._get_active_timeline()
        fps = resolve_controller.get_project_frame_rate()
        before_snapshot = snapshot_audio_tracks(timeline, fps) if timeline else {"timestamp": 0, "tracks": [], "total_clips": 0}

        before_media_pool = _snapshot_all_media_pool_folders(resolve_controller.media_pool)

        # 3. 复制到项目本地路径
        session_id = str(uuid.uuid4())[:8]
        project_name = project.GetName() or "unknown"

        print(f"[SFX press] session={session_id} source={request.source_path} dest_dir={dest_dir}")
        _append_sfx_drag_log("press_start", {
            "session_id": session_id,
            "source_path": request.source_path,
            "source_relative_path": request.source_relative_path,
            "drag_source": request.drag_source,
            "drag_probe_path": request.drag_probe_path,
            "drag_probe_name": request.drag_probe_name,
            "drag_probe_token": request.drag_probe_token,
            "dest_dir": dest_dir,
            "before_snapshot": before_snapshot,
            "before_media_pool": before_media_pool,
            "io_range": io_range,
        })

        copy_result = copy_sound_to_dest_dir(request.source_path, dest_dir, target_filename=filename)

        print(f"[SFX press] copy_result status={copy_result.get('status')} "
              f"need_client_copy={copy_result.get('need_client_copy')} "
              f"local_path={copy_result.get('local_path')}")
        _append_sfx_drag_log("press_copy_result", {
            "session_id": session_id,
            "copy_result": copy_result,
        })

        if copy_result.get("need_client_copy"):
            # Python 进程无权限，让前端通过 Tauri 原生 API 完成文件操作
            client_params = copy_result.get("client_copy_params", {})
            client_source = client_params.get("source_path") or request.source_path
            client_dest_dir = client_params.get("dest_dir") or dest_dir
            client_dest_path = client_params.get("dest_path") or dest_path
            client_filename = client_params.get("filename") or os.path.basename(client_source)

            # 如果目标文件已存在且内容相同，无需复制
            if client_params.get("status") == "reuse":
                session_payload = {
                    "source_path": request.source_path,
                    "source_basename": os.path.basename(request.source_path or ""),
                    "drag_probe_path": str(request.drag_probe_path or ""),
                    "drag_probe_name": str(request.drag_probe_name or ""),
                    "drag_probe_token": str(request.drag_probe_token or ""),
                    "local_copy_path": client_dest_path,
                    "filename": client_filename,
                    "before_snapshot": before_snapshot,
                    "before_media_pool": before_media_pool,
                    "project_name": project_name,
                    "source_relative_path": request.source_relative_path,
                    "asset_key": asset_key,
                    "in_point": io_range["in_point"],
                    "out_point": io_range["out_point"],
                    "has_io_range": io_range["has_io_range"],
                    "drag_source": str(request.drag_source or "detail_button"),
                    "created_at": time.time(),
                    "copy_status": "reuse",
                    "media_id": "",
                    "media_name": "",
                    "media_path": "",
                }
                _sound_sessions[session_id] = session_payload
                return {
                    "status": "success",
                    "session_id": session_id,
                    "local_copy_path": client_dest_path,
                    "filename": client_filename,
                    "media_id": "",
                    "message": client_params.get("message") or f"已复用项目内副本: {client_dest_path}",
                }

            _sound_sessions[session_id] = {
                "source_path": request.source_path,
                "source_basename": os.path.basename(request.source_path or ""),
                "drag_probe_path": str(request.drag_probe_path or ""),
                "drag_probe_name": str(request.drag_probe_name or ""),
                "drag_probe_token": str(request.drag_probe_token or ""),
                "local_copy_path": client_dest_path,
                "filename": client_filename,
                "before_snapshot": before_snapshot,
                "before_media_pool": before_media_pool,
                "project_name": project_name,
                "source_relative_path": request.source_relative_path,
                "asset_key": asset_key,
                "in_point": io_range["in_point"],
                "out_point": io_range["out_point"],
                "has_io_range": io_range["has_io_range"],
                "drag_source": str(request.drag_source or "detail_button"),
                "created_at": time.time(),
                "copy_status": "pending_client",
                "pending_client_copy": True,
                "media_id": "",
                "media_name": "",
                "media_path": "",
            }

            return {
                "status": "success",
                "session_id": session_id,
                "need_client_copy": True,
                "filename": client_filename,
                "client_copy_params": {
                    "source_path": client_source,
                    "dest_dir": client_dest_dir,
                    "dest_path": client_dest_path,
                    "filename": client_filename,
                },
                "message": "需要应用内完成文件复制，请稍候...",
            }

        if copy_result.get("status") != "success":
            raise HTTPException(status_code=500, detail=copy_result.get("message") or "复制项目内音效副本失败")
        local_copy_path = copy_result.get("local_path") or dest_path
        filename = copy_result.get("filename") or os.path.basename(local_copy_path) or filename

        # 4. 生成 session
        session_payload = {
            "source_path": request.source_path,
            "source_basename": os.path.basename(request.source_path or ""),
            "drag_probe_path": str(request.drag_probe_path or ""),
            "drag_probe_name": str(request.drag_probe_name or ""),
            "drag_probe_token": str(request.drag_probe_token or ""),
            "local_copy_path": local_copy_path,
            "filename": filename,
            "before_snapshot": before_snapshot,
            "before_media_pool": before_media_pool,
            "project_name": project_name,
            "source_relative_path": request.source_relative_path,
            "asset_key": asset_key,
            "in_point": io_range["in_point"],
            "out_point": io_range["out_point"],
            "has_io_range": io_range["has_io_range"],
            "drag_source": str(request.drag_source or "detail_button"),
            "created_at": time.time(),
            "copy_status": copy_result.get("status"),
            "media_id": "",
            "media_name": "",
            "media_path": "",
        }
        _sound_sessions[session_id] = session_payload

        return {
            "status": "success",
            "session_id": session_id,
            "local_copy_path": local_copy_path,
            "filename": filename,
            "media_id": "",
            "message": copy_result.get("message") or f"「{filename}」已复制到项目文件夹，请在达芬奇中拖入时间线",
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"操作失败: {str(e)}")


class SoundEffectPressConfirmRequest(BaseModel):
    session_id: str
    local_copy_path: str


@app.post("/api/sound-effects/press/confirm")
async def sound_effect_press_confirm(request: SoundEffectPressConfirmRequest):
    """
    确认客户端（Tauri）已完成文件复制，更新 session 中的文件路径。
    前端在通过 Tauri 原生 API 完成 mkdir + copy 后调用此接口。
    """
    session = _sound_sessions.get(request.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在或已过期")

    if not session.get("pending_client_copy"):
        raise HTTPException(status_code=400, detail="该会话不需要客户端复制确认")

    if not request.local_copy_path:
        raise HTTPException(status_code=400, detail="缺少 local_copy_path")

    print(f"[SFX press/confirm] session={request.session_id} local_copy_path={request.local_copy_path} exists={os.path.exists(request.local_copy_path)}")

    session["local_copy_path"] = request.local_copy_path
    session["filename"] = os.path.basename(request.local_copy_path)
    session["copy_status"] = "success"
    session["pending_client_copy"] = False

    return {
        "status": "success",
        "session_id": request.session_id,
        "local_copy_path": request.local_copy_path,
        "filename": session["filename"],
        "media_id": "",
        "message": f"「{session['filename']}」已复制到项目文件夹，请在达芬奇中拖入时间线",
    }


@app.post("/api/sound-effects/insert-to-timeline")
async def sound_effect_insert_to_timeline(request: SoundEffectInsertRequest):
    """
    一键插入时间线：
    1. 计算目标路径
    2. 本地文件不存在 → 复制源文件到项目本地目录（存在则复用）
    3. insert_audio_segment_to_timeline 统一负责媒体池查重+导入+插入
    4. 归档到指定达芬奇文件夹
    5. 记录使用统计
    """
    if not resolve_controller.resolve:
        raise HTTPException(status_code=500, detail="未连接达芬奇")

    try:
        resolve_controller._refresh_context()
        project = resolve_controller.project
        media_pool = resolve_controller.media_pool
        if not project or not media_pool:
            raise HTTPException(status_code=500, detail="未检测到达芬奇项目")

        # 1. 获取项目本地路径
        context = resolve_controller.get_project_context(include_media=False)
        local_path = context.get("local_path", "")
        if not local_path:
            raise HTTPException(status_code=500, detail="未设置项目本地路径，请先初始化项目")

        # 2. 计算目标路径
        config = load_sound_effects_config()
        mappings = (config or {}).get("path_mappings", [])
        subfolder = (config.get("local_target_folder") or config.get("save_subfolder", "音效") or "音效")
        subfolder = str(subfolder).lstrip("/").replace("..", "").replace("\\", "/")

        asset_key = ""
        lib = config.get("library_path", "")
        if lib:
            actual_lib = resolve_mapped_path(lib, mappings)
            prefix = actual_lib.rstrip("/") + "/"
            if request.source_path.startswith(prefix):
                rel = request.source_path[len(prefix):]
                asset_key = f"{lib}::{rel}"

        dest_dir = os.path.join(local_path, subfolder)
        source_relative_path = request.source_relative_path or ""
        folder_depth = config.get("folder_depth", 1)
        folder_depth_direction = str(config.get("folder_depth_direction", "forward") or "forward")
        if source_relative_path and folder_depth > 0:
            sub_path = compute_local_save_subpath(source_relative_path, folder_depth, direction=folder_depth_direction)
            dest_dir = os.path.join(local_path, subfolder, os.path.dirname(sub_path))

        filename = os.path.basename(request.source_path)
        dest_path = os.path.join(dest_dir, filename)

        # 3. 确保本地有文件（copy_sound_to_dest_dir 内部检测同内容复用，不创建 _1 后缀）
        os.makedirs(dest_dir, exist_ok=True)
        copy_result = copy_sound_to_dest_dir(request.source_path, dest_dir, target_filename=filename)
        if copy_result.get("need_client_copy"):
            client_params = copy_result.get("client_copy_params", {})
            local_copy_path = client_params.get("dest_path") or dest_path
        elif copy_result.get("status") in ("success", "reuse"):
            local_copy_path = copy_result.get("local_path") or dest_path
        else:
            raise HTTPException(status_code=500, detail=copy_result.get("message") or "复制文件失败")

        print(f"[SFX insert-to-timeline] source={request.source_path} local_copy={local_copy_path}")

        # 4. 插入时间线（内部统一查重、导入、智能轨道选择）
        result = resolve_controller.insert_audio_segment_to_timeline(
            local_copy_path,
            in_point=request.in_point,
            out_point=request.out_point,
            track_index=0,
        )
        if result.get("status") != "success":
            raise HTTPException(status_code=500, detail=result.get("message", "插入失败"))

        # 5. 媒体池归档（按路径查找刚导入/已存在的素材）
        davinci_base_folder = (config.get("davinci_archive_folder") or config.get("davinci_folder", "音效") or "音效")
        davinci_base_folder = str(davinci_base_folder).lstrip("/").replace("..", "").replace("\\", "/")

        target_folder_path = compute_davinci_target_folder(
            source_relative_path, davinci_base_folder, folder_depth, direction=folder_depth_direction
        )

        root_folder = media_pool.GetRootFolder()
        media_item = resolve_controller._find_media_item_by_path(root_folder, local_copy_path)
        if not media_item:
            media_item = resolve_controller._find_media_item(root_folder, filename)

        moved = False
        if media_item:
            try:
                media_item.ReplaceClip(local_copy_path)
            except Exception as e:
                print(f"[SFX insert] ReplaceClip 失败: {local_copy_path} -> {e}")

            try:
                target_folder = root_folder
                for part in target_folder_path.split("/"):
                    if part:
                        target_folder = resolve_controller._get_or_create_davinci_folder(target_folder, part)
                move_result = media_pool.MoveClips([media_item], target_folder)
                moved = bool(move_result)
            except Exception:
                pass

        # 6. 记录使用统计
        if asset_key:
            try:
                increment_asset_used(asset_key, 1)
            except Exception:
                pass

        return {
            "status": "success",
            "local_copy_path": local_copy_path,
            "track_index": result.get("trackIndex"),
            "record_frame": result.get("recordFrame"),
            "start_frame": result.get("startFrame"),
            "end_frame": result.get("endFrame"),
            "moved_to_folder": target_folder_path,
            "moved": moved,
            "message": f"已插入到轨道 {result.get('trackIndex')}，播放头位置",
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"插入时间线失败: {str(e)}")


@app.post("/api/sound-effects/release")
async def sound_effect_release(request: SoundEffectReleaseRequest):
    """
    音效释放：
    1. 采集释放后的时间线快照
    2. 对比前后快照，判断音效是否被实际使用
    3. 如果使用 → 找到媒体池当前文件夹中的该音效，移动到指定文件夹
    4. 如果未使用 → 删除本地副本
    """
    session = _sound_sessions.get(request.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在或已过期")

    try:
        resolve_controller._refresh_context()
        timeline = resolve_controller._get_active_timeline()
        fps = resolve_controller.get_project_frame_rate()

        filename = session["filename"]
        before = session["before_snapshot"]

        local_copy_path = session["local_copy_path"]
        source_path = str(session.get("source_path") or "")
        drag_probe_path = str(session.get("drag_probe_path") or "")
        drag_probe_name = str(session.get("drag_probe_name") or "")
        drag_probe_token = str(session.get("drag_probe_token") or "")
        session_media_id = str(session.get("media_id") or "").strip()
        local_basename = os.path.basename(local_copy_path) if local_copy_path else filename
        local_no_ext = os.path.splitext(local_basename)[0]
        source_basename = os.path.basename(session.get("source_basename") or source_path or "")
        source_no_ext = os.path.splitext(source_basename)[0] if source_basename else ""
        drag_probe_no_ext = os.path.splitext(drag_probe_name)[0] if drag_probe_name else ""
        candidates = {local_basename, local_no_ext, source_basename, source_no_ext, drag_probe_name, drag_probe_no_ext}
        candidates = {c for c in candidates if c}
        exact_paths = {
            os.path.normpath(p)
            for p in (local_copy_path, source_path, drag_probe_path)
            if p
        }
        probe_tokens = {drag_probe_token} if drag_probe_token else set()
        preferred_media_ids = {session_media_id} if session_media_id else set()
        io_range = _normalize_sound_effect_io_range(
            session.get("in_point"),
            session.get("out_point"),
        )

        # 1. 采集释放后的快照；对带 IO 的拖拽做短轮询，等待达芬奇真正落到时间线
        after_snapshot = snapshot_audio_tracks(timeline, fps) if timeline else {"timestamp": 0, "tracks": [], "total_clips": 0}
        timeline_match = _match_new_timeline_audio_clip(
            before,
            after_snapshot,
            exact_paths,
            candidates,
            probe_tokens,
            preferred_media_ids,
        )
        if io_range["has_io_range"] and timeline_match.get("matched_clip") is None:
            after_snapshot, timeline_match = await _wait_for_new_timeline_audio_clip(
                before_snapshot=before,
                exact_paths=exact_paths,
                candidate_names=candidates,
                probe_tokens=probe_tokens,
                preferred_media_ids=preferred_media_ids,
                fps=fps,
                attempts=7,
                delay_seconds=0.25,
            )

        # 2. 对比：检查时间线上/媒体池是否新增该音效
        before_paths = {
            os.path.basename(clip.get("clip_path") or "")
            for clip in _iter_snapshot_audio_clips(before)
            if clip.get("clip_path")
        }
        after_paths = {
            os.path.basename(clip.get("clip_path") or "")
            for clip in _iter_snapshot_audio_clips(after_snapshot)
            if clip.get("clip_path")
        }
        matched_timeline_clip = timeline_match.get("matched_clip")
        used_on_timeline = matched_timeline_clip is not None

        before_mp = session.get("before_media_pool") or {"count": 0, "paths": []}
        after_mp = _snapshot_all_media_pool_folders(resolve_controller.media_pool)
        before_mp_paths = set(before_mp.get("paths") or [])
        after_mp_paths = set(after_mp.get("paths") or [])
        new_mp_paths = after_mp_paths - before_mp_paths
        used_in_media_pool = any((x in candidates) or (os.path.splitext(x)[0] in candidates) for x in new_mp_paths)

        is_used = bool(used_on_timeline or used_in_media_pool)
        trim_applied = False
        trim_error = ""
        trim_result = None

        print(f"[SFX release] session={request.session_id} filename={filename} "
              f"used_on_timeline={used_on_timeline} used_in_media_pool={used_in_media_pool} "
              f"is_used={is_used} local_copy={local_copy_path} "
              f"before_tl={len(before_paths)} after_tl={len(after_paths)} new_tl={len(timeline_match.get('new_clips') or [])} "
              f"before_mp={len(before_mp_paths)} after_mp={len(after_mp_paths)} new_mp={len(new_mp_paths)} "
              f"match_attempt={timeline_match.get('attempt')} fallback_unique={timeline_match.get('fallback_unique')} "
              f"candidates={candidates}")
        _append_sfx_drag_log("release_match", {
            "session_id": request.session_id,
            "filename": filename,
            "source_path": source_path,
            "local_copy_path": local_copy_path,
            "drag_probe_path": drag_probe_path,
            "drag_probe_name": drag_probe_name,
            "drag_probe_token": drag_probe_token,
            "session_media_id": session_media_id,
            "used_on_timeline": used_on_timeline,
            "used_in_media_pool": used_in_media_pool,
            "is_used": is_used,
            "match_attempt": timeline_match.get("attempt"),
            "fallback_unique": timeline_match.get("fallback_unique"),
            "before_snapshot": before,
            "after_snapshot": after_snapshot,
            "new_timeline_clips": timeline_match.get("new_clips") or [],
            "matched_timeline_clip": matched_timeline_clip,
            "before_media_pool": before_mp,
            "after_media_pool": after_mp,
            "new_media_pool_paths": list(new_mp_paths),
            "candidates": sorted(list(candidates)),
            "io_range": io_range,
        })
        if timeline_match.get("new_clips"):
            try:
                print(f"[SFX release] new_timeline_clips={json.dumps(timeline_match.get('new_clips') or [], ensure_ascii=False)}")
            except Exception:
                print(f"[SFX release] new_timeline_clips={timeline_match.get('new_clips')}")
        if matched_timeline_clip:
            try:
                print(f"[SFX release] matched_timeline_clip={json.dumps(matched_timeline_clip, ensure_ascii=False)}")
            except Exception:
                print(f"[SFX release] matched_timeline_clip={matched_timeline_clip}")

        if is_used:
            asset_key = session.get("asset_key", "")
            if asset_key:
                increment_asset_used(asset_key, 1)

            if used_on_timeline and io_range["has_io_range"]:
                if timeline_match.get("ambiguous"):
                    trim_error = "ambiguous_clip_match"
                elif matched_timeline_clip:
                    trim_result = resolve_controller.replace_dropped_audio_with_trimmed_segment(
                        file_path=local_copy_path,
                        track_index=int(matched_timeline_clip.get("track_index") or 1),
                        record_frame=int(matched_timeline_clip.get("start_frame") or 0),
                        dropped_start_frame=int(matched_timeline_clip.get("start_frame") or 0),
                        dropped_end_frame=int(matched_timeline_clip.get("end_frame") or 0),
                        in_point=io_range["in_point"],
                        out_point=io_range["out_point"],
                        source_path_hint=drag_probe_path or source_path,
                        source_media_id=session_media_id or matched_timeline_clip.get("media_id"),
                    )
                    if trim_result.get("status") == "success" and trim_result.get("trim_applied"):
                        trim_applied = True
                    else:
                        trim_error = trim_result.get("message") or "io_trim_failed"

            # 3a. 已使用 → 将媒体池当前文件夹中的该音效移动到指定文件夹
            config = load_sound_effects_config()
            davinci_base_folder = (config.get("davinci_archive_folder") or config.get("davinci_folder", "音效") or "音效")
            davinci_base_folder = str(davinci_base_folder).lstrip("/").replace("..", "").replace("\\", "/")
            folder_depth = config.get("folder_depth", 1)
            folder_depth_direction = str(config.get("folder_depth_direction", "forward") or "forward")
            source_relative_path = session.get("source_relative_path", "")

            # 计算目标文件夹（根据层级深度）
            target_folder_path = compute_davinci_target_folder(
                source_relative_path, davinci_base_folder, folder_depth, direction=folder_depth_direction
            )

            media_pool = resolve_controller.media_pool
            root_folder = media_pool.GetRootFolder()

            media_item = None
            relink_lookup = "none"
            if session_media_id:
                try:
                    media_item = resolve_controller._find_media_item_by_media_id(root_folder, session_media_id)
                    if media_item:
                        relink_lookup = "session_media_id"
                except Exception:
                    media_item = None
            if drag_probe_path:
                try:
                    media_item = resolve_controller._find_media_item_by_path(root_folder, drag_probe_path)
                    if media_item and not relink_lookup.startswith("session_media_id"):
                        relink_lookup = "probe_path"
                except Exception:
                    media_item = None
            try:
                if not media_item:
                    media_item = resolve_controller._find_media_item_by_path(root_folder, local_copy_path)
                    if media_item:
                        relink_lookup = "local_copy_path"
            except Exception:
                media_item = media_item or None
            if not media_item and drag_probe_name:
                try:
                    media_item = resolve_controller._find_media_item(root_folder, drag_probe_name)
                    if media_item:
                        relink_lookup = "probe_name"
                except Exception:
                    media_item = None
            if not media_item:
                try:
                    media_item = resolve_controller._find_media_item(root_folder, local_basename)
                    if media_item:
                        relink_lookup = "local_basename"
                except Exception:
                    media_item = None
            if not media_item and source_basename:
                try:
                    media_item = resolve_controller._find_media_item(root_folder, source_basename)
                    if media_item:
                        relink_lookup = "source_basename"
                except Exception:
                    media_item = None

            moved = False
            relinked = False
            relink_error = ""
            relink_target_path = ""
            relink_target_name = ""
            relink_target_media_id = ""
            if media_item:
                try:
                    relink_target_path = media_item.GetClipProperty("File Path") or ""
                except Exception:
                    relink_target_path = ""
                try:
                    relink_target_name = media_item.GetName() or ""
                except Exception:
                    relink_target_name = ""
                try:
                    relink_target_media_id = media_item.GetMediaId() or ""
                except Exception:
                    relink_target_media_id = ""
                # 替换为本地路径，解决拖拽原始路径导致的问题
                if local_copy_path and os.path.exists(local_copy_path):
                    try:
                        media_item.ReplaceClip(local_copy_path)
                        relinked = True
                    except Exception as e:
                        relink_error = str(e)
                        print(f"[SFX] ReplaceClip 失败: {local_copy_path} -> {e}")

                # 创建目标文件夹路径
                target_folder = root_folder
                for part in target_folder_path.split("/"):
                    if part:
                        target_folder = resolve_controller._get_or_create_davinci_folder(target_folder, part)

                try:
                    move_result = media_pool.MoveClips([media_item], target_folder)
                    moved = bool(move_result)
                except Exception:
                    pass
            print(
                f"[SFX release] relink_lookup={relink_lookup} relinked={relinked} "
                f"relink_target_name={relink_target_name} relink_target_path={relink_target_path} "
                f"relink_target_media_id={relink_target_media_id} trim_applied={trim_applied} trim_error={trim_error}"
            )
            _append_sfx_drag_log("release_relink", {
                "session_id": request.session_id,
                "relink_lookup": relink_lookup,
                "relinked": relinked,
                "relink_error": relink_error,
                "relink_target_name": relink_target_name,
                "relink_target_path": relink_target_path,
                "relink_target_media_id": relink_target_media_id,
                "session_media_id": session_media_id,
                "trim_applied": trim_applied,
                "trim_error": trim_error,
                "trim_result": trim_result,
                "moved": moved,
                "target_folder_path": target_folder_path,
            })

            # 清理 session
            _sound_sessions.pop(request.session_id, None)

            return {
                "status": "success",
                "action": "used",
                "filename": filename,
                "moved_to_folder": target_folder_path,
                "moved": moved,
                "relinked": relinked,
                "relink_error": relink_error,
                "relink_lookup": relink_lookup,
                "relink_target_path": relink_target_path,
                "relink_target_name": relink_target_name,
                "relink_target_media_id": relink_target_media_id,
                "trim_applied": trim_applied,
                "trim_error": trim_error,
                "trim_result": trim_result,
                "local_copy_path": local_copy_path,
                "message": (
                    f"「{filename}」已使用，已重定向到项目内副本并移动到媒体池「{target_folder_path}」"
                    if relinked
                    else f"「{filename}」已使用，已移动到媒体池「{target_folder_path}」"
                ),
            }
        else:
            # 3b. 未检测到使用 → 删除媒体池条目 + 本地副本 + 清理空目录
            media_deleted = False
            media_delete_error = ""
            mp_item = None
            try:
                mp = resolve_controller.media_pool
                if mp:
                    root_folder = mp.GetRootFolder()
                    if session_media_id:
                        try:
                            mp_item = resolve_controller._find_media_item_by_media_id(root_folder, session_media_id)
                        except Exception:
                            mp_item = None
                    if not mp_item:
                        try:
                            mp_item = resolve_controller._find_media_item_by_path(root_folder, local_copy_path)
                        except Exception:
                            mp_item = None
                    if not mp_item:
                        try:
                            mp_item = resolve_controller._find_media_item(root_folder, local_basename)
                        except Exception:
                            mp_item = None
                    if mp_item:
                        try:
                            mp.DeleteClips([mp_item])
                            media_deleted = True
                        except Exception as e:
                            media_delete_error = str(e)
            except Exception as e:
                media_delete_error = str(e)

            delete_result = delete_local_sound_file(local_copy_path)
            print(f"[SFX] 未检测到音效使用，已删除本地副本: {local_copy_path} (status: {delete_result.get('status')})"
                  f" media_deleted={media_deleted} media_delete_error={media_delete_error}")

            if delete_result.get("status") == "success":
                _remove_empty_parent_dirs(local_copy_path)

            _sound_sessions.pop(request.session_id, None)
            _append_sfx_drag_log("release_deleted", {
                "session_id": request.session_id,
                "filename": filename,
                "local_copy_path": local_copy_path,
                "drag_probe_path": drag_probe_path,
                "delete_result": delete_result.get("status"),
                "media_deleted": media_deleted,
                "media_delete_error": media_delete_error,
            })

            return {
                "status": "success",
                "action": "deleted",
                "filename": filename,
                "delete_result": delete_result.get("status"),
                "media_deleted": media_deleted,
                "media_delete_error": media_delete_error,
                "message": f"「{filename}」未使用，已自动删除本地副本",
            }

    except HTTPException:
        _append_sfx_drag_log("release_http_exception", {
            "session_id": request.session_id,
        })
        raise
    except Exception as e:
        _append_sfx_drag_log("release_exception", {
            "session_id": request.session_id,
            "error": str(e),
        })
        _sound_sessions.pop(request.session_id, None)
        raise HTTPException(status_code=500, detail=f"释放处理失败: {str(e)}")


@app.get("/api/clip-import/status")
async def clip_import_status():
    return clip_import_manager.get_status()


@app.post("/api/clip-import/toggle")
async def clip_import_toggle(request: Request):
    body = await request.json()
    enabled = body.get("enabled", False)
    return clip_import_manager.toggle(enabled)


@app.get("/api/clip-import/settings")
async def clip_import_get_settings():
    return {
        "config": clip_import_manager.config,
    }


@app.post("/api/clip-import/settings")
async def clip_import_save_settings(request: Request):
    body = await request.json()
    return clip_import_manager.update_settings(body)


@app.delete("/api/clip-import/history")
async def clip_import_clear_history():
    return clip_import_manager.clear_history()


@app.get("/api/clip-import/local-folders")
async def clip_import_local_folders():
    return {"folders": clip_import_manager.list_local_folders()}


@app.get("/api/clip-import/davinci-folders")
async def clip_import_davinci_folders():
    return {"folders": clip_import_manager.list_davinci_folders()}


if __name__ == "__main__":
    import uvicorn
    from port_utils import find_available_port
    env_port = os.environ.get("APP_BACKEND_PORT", "")
    if env_port:
        port = int(env_port)
    else:
        port = find_available_port()
        print(f"APP_BACKEND_PORT not set, auto-selected port {port}")
    uvicorn.run(app, host="127.0.0.1", port=port, reload=False)
