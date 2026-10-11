import os
import sys
import unittest
from unittest import mock

import httpx

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from app.update_service import check_github_update, is_newer_version, pick_download_asset
import main as backend_main


class FakeResponse:
    def __init__(self, status_code, data):
        self.status_code = status_code
        self._data = data

    def json(self):
        return self._data


class TestGithubUpdateService(unittest.TestCase):
    def test_not_configured_returns_clear_message(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch("app.update_service.GITHUB_UPDATE_REPO", ""):
            result = check_github_update("1.0.1", "macos", "aarch64")

        self.assertFalse(result["has_update"])
        self.assertTrue(result["error"])
        self.assertEqual(result["code"], "GITHUB_REPO_NOT_CONFIGURED")

    def test_uses_packaged_release_config_repo(self):
        release_payload = {
            "tag_name": "v1.0.1",
            "published_at": "2026-06-13T10:00:00Z",
            "body": "",
            "html_url": "https://github.com/frame-qingsong/quickclip/releases/tag/v1.0.1",
            "assets": [],
        }
        with mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch("app.update_service.GITHUB_UPDATE_REPO", "frame-qingsong/quickclip"), \
                mock.patch("app.update_service.requests.get", return_value=FakeResponse(200, release_payload)) as get:
            result = check_github_update("1.0.1", "macos", "aarch64")

        get.assert_called_once()
        self.assertEqual(result["repo"], "frame-qingsong/quickclip")
        self.assertFalse(result["has_update"])

    def test_version_compare(self):
        self.assertTrue(is_newer_version("v1.0.2", "1.0.1"))
        self.assertFalse(is_newer_version("v1.0.1", "1.0.1"))
        self.assertFalse(is_newer_version("v1.0.0", "1.0.1"))

    def test_picks_macos_arm64_dmg_asset(self):
        asset = pick_download_asset(
            [
                {"name": "QuickClip-1.0.2-x64.dmg", "browser_download_url": "https://example.com/x64.dmg"},
                {"name": "QuickClip-1.0.2-arm64.dmg", "browser_download_url": "https://example.com/arm64.dmg"},
            ],
            "macos",
            "aarch64",
        )

        self.assertEqual(asset["url"], "https://example.com/arm64.dmg")

    def test_latest_release_response_maps_to_update_payload(self):
        release_payload = {
            "tag_name": "v1.0.2",
            "published_at": "2026-06-13T10:00:00Z",
            "body": "更新说明",
            "html_url": "https://github.com/frame-qingsong/quickclip/releases/tag/v1.0.2",
            "assets": [
                {
                    "name": "QuickClip-1.0.2-arm64.dmg",
                    "browser_download_url": "https://github.com/frame-qingsong/quickclip/releases/download/v1.0.2/QuickClip-1.0.2-arm64.dmg",
                }
            ],
        }
        with mock.patch.dict(os.environ, {"QUICKCLIP_GITHUB_REPO": "frame-qingsong/quickclip"}, clear=True), \
                mock.patch("app.update_service.requests.get", return_value=FakeResponse(200, release_payload)) as get:
            result = check_github_update("1.0.1", "macos", "aarch64")

        get.assert_called_once()
        self.assertTrue(result["has_update"])
        self.assertEqual(result["latest_version"], "1.0.2")
        self.assertEqual(result["download_name"], "QuickClip-1.0.2-arm64.dmg")
        self.assertEqual(result["source"], "github")


class TestUpdateRoute(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=backend_main.app),
            base_url="http://testserver",
        )

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_update_check_route_delegates_to_update_service(self):
        with mock.patch("main.check_github_update", return_value={
            "has_update": False,
            "latest_version": "1.0.1",
            "current_version": "1.0.1",
            "source": "github",
            "repo": "boxin299/quickclip",
        }) as check:
            response = await self.client.get(
                "/api/update/check?platform=macos&arch=aarch64&current_version=1.0.1"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["repo"], "boxin299/quickclip")
        check.assert_called_once_with(current_version="1.0.1", platform="macos", arch="aarch64")


if __name__ == "__main__":
    unittest.main()
