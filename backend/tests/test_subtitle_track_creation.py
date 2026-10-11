import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import main as backend_main


class DelayedSubtitleTrackTimeline:
    def __init__(self, visible_after_checks=3):
        self.add_track_calls = 0
        self.subtitle_checks_after_add = 0
        self.visible_after_checks = visible_after_checks

    @property
    def subtitle_track_visible(self):
        return (
            self.add_track_calls > 0
            and self.subtitle_checks_after_add >= self.visible_after_checks
        )

    def GetCurrentTimecode(self):
        return "01:00:00:00"

    def AddTrack(self, track_type):
        if track_type == "subtitle":
            self.add_track_calls += 1
            return True
        return False

    def GetTrackCount(self, track_type):
        if track_type != "subtitle":
            return 0
        if self.add_track_calls == 0:
            return 0
        self.subtitle_checks_after_add += 1
        return 1 if self.subtitle_track_visible else 0

    def GetItemListInTrack(self, track_type, track_index):
        return []


class FakeMediaPool:
    def __init__(self, timeline):
        self.timeline = timeline
        self.deleted = []

    def GetRootFolder(self):
        return FakeFolder()

    def SetCurrentFolder(self, folder):
        return True

    def ImportMedia(self, path):
        return [FakeMediaItem(path)]

    def AppendToTimeline(self, media_items):
        if not self.timeline.subtitle_track_visible:
            return []
        return [object()]

    def DeleteClips(self, media_items):
        self.deleted.extend(media_items)
        return True


class FakeFolder:
    def GetClipList(self):
        return []

    def GetSubFolderList(self):
        return []


class FakeMediaItem:
    def __init__(self, path):
        self.path = path

    def GetName(self):
        return os.path.basename(self.path)


class FakeResolveController:
    def __init__(self, media_pool):
        self.media_pool = media_pool

    def _get_active_timeline(self):
        return None


class SubtitleTrackCreationTest(unittest.TestCase):
    def test_waits_until_created_subtitle_track_is_visible_before_appending(self):
        timeline = DelayedSubtitleTrackTimeline(visible_after_checks=5)
        media_pool = FakeMediaPool(timeline)

        with tempfile.NamedTemporaryFile(suffix=".srt") as srt, \
                mock.patch.object(backend_main, "resolve_controller", FakeResolveController(media_pool)), \
                mock.patch.object(backend_main, "_build_subtitle_artifacts", return_value={
                    "srt_path": srt.name,
                    "subtitle_dir": os.path.dirname(srt.name),
                    "segment_count": 1,
                }), \
                mock.patch.object(backend_main, "_cleanup_subtitle_export_files"), \
                mock.patch.object(backend_main, "_restore_timeline_playhead"), \
                mock.patch.object(backend_main.time, "sleep"):
            result = backend_main._insert_subtitles_to_timeline(
                timeline,
                [{"start": 0, "end": 1, "text": "测试"}],
                24,
            )

        self.assertEqual(result["status"], "success")
        self.assertEqual(timeline.add_track_calls, 1)


if __name__ == "__main__":
    unittest.main()
