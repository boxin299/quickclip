import asyncio
import os
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from fastapi import BackgroundTasks

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
import main  # noqa: E402


class WaveformEndpointConcurrencyTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.library_path = os.path.join(self.tmp.name, "library")
        os.makedirs(self.library_path)
        self.files = []
        for idx in range(4):
            path = os.path.join(self.library_path, f"hit-{idx}.wav")
            with open(path, "wb") as handle:
                handle.write(b"wav")
            self.files.append(path)
        main._waveform_generation_lock = None
        main._precompute_state.update({
            "running": False,
            "total": 0,
            "done": 0,
            "currentFile": "",
            "startedAt": 0.0,
        })

    async def asyncTearDown(self):
        main._waveform_generation_lock = None
        self.tmp.cleanup()

    def _config(self):
        return {
            "library_path": self.library_path,
            "path_mappings": [],
            "waveform_cache_library_dir": ".sfx_cache",
            "waveform_cache_compress": True,
            "preview_cache_max_mb": 0,
            "scan_cache_ttl_seconds": 300,
            "library_scan_depth": 20,
        }

    async def test_batch_waveforms_generate_uncached_files_concurrently(self):
        active = 0
        max_active = 0
        guard = threading.Lock()

        def fake_generate(_path, samples, _preview_cache_mb):
            nonlocal active, max_active
            with guard:
                active += 1
                max_active = max(max_active, active)
            time.sleep(0.05)
            with guard:
                active -= 1
            return {
                "status": "success",
                "data": [0.0, 0.5] * samples,
                "duration": 1.0,
                "sample_rate": 48000,
                "samples": samples,
            }

        with patch.object(main, "load_sound_effects_config", self._config), \
             patch.object(main, "get_waveform_cache_library", return_value=None), \
             patch.object(main, "set_waveform_cache_library", return_value=True), \
             patch.object(main, "generate_waveform_data", side_effect=fake_generate):
            result = await main.get_sound_waveforms_batch(
                main.BatchWaveformRequest(paths=self.files, samples=80)
            )

        self.assertEqual(result["status"], "success")
        self.assertEqual(set(result["waveforms"].keys()), set(self.files))
        self.assertGreater(
            max_active,
            1,
            "batch endpoint should generate multiple uncached waveforms in parallel",
        )

    async def test_precompute_counts_cached_files_as_done(self):
        scan_files = [
            {"relative_path": os.path.basename(path)}
            for path in self.files[:2]
        ]
        background_tasks = BackgroundTasks()

        with patch.object(main, "load_sound_effects_config", self._config), \
             patch.object(main, "get_sound_library_scan_data", return_value={"files": scan_files}), \
             patch.object(main, "get_waveform_cache_library", return_value={
                 "status": "success",
                 "data": [0.0, 0.5],
                 "duration": 1.0,
                 "sample_rate": 48000,
             }), \
             patch.object(main, "generate_waveform_data") as generate_mock:
            result = await main.precompute_waveforms_endpoint(
                main.PrecomputeWaveformsRequest(
                    library_path=self.library_path,
                    samples=80,
                    workers=2,
                ),
                background_tasks,
            )
            await background_tasks()

        self.assertEqual(result["total"], 2)
        self.assertFalse(main._precompute_state["running"])
        self.assertEqual(main._precompute_state["total"], 2)
        self.assertEqual(main._precompute_state["done"], 2)
        generate_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
