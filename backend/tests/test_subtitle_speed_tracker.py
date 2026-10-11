import unittest
from app.subtitle_speed_tracker import SubtitleSpeedTracker


class TestBladeCutDetection(unittest.TestCase):
    def setUp(self):
        self.tracker = SubtitleSpeedTracker()

    def test_detect_blade_cuts_two_adjacent_same_text(self):
        subtitles = [
            {"start": 0.0, "end": 4.0, "text": "今天晚上我一直在改代码", "track_index": 1},
            {"start": 4.0, "end": 10.0, "text": "今天晚上我一直在改代码", "track_index": 1},
        ]
        groups = self.tracker.detect_blade_cut_groups(subtitles)
        self.assertEqual(len(groups), 1)
        self.assertEqual(len(groups[0]), 2)
        self.assertEqual(groups[0][0]["start"], 0.0)
        self.assertEqual(groups[0][1]["start"], 4.0)

    def test_detect_blade_cuts_different_text_not_detected(self):
        subtitles = [
            {"start": 0.0, "end": 4.0, "text": "今天天气很好", "track_index": 1},
            {"start": 4.0, "end": 10.0, "text": "我在改代码", "track_index": 1},
        ]
        groups = self.tracker.detect_blade_cut_groups(subtitles)
        self.assertEqual(len(groups), 0)

    def test_detect_blade_cuts_three_adjacent(self):
        subtitles = [
            {"start": 0.0, "end": 3.0, "text": "今天天气很好", "track_index": 1},
            {"start": 3.0, "end": 6.0, "text": "今天天气很好", "track_index": 1},
            {"start": 6.0, "end": 10.0, "text": "今天天气很好", "track_index": 1},
        ]
        groups = self.tracker.detect_blade_cut_groups(subtitles)
        self.assertEqual(len(groups), 1)
        self.assertEqual(len(groups[0]), 3)

    def test_detect_blade_cuts_multiple_groups(self):
        subtitles = [
            {"start": 0.0, "end": 2.0, "text": "AAA", "track_index": 1},
            {"start": 2.0, "end": 5.0, "text": "AAA", "track_index": 1},
            {"start": 5.0, "end": 8.0, "text": "BBB", "track_index": 1},
            {"start": 8.0, "end": 10.0, "text": "BBB", "track_index": 1},
        ]
        groups = self.tracker.detect_blade_cut_groups(subtitles)
        self.assertEqual(len(groups), 2)

    def test_detect_blade_cuts_different_tracks_not_grouped(self):
        subtitles = [
            {"start": 0.0, "end": 4.0, "text": "今天天气很好", "track_index": 1},
            {"start": 0.0, "end": 4.0, "text": "今天天气很好", "track_index": 2},
        ]
        groups = self.tracker.detect_blade_cut_groups(subtitles)
        self.assertEqual(len(groups), 0)

    def test_blade_cut_redistribute_words_by_time_ratio(self):
        text = "今天晚上我一直在改代码"
        ratios = [4.0, 6.0]
        pieces = self.tracker._split_text_by_ratios(text, ratios)
        self.assertEqual(len(pieces), 2)
        self.assertTrue(len(pieces[0].strip()) > 0)
        self.assertTrue(len(pieces[1].strip()) > 0)
        self.assertEqual(
            len(pieces[0].replace(" ", "")) + len(pieces[1].replace(" ", "")),
            len(text.replace(" ", ""))
        )


class FakeSubtitleItem:
    def __init__(self, name, text, start=0, end=240):
        self.name = name
        self.text = text
        self.start = start
        self.end = end

    def GetName(self):
        return self.name

    def GetProperty(self, key=None):
        props = {"Text": self.text}
        if key is None:
            return props
        return props.get(key)

    def GetStart(self):
        return self.start

    def GetEnd(self):
        return self.end


class FakeSubtitleTimeline:
    def __init__(self, items):
        self.items = items

    def GetTrackCount(self, track_type):
        return 1 if track_type == "subtitle" else 0

    def GetItemListInTrack(self, track_type, track_index):
        if track_type == "subtitle" and track_index == 1:
            return self.items
        return []

    def GetStartFrame(self):
        return 0


