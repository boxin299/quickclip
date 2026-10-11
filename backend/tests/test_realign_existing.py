"""变速匹配 realign_existing_subtitles 测试。

变速匹配语义（区别于同步时间线）：
- 只调整时间线「已有字幕」的位置，文本始终用当前字幕文本（不还原成绑定时的旧文本）
- 不给本身没字幕的片段新增字幕
- 没匹配到音频片段的字幕（如别的轨道）原样保留，绝不删除
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


class TestRealignExisting(unittest.TestCase):
    def setUp(self):
        self.tracker = SubtitleSpeedTracker()
        self.session = "sm"
        self.tracker.create_session(self.session, fps=24, track_type="audio", track_index=1)

    def test_uses_current_text_not_bound_text(self):
        """问题1：用户改过的字幕文本不能被还原成绑定时的旧文本。"""
        # 绑定时记录旧文本
        self.tracker._bindings[self.session] = [
            SubtitleBinding(
                subtitle_index=0, media_path="/v/a.mp4",
                sub_source_start=2.0, sub_source_end=4.0,
                root_id="sub-0", root_source_start=2.0, root_source_end=4.0,
                root_text="旧的转录文本",
            ),
        ]
        snapshot = [
            ClipSnapshot(clip_name="A", clip_path="/v/a.mp4",
                         timeline_start=0.0, timeline_end=10.0,
                         source_start=0.0, source_end=10.0, speed=1.0),
        ]
        # 当前时间线字幕：用户已改成新文本
        current = [{"start": 2.0, "end": 4.0, "text": "我手动改过的文本"}]
        updated, _ = self.tracker.realign_existing_subtitles(current, snapshot, self.session)
        self.assertEqual(len(updated), 1)
        self.assertEqual(updated[0]["text"], "我手动改过的文本")

    def test_does_not_add_subtitle_to_unlabeled_region(self):
        """问题2：本身没字幕的片段，不会被凭空加上字幕。"""
        # binding 覆盖源 2-4s（A 片段的字幕）
        self.tracker._bindings[self.session] = [
            SubtitleBinding(
                subtitle_index=0, media_path="/v/a.mp4",
                sub_source_start=2.0, sub_source_end=4.0,
                root_id="sub-0", root_source_start=2.0, root_source_end=4.0,
                root_text="A的字幕",
            ),
        ]
        # 快照：A 在原位置，B 是同源片段追加到末尾（源 2-4 也落在 B 内）
        snapshot = [
            ClipSnapshot(clip_name="A", clip_path="/v/a.mp4",
                         timeline_start=0.0, timeline_end=10.0,
                         source_start=0.0, source_end=10.0, speed=1.0),
            ClipSnapshot(clip_name="B追加", clip_path="/v/a.mp4",
                         timeline_start=100.0, timeline_end=104.0,
                         source_start=1.0, source_end=5.0, speed=1.0),
        ]
        # 当前时间线只有 A 的字幕，B 区间没有字幕
        current = [{"start": 2.0, "end": 4.0, "text": "A的字幕"}]
        updated, _ = self.tracker.realign_existing_subtitles(current, snapshot, self.session)
        # 只应有 1 条（A），不应给 B 凭空加字幕
        self.assertEqual(len(updated), 1)
        starts = [round(s["start"], 1) for s in updated]
        self.assertNotIn(101.0, starts)

    def test_keeps_unmatched_subtitle(self):
        """问题3：没匹配到音频片段的字幕（如别的轨道）原样保留，不删除。"""
        # 绑定在第一轨道的音频
        self.tracker._bindings[self.session] = [
            SubtitleBinding(
                subtitle_index=0, media_path="/v/a.mp4",
                sub_source_start=2.0, sub_source_end=4.0,
                root_id="sub-0", root_source_start=2.0, root_source_end=4.0,
                root_text="第一轨字幕",
            ),
        ]
        snapshot = [
            ClipSnapshot(clip_name="A", clip_path="/v/a.mp4",
                         timeline_start=0.0, timeline_end=10.0,
                         source_start=0.0, source_end=10.0, speed=1.0),
        ]
        # 当前字幕：一条对应第一轨音频，一条对应第二轨（快照里没有，无法匹配）
        current = [
            {"start": 2.0, "end": 4.0, "text": "第一轨字幕"},
            {"start": 50.0, "end": 52.0, "text": "第二轨字幕"},
        ]
        updated, _ = self.tracker.realign_existing_subtitles(current, snapshot, self.session)
        texts = [s["text"] for s in updated]
        # 两条都要保留
        self.assertIn("第一轨字幕", texts)
        self.assertIn("第二轨字幕", texts)
        self.assertEqual(len(updated), 2)
        # 第二轨字幕保持原位置不变
        second = [s for s in updated if s["text"] == "第二轨字幕"][0]
        self.assertEqual(second["start"], 50.0)
        self.assertEqual(second["end"], 52.0)

    def test_speed_change_repositions(self):
        """变速后，匹配到的字幕位置应随片段位置/速度更新。"""
        self.tracker._bindings[self.session] = [
            SubtitleBinding(
                subtitle_index=0, media_path="/v/a.mp4",
                sub_source_start=2.0, sub_source_end=4.0,
                root_id="sub-0", root_source_start=2.0, root_source_end=4.0,
                root_text="字幕",
            ),
        ]
        # 片段被移动到 timeline 20s 起，源仍是 0-10
        snapshot = [
            ClipSnapshot(clip_name="A", clip_path="/v/a.mp4",
                         timeline_start=20.0, timeline_end=30.0,
                         source_start=0.0, source_end=10.0, speed=1.0),
        ]
        current = [{"start": 2.0, "end": 4.0, "text": "字幕"}]
        updated, change_log = self.tracker.realign_existing_subtitles(current, snapshot, self.session)
        self.assertEqual(len(updated), 1)
        # 源 2-4s 现在映射到 timeline 22-24s
        self.assertEqual(round(updated[0]["start"], 1), 22.0)
        self.assertEqual(round(updated[0]["end"], 1), 24.0)


class TestBladeCutSplit(unittest.TestCase):
    """分割点切断已禁用：相邻、文本相同的字幕不再按时长比例重分配文本。"""

    def setUp(self):
        self.tracker = SubtitleSpeedTracker()
        self.session = "blade"
        self.tracker.create_session(self.session, fps=24, track_type="audio", track_index=1)

    def test_blade_cut_keeps_text_unchanged(self):
        """一条字幕被剃刀切成两条（文本相同），不再自动按分割点拆文字。"""
        # 绑定时是完整一条 "今天天气真的非常好"，源 0-9s
        self.tracker._bindings[self.session] = [
            SubtitleBinding(
                subtitle_index=0, media_path="/v/a.mp4",
                sub_source_start=0.0, sub_source_end=9.0,
                root_id="blade-root-0", root_source_start=0.0, root_source_end=9.0,
                root_text="今天天气真的非常好",
            ),
            SubtitleBinding(
                subtitle_index=1, media_path="/v/a.mp4",
                sub_source_start=0.0, sub_source_end=9.0,
                root_id="blade-root-0", root_source_start=0.0, root_source_end=9.0,
                root_text="今天天气真的非常好",
            ),
        ]
        snapshot = [
            ClipSnapshot(clip_name="A", clip_path="/v/a.mp4",
                         timeline_start=0.0, timeline_end=9.0,
                         source_start=0.0, source_end=9.0, speed=1.0),
        ]
        # 时间线上：剃刀切成两条，文本都还是全文，时间相邻
        current = [
            {"start": 0.0, "end": 6.0, "text": "今天天气真的非常好", "track_index": 1},
            {"start": 6.0, "end": 9.0, "text": "今天天气真的非常好", "track_index": 1},
        ]
        updated, _ = self.tracker.realign_existing_subtitles(current, snapshot, self.session)
        self.assertEqual(len(updated), 2)
        self.assertEqual(updated[0]["text"], "今天天气真的非常好")
        self.assertEqual(updated[1]["text"], "今天天气真的非常好")
        self.assertEqual(updated[0]["start"], 0.0)
        self.assertEqual(updated[0]["end"], 6.0)
        self.assertEqual(updated[1]["start"], 6.0)
        self.assertEqual(updated[1]["end"], 9.0)

    def test_blade_split_keeps_custom_split_point(self):
        """分割点是用户自定义的（非整条中点），不再触发文字重分配。"""
        self.tracker._bindings[self.session] = [
            SubtitleBinding(
                subtitle_index=0, media_path="/v/a.mp4",
                sub_source_start=10.0, sub_source_end=12.0,
                root_id="blade-root-x", root_source_start=10.0, root_source_end=12.0,
                root_text="前半后半",
            ),
            SubtitleBinding(
                subtitle_index=1, media_path="/v/a.mp4",
                sub_source_start=10.0, sub_source_end=12.0,
                root_id="blade-root-x", root_source_start=10.0, root_source_end=12.0,
                root_text="前半后半",
            ),
        ]
        snapshot = [
            ClipSnapshot(clip_name="A", clip_path="/v/a.mp4",
                         timeline_start=10.0, timeline_end=12.0,
                         source_start=10.0, source_end=12.0, speed=1.0),
        ]
        # 用户在 11.0s 处分割（不是中点）
        current = [
            {"start": 10.0, "end": 11.0, "text": "前半后半", "track_index": 1},
            {"start": 11.0, "end": 12.0, "text": "前半后半", "track_index": 1},
        ]
        updated, _ = self.tracker.realign_existing_subtitles(current, snapshot, self.session)
        self.assertEqual(len(updated), 2)
        self.assertEqual(updated[0]["start"], 10.0)
        self.assertEqual(updated[0]["end"], 11.0)
        self.assertEqual(updated[1]["start"], 11.0)
        self.assertEqual(updated[1]["end"], 12.0)
        self.assertEqual(updated[0]["text"], "前半后半")
        self.assertEqual(updated[1]["text"], "前半后半")


    def test_non_blade_identical_distant_text_not_split(self):
        """文本相同但不相邻的两条字幕（非剃刀切割）不重分配，各自保留全文。"""
        self.tracker._bindings[self.session] = [
            SubtitleBinding(
                subtitle_index=0, media_path="/v/a.mp4",
                sub_source_start=0.0, sub_source_end=3.0,
                root_id="sub-0", root_source_start=0.0, root_source_end=3.0,
                root_text="重复台词",
            ),
            SubtitleBinding(
                subtitle_index=1, media_path="/v/a.mp4",
                sub_source_start=20.0, sub_source_end=23.0,
                root_id="sub-1", root_source_start=20.0, root_source_end=23.0,
                root_text="重复台词",
            ),
        ]
        snapshot = [
            ClipSnapshot(clip_name="A", clip_path="/v/a.mp4",
                         timeline_start=0.0, timeline_end=30.0,
                         source_start=0.0, source_end=30.0, speed=1.0),
        ]
        # 两条文本相同但时间不相邻（中间隔很远）
        current = [
            {"start": 0.0, "end": 3.0, "text": "重复台词", "track_index": 1},
            {"start": 20.0, "end": 23.0, "text": "重复台词", "track_index": 1},
        ]
        updated, _ = self.tracker.realign_existing_subtitles(current, snapshot, self.session)
        self.assertEqual(len(updated), 2)
        # 不相邻 → 不是剃刀切割 → 各自保留全文
        self.assertEqual(updated[0]["text"], "重复台词")
        self.assertEqual(updated[1]["text"], "重复台词")

    def test_added_newline_splits_single_subtitle(self):
        """用户在当前字幕中新加回车时，按新增回车位置拆成多条字幕。"""
        self.tracker._bindings[self.session] = [
            SubtitleBinding(
                subtitle_index=0, media_path="/v/a.mp4",
                sub_source_start=0.0, sub_source_end=10.0,
                root_id="sub-0", root_source_start=0.0, root_source_end=10.0,
                root_text="1234567890",
            ),
        ]
        snapshot = [
            ClipSnapshot(clip_name="A", clip_path="/v/a.mp4",
                         timeline_start=0.0, timeline_end=10.0,
                         source_start=0.0, source_end=10.0, speed=1.0),
        ]
        current = [{"start": 0.0, "end": 10.0, "text": "12345\n67890", "track_index": 1}]
        updated, change_log = self.tracker.realign_existing_subtitles(current, snapshot, self.session)
        self.assertEqual(len(updated), 2)
        self.assertEqual(updated[0]["text"], "12345")
        self.assertEqual(updated[1]["text"], "67890")
        self.assertEqual(updated[0]["start"], 0.0)
        self.assertEqual(updated[0]["end"], 5.0)
        self.assertEqual(updated[1]["start"], 5.0)
        self.assertEqual(updated[1]["end"], 10.0)
        self.assertTrue(any(item["description"] == "新增换行切分" for item in change_log))

    def test_existing_newline_does_not_split_again(self):
        """原绑定文本里已有的回车不是用户新增断句，不应触发拆块。"""
        self.tracker._bindings[self.session] = [
            SubtitleBinding(
                subtitle_index=0, media_path="/v/a.mp4",
                sub_source_start=0.0, sub_source_end=10.0,
                root_id="sub-0", root_source_start=0.0, root_source_end=10.0,
                root_text="12345\n67890",
            ),
        ]
        snapshot = [
            ClipSnapshot(clip_name="A", clip_path="/v/a.mp4",
                         timeline_start=0.0, timeline_end=10.0,
                         source_start=0.0, source_end=10.0, speed=1.0),
        ]
        current = [{"start": 0.0, "end": 10.0, "text": "12345\n67890", "track_index": 1}]
        updated, change_log = self.tracker.realign_existing_subtitles(current, snapshot, self.session)
        self.assertEqual(len(updated), 1)
        self.assertEqual(updated[0]["text"], "12345\n67890")
        self.assertFalse(any(item["description"] == "新增换行切分" for item in change_log))



class TestRebuiltBindingsAfterManualSplit(unittest.TestCase):
    """手动分割点不再触发断句；字幕变化后通过重建绑定让每条字幕独立跟随。"""

    def setUp(self):
        self.tracker = SubtitleSpeedTracker()
        self.session = "shift"
        self.tracker.create_session(self.session, fps=24, track_type="audio", track_index=1)

    def test_rebuilt_bindings_keep_subtitles_independent_after_manual_split(self):
        initial_snapshot = [
            ClipSnapshot(clip_name="A", clip_path="/v/a.mp4",
                         timeline_start=0.0, timeline_end=9.0,
                         source_start=0.0, source_end=9.0, speed=1.0),
        ]
        current = [
            {"start": 0.0, "end": 1.5, "text": "第一条", "track_index": 1},
            {"start": 1.5, "end": 3.0, "text": "第一条", "track_index": 1},
            {"start": 3.0, "end": 6.0, "text": "第二条", "track_index": 1},
            {"start": 6.0, "end": 9.0, "text": "第三条", "track_index": 1},
        ]
        bindings = self.tracker.create_bindings_from_timeline(current, initial_snapshot, self.session)
        self.assertEqual(len(bindings), 4)

        moved_snapshot = [
            ClipSnapshot(clip_name="A", clip_path="/v/a.mp4",
                         timeline_start=100.0, timeline_end=109.0,
                         source_start=0.0, source_end=9.0, speed=1.0),
        ]
        updated, _ = self.tracker.realign_existing_subtitles(current, moved_snapshot, self.session)
        self.assertEqual(len(updated), 4)

        second = [s for s in updated if s["text"] == "第二条"]
        self.assertEqual(len(second), 1)
        self.assertEqual(round(second[0]["start"], 1), 103.0)
        self.assertEqual(round(second[0]["end"], 1), 106.0)

        third = [s for s in updated if s["text"] == "第三条"]
        self.assertEqual(len(third), 1)
        self.assertEqual(round(third[0]["start"], 1), 106.0)
        self.assertEqual(round(third[0]["end"], 1), 109.0)


class TestRebuildBindingsAfterSplit(unittest.TestCase):
    """字幕变化后重建绑定：绑定数始终与当前字幕一致，支持多次分割。"""

    def setUp(self):
        self.tracker = SubtitleSpeedTracker()
        self.session = "rebuild"
        self.tracker.create_session(self.session, fps=24, track_type="audio", track_index=1)
        self.snapshot = [
            ClipSnapshot(clip_name="A", clip_path="/v/a.mp4",
                         timeline_start=0.0, timeline_end=12.0,
                         source_start=0.0, source_end=12.0, speed=1.0),
        ]

    def test_rebuild_matches_current_subtitle_count(self):
        # 初始 2 条
        subs = [
            {"start": 0.0, "end": 6.0, "text": "第一句", "track_index": 1},
            {"start": 6.0, "end": 12.0, "text": "第二句", "track_index": 1},
        ]
        b1 = self.tracker.create_bindings_from_timeline(subs, self.snapshot, self.session)
        self.assertEqual(len(b1), 2)

        # 第一次分割：第一句切成两段（已分好不同文字），共 3 条
        subs2 = [
            {"start": 0.0, "end": 3.0, "text": "第一", "track_index": 1},
            {"start": 3.0, "end": 6.0, "text": "句", "track_index": 1},
            {"start": 6.0, "end": 12.0, "text": "第二句", "track_index": 1},
        ]
        b2 = self.tracker.create_bindings_from_timeline(subs2, self.snapshot, self.session)
        self.assertEqual(len(b2), 3)

        # 第二次分割：第二句也切成两段，共 4 条 —— 不应缺失
        subs3 = [
            {"start": 0.0, "end": 3.0, "text": "第一", "track_index": 1},
            {"start": 3.0, "end": 6.0, "text": "句", "track_index": 1},
            {"start": 6.0, "end": 9.0, "text": "第", "track_index": 1},
            {"start": 9.0, "end": 12.0, "text": "二句", "track_index": 1},
        ]
        b3 = self.tracker.create_bindings_from_timeline(subs3, self.snapshot, self.session)
        self.assertEqual(len(b3), 4)

        # 重建后用 realign 做纯音频变速（片段移到 100s），4 条都应独立跟随、不丢
        moved = [
            ClipSnapshot(clip_name="A", clip_path="/v/a.mp4",
                         timeline_start=100.0, timeline_end=112.0,
                         source_start=0.0, source_end=12.0, speed=1.0),
        ]
        updated, _ = self.tracker.realign_existing_subtitles(subs3, moved, self.session)
        self.assertEqual(len(updated), 4)
        texts = [s["text"] for s in updated]
        self.assertEqual(texts, ["第一", "句", "第", "二句"])
        # 位置随片段平移到 100s 起
        self.assertEqual(round(updated[0]["start"], 1), 100.0)
        self.assertEqual(round(updated[3]["end"], 1), 112.0)


if __name__ == "__main__":
    unittest.main()
