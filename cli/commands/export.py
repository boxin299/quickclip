"""export — 导出渲染。"""
from typing import Optional

import typer

from cli.base import get_client, get_json
from cli.base import output, print_error

export_app = typer.Typer(no_args_is_help=True)


@export_app.command("render")
def export_render(
    target_dir: str = typer.Option(..., "--dir", "-d", help="导出目录"),
    file_name: str = typer.Option(..., "--name", "-n", help="文件名模板"),
    preset: Optional[str] = typer.Option(None, "--preset", "-p", help="导出预设名称"),
    timeline: Optional[str] = typer.Option(None, "--timeline", "-t", help="指定时间线名（默认当前）"),
    use_subfolder: bool = typer.Option(False, "--subfolder", help="使用子文件夹"),
    subfolder_name: Optional[str] = typer.Option(None, "--subfolder-name", help="子文件夹名称"),
):
    """渲染导出视频。"""
    client = get_client()
    use_json = get_json()

    body = {
        "target_dir": target_dir,
        "file_name_template": file_name,
        "preset_name": preset,
        "timeline_name": timeline,
        "use_subfolder": use_subfolder,
        "subfolder_name": subfolder_name,
    }

    result = client.post("/api/export/render", body=body, timeout=300.0)
    if result.get("error"):
        print_error(str(result["error"]), use_json)
    output(result, use_json=use_json)


@export_app.command("backup")
def export_backup(
    file_name: str = typer.Option(..., "--name", "-n", help="文件名模板"),
    timeline: Optional[str] = typer.Option(None, "--timeline", "-t", help="指定时间线名"),
    use_subfolder: bool = typer.Option(False, "--subfolder", help="使用子文件夹"),
    subfolder_name: Optional[str] = typer.Option(None, "--subfolder-name", help="子文件夹名称"),
):
    """仅备份项目文件（不渲染）。"""
    client = get_client()
    use_json = get_json()

    body = {
        "target_dir": "",
        "file_name_template": file_name,
        "timeline_name": timeline,
        "use_subfolder": use_subfolder,
        "subfolder_name": subfolder_name,
    }

    result = client.post("/api/export/backup-only", body=body, timeout=120.0)
    if result.get("error"):
        print_error(str(result["error"]), use_json)
    output(result, use_json=use_json)


@export_app.command("presets")
def export_presets():
    """列出可用导出预设。"""
    client = get_client()
    use_json = get_json()
    result = client.get("/api/export/presets")
    if result.get("error"):
        print_error(str(result["error"]), use_json)
    if use_json:
        output(result, use_json=True)
    else:
        presets = result.get("presets", [])
        if not presets:
            print("(无导出预设)")
        else:
            for p in presets:
                print(f"  {p}")
