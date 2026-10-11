"""QuickClip CLI — DaVinci Resolve 文本驱动剪辑命令行工具。"""
import os
import sys
from typing import Optional

# 确保项目根目录在 sys.path 中（支持 python cli/main.py 和 python -m cli 两种启动方式）
_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

import typer

from cli.base import APIClient, output, print_error, get_backend_url, set_json, set_backend, get_client, get_json

app = typer.Typer(
    name="quickclip",
    help="QuickClip CLI — DaVinci Resolve 文本驱动剪辑工具",
    no_args_is_help=True,
)


@app.callback()
def main(
    ctx: typer.Context,
    json_output: bool = typer.Option(
        False, "--json", help="以 JSON 格式输出（供 AI agent 使用）",
    ),
    backend: str = typer.Option(
        None, "--backend", help="后端地址（默认 http://localhost:8000）",
    ),
    api_key: Optional[str] = typer.Option(
        None, "--api-key", help="API 认证密钥",
    ),
):
    set_json(json_output)
    set_backend(backend or get_backend_url())
    if api_key:
        os.environ["QC_API_KEY"] = api_key
    ctx.ensure_object(dict)
    ctx.obj["json"] = json_output
    ctx.obj["backend"] = backend or get_backend_url()


# ── 注册子命令组 ──────────────────────────────

# 子命令模块延迟导入（放在文件底部以避免 Typer 装饰器尚未注册时的循环依赖）
from cli.commands.transcribe import transcribe_app
from cli.commands.timeline import timeline_app
from cli.commands.project import project_app
from cli.commands.subtitle import subtitle_app
from cli.commands.export import export_app

app.add_typer(transcribe_app, name="transcribe", help="转录媒体文件为文字稿")
app.add_typer(timeline_app, name="timeline", help="时间线操作")
app.add_typer(project_app, name="project", help="项目管理")
app.add_typer(subtitle_app, name="subtitle", help="字幕编辑")
app.add_typer(export_app, name="export", help="导出渲染")


def entry():
    """pip install -e . 后的 console_scripts 入口"""
    app()


if __name__ == "__main__":
    entry()
