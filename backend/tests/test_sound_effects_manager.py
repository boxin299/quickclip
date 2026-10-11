import os
import tempfile
import unittest

from app import sound_effects_manager as sm


class SoundEffectsManagerPerfTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.original_db_file = sm.ASSET_META_DB_FILE
        self.original_initialized = sm._asset_meta_db_initialized
        self._close_thread_local_conn()
        sm.ASSET_META_DB_FILE = os.path.join(self.tmp.name, "sfx_meta.sqlite3")
        sm._asset_meta_db_initialized = False
        sm._project_audio_basenames_cache.clear()

    def tearDown(self):
        self._close_thread_local_conn()
        sm.ASSET_META_DB_FILE = self.original_db_file
        sm._asset_meta_db_initialized = self.original_initialized
        sm._project_audio_basenames_cache.clear()
        self.tmp.cleanup()

    def _close_thread_local_conn(self):
        conn = getattr(sm._asset_meta_db_local, "conn", None)
        if conn is not None:
            conn.close()
            delattr(sm._asset_meta_db_local, "conn")

    def test_selected_folder_browse_includes_descendants_and_excludes_siblings(self):
        library_path = os.path.join(self.tmp.name, "library")
        foley_path = os.path.join(library_path, "Foley")
        steps_path = os.path.join(foley_path, "Steps")
        whoosh_path = os.path.join(library_path, "Whoosh")
        os.makedirs(steps_path)
        os.makedirs(whoosh_path)

        conn = sm._get_asset_meta_db()
        library_id = sm._library_cache_id(library_path, 20, None)
        rows = [
            (
                f"{library_path}::Foley/hit.wav",
                library_id,
                library_path,
                library_path,
                "Foley/hit.wav",
                "Foley",
                foley_path,
                os.path.join(foley_path, "hit.wav"),
                os.path.join(foley_path, "hit.wav").lower(),
                "hit",
                "hit",
                "hit.wav",
                "hit.wav",
                "foley/hit.wav",
                ".wav",
                10,
                0.01,
                "2026-05-13 00:00",
                "0:01",
                1.0,
                48000,
            ),
            (
                f"{library_path}::Foley/Steps/step.wav",
                library_id,
                library_path,
                library_path,
                "Foley/Steps/step.wav",
                "Foley/Steps",
                steps_path,
                os.path.join(steps_path, "step.wav"),
                os.path.join(steps_path, "step.wav").lower(),
                "step",
                "step",
                "step.wav",
                "step.wav",
                "foley/steps/step.wav",
                ".wav",
                12,
                0.01,
                "2026-05-13 00:00",
                "0:01",
                1.0,
                48000,
            ),
            (
                f"{library_path}::Whoosh/whoosh.wav",
                library_id,
                library_path,
                library_path,
                "Whoosh/whoosh.wav",
                "Whoosh",
                whoosh_path,
                os.path.join(whoosh_path, "whoosh.wav"),
                os.path.join(whoosh_path, "whoosh.wav").lower(),
                "whoosh",
                "whoosh",
                "whoosh.wav",
                "whoosh.wav",
                "whoosh/whoosh.wav",
                ".wav",
                14,
                0.01,
                "2026-05-13 00:00",
                "0:01",
                1.0,
                48000,
            ),
        ]
        with conn:
            conn.executemany(
                """
                INSERT INTO library_asset_index(
                  asset_key, library_id, library_path, actual_root, relative_path, parent_folder,
                  parent_path, path, path_lower, name, name_lower, filename, filename_lower,
                  relative_path_lower, extension, size, size_mb, modified, duration,
                  duration_seconds, sample_rate
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )

        result = sm.browse_sound_library_assets_index(
            library_path,
            selected_folder=foley_path,
            limit=20,
            offset=0,
        )

        self.assertEqual(result["total"], 2)
        self.assertEqual(
            {item["filename"] for item in result["items"]},
            {"hit.wav", "step.wav"},
        )

    def test_project_audio_basename_cache_reuses_recent_scan(self):
        project_audio_path = os.path.join(self.tmp.name, "project", "音效")
        os.makedirs(project_audio_path)
        hit_path = os.path.join(project_audio_path, "hit.wav")
        with open(hit_path, "wb") as handle:
            handle.write(b"wav")

        first = sm._get_project_audio_basenames(project_audio_path, ttl_seconds=60)
        os.remove(hit_path)
        cached = sm._get_project_audio_basenames(project_audio_path, ttl_seconds=60)
        refreshed = sm._get_project_audio_basenames(project_audio_path, ttl_seconds=0)

        self.assertEqual(first, {"hit.wav"})
        self.assertEqual(cached, {"hit.wav"})
        self.assertEqual(refreshed, set())

    def test_davinci_target_folder_preserves_forward_subfolder_hierarchy(self):
        target = sm.compute_davinci_target_folder(
            "Foley/Steps/wood.wav",
            "音效",
            folder_depth=2,
            direction="forward",
        )

        self.assertEqual(target, "音效/Foley/Steps")

    def test_davinci_target_folder_preserves_reverse_subfolder_hierarchy(self):
        target = sm.compute_davinci_target_folder(
            "Library/Foley/Steps/wood.wav",
            "音效",
            folder_depth=2,
            direction="reverse",
        )

        self.assertEqual(target, "音效/Foley/Steps")


if __name__ == "__main__":
    unittest.main()
