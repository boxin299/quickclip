import os
import tempfile
import unittest

from app.auth_store import AuthStore, AuthError


class AuthStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = AuthStore(os.path.join(self.tmp.name, "auth_store.json"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_register_login_and_license_required(self):
        registered = self.store.register_user("user@example.com", "password123", "剪辑师", "device-1", "MacBook")
        self.assertEqual(registered["user"]["email"], "user@example.com")
        self.assertEqual(registered["license"]["status"], "none")

        logged_in = self.store.login_user("user@example.com", "password123", "device-1", "MacBook")
        self.assertTrue(logged_in["access_token"])
        self.assertFalse(logged_in["license"]["can_use"])
        self.assertEqual(logged_in["license"]["reason"], "LICENSE_REQUIRED")

    def test_rejects_duplicate_email_and_bad_password(self):
        self.store.register_user("dupe@example.com", "password123", "A", "device-1", "MacBook")
        with self.assertRaises(AuthError) as duplicate:
            self.store.register_user("DUPE@example.com", "password123", "B", "device-1", "MacBook")
        self.assertEqual(duplicate.exception.code, "EMAIL_ALREADY_REGISTERED")

        with self.assertRaises(AuthError) as bad_login:
            self.store.login_user("dupe@example.com", "wrong-password", "device-1", "MacBook")
        self.assertEqual(bad_login.exception.code, "INVALID_CREDENTIALS")

    def test_paid_order_grants_license_and_is_idempotent(self):
        user = self.store.register_user("paid@example.com", "password123", "Paid", "device-1", "MacBook")["user"]
        first = self.store.process_payment_event(
            provider="manual",
            event_id="evt-1",
            event_type="payment.paid",
            payload={
                "user_id": user["id"],
                "provider_order_id": "order-1",
                "product_id": "standard-yearly",
                "plan": "standard",
                "duration_days": 365,
                "amount": 39900,
                "currency": "CNY",
            },
        )
        second = self.store.process_payment_event(
            provider="manual",
            event_id="evt-1",
            event_type="payment.paid",
            payload={"user_id": user["id"], "provider_order_id": "order-1"},
        )
        self.assertEqual(first["status"], "processed")
        self.assertEqual(second["status"], "duplicate")
        status = self.store.get_license_status(user["id"], "device-1", bind_device=True)
        self.assertTrue(status["can_use"])
        self.assertEqual(status["plan"], "standard")

    def test_device_limit_blocks_third_device(self):
        user = self.store.register_user("limit@example.com", "password123", "Limit", "device-1", "MacBook")["user"]
        self.store.grant_license(user["id"], "standard", 365, max_devices=2, source_order_id="manual")
        self.assertTrue(self.store.get_license_status(user["id"], "device-1", True)["can_use"])
        self.assertTrue(self.store.get_license_status(user["id"], "device-2", True)["can_use"])
        third = self.store.get_license_status(user["id"], "device-3", True)
        self.assertFalse(third["can_use"])
        self.assertEqual(third["reason"], "DEVICE_LIMIT_EXCEEDED")

    def test_admin_can_revoke_license_and_disable_device(self):
        user = self.store.register_user("admin-target@example.com", "password123", "Target", "device-1", "MacBook")["user"]
        license_record = self.store.grant_license(user["id"], "standard", 365, max_devices=2, source_order_id="manual")
        self.assertTrue(self.store.get_license_status(user["id"], "device-1", True)["can_use"])

        self.store.revoke_license(license_record["id"], "admin-test")
        revoked = self.store.get_license_status(user["id"], "device-1", True)
        self.assertFalse(revoked["can_use"])
        self.assertEqual(revoked["reason"], "LICENSE_REVOKED")


if __name__ == "__main__":
    unittest.main()
