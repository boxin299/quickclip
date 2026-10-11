"""timeline — 时间线操作。"""
import json
from typing import Optional

import typer

from cli.base import get_client, get_json
from cli.base import output, print_error

timeline_app = typer.Typer(no_args_is_help=True)


@timeline_app.command("current")
def timeline_current():
    """查看当前活动时间线。"""
    client = get_client()
    use_json = get_json()
    result = client.get("/api/timeline/current")
    if result.get("error"):
        print_error(str(result["error"]), use_json)
    output(result, use_json=use_json)


@timeline_app.command("list")
def timeline_list():
    """列出项目中所有时间线。"""
    client = get_client()
    use_json = get_json()
    result = client.get("/api/project/context")
    if result.get("error"):
        print_error(str(result["error"]), use_json)
    timelines = []
    ctx = result.get("context")
    if isinstance(ctx, dict):
        timelines = ctx.get("timelines", [])
    if use_json:
        output({"timelines": timelines}, use_json=True)
    else:
        if not timelines:
            print("(无时间线)")
        else:
            for t in timelines:
                print(f"  {t}")


@timeline_app.command("generate")
def timeline_generate(
    segments_file: str = typer.Option(
        ..., "--segments", "-s", help="文稿 segments JSON 文件路径"
    ),
    video_path: str = typer.Option(
        ..., "--video", "-v", help="媒体文件路径"
    ),
):
    """从转录文稿生成时间线 JSON 并调用达芬奇剪辑。"""
    client = get_client()
    use_json = get_json()

    try:
        with open(segments_file, "r", encoding="utf-8") as f:
            segments = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print_error(f"无法读取文稿文件: {e}", use_json)

    if not isinstance(segments, list):
        print_error("文稿文件应为 segments 数组", use_json)

    result = client.post("/api/timeline/generate", body={
        "video_path": video_path,
        "segments": segments,
    })
    if result.get("status") == "success":
        output(result["timeline"], use_json=use_json)
    else:
        msg = result.get("detail") or result.get("error") or result.get("message") or "生成时间线失败"
        print_error(str(msg), use_json)


@timeline_app.command("apply")
def timeline_apply(
    segments_file: str = typer.Option(
        ..., "--segments", "-s", help="文稿 segments JSON 文件路径"
    ),
    method: str = typer.Option(
        "new_timeline", "--method", "-m",
        help="应用方式: new_timeline / append / inplace_main / inplace_all",
    ),
    target: Optional[str] = typer.Option(
        None, "--target", "-t", help="目标时间线名称（new_timeline 时为新时间线名）",
    ),
    frame_rate: float = typer.Option(24.0, "--fps", help="帧率"),
    source_type: str = typer.Option("file", "--source-type", help="来源类型: file / timeline"),
    clip_mapping_file: Optional[str] = typer.Option(
        None, "--clip-mapping", help="时间码映射 JSON 文件路径（source_type=timeline 时需要）"
    ),
    merge_gap: float = typer.Option(0.5, "--merge-gap", help="原位模式合并删除区间的间隙阈值（秒）"),
):
    """应用时间线编辑到 DaVinci Resolve。"""
    client = get_client()
    use_json = get_json()

    try:
        with open(segments_file, "r", encoding="utf-8") as f:
            segments = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print_error(f"无法读取文稿文件: {e}", use_json)

    if not isinstance(segments, list):
        print_error("文稿文件应为 segments 数组", use_json)

    clip_mapping = None
    if clip_mapping_file:
        try:
            with open(clip_mapping_file, "r", encoding="utf-8") as f:
                clip_mapping = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError) as e:
            print_error(f"无法读取时间码映射文件: {e}", use_json)

    body = {
        "segments": segments,
        "apply_method": method,
        "source_type": source_type,
        "frame_rate": frame_rate,
        "merge_gap_seconds": merge_gap,
    }
    if clip_mapping:
        body["clip_mapping"] = clip_mapping
    if target and method == "new_timeline":
        body["timeline_name"] = target

    result = client.post("/api/timeline/apply-edit", body=body, timeout=120.0)
    if result.get("error"):
        print_error(str(result["error"]), use_json)
    output(result, use_json=use_json)


@timeline_app.command("select")
def timeline_select(
    segments_file: str = typer.Option(
        ..., "--segments", "-s", help="文稿 segments JSON 文件路径"
    ),
    keep: Optional[str] = typer.Option(
        None, "--keep", "-k", help="保留索引范围，如 '0-5,8,10-15'"
    ),
    keep_speaker: Optional[str] = typer.Option(
        None, "--keep-speaker", help="保留指定说话人编号，如 '0,1'"
    ),
    out_file: Optional[str] = typer.Option(
        None, "--out", "-o", help="输出文件路径（默认输出到 stdout）"
    ),
):
    """选中/筛选需要的 Talking 片段（通过 bold 标记）。"""
    use_json = get_json()

    try:
        with open(segments_file, "r", encoding="utf-8") as f:
            segments = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print_error(f"无法读取文稿文件: {e}", use_json)

    if not isinstance(segments, list):
        print_error("文稿文件应为 segments 数组", use_json)

    selected = segments

    if keep:
        indices = set()
        for part in keep.split(","):
            part = part.strip()
            if not part:
                continue
            try:
                if "-" in part:
                    a, b = part.split("-", 1)
                    indices.update(range(int(a.strip()), int(b.strip()) + 1))
                else:
                    indices.add(int(part))
            except ValueError:
                print_error(f"无效的索引范围: {part}", use_json)
        selected = [s for i, s in enumerate(segments) if i in indices]

    if keep_speaker:
        try:
            speakers = {int(x.strip()) for x in keep_speaker.split(",") if x.strip()}
            selected = [s for s in selected if s.get("speaker") in speakers]
        except ValueError as e:
            print_error(f"无效的说话人编号: {e}", use_json)

    for s in selected:
        s["bold"] = True

    result = json.dumps(selected, ensure_ascii=False, indent=2)
    if out_file:
        with open(out_file, "w", encoding="utf-8") as f:
            f.write(result)
        output({"file": out_file, "count": len(selected)}, use_json=use_json)
    else:
        output(selected, use_json=use_json)


@timeline_app.command("create")
def timeline_create(
    name: str = typer.Option(..., "--name", "-n", help="新时间线名称"),
):
    """创建新时间线并命名。"""
    client = get_client()
    use_json = get_json()

    result = client.post("/api/project/create", body={
        "project_name": name,
        "local_path": "",
    })
    if result.get("error"):
        print_error(str(result["error"]), use_json)
    output(result, use_json=use_json)
