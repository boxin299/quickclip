#!/usr/bin/env python3
"""
QuickClip 管理后台 CLI 工具
─────────────────────────────
供 AI Agent 自动管理激活码和销售相关操作。

认证方式（二选一）：
  1. 环境变量 QC_API_KEY  (推荐，AI Agent 用)
  2. 环境变量 QC_ADMIN_EMAIL + QC_ADMIN_PASSWORD

服务器地址：
  环境变量 QC_API_URL  (默认: http://124.220.21.242:8000)

用法示例：
  export QC_API_KEY="qc_sk-xxxxx"
  export QC_API_URL="http://124.220.21.242:8000"

  python3 tools/admin_cli.py generate-code --plan lifetime --note "VIP客户" --order "ORD-2026-001"
  python3 tools/admin_cli.py list-codes --status active
  python3 tools/admin_cli.py list-codes --search "张三"
  python3 tools/admin_cli.py get-code QC-ABCD-EFGH-IJKL
  python3 tools/admin_cli.py update-code QC-ABCD-EFGH-IJKL --note "已发货" --order "ORD-001"
  python3 tools/admin_cli.py delete-code QC-ABCD-EFGH-IJKL
  python3 tools/admin_cli.py list-users
  python3 tools/admin_cli.py bind-code USER_ID --code QC-ABCD-EFGH-IJKL
  python3 tools/admin_cli.py unbind-code USER_ID --code QC-ABCD-EFGH-IJKL
  python3 tools/admin_cli.py sales-stats
  python3 tools/admin_cli.py create-api-key --name "AutoSalesAgent"
  python3 tools/admin_cli.py list-api-keys
  python3 tools/admin_cli.py delete-api-key KEY_ID
"""

import argparse
import json
import os
import sys
from typing import Optional
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode


