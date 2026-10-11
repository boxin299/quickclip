import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import resolve_api


class FakeFolder:
    def __init__(self, name, children=None):
        self._name = name
        self._children = children or []

    def GetName(self):
        return self._name

    def GetSubFolderList(self):
        return self._children


class FakeMediaPool:
    def __init__(self, root):
        self._root = root

    def GetRootFolder(self):
        return self._root


class FakeProject:
    def __init__(self, root):
        self._media_pool = FakeMediaPool(root)

    def GetMediaPool(self):
        return self._media_pool


class ResolveApiFolderOrderTest(unittest.TestCase):
    def test_get_media_pool_folders_preserves_resolve_order(self):
        root = FakeFolder("Root", [
            FakeFolder("B素材", [FakeFolder("B2")]),
            FakeFolder("A素材"),
            FakeFolder("10交付"),
            FakeFolder("2剪辑"),
        ])

        with patch.object(resolve_api, "RESOLVE_AVAILABLE", False):
            controller = resolve_api.ResolveController()
        controller.resolve = object()
        controller.project = FakeProject(root)
        controller._refresh_context = lambda: True

        self.assertEqual(controller.get_media_pool_folders(), [
            "B素材",
            "B素材/B2",
            "A素材",
            "10交付",
            "2剪辑",
        ])


if __name__ == "__main__":
    unittest.main()
