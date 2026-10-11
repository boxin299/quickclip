"""
转录项目缓存管理模块
负责转录项目的持久化存储、读取和删除
"""

import os
import json
import shutil
import tempfile
from typing import List, Dict, Any, Optional
from pathlib import Path
from datetime import datetime
import platform


_resolved_root: Optional[Path] = None


def _build_candidates() -> List[Path]:
    candidates = []
    if platform.system() == "Darwin":
        candidates.append(Path(os.path.expanduser("~/.quickclip/opt")))
        candidates.append(Path(os.path.expanduser("~/Library/Caches/QuickClip/opt")))
        candidates.append(Path(os.path.expanduser("~/Movies/QuickClip/opt")))
        candidates.append(Path(tempfile.gettempdir()) / "quickclip" / "opt")
    elif platform.system() == "Windows":
        candidates.append(Path(os.environ.get("APPDATA", "~")) / "QuickClip" / "opt")
        candidates.append(Path(tempfile.gettempdir()) / "quickclip" / "opt")
    else:
        candidates.append(Path(os.path.expanduser("~/.quickclip/opt")))
        candidates.append(Path(tempfile.gettempdir()) / "quickclip" / "opt")
    return candidates


def _resolve_storage_root() -> Path:
    global _resolved_root
    if _resolved_root is not None:
        return _resolved_root

    last_error = None
    for candidate in _build_candidates():
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            test_file = candidate / ".write_test"
            with open(test_file, "w", encoding="utf-8") as f:
                f.write("ok")
            test_file.unlink(missing_ok=True)
            _resolved_root = candidate
            print(f"[INFO] 使用存储根目录: {candidate}")
            return candidate
        except Exception as e:
            last_error = e
            continue

    raise RuntimeError(f"无法创建可写的存储目录: {last_error}")


def _ensure_storage_root() -> Path:
    return _resolve_storage_root()


def _safe_name(name: str) -> str:
    return name.replace("/", "_").replace("\\", "_") if name else "default"


def get_cache_dir(project_name: str) -> Path:
    """获取指定达芬奇项目的缓存目录"""
    root = _ensure_storage_root()
    return root / _safe_name(project_name) / "transcripts"


def get_audio_export_dir(project_name: str, transcription_project_name: str) -> Path:
    root = _ensure_storage_root()
    return root / _safe_name(transcription_project_name) / "audio"


def get_transcript_dir(project_name: str, transcript_id: str) -> Path:
    """获取指定转录项目的目录"""
    return get_cache_dir(project_name) / transcript_id


def list_transcript_projects(project_name: str) -> List[Dict[str, Any]]:
    """
    列出当前达芬奇项目的所有转录项目
    
    Returns:
        转录项目列表，按创建时间降序排列
    """
    cache_dir = get_cache_dir(project_name)
    if not cache_dir.exists():
        return []
    
    projects = []
    for d in cache_dir.iterdir():
        if d.is_dir():
            metadata_path = d / "metadata.json"
            if metadata_path.exists():
                try:
                    with open(metadata_path, "r", encoding="utf-8") as f:
                        metadata = json.load(f)
                    projects.append(metadata)
                except Exception:
                    pass
    
    # 按创建时间降序排列
    projects.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return projects


def list_all_transcript_projects() -> List[Dict[str, Any]]:
    """
    列出所有达芬奇项目下的所有转录项目

    Returns:
        转录项目列表，每个项目包含 davinci_project 字段标识所属达芬奇项目
    """
    root = _ensure_storage_root()
    if not root.exists():
        return []

    all_projects = []
    for project_dir in root.iterdir():
        if not project_dir.is_dir():
            continue
        davinci_project = project_dir.name
        transcripts_dir = project_dir / "transcripts"
        if not transcripts_dir.exists():
            continue
        for d in transcripts_dir.iterdir():
            if d.is_dir():
                metadata_path = d / "metadata.json"
                if metadata_path.exists():
                    try:
                        with open(metadata_path, "r", encoding="utf-8") as f:
                            metadata = json.load(f)
                        metadata["davinci_project"] = davinci_project
                        all_projects.append(metadata)
                    except Exception:
                        pass

    all_projects.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return all_projects


def find_transcript_project(transcript_id: str) -> Optional[Dict[str, Any]]:
    """
    跨所有达芬奇项目查找指定转录项目的完整数据
    返回数据中包含 davinci_project 字段
    """
    root = _ensure_storage_root()
    if not root.exists():
        return None

    for project_dir in root.iterdir():
        if not project_dir.is_dir():
            continue
        transcripts_dir = project_dir / "transcripts"
        if not transcripts_dir.exists():
            continue
        tdir = transcripts_dir / transcript_id
        if not tdir.exists():
            continue

        result = {}
        metadata_path = tdir / "metadata.json"
        if metadata_path.exists():
            with open(metadata_path, "r", encoding="utf-8") as f:
                result["metadata"] = json.load(f)
        transcript_path = tdir / "transcript.json"
        if transcript_path.exists():
            with open(transcript_path, "r", encoding="utf-8") as f:
                result["transcript"] = json.load(f)
        mapping_path = tdir / "clip_mapping.json"
        if mapping_path.exists():
            with open(mapping_path, "r", encoding="utf-8") as f:
                result["clip_mapping"] = json.load(f)

        if result:
            result["metadata"]["davinci_project"] = project_dir.name
            return result

    return None


