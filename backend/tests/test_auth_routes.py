import os
import tempfile
import unittest

import httpx
from fastapi import FastAPI

from app.auth_store import AuthStore
from app.auth_routes import init_auth_routes
from app.auth_guard import install_auth_guard


class AuthRoutesTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = AuthStore(os.path.join(self.tmp.name, "auth_store.json"))
        self.app = FastAPI()
        init_auth_routes(self.app, self.store)
        install_auth_guard(self.app, self.store)

        @self.app.get("/api/status")
        async def status():
            return {"ok": True}

        @self.app.post("/api/transcribe/path")
        async def protected_transcribe():
            return {"ok": True}

        transport = httpx.ASGITransport(app=self.app)
        self.client = httpx.AsyncClient(transport=transport, base_url="http://testserver")

    async def asyncTearDown(self):
        await self.client.aclose()
        self.tmp.cleanup()

    async def test_register_login_license_and_protected_api(self):
        device_headers = {"X-Device-Id": "device-1", "X-Device-Name": "MacBook"}
        register = await self.client.post("/api/auth/register", json={
            "email": "user@example.com",
            "password": "password123",
            "nickname": "User",
        }, headers=device_headers)
        self.assertEqual(register.status_code, 200)
        token = register.json()["access_token"]

        blocked = await self.client.post("/api/transcribe/path", headers={"Authorization": f"Bearer {token}", **device_headers})
        self.assertEqual(blocked.status_code, 403)
        self.assertEqual(blocked.json()["detail"]["code"], "LICENSE_REQUIRED")

        user_id = register.json()["user"]["id"]
        self.store.grant_license(user_id, "standard", 365, 2, "test-order")

        status = await self.client.get("/api/license/status", headers={"Authorization": f"Bearer {token}", **device_headers})
        self.assertEqual(status.status_code, 200)
        self.assertTrue(status.json()["can_use"])

        allowed = await self.client.post("/api/transcribe/path", headers={"Authorization": f"Bearer {token}", **device_headers})
        self.assertEqual(allowed.status_code, 200)

    async def test_admin_can_grant_license(self):
        registered = (await self.client.post("/api/auth/register", json={
            "email": "grant@example.com",
            "password": "password123",
        }, headers={"X-Device-Id": "device-1"})).json()
        admin_login = await self.client.post("/api/admin/login", json={
            "email": "REDACTED_CONFIGURE_LOCALLY",
            "password": "admin123456",
        })
        self.assertEqual(admin_login.status_code, 200)
        admin_token = admin_login.json()["admin_token"]

        grant = await self.client.post("/api/admin/licenses/grant", json={
            "user_id": registered["user"]["id"],
            "plan": "standard",
            "duration_days": 365,
            "max_devices": 2,
        }, headers={"Authorization": f"Bearer {admin_token}"})
        self.assertEqual(grant.status_code, 200)
        self.assertEqual(grant.json()["plan"], "standard")


if __name__ == "__main__":
    unittest.main()
