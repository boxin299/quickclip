"""GitHub Releases based update checks for QuickClip."""

from __future__ import annotations

import os
import re
import warnings
from typing import Any, Dict, Iterable, List, Optional, Tuple

warnings.filterwarnings(
    "ignore",
    message=r"urllib3 v2 only supports OpenSSL 1\.1\.1\+",
)
import requests


GITHUB_REPO_ENV = "QUICKCLIP_GITHUB_REPO"
GITHUB_API_ENV = "QUICKCLIP_GITHUB_API_BASE"

try:
    from release_config import GITHUB_UPDATE_REPO
except Exception:
    GITHUB_UPDATE_REPO = ""


def normalize_version(version: str) -> str:
    value = str(version or "").strip()
    if value.startswith(("v", "V")):
        value = value[1:]
    return value


def version_tuple(version: str) -> Tuple[int, ...]:
    normalized = normalize_version(version)
    parts = re.split(r"[^0-9]+", normalized)
    numbers = [int(p) for p in parts if p != ""]
    return tuple(numbers or [0])


def is_newer_version(latest: str, current: str) -> bool:
    latest_parts = version_tuple(latest)
    current_parts = version_tuple(current)
    max_len = max(len(latest_parts), len(current_parts))
    latest_parts = latest_parts + (0,) * (max_len - len(latest_parts))
    current_parts = current_parts + (0,) * (max_len - len(current_parts))
    return latest_parts > current_parts


def platform_asset_keywords(platform: str, arch: str) -> List[str]:
    platform = (platform or "").lower()
    arch = (arch or "").lower()
    keywords: List[str] = []

    if platform in {"macos", "darwin", "mac"}:
        keywords.extend([".dmg", "mac", "darwin"])
        if arch in {"aarch64", "arm64"}:
            keywords.extend(["arm64", "aarch64", "apple"])
        elif arch in {"x86_64", "amd64", "x64"}:
            keywords.extend(["x64", "x86_64", "intel", "amd64"])
    elif platform in {"windows", "win32", "win"}:
        keywords.extend([".exe", ".msi", "windows", "win"])
        if arch:
            keywords.append("x64" if arch in {"x86_64", "amd64"} else arch)
    elif platform == "linux":
        keywords.extend([".appimage", ".deb", ".rpm", "linux"])
        if arch:
            keywords.append("x64" if arch in {"x86_64", "amd64"} else arch)

    return keywords


def pick_download_asset(assets: Iterable[Dict[str, Any]], platform: str, arch: str) -> Optional[Dict[str, str]]:
    candidates = []
    keywords = platform_asset_keywords(platform, arch)
    for asset in assets or []:
        name = str(asset.get("name") or "")
        url = str(asset.get("browser_download_url") or "")
        if not name or not url:
            continue
        lower_name = name.lower()
        score = sum(1 for keyword in keywords if keyword and keyword in lower_name)
        if score > 0:
            candidates.append((score, name, url))

    if not candidates:
        return None

    candidates.sort(key=lambda item: (-item[0], item[1]))
    _, name, url = candidates[0]
    return {"name": name, "url": url}


def github_latest_release_url(repo: str) -> str:
    api_base = os.environ.get(GITHUB_API_ENV, "https://api.github.com").rstrip("/")
    return f"{api_base}/repos/{repo}/releases/latest"


def check_github_update(
    current_version: str,
    platform: str,
    arch: str,
    repo: Optional[str] = None,
    timeout: float = 8.0,
) -> Dict[str, Any]:
    repo = (repo or os.environ.get(GITHUB_REPO_ENV) or GITHUB_UPDATE_REPO or "").strip()
    if not repo:
        return {
            "has_update": False,
            "error": True,
            "code": "GITHUB_REPO_NOT_CONFIGURED",
            "message": f"尚未配置 GitHub 更新仓库，请在 release_config.py 中填写 owner/repo，或设置 {GITHUB_REPO_ENV}=owner/repo",
        }

    url = github_latest_release_url(repo)
    try:
        response = requests.get(
            url,
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "QuickClip-Updater",
            },
            timeout=timeout,
        )
    except requests.RequestException as exc:
        return {
            "has_update": False,
            "error": True,
            "code": "GITHUB_REQUEST_FAILED",
            "message": f"无法连接 GitHub 更新源：{exc}",
        }

    if response.status_code == 404:
        return {
            "has_update": False,
            "error": True,
            "code": "GITHUB_RELEASE_NOT_FOUND",
            "message": "GitHub 仓库还没有发布 Release，创建第一个 Release 后即可检查更新。",
        }
    if response.status_code >= 400:
        return {
            "has_update": False,
            "error": True,
            "code": "GITHUB_REQUEST_FAILED",
            "message": f"GitHub 更新源返回 HTTP {response.status_code}",
        }

    release = response.json()
    tag = str(release.get("tag_name") or release.get("name") or "")
    latest_version = normalize_version(tag)
    has_update = is_newer_version(latest_version, current_version)
    asset = pick_download_asset(release.get("assets") or [], platform, arch)
    html_url = str(release.get("html_url") or f"https://github.com/{repo}/releases/latest")

    return {
        "has_update": has_update,
        "latest_version": latest_version,
        "current_version": current_version,
        "release_date": str(release.get("published_at") or "")[:10],
        "changelog": release.get("body") or "",
        "download_url": asset["url"] if asset else html_url,
        "download_name": asset["name"] if asset else "",
        "source": "github",
        "repo": repo,
    }
