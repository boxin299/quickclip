import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import cache_manager


class TestTranscriptProjectUpdate(unittest.TestCase):
    def setUp(self):
        self._old_root = cache_manager._resolved_root
        self.tmp = tempfile.TemporaryDirectory()
        cache_manager._resolved_root = Path(self.tmp.name)

    def tearDown(self):
        cache_manager._resolved_root = self._old_root
        self.tmp.cleanup()

    def test_update_transcript_project_segments_persists_transcript_and_metadata(self):
        metadata = {
            "id": "tid-1",
            "name": "测试字幕",
            "created_at": "2026-06-13T10:00:00",
            "segment_count": 1,
        }
        transcript = {
            "segments": [{"start": 0.0, "end": 1.0, "text": "旧字幕"}],
            "duration": 1.0,
        }
        cache_manager.save_transcript_project("达芬奇项目", "tid-1", metadata, transcript)

        updated = [
            {"start": 0.0, "end": 0.5, "text": "新"},
            {"start": 0.5, "end": 1.0, "text": "字幕"},
        ]
        result = cache_manager.update_transcript_project_segments("达芬奇项目", "tid-1", updated)

        self.assertEqual(result["segment_count"], 2)
        self.assertIn("updated_at", result)

        project = cache_manager.get_transcript_project("达芬奇项目", "tid-1")
        self.assertEqual(project["transcript"]["segments"], updated)
        self.assertEqual(project["metadata"]["segment_count"], 2)

        transcript_path = cache_manager.get_transcript_dir("达芬奇项目", "tid-1") / "transcript.json"
        with open(transcript_path, "r", encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved["segments"], updated)
