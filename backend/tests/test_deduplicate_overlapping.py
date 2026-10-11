"""_deduplicate_overlapping_segments 回归测试。

根因：旧实现用 `seg.start <= prev.end + tolerance` 判定重叠，
把首尾相接（seg.start == prev.end）的正常连续字幕误判为重叠而合并，
导致连续语音字幕每两条被吃掉一条。
"""
import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))


def _tc(h, m, s, f, fps=24):
    return round(h * 3600 + m * 60 + s + f / fps, 3)


class TestDeduplicateOverlapping(unittest.TestCase):
    def setUp(self):
        from main import _deduplicate_overlapping_segments
        self.dedup = _deduplicate_overlapping_segments

    def test_adjacent_segments_all_kept(self):
        """首尾相接的连续字幕不能被合并，必须全部保留。"""
        segs = [
            {"start": _tc(0, 0, 0, 0), "end": _tc(0, 0, 2, 23), "text": "一万尼特240帧3800分区"},
            {"start": _tc(0, 0, 2, 23), "end": _tc(0, 0, 4, 12), "text": "8只增强芯片还有AI"},
            {"start": _tc(0, 0, 4, 12), "end": _tc(0, 0, 6, 0), "text": "如果你在选购电视的话"},
            {"start": _tc(0, 0, 6, 0), "end": _tc(0, 0, 7, 19), "text": "你一定会看到这些名字"},
            {"start": _tc(0, 0, 7, 19), "end": _tc(0, 0, 9, 10), "text": "听起来真的很酷炫"},
            {"start": _tc(0, 0, 9, 10), "end": _tc(0, 0, 11, 12), "text": "好像我们看的东西都变得更亮了"},
            {"start": _tc(0, 0, 11, 12), "end": _tc(0, 0, 12, 6), "text": "更鲜艳了"},
            {"start": _tc(0, 0, 12, 6), "end": _tc(0, 0, 13, 2), "text": "更丝滑了"},
            {"start": _tc(0, 0, 13, 2), "end": _tc(0, 0, 14, 18), "text": "这好像没有什么问题"},
            {"start": _tc(0, 0, 14, 18), "end": _tc(0, 0, 16, 8), "text": "我们可以更好地享受内容"},
            {"start": _tc(0, 0, 16, 8), "end": _tc(0, 0, 17, 21), "text": "但真的是这样吗"},
            {"start": _tc(0, 0, 17, 21), "end": _tc(0, 0, 19, 9), "text": "你有没有注意到一个细节"},
        ]
        out = self.dedup([dict(s) for s in segs])
        self.assertEqual(len(out), 12, f"连续字幕被误删，仅剩 {len(out)} 条")
        self.assertEqual([o["text"] for o in out], [s["text"] for s in segs])

    def test_true_overlap_is_merged(self):
        """真正重叠（后一条明显侵入前一条）应去重，保留文本较长者。"""
        segs = [
            {"start": 0.0, "end": 5.0, "text": "完整的较长字幕内容"},
            {"start": 1.0, "end": 4.0, "text": "短"},  # 完全落在上一条内部
        ]
        out = self.dedup([dict(s) for s in segs])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["text"], "完整的较长字幕内容")

    def test_duplicate_same_range_merged(self):
        """同一区间的重复条目应合并为一条。"""
        segs = [
            {"start": 2.0, "end": 5.0, "text": "重复字幕"},
            {"start": 2.0, "end": 5.0, "text": "重复字幕"},
        ]
        out = self.dedup([dict(s) for s in segs])
        self.assertEqual(len(out), 1)

    def test_small_overlap_within_tolerance_kept_as_adjacent(self):
        """微小的浮点误差级别重叠（<= tolerance）按相接处理，不删字幕。"""
        segs = [
            {"start": 0.0, "end": 2.0, "text": "第一条"},
            {"start": 1.995, "end": 4.0, "text": "第二条"},  # 重叠 0.005s，属浮点误差
        ]
        out = self.dedup([dict(s) for s in segs])
        self.assertEqual(len(out), 2)


if __name__ == "__main__":
    unittest.main()
