import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import resolve_api


class FakeMediaPoolItem:
    def __init__(self, file_path, props=None):
        self.file_path = file_path
        self.props = props or {}

    def GetClipProperty(self, key=None):
        if key is None:
            return self.props
        if key == "File Path":
            return self.file_path
        return self.props.get(key, "")

    def GetName(self):
        return os.path.basename(self.file_path)


class FakeFolder:
    def __init__(self, clips=None):
        self.clips = clips or []

    def GetClipList(self):
        return self.clips

    def GetSubFolderList(self):
        return []


class FakeTimelineClip:
    def __init__(self, start, end):
        self.start = start
        self.end = end

    def GetStart(self):
        return self.start

    def GetEnd(self):
        return self.end


class FakeTimeline:
    def __init__(self, audio_tracks=None):
        self.audio_tracks = audio_tracks or {1: []}
        self.added_tracks = 0

    def GetSetting(self, key):
        if key == "timelineFrameRate":
            return "24"
        return ""

    def GetCurrentTimecode(self):
        return "00:00:10:00"

    def GetTrackCount(self, track_type):
        return len(self.audio_tracks)

    def GetItemListInTrack(self, track_type, track_index):
        return self.audio_tracks.get(track_index, [])

    def AddTrack(self, track_type):
        next_index = len(self.audio_tracks) + 1
        self.audio_tracks[next_index] = []
        self.added_tracks += 1
        return True


class FakeProject:
    def __init__(self, timeline):
        self.timeline = timeline

    def GetCurrentTimeline(self):
        return self.timeline

    def GetSetting(self, key):
        if key == "timelineFrameRate":
            return "24"
        return ""


class FakeMediaPool:
    def __init__(self, root):
        self.root = root
        self.appended_clip_infos = []

    def GetRootFolder(self):
        return self.root

    def AppendToTimeline(self, clip_infos):
        self.appended_clip_infos.extend(clip_infos)
        if clip_infos and "endFrame" in clip_infos[0]:
            return [object()]
        return []


class ResolveSfxTimelineInsertTest(unittest.TestCase):
    def test_insert_without_io_appends_full_clip_range(self):
        with tempfile.NamedTemporaryFile(suffix=".wav") as audio:
            item = FakeMediaPoolItem(audio.name, {"Start": "0", "Duration": "00:00:02:00"})
            root = FakeFolder([item])

            with patch.object(resolve_api, "RESOLVE_AVAILABLE", False):
                controller = resolve_api.ResolveController()
            controller.resolve = object()
            controller.media_storage = object()
            controller.media_pool = FakeMediaPool(root)
            controller.project = FakeProject(FakeTimeline())
            controller._refresh_context = lambda: True

            result = controller.insert_audio_segment_to_timeline(audio.name, track_index=0)

            self.assertEqual(result["status"], "success")
            self.assertEqual(result["added"], 1)
            self.assertEqual(controller.media_pool.appended_clip_infos[0]["startFrame"], 0)
            self.assertEqual(controller.media_pool.appended_clip_infos[0]["endFrame"], 48)
            self.assertEqual(controller.media_pool.appended_clip_infos[0]["recordFrame"], 240)

    def test_insert_uses_full_sound_duration_when_choosing_gap(self):
        with tempfile.NamedTemporaryFile(suffix=".wav") as audio:
            item = FakeMediaPoolItem(audio.name, {"Start": "0", "Duration": "00:00:02:00"})
            root = FakeFolder([item])
            timeline = FakeTimeline({1: [FakeTimelineClip(264, 320)]})

            with patch.object(resolve_api, "RESOLVE_AVAILABLE", False):
                controller = resolve_api.ResolveController()
            controller.resolve = object()
            controller.media_storage = object()
            controller.media_pool = FakeMediaPool(root)
            controller.project = FakeProject(timeline)
            controller._refresh_context = lambda: True

            result = controller.insert_audio_segment_to_timeline(audio.name, track_index=0)

            self.assertEqual(result["status"], "success")
            self.assertEqual(result["trackIndex"], 2)
            self.assertEqual(timeline.added_tracks, 1)
            self.assertEqual(controller.media_pool.appended_clip_infos[0]["recordFrame"], 240)
            self.assertEqual(controller.media_pool.appended_clip_infos[0]["endFrame"], 48)


if __name__ == "__main__":
    unittest.main()
