"""
QuickClip Web 辅助 API
包含软件状态检查和第三方素材/评论解析等无需账号的公开接口。
"""
import sys
import os
from contextlib import asynccontextmanager

# 确保能导入同目录模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动时提示辅助 API 已就绪。"""
    print("\n  QuickClip Web API 已启动\n")
    yield

app = FastAPI(title="QuickClip Web API", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/status")
async def api_status():
    return {"status": "ok", "service": "quickclip-web-api", "version": "0.2.0"}


@app.get("/api/yueliu/resolve")
async def resolve_yueliu_link(url: str):
    """解析阅流短链接，返回 share code"""
    import re
    import requests as req
    try:
        resp = req.get(url, allow_redirects=False, timeout=10,
            headers={"User-Agent": "Mozilla/5.0"})
        location = resp.headers.get("Location", "")
        m = re.search(r'/share/(?:list/)?([a-f0-9]+)', location)
        if m:
            return {"ok": True, "shareCode": m.group(1), "redirectUrl": location}
        m = re.search(r'/share/(?:list/)?([a-f0-9]+)', url)
        if m:
            return {"ok": True, "shareCode": m.group(1), "redirectUrl": url}
        return {"ok": False, "error": "无法从链接中提取分享码"}
    except Exception as e:
        return {"ok": False, "error": f"请求失败: {str(e)}"}


@app.get("/api/yueliu/comments")
async def get_yueliu_comments(url: str):
    """完整流程：解析短链接 → 获取文件列表 → 拉取所有时间戳评论"""
    import re
    import hashlib
    import time as _time
    import requests as req

    API_BASE = "https://pub.yueliu.cloud"
    APP_SECRET = os.environ.get("YUE_LIU_APP_SECRET", "")

    # ── 1. 解析 share code ─────────────────────
    share_code = None
    # 直接从 URL 提取
    m = re.search(r'/share/(?:list/)?([a-f0-9]+)', url)
    if m:
        share_code = m.group(1)
    m = re.search(r'/share/file/[^/]+/([a-f0-9]+)', url)
    if m:
        share_code = m.group(1)

    if not share_code:
        # 短链接，跟随重定向
        try:
            resp = req.get(url, allow_redirects=False, timeout=10,
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
    def make_headers(code, path_suffix="list"):
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

    # ── 3. 获取文件列表 ──────────────────────
    h, token = make_headers(share_code)
    verify = hashlib.md5(f"{token}{share_code}".encode()).hexdigest()

    files_resp = req.get(f"{API_BASE}/api/v1/share/files", params={
        "code": share_code, "verify": verify,
        "curr_page": 1, "page_size": 30, "top_id": 0,
    }, headers=h)

    if files_resp.status_code != 200:
        return {"ok": False, "error": f"API 请求失败: HTTP {files_resp.status_code}"}

    files_data = files_resp.json()
    if files_data.get("code") != 1000:
        return {"ok": False, "error": f"获取文件列表失败: {files_data.get('msg', '未知')}"}

    files = files_data["data"]["list"]
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
            h2, token2 = make_headers(share_code, "file/xxx")
            verify2 = hashlib.md5(f"{token2}{doc_id}".encode()).hexdigest()

            try:
                comments_resp = req.get(f"{API_BASE}/api/v1/project/comment", params={
                    "code": share_code, "doc_id": doc_id, "verify": verify2,
                }, headers=h2)

                if comments_resp.status_code == 200:
                    comments_data = comments_resp.json()
                    if comments_data.get("code") == 1000:
                        raw = comments_data["data"]["list"]
                        raw.sort(key=lambda c: float(c.get("media_time", 0)))
                        file_info["comments"] = [{
                            "id": c["id"],
                            "timeMs": float(c.get("media_time", 0)),
                            "timeFormatted": _format_time(c.get("media_time", 0)),
                            "content": c.get("content", ""),
                            "user": c.get("userinfo", {}).get("real_name", ""),
                            "userId": c.get("userinfo", {}).get("user_id", 0),
                            "createdAt": c.get("created_at", 0),
                            "replyCount": c.get("count", 0),
                            "duration": c.get("duration", 0),
                        } for c in raw]
                    else:
                        file_info["error"] = comments_data.get("msg", "未知")
            except Exception as e:
                file_info["error"] = str(e)

        all_files.append(file_info)

    # ── 5. 获取分享名称 ──────────────────────
    share_name = files[0]["name"] if files else "未命名"
    try:
        h3, token3 = make_headers(share_code)
        verify3 = hashlib.md5(f"{token3}{share_code}".encode()).hexdigest()
        share_resp = req.get(f"{API_BASE}/api/v1/share", params={
            "code": share_code, "verify": verify3,
        }, headers=h3)
        if share_resp.status_code == 200 and share_resp.json().get("code") == 1000:
            share_name = share_resp.json()["data"].get("name", share_name)
    except Exception:
        pass

    return {
        "ok": True,
        "shareCode": share_code,
        "shareName": share_name,
        "files": all_files,
    }


def _format_time(ms):
    ms = float(ms) if ms else 0
    total_sec = int(ms / 1000)
    return f"{total_sec // 60:02d}:{total_sec % 60:02d}"


if __name__ == "__main__":
    import uvicorn
    from port_utils import find_available_port
    port = int(os.environ.get("APP_BACKEND_PORT", "0") or "0") or find_available_port()
    print(f"Starting web server on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
