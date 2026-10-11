import io
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import clip_import_manager as cim


class FakePasteboard:
    def __init__(self, values):
        self.values = values

    def dataForType_(self, pasteboard_type):
        return self.values.get(pasteboard_type)


def make_png_bytes():
    out = io.BytesIO()
    Image.new("RGBA", (2, 2), (255, 0, 0, 255)).save(out, format="PNG")
    return out.getvalue()


def make_cmyk_tiff_bytes():
    out = io.BytesIO()
    Image.new("CMYK", (2, 2), (0, 128, 128, 0)).save(out, format="TIFF")
    return out.getvalue()


class ImageProcessorTest(unittest.TestCase):
    def test_extract_image_data_falls_back_to_png_when_tiff_is_not_decodable(self):
        png_bytes = make_png_bytes()
        pasteboard = FakePasteboard({
            "TIFF": b"",
            "PDF": None,
            "PNG": png_bytes,
        })

        with patch.object(cim, "PYOBJC_AVAILABLE", True), \
             patch.object(cim, "NSPasteboardTypeTIFF", "TIFF", create=True), \
             patch.object(cim, "NSPasteboardTypePDF", "PDF", create=True), \
             patch.object(cim, "NSPasteboardTypePNG", "PNG", create=True):
            result = cim.ImageProcessor().extract_image_data(pasteboard)

        self.assertEqual(result, png_bytes)

    def test_convert_format_converts_cmyk_clipboard_image_to_png(self):
        image_bytes = make_cmyk_tiff_bytes()

        converted, actual_format = cim.ImageProcessor().convert_format(image_bytes, "PNG")

        self.assertEqual(actual_format, "PNG")
        with Image.open(io.BytesIO(converted)) as image:
            self.assertEqual(image.format, "PNG")


class ClipboardMonitorTest(unittest.TestCase):
    def test_image_hash_falls_back_to_png_when_tiff_is_empty(self):
        png_bytes = make_png_bytes()
        pasteboard = FakePasteboard({
            "TIFF": b"",
            "PNG": png_bytes,
        })

        with patch.object(cim, "NSPasteboardTypeTIFF", "TIFF", create=True), \
             patch.object(cim, "NSPasteboardTypePNG", "PNG", create=True):
            result = cim.ClipboardMonitor._pasteboard_image_hash(pasteboard)

        self.assertEqual(result, cim.hashlib.md5(png_bytes).hexdigest())


class ClipImportManagerStartupTest(unittest.TestCase):
    def test_manager_startup_forces_clipboard_monitor_disabled(self):
        saved_config = {
            "enabled": True,
            "output_format": "PNG",
            "local_target_folder": ".",
            "davinci_folder": ".",
            "organization": "flat",
            "dedup_method": "md5",
        }
        stored_config = {}

        def fake_save_config(config):
            stored_config.update(config)

        with patch.object(cim, "load_config", return_value=saved_config), \
             patch.object(cim, "save_config", side_effect=fake_save_config):
            manager = cim.ClipImportManager(resolve_controller=None)

        self.assertFalse(manager.config["enabled"])
        self.assertFalse(manager.running)
        self.assertFalse(stored_config["enabled"])


class FakeDavinciFolder:
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


class FakeResolveController:
    def __init__(self, root=None, project_path=""):
        self.media_pool = FakeMediaPool(root) if root else None
        self.project_path = project_path

    def _refresh_context(self):
        return True

    def _detect_project_local_path(self):
        return self.project_path, "test"


class ClipImportFolderOrderingTest(unittest.TestCase):
    def test_list_local_folders_uses_natural_sort(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            for folder in ["10交付", "2剪辑", "1素材", "1素材/B-roll", "1素材/A-roll"]:
                os.makedirs(os.path.join(tmpdir, folder), exist_ok=True)
            manager = cim.ClipImportManager(resolve_controller=FakeResolveController(project_path=tmpdir))

            self.assertEqual(manager.list_local_folders(), [
                ".",
                "1素材",
                "1素材/A-roll",
                "1素材/B-roll",
                "2剪辑",
                "10交付",
            ])

    def test_list_davinci_folders_uses_natural_sort(self):
        root = FakeDavinciFolder("Root", [
            FakeDavinciFolder("B素材", [FakeDavinciFolder("B2")]),
            FakeDavinciFolder("A素材"),
            FakeDavinciFolder("10交付"),
            FakeDavinciFolder("2剪辑"),
        ])
        manager = cim.ClipImportManager(resolve_controller=FakeResolveController(root=root))

        self.assertEqual(manager.list_davinci_folders(), [
            ".",
            "2剪辑",
            "10交付",
            "A素材",
            "B素材",
            "B素材/B2",
        ])


if __name__ == "__main__":
    unittest.main()