def get_env(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


def api_request(method: str, path: str, body: dict = None, params: dict = None) -> dict:
    """发送 API 请求，自动处理认证。"""
    base = get_env("QC_API_URL", "http://124.220.21.242:8000").rstrip("/")
    url = f"{base}{path}"
    if params:
        qs = urlencode({k: v for k, v in params.items() if v})
        if qs:
            url += "?" + qs

    headers = {"Content-Type": "application/json", "Accept": "application/json"}

    # 认证方式 1: API Key
    api_key = get_env("QC_API_KEY")
    if api_key:
        headers["X-API-Key"] = api_key
    else:
        # 认证方式 2: 管理员登录 -> Bearer Token
        admin_token = _get_admin_token(base)
        if admin_token:
            headers["Authorization"] = f"Bearer {admin_token}"

    data = json.dumps(body).encode("utf-8") if body else None
    req = Request(url, data=data, headers=headers, method=method)

    try:
        with urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        try:
            err_body = json.loads(e.read().decode("utf-8"))
        except Exception:
            err_body = {}
        detail = err_body.get("detail", {})
        if isinstance(detail, dict):
            msg = detail.get("message", str(e))
        else:
            msg = str(detail or e)
        print(f"❌ 请求失败 [{e.code}]: {msg}", file=sys.stderr)
        sys.exit(1)
    except URLError as e:
        print(f"❌ 无法连接服务器: {e.reason}", file=sys.stderr)
        print(f"   请确认 QC_API_URL 正确且后端服务正在运行", file=sys.stderr)
        sys.exit(1)


# ── Admin Token 缓存 ──────────────────────────

_admin_token_cache: Optional[str] = None


def _get_admin_token(base_url: str) -> Optional[str]:
    global _admin_token_cache
    if _admin_token_cache:
        return _admin_token_cache
    email = get_env("QC_ADMIN_EMAIL")
    password = get_env("QC_ADMIN_PASSWORD")
    if not email or not password:
        return None
    body = json.dumps({"email": email, "password": password}).encode("utf-8")
    req = Request(f"{base_url}/api/admin/login", data=body,
                  headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            _admin_token_cache = data.get("admin_token", "")
            return _admin_token_cache
    except Exception:
        return None


# ── 格式化输出 ────────────────────────────────

def print_json(data):
    print(json.dumps(data, ensure_ascii=False, indent=2))


def print_table(rows: list, columns: list):
    """简单表格输出。"""
    if not rows:
        print("(无数据)")
        return
    # 计算列宽
    widths = {}
    for col_key, col_label in columns:
        widths[col_key] = len(col_label)
    for row in rows:
        for col_key, _ in columns:
            val = str(row.get(col_key, "") or "")
            widths[col_key] = max(widths[col_key], len(val[:60]))
    # 表头
    header = "  ".join(lbl.ljust(widths[key]) for key, lbl in columns)
    sep = "  ".join("-" * widths[key] for key, _ in columns)
    print(header)
    print(sep)
    for row in rows:
        line = "  ".join(str(row.get(key, "") or "")[:60].ljust(widths[key]) for key, _ in columns)
        print(line)
    print(f"\n共 {len(rows)} 条记录")


# ── 子命令实现 ────────────────────────────────

def cmd_generate(args):
    """生成激活码"""
    body = {
        "plan": args.plan,
        "duration_days": args.days,
        "max_devices": args.devices,
        "note": args.note or "",
        "order_number": args.order or "",
    }
    result = api_request("POST", "/api/admin/activation-codes/generate", body)
    print_json(result)


def cmd_list_codes(args):
    """列出激活码"""
    params = {}
    if args.status:
        params["status"] = args.status
    if args.search:
        params["search"] = args.search
    if args.order:
        params["order_number"] = args.order
    result = api_request("GET", "/api/admin/activation-codes", params=params)
    codes = result.get("codes", [])

    if args.json_output:
        print_json({"codes": codes})
        return

    columns = [
        ("code", "激活码"),
        ("plan", "套餐"),
        ("status", "状态"),
        ("used_count", "已用"),
        ("max_devices", "上限"),
        ("order_number", "订单号"),
        ("note", "备注"),
        ("created_at", "创建时间"),
    ]
    print_table(codes, columns)


def cmd_get_code(args):
    """查询单个激活码详情"""
    result = api_request("GET", f"/api/admin/activation-codes/{args.code}")
    print_json(result)


def cmd_update_code(args):
    """编辑激活码"""
    body = {}
    if args.days is not None:
        body["duration_days"] = args.days
    if args.devices is not None:
        body["max_devices"] = args.devices
    if args.note is not None:
        body["note"] = args.note
    if args.order is not None:
        body["order_number"] = args.order
    if args.status:
        body["status"] = args.status
    if not body:
        print("❌ 请至少指定一个要修改的字段", file=sys.stderr)
        sys.exit(1)
    result = api_request("PUT", f"/api/admin/activation-codes/{args.code}", body)
    print_json(result)


def cmd_delete_code(args):
    """删除激活码"""
    print(f"⚠️  即将删除激活码: {args.code}")
    confirm = input("确认删除？(输入 YES 继续): ")
    if confirm.strip() != "YES":
        print("已取消")
        return
    result = api_request("DELETE", f"/api/admin/activation-codes/{args.code}")
    print_json(result)


def cmd_list_users(args):
    """列出用户"""
    result = api_request("GET", "/api/admin/users")

    if args.json_output:
        print_json({"users": result.get("users", [])})
        return

    users = result.get("users", [])
    for u in users:
        codes = u.get("activation_codes", [])
        code_strs = [c.get("code", "") for c in codes] if codes else []
        print(f"  {u.get('email', '?')}  (ID: {u.get('id', '?')[:12]}...)  "
              f"状态: {u.get('status', '?')}  绑定码: {', '.join(code_strs) if code_strs else '无'}")

    if not users:
        print("(无用户)")
    else:
        print(f"\n共 {len(users)} 个用户")


def cmd_bind_code(args):
    """帮用户绑定激活码"""
    result = api_request("POST", f"/api/admin/users/{args.user_id}/bind-code",
                         {"code": args.code})
    print_json(result)


def cmd_unbind_code(args):
    """解绑用户的激活码"""
    print(f"⚠️  即将解绑用户 {args.user_id} 的激活码 {args.code}")
    confirm = input("确认？(输入 YES 继续): ")
    if confirm.strip() != "YES":
        print("已取消")
        return
    result = api_request("POST", f"/api/admin/users/{args.user_id}/unbind-code",
                         {"code": args.code})
    print_json(result)


def cmd_sales_stats(args):
    """销售统计"""
    result = api_request("GET", "/api/admin/sales-stats")

    if args.json_output:
        print_json(result)
        return

    print(f"📊 销售统计概览")
    print(f"   总激活码: {result.get('total_codes', 0)}")
    print(f"   活跃: {result.get('active_codes', 0)}  |  "
          f"已耗尽: {result.get('exhausted_codes', 0)}  |  "
          f"已过期: {result.get('expired_codes', 0)}  |  "
          f"已撤销: {result.get('revoked_codes', 0)}")
    print(f"   总使用次数: {result.get('total_used_count', 0)}")
    print()

    by_order = result.get("by_order", [])
    if by_order:
        print("📦 按订单号汇总:")
        for o in by_order:
            print(f"   {o['order_number']}: {o['total_codes']}码 活跃{o['active_codes']} 已用{o['used_count']}次")
    else:
        print("   (无订单号)")

    recent = result.get("recent_codes", [])
    if recent:
        print(f"\n🕐 最近生成的激活码 (最近 {len(recent)} 个):")
        columns = [
            ("code", "激活码"),
            ("plan", "套餐"),
            ("status", "状态"),
            ("order_number", "订单号"),
            ("note", "备注"),
            ("created_at", "创建"),
        ]
        print_table(recent, columns)


def cmd_create_api_key(args):
    """创建 API Key"""
    body = {"name": args.name or f"CLI-{os.uname().nodename}"}
    result = api_request("POST", "/api/admin/api-keys", body)
    if result.get("api_key"):
        print(f"\n✅ {result.get('message', '')}")
        print(f"\n🔑 API Key: {result['api_key']}")
        print(f"📛 名称: {result.get('name', '')}")
        print(f"🆔 ID: {result.get('id', '')}")
        print(f"\n⚠️  请立即保存此密钥！可通过以下方式使用:")
        print(f"   export QC_API_KEY=\"{result['api_key']}\"")
    else:
        print_json(result)


def cmd_list_api_keys(args):
    """列出 API Keys"""
    result = api_request("GET", "/api/admin/api-keys")
    keys = result.get("keys", [])
    if args.json_output:
        print_json({"keys": keys})
        return
    if not keys:
        print("(无 API Key)")
        return
    for k in keys:
        last = k.get("last_used_at") or "从未使用"
        print(f"  {k.get('name', '?')}  |  {k.get('key_prefix', '?')}  |  "
              f"状态: {k.get('status', '?')}  |  最后使用: {last[:19]}")
    print(f"\n共 {len(keys)} 个 API Key")


def cmd_delete_api_key(args):
    """删除 API Key"""
    print(f"⚠️  即将删除 API Key: {args.key_id}")
    confirm = input("确认？(输入 YES 继续): ")
    if confirm.strip() != "YES":
        print("已取消")
        return
    result = api_request("DELETE", f"/api/admin/api-keys/{args.key_id}")
    print_json(result)


# ── 主入口 ────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="QuickClip 管理后台 CLI — 供 AI Agent 管理激活码和销售",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
环境变量:
  QC_API_KEY          API 密钥 (推荐, 通过 create-api-key 创建)
  QC_API_URL          后端地址 (默认 http://124.220.21.242:8000)
  QC_ADMIN_EMAIL      管理员邮箱 (备选认证)
  QC_ADMIN_PASSWORD   管理员密码 (备选认证)

示例:
  python3 tools/admin_cli.py generate-code --plan lifetime --note "VIP" --order "ORD-001"
  python3 tools/admin_cli.py list-codes --status active
  python3 tools/admin_cli.py sales-stats
        """
    )
    sub = parser.add_subparsers(dest="command", help="可用命令")

    # generate-code
    p = sub.add_parser("generate-code", help="生成激活码")
    p.add_argument("--plan", default="standard", choices=["standard", "lifetime", "trial"],
                   help="套餐类型 (默认 standard)")
    p.add_argument("--days", type=int, default=365, help="授权天数 (默认 365)")
    p.add_argument("--devices", type=int, default=2, help="最大设备数 (默认 2)")
    p.add_argument("--note", default="", help="备注")
    p.add_argument("--order", default="", help="订单号")

    # list-codes
    p = sub.add_parser("list-codes", help="列出激活码")
    p.add_argument("--status", default="", choices=["active", "exhausted", "expired", "revoked", ""],
                   help="按状态筛选")
    p.add_argument("--search", default="", help="搜索码/备注/订单号/创建者")
    p.add_argument("--order", default="", help="按订单号筛选")
    p.add_argument("--json", dest="json_output", action="store_true", help="JSON 格式输出")

    # get-code
    p = sub.add_parser("get-code", help="查询激活码详情")
    p.add_argument("code", help="激活码或 ID")

    # update-code
    p = sub.add_parser("update-code", help="编辑激活码")
    p.add_argument("code", help="激活码或 ID")
    p.add_argument("--days", type=int, default=None, help="修改授权天数")
    p.add_argument("--devices", type=int, default=None, help="修改最大设备数")
    p.add_argument("--note", default=None, help="修改备注")
    p.add_argument("--order", default=None, help="修改订单号")
    p.add_argument("--status", default="", choices=["active", "expired", "exhausted", "revoked", ""],
                   help="修改状态")

    # delete-code
    sub.add_parser("delete-code", help="删除激活码").add_argument("code", help="激活码或 ID")

    # list-users
    p = sub.add_parser("list-users", help="列出用户及绑定激活码")
    p.add_argument("--json", dest="json_output", action="store_true", help="JSON 格式输出")

    # bind-code
    p = sub.add_parser("bind-code", help="帮用户绑定激活码")
    p.add_argument("user_id", help="用户 ID")
    p.add_argument("--code", required=True, help="激活码")

    # unbind-code
    p = sub.add_parser("unbind-code", help="解绑用户激活码")
    p.add_argument("user_id", help="用户 ID")
    p.add_argument("--code", required=True, help="激活码")

    # sales-stats
    p = sub.add_parser("sales-stats", help="销售统计")
    p.add_argument("--json", dest="json_output", action="store_true", help="JSON 格式输出")

    # create-api-key
    p = sub.add_parser("create-api-key", help="创建 API Key (需要管理员密码)")
    p.add_argument("--name", default="", help="密钥名称")

    # list-api-keys
    p = sub.add_parser("list-api-keys", help="列出 API Keys")
    p.add_argument("--json", dest="json_output", action="store_true", help="JSON 格式输出")

    # delete-api-key
    sub.add_parser("delete-api-key", help="删除 API Key").add_argument("key_id", help="API Key ID")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    # 分发命令
    commands = {
        "generate-code": cmd_generate,
        "list-codes": cmd_list_codes,
        "get-code": cmd_get_code,
        "update-code": cmd_update_code,
        "delete-code": cmd_delete_code,
        "list-users": cmd_list_users,
        "bind-code": cmd_bind_code,
        "unbind-code": cmd_unbind_code,
        "sales-stats": cmd_sales_stats,
        "create-api-key": cmd_create_api_key,
        "list-api-keys": cmd_list_api_keys,
        "delete-api-key": cmd_delete_api_key,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()
