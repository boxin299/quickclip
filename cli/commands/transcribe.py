"""transcribe — 转录媒体文件为文字稿。"""
import typer

from cli.base import get_client, get_json
from cli.base import output, print_error

transcribe_app = typer.Typer(no_args_is_help=True)


@transcribe_app.command("start")
def transcribe_start(
    path: str = typer.Option(..., "--path", "-p", help="本地媒体文件路径"),
):
    """上传/指定媒体文件并转录。"""
    client = get_client()
    use_json = get_json()

    if not path.strip():
        print_error("请提供有效的媒体文件路径", use_json)

    result = client.post("/api/transcribe/path", params={"video_path": path}, timeout=600.0)
    if result.get("status") == "success":
        output(result["transcript"], use_json=use_json)
    else:
        msg = result.get("detail") or result.get("error") or result.get("message") or "转录失败"
        print_error(str(msg), use_json)


@transcribe_app.command("status")
def transcribe_status(
    transcript_id: str = typer.Argument(..., help="转录项目 ID"),
):
    """查看转录进度/结果。"""
    client = get_client()
    use_json = get_json()

    result = client.get(f"/api/transcript/projects/{transcript_id}")
    if result.get("error"):
        print_error(str(result["error"]), use_json)
    output(result, use_json=use_json)
