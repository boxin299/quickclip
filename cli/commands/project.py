"""project — 项目管理。"""
import os

import typer

from cli.base import get_client, get_json
from cli.base import output, print_error

project_app = typer.Typer(no_args_is_help=True)


@project_app.command("context")
def project_context():
    """获取当前项目详情（时间线列表、媒体池等）。"""
    client = get_client()
    use_json = get_json()
    result = client.get("/api/project/context")
    if result.get("error"):
        print_error(str(result["error"]), use_json)
    output(result, use_json=use_json)


@project_app.command("list")
def project_list():
    """列出所有项目。"""
    client = get_client()
    use_json = get_json()
    status = client.get("/api/status")
    if status.get("error"):
        print_error(str(status["error"]), use_json)

    project_name = status.get("project") or status.get("project_name")
    backups = status.get("backups") or status.get("backup_projects", [])

    projects = []
    if project_name:
        projects.append({"name": project_name, "active": True})
    for b in backups:
        name = b if isinstance(b, str) else b.get("name", str(b))
        if name and name != project_name:
            projects.append({"name": name, "active": False})

    if use_json:
        output({"projects": projects}, use_json=True)
    else:
        if not projects:
            print("(无项目)")
        else:
            for p in projects:
                marker = " *" if p["active"] else ""
                print(f"  {p['name']}{marker}")


@project_app.command("create")
def project_create(
    name: str = typer.Option(..., "--name", "-n", help="项目名称"),
    local_path: str = typer.Option(..., "--path", "-p", help="本地项目路径"),
):
    """创建新项目。"""
    if not name.strip():
        print_error("项目名称不能为空", get_json())
    if not local_path.strip():
        print_error("本地项目路径不能为空", get_json())
    if not os.path.isdir(local_path):
        print_error(f"路径不存在: {local_path}", get_json())

    client = get_client()
    use_json = get_json()
    result = client.post("/api/project/create", body={
        "project_name": name.strip(),
        "local_path": local_path,
    })
    if result.get("error"):
        print_error(str(result["error"]), use_json)
    output(result, use_json=use_json)


@project_app.command("switch")
def project_switch(
    name: str = typer.Argument(..., help="目标项目名称（请在达芬奇中先打开该项目）"),
):
    """切换活动项目（通过重新连接达芬奇当前项目）。"""
    if not name.strip():
        print_error("项目名称不能为空", get_json())

    client = get_client()
    use_json = get_json()
    result = client.post("/api/reconnect")
    if result.get("error"):
        print_error(str(result["error"]), use_json)
    output(result, use_json=use_json)
