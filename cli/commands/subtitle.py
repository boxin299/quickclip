"""subtitle — 字幕编辑。"""
import json
import os
from typing import Optional

import typer

from cli.base import get_client, get_json
from cli.base import output, print_error

subtitle_app = typer.Typer(no_args_is_help=True)


@subtitle_app.command("fetch")
def subtitle_fetch():
    """从 DaVinci Resolve 拉取现有字幕。"""
    client = get_client()
    use_json = get_json()
    result = client.get("/api/subtitle/fetch-from-resolve")
    if result.get("error"):
        print_error(str(result["error"]), use_json)
    output(result, use_json=use_json)


@subtitle_app.command("transcribe")
def subtitle_transcribe(
    path: Optional[str] = typer.Option(
        None, "--path", "-p", help="媒体文件路径（本地文件转录）"
    ),
    language: str = typer.Option("zh", "--lang", "-l", help="语言代码"),
    transcript_id: Optional[str] = typer.Option(
        None, "--id", help="已有转录项目 ID（跳过转录直接使用缓存）"
    ),
    hotwords: Optional[str] = typer.Option(
        None, "--hotwords", help="热词列表，逗号分隔"
    ),
    out_file: Optional[str] = typer.Option(
        None, "--out", "-o", help="将转录结果保存到文件"
    ),
):
    """对时间线音频执行转录。"""
    client = get_client()
    use_json = get_json()

    if transcript_id:
        result = client.get(f"/api/transcript/projects/{transcript_id}")
        if result.get("error"):
            print_error(str(result["error"]), use_json)
        if out_file:
            with open(out_file, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
            output({"file": out_file}, use_json=use_json)
        else:
            output(result, use_json=use_json)
        return

    if not path:
        print_error("请指定 --path 或 --id", use_json)

    body = {
        "video_path": path,
        "language": language,
        "source_type": "file",
        "original_filename": os.path.basename(path),
        "frame_rate": 24.0,
    }
    if hotwords:
        body["hotwords"] = [w.strip() for w in hotwords.split(",") if w.strip()]

    result = client.post("/api/subtitle/transcribe", body=body, timeout=600.0)
    if result.get("error"):
        print_error(str(result["error"]), use_json)

    if out_file:
        with open(out_file, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        output({"file": out_file}, use_json=use_json)
    else:
        output(result, use_json=use_json)


@subtitle_app.command("optimize")
def subtitle_optimize(
    input_file: str = typer.Option(
        ..., "--input", "-i", help="字幕文本文件路径"
    ),
    api_key: str = typer.Option(..., "--api-key", help="AI API 密钥"),
    base_url: str = typer.Option("https://api.poixe.com/v1", "--base-url", help="AI API 地址"),
    model: str = typer.Option("gpt-5-mini:free", "--model", "-m", help="AI 模型"),
    enable_typo: bool = typer.Option(True, "--typo/--no-typo", help="启用错别字修正"),
    enable_break: bool = typer.Option(True, "--break/--no-break", help="启用断句优化"),
    enable_noun: bool = typer.Option(True, "--noun/--no-noun", help="启用专有名词识别"),
    proper_nouns: Optional[str] = typer.Option(
        None, "--proper-nouns", help="专有名词列表，逗号分隔"
    ),
    out_file: Optional[str] = typer.Option(
        None, "--out", "-o", help="输出文件路径"
    ),
):
    """AI 优化字幕文本。"""
    client = get_client()
    use_json = get_json()

    try:
        with open(input_file, "r", encoding="utf-8") as f:
            subtitle_text = f.read()
    except OSError as e:
        print_error(f"无法读取字幕文件: {e}", use_json)

    body = {
        "subtitle_text": subtitle_text,
        "api_key": api_key,
        "base_url": base_url,
        "model": model,
        "enable_typo_fix": enable_typo,
        "enable_sentence_break": enable_break,
        "enable_proper_noun": enable_noun,
        "proper_nouns": [n.strip() for n in proper_nouns.split(",") if n.strip()] if proper_nouns else [],
    }

    result = client.post("/api/subtitle/ai-optimize", body=body, timeout=120.0)
    if result.get("error"):
        print_error(str(result["error"]), use_json)

    if out_file:
        with open(out_file, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        output({"file": out_file}, use_json=use_json)
    else:
        output(result, use_json=use_json)


@subtitle_app.command("insert")
def subtitle_insert(
    segments_file: str = typer.Option(
        ..., "--segments", "-s", help="字幕 segments JSON 文件路径"
    ),
):
    """将字幕插入 DaVinci Resolve 时间线。"""
    client = get_client()
    use_json = get_json()

    try:
        with open(segments_file, "r", encoding="utf-8") as f:
            segments = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print_error(f"无法读取字幕文件: {e}", use_json)

    if not isinstance(segments, list):
        print_error("字幕文件应为 segments 数组", use_json)

    result = client.post("/api/subtitle/insert-timeline", body={"segments": segments})
    if result.get("error"):
        print_error(str(result["error"]), use_json)
    output(result, use_json=use_json)