class FakeMediaPoolItem:
    def __init__(self, properties=None, media_id="media-1"):
        self.properties = properties or {}
        self.media_id = media_id

    def GetClipProperty(self, key=None):
        if key is None:
            return self.properties
        return self.properties.get(key)

    def GetMediaId(self):
        return self.media_id


class FakeAudioClip:
    def __init__(
        self,
        name="A001",
        start=0,
        end=250,
        source_start=0,
        source_end=250,
        media_pool_item=None,
    ):
        self.name = name
        self.start = start
        self.end = end
        self.source_start = source_start
        self.source_end = source_end
        self.media_pool_item = media_pool_item or FakeMediaPoolItem()

    def GetName(self):
        return self.name

    def GetStart(self):
        return self.start

    def GetEnd(self):
        return self.end

    def GetSourceStartFrame(self):
        return self.source_start

    def GetSourceEndFrame(self):
        return self.source_end

    def GetMediaPoolItem(self):
        return self.media_pool_item


class FakeClipTimeline:
    def __init__(self, clips, start_frame=0):
        self.clips = clips
        self.start_frame = start_frame

    def GetItemListInTrack(self, track_type, track_index):
        if track_type == "audio" and track_index == 1:
            return self.clips
        return []

    def GetTrackCount(self, track_type):
        return 1 if track_type == "audio" else 0

    def GetStartFrame(self):
        return self.start_frame


class TestTimelineSubtitleTextReading(unittest.TestCase):
    def setUp(self):
        self.tracker = SubtitleSpeedTracker()

    def test_reads_subtitle_text_property_before_name(self):
        timeline = FakeSubtitleTimeline([
            FakeSubtitleItem(name="1234567890", text="12345\n67890"),
        ])
        subtitles = self.tracker.read_timeline_subtitles(timeline, fps=24)
        self.assertEqual(subtitles[0]["text"], "12345\n67890")

    def test_subtitle_hash_changes_when_text_property_changes_but_name_does_not(self):
        before = FakeSubtitleTimeline([
            FakeSubtitleItem(name="1234567890", text="1234567890"),
        ])
        after = FakeSubtitleTimeline([
            FakeSubtitleItem(name="1234567890", text="12345\n67890"),
        ])
        self.assertNotEqual(
            self.tracker.get_subtitle_hash(before),
            self.tracker.get_subtitle_hash(after),
        )


class TestClipSnapshotCollection(unittest.TestCase):
    def setUp(self):
        self.tracker = SubtitleSpeedTracker()

    def test_collect_snapshot_accepts_resolve_frame_rate_strings(self):
        clip = FakeAudioClip(
            start=0,
            end=250,
            source_start=0,
            source_end=250,
            media_pool_item=FakeMediaPoolItem({
                "FPS": "25 fps",
                "File Path": "/media/a.wav",
            }),
        )
        timeline = FakeClipTimeline([clip])

        tracks = self.tracker.list_audio_tracks(timeline)
        snapshot = self.tracker.collect_snapshot(timeline, fps=25, track_type="audio", track_index=1, session_id="sm")

        self.assertEqual(tracks[0]["clip_count"], 1)
        self.assertEqual(len(snapshot), 1)
        self.assertEqual(snapshot[0].clip_path, "/media/a.wav")
        self.assertEqual(snapshot[0].source_frame_rate, 25.0)

    def test_collect_snapshot_falls_back_to_timeline_fps_when_media_fps_is_blank(self):
        clip = FakeAudioClip(
            start=100,
            end=340,
            source_start=48,
            source_end=288,
            media_pool_item=FakeMediaPoolItem({
                "FPS": "",
                "Frame Rate": None,
                "File Path": "/media/blank-fps.wav",
            }),
        )
        timeline = FakeClipTimeline([clip], start_frame=100)

        snapshot = self.tracker.collect_snapshot(timeline, fps=24, track_type="audio", track_index=1, session_id="sm")

        self.assertEqual(len(snapshot), 1)
        self.assertEqual(snapshot[0].timeline_start, 0.0)
        self.assertEqual(snapshot[0].timeline_end, 10.0)
        self.assertEqual(snapshot[0].source_start, 2.0)
        self.assertEqual(snapshot[0].source_end, 12.0)
        self.assertEqual(snapshot[0].source_frame_rate, 24.0)
