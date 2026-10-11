import os
import sys
import tempfile
import unittest
from unittest import mock

import httpx

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import transcriber
import main as backend_main
from transcriber import TranscriberService, TranscriptionModelMissingError


class TestTranscriberModelPreflight(unittest.TestCase):
    def test_transcribe_does_not_download_missing_model_implicitly(self):
        service = TranscriberService()

        with mock.patch.object(transcriber, "FW_AVAILABLE", True), \
                mock.patch.object(transcriber, "WhisperModel", object), \
                mock.patch.object(service, "_is_model_cached", return_value=False), \
                mock.patch.object(service, "_download_whisper_files") as download:
            with self.assertRaises(TranscriptionModelMissingError):
                service._ensure_ready()

        download.assert_not_called()

    def test_whisper_keeps_word_timestamps_by_default_for_clip_selection(self):
        service = TranscriberService()
        fake_model = mock.Mock()
        fake_model.transcribe.return_value = (
            [mock.Mock(text="你好世界", start=0, end=1, words=None)],
            mock.Mock(language="zh"),
        )
        service.whisper = fake_model

        segments, _ = service._do_whisper(
            audio=[0.0],
            language="zh",
            initial_prompt="QuickClip",
        )

        self.assertEqual(segments[0]["text"], "你好世界")
        kwargs = fake_model.transcribe.call_args.kwargs
        self.assertTrue(kwargs["word_timestamps"])
        self.assertIn("简体中文", kwargs["initial_prompt"])
        self.assertIn("QuickClip", kwargs["initial_prompt"])


class TestTranscribeRoutesModelPreflight(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=backend_main.app),
            base_url="http://testserver",
        )
        self.tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        self.tmp.close()

    async def asyncTearDown(self):
        await self.client.aclose()
        os.unlink(self.tmp.name)

    async def test_subtitle_transcribe_returns_409_when_model_missing(self):
        with mock.patch.object(
            backend_main.transcriber,
            "transcribe",
            side_effect=TranscriptionModelMissingError(),
        ):
            response = await self.client.post(
                "/api/subtitle/transcribe",
                json={"video_path": self.tmp.name},
            )

        self.assertEqual(response.status_code, 409)
        self.assertIn("语音识别模型未安装", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