def get_transcript_project(project_name: str, transcript_id: str) -> Optional[Dict[str, Any]]:
    """获取指定转录项目的完整数据"""
    tdir = get_transcript_dir(project_name, transcript_id)
    if not tdir.exists():
        return None
    
    result = {}
    
    # 读取元数据
    metadata_path = tdir / "metadata.json"
    if metadata_path.exists():
        with open(metadata_path, "r", encoding="utf-8") as f:
            result["metadata"] = json.load(f)
    
    # 读取转录结果
    transcript_path = tdir / "transcript.json"
    if transcript_path.exists():
        with open(transcript_path, "r", encoding="utf-8") as f:
            result["transcript"] = json.load(f)
    
    # 读取时间码映射表
    mapping_path = tdir / "clip_mapping.json"
    if mapping_path.exists():
        with open(mapping_path, "r", encoding="utf-8") as f:
            result["clip_mapping"] = json.load(f)
    
    return result if result else None


def save_transcript_project(
    project_name: str,
    transcript_id: str,
    metadata: Dict[str, Any],
    transcript: Dict[str, Any],
    clip_mapping: Optional[List[Dict]] = None,
    audio_path: Optional[str] = None,
) -> Dict[str, Any]:
    """
    保存转录项目到缓存目录
    
    Args:
        project_name: 达芬奇项目名
        transcript_id: 转录项目 ID
        metadata: 元数据（名称、来源类型等）
        transcript: 转录结果
        clip_mapping: 时间码映射表（时间线源时）
        audio_path: 渲染的音频文件路径（将被复制到缓存目录）
    
    Returns:
        完整的元数据（包含文件路径信息）
    """
    tdir = get_transcript_dir(project_name, transcript_id)
    tdir.mkdir(parents=True, exist_ok=True)
    
    # 保存转录结果
    with open(tdir / "transcript.json", "w", encoding="utf-8") as f:
        json.dump(transcript, f, ensure_ascii=False, indent=2)
    
    # 保存时间码映射表
    if clip_mapping:
        with open(tdir / "clip_mapping.json", "w", encoding="utf-8") as f:
            json.dump(clip_mapping, f, ensure_ascii=False, indent=2)
    
    # 复制音频文件到缓存目录
    rendered_audio_path = None
    if audio_path and os.path.exists(audio_path):
        ext = os.path.splitext(audio_path)[1]
        dest = str(tdir / f"audio_rendered{ext}")
        shutil.copy2(audio_path, dest)
        rendered_audio_path = dest
    
    # 更新元数据
    metadata["id"] = transcript_id
    metadata["files"] = {
        "transcript": "transcript.json",
        "clip_mapping": "clip_mapping.json" if clip_mapping else None,
        "audio_render": os.path.basename(rendered_audio_path) if rendered_audio_path else None,
    }
    metadata["has_clip_mapping"] = clip_mapping is not None and len(clip_mapping) > 0
    
    with open(tdir / "metadata.json", "w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)
    
    return metadata


def update_transcript_project_segments(
    project_name: str,
    transcript_id: str,
    segments: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """更新已保存转录项目的字幕 segments，并同步元数据。"""
    tdir = get_transcript_dir(project_name, transcript_id)
    if not tdir.exists():
        raise FileNotFoundError(f"转录项目不存在: {transcript_id}")

    transcript_path = tdir / "transcript.json"
    metadata_path = tdir / "metadata.json"

    transcript: Dict[str, Any] = {}
    if transcript_path.exists():
        with open(transcript_path, "r", encoding="utf-8") as f:
            transcript = json.load(f)
    transcript["segments"] = segments

    with open(transcript_path, "w", encoding="utf-8") as f:
        json.dump(transcript, f, ensure_ascii=False, indent=2)

    metadata: Dict[str, Any] = {}
    if metadata_path.exists():
        with open(metadata_path, "r", encoding="utf-8") as f:
            metadata = json.load(f)
    metadata["id"] = transcript_id
    metadata["segment_count"] = len(segments)
    metadata["updated_at"] = datetime.now().isoformat()

    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)

    return metadata


def delete_transcript_project(project_name: str, transcript_id: str) -> bool:
    """删除整个转录项目（包括所有文件）"""
    tdir = get_transcript_dir(project_name, transcript_id)
    if tdir.exists():
        shutil.rmtree(tdir)
        return True
    return False


def delete_transcript_audio(project_name: str, transcript_id: str) -> bool:
    """仅删除渲染的音频文件，保留转录记录"""
    tdir = get_transcript_dir(project_name, transcript_id)
    if not tdir.exists():
        return False
    
    deleted = False
    for f in tdir.iterdir():
        if f.name.startswith("audio_rendered"):
            f.unlink()
            deleted = True
    
    # 更新元数据
    metadata_path = tdir / "metadata.json"
    if metadata_path.exists() and deleted:
        with open(metadata_path, "r", encoding="utf-8") as f:
            metadata = json.load(f)
        if "files" in metadata:
            metadata["files"]["audio_render"] = None
        with open(metadata_path, "w", encoding="utf-8") as f:
            json.dump(metadata, f, ensure_ascii=False, indent=2)
    
    return deleted


def delete_all_cache(project_name: Optional[str] = None) -> int:
    """
    删除缓存
    
    Args:
        project_name: 指定项目则只删除该项目的缓存，None 则删除全部
    
    Returns:
        删除的目录数量
    """
    if project_name:
        cache_dir = get_cache_dir(project_name)
        if cache_dir.exists():
            shutil.rmtree(cache_dir)
            return 1
        return 0
    else:
        count = 0
        root = _ensure_storage_root()
        if root.exists():
            for d in root.iterdir():
                if d.is_dir():
                    shutil.rmtree(d)
                    count += 1
        return count


def generate_transcript_id(source_name: str) -> str:
    """生成转录项目 ID（基于时间戳+来源名）"""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_name = "".join(c if c.isalnum() or c in "_-" else "_" for c in source_name)[:30]
    return f"{timestamp}_{safe_name}"
