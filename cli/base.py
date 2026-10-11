"""CLI 基础设施：HTTP 客户端、输出格式化、配置管理。"""
import os
import sys
import json
from typing import Any, Optional

import httpx

# ── 配置 ──────────────────────────────────────

_DEFAULT_BACKEND = "http://localhost:8000"


def get_backend_url() -> str:
    return os.environ.get("QC_BACKEND_URL", _DEFAULT_BACKEND).rstrip("/")


def get_api_key() -> Optional[str]:
    return os.environ.get("QC_API_KEY") or None


# ── HTTP 客户端 ──────────────────────────────

class APIClient:
    """轻量 HTTP 客户端，封装认证和错误处理。"""

    def __init__(self, backend: Optional[str] = None):
        self.backend = (backend or get_backend_url()).rstrip("/")
        self.api_key = get_api_key()

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.api_key:
            h["X-API-Key"] = self.api_key
        return h

    def _url(self, path: str) -> str:
        return f"{self.backend}{path}"

    def _request(self, method: str, path: str, body: Optional[dict] = None,
                 params: Optional[dict] = None, timeout: float = 60.0) -> dict:
        try:
            r = httpx.request(
                method=method,
                url=self._url(path),
                json=body,
                params=params,
                headers=self._headers(),
                timeout=timeout,
            )
            r.raise_for_status()
            return r.json()
        except json.JSONDecodeError:
            return {"ok": False, "error": "后端返回了无效的 JSON 响应", "detail": None}
        except httpx.ConnectError:
            return {"ok": False, "error": f"无法连接后端 {self.backend}", "detail": None}
        except httpx.HTTPStatusError as e:
            try:
                detail = e.response.json()
            except Exception:
                detail = str(e)
            return {"ok": False, "error": f"请求失败 [{e.response.status_code}]", "detail": detail}
        except httpx.TimeoutException:
            return {"ok": False, "error": "请求超时", "detail": None}
        except httpx.RequestError as e:
            return {"ok": False, "error": f"网络请求异常: {e}", "detail": None}

    def get(self, path: str, params: Optional[dict] = None) -> dict:
        return self._request("GET", path, params=params)

    def post(self, path: str, body: Optional[dict] = None,
             params: Optional[dict] = None, timeout: float = 60.0) -> dict:
        return self._request("POST", path, body=body, params=params, timeout=timeout)

    def delete(self, path: str, params: Optional[dict] = None) -> dict:
        return self._request("DELETE", path, params=params)


# ── 全局 CLI 状态（由 main.py 的 callback 设置） ──

_json_opt: bool = False
_backend_opt: Optional[str] = None


def set_json(val: bool) -> None:
    global _json_opt
    _json_opt = val


def set_backend(val: str) -> None:
    global _backend_opt
    _backend_opt = val


def get_client() -> APIClient:
    return APIClient(_backend_opt or get_backend_url())


def get_json() -> bool:
    return _json_opt


# ── 输出 ──────────────────────────────────────

def output(data: Any, use_json: bool = False, ok: bool = True,
           elapsed_ms: int = 0):
    """统一输出：--json 模式输出 JSON 信封，否则直接打印。"""
    if use_json:
        envelope = {"ok": ok, "data": data, "elapsed_ms": elapsed_ms}
        if not ok:
            envelope["error"] = data.get("error", "Unknown error") if isinstance(data, dict) else str(data)
            envelope.pop("data", None)
        print(json.dumps(envelope, ensure_ascii=False, indent=2))
    else:
        if isinstance(data, dict) or isinstance(data, list):
            print(json.dumps(data, ensure_ascii=False, indent=2))
        elif data is not None:
            print(data)


def print_error(message: str, use_json: bool = False):
    """输出错误并退出。"""
    if use_json:
        print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    else:
        print(f"❌ {message}", file=sys.stderr)
    sys.exit(1)
