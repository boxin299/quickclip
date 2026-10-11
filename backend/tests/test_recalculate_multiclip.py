"""recalculate_subtitles 多片段映射回归测试。

根因：普通字幕 binding 在快照中只匹配「第一个」源时间重叠的 clip 就 break，
导致同一段源内容在时间线上出现多次（如把视频片段追加到末尾）时，
只有第一次出现的位置有字幕，追加到末尾的同源片段没有字幕。

修复：普通组（非剃刀切点组）遍历所有源重叠 clip，各生成一条字幕。
剃刀切点组保持原行为（只取第一个匹配），避免影响字词重分配。
"""
import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from subtitle_speed_tracker import (
    SubtitleSpeedTracker,
    ClipSnapshot,
    SubtitleBinding,
)


class TestRecalculateMultiClip(unittest.TestCase):
    def setUp(self):
        self.tracker = SubtitleSpeedTracker()

    def _make_session_with_binding(self, session_id, binding):
        self.tracker.create_session(session_id, fps=24, track_type="audio", track_index=1)
        self.tracker._bindings[session_id] = [binding]

    def test_same_source_appears_twice_gets_subtitle_both_places(self):
        """同一段源内容在时间线出现两次（原位置 + 追加到末尾），两处都应有字幕。"""
        session = "s1"
        # 字幕绑定到源媒体 2.0s-4.0s
        binding = SubtitleBinding(
            subtitle_index=0,
            media_path="/v/a.mp4",
            sub_source_start=2.0,
            sub_source_end=4.0,
            root_id="root-0",
            root_source_start=2.0,
            root_source_end=4.0,
            root_text="测试字幕",
        )
        self._make_session_with_binding(session, binding)

        # 快照：源 2-4s 的内容出现在时间线两个位置
        snapshot = [
            ClipSnapshot(
                clip_name="原片段", clip_path="/v/a.mp4",
                timeline_start=0.0, timeline_end=10.0,
                source_start=0.0, source_end=10.0, speed=1.0,
            ),
            ClipSnapshot(
                clip_name="追加到末尾", clip_path="/v/a.mp4",
                timeline_start=100.0, timeline_end=104.0,
                source_start=1.0, source_end=5.0, speed=1.0,
            ),
        ]
        timeline_subs = [{"start": 2.0, "end": 4.0, "text": "测试字幕"}]

        updated, _ = self.tracker.recalculate_subtitles(timeline_subs, snapshot, session)
        visible = [s for s in updated if not s.get("hidden", False)]

        # 期望两条：原位置 (2-4s) + 末尾位置 (源2-4 映射到 timeline 101-103)
        self.assertEqual(len(visible), 2, f"应在两处都生成字幕，实际 {len(visible)} 条")
        starts = sorted(round(s["start"], 1) for s in visible)
        self.assertEqual(starts, [2.0, 101.0])
        for s in visible:
            self.assertEqual(s["text"], "测试字幕")

    def test_single_clip_still_one_subtitle(self):
        """源内容只出现一次时，仍只生成一条字幕（不回归）。"""
        session = "s2"
        binding = SubtitleBinding(
            subtitle_index=0, media_path="/v/a.mp4",
            sub_source_start=2.0, sub_source_end=4.0,
            root_id="root-0", root_source_start=2.0, root_source_end=4.0,
            root_text="唯一字幕",
        )
        self._make_session_with_binding(session, binding)
        snapshot = [
            ClipSnapshot(
                clip_name="c", clip_path="/v/a.mp4",
                timeline_start=0.0, timeline_end=10.0,
                source_start=0.0, source_end=10.0, speed=1.0,
            ),
        ]
        timeline_subs = [{"start": 2.0, "end": 4.0, "text": "唯一字幕"}]
        updated, _ = self.tracker.recalculate_subtitles(timeline_subs, snapshot, session)
        visible = [s for s in updated if not s.get("hidden", False)]
        self.assertEqual(len(visible), 1)

    def test_no_matching_clip_marks_hidden(self):
        """源内容在快照中不存在时，字幕标记为 hidden。"""
        session = "s3"
        binding = SubtitleBinding(
            subtitle_index=0, media_path="/v/a.mp4",
            sub_source_start=50.0, sub_source_end=52.0,
            root_id="root-0", root_source_start=50.0, root_source_end=52.0,
            root_text="无匹配",
        )
        self._make_session_with_binding(session, binding)
        snapshot = [
            ClipSnapshot(
                clip_name="c", clip_path="/v/a.mp4",
                timeline_start=0.0, timeline_end=10.0,
                source_start=0.0, source_end=10.0, speed=1.0,
            ),
        ]
        timeline_subs = [{"start": 50.0, "end": 52.0, "text": "无匹配"}]
        updated, _ = self.tracker.recalculate_subtitles(timeline_subs, snapshot, session)
        visible = [s for s in updated if not s.get("hidden", False)]
        self.assertEqual(len(visible), 0)


if __name__ == "__main__":
    unittest.main()
