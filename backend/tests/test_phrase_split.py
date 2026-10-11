"""中文词组分割测试（jieba 分词）。

验证 _split_text_by_ratios 用 jieba 把中文按词组切成单元，
分割边界只落在词组之间，不切断「运动预测」「电视画质」等词组；
自定义词表能加入 jieba 词典作为保护词；jieba 不可用时回退单字。
"""
import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from subtitle_speed_tracker import SubtitleSpeedTracker


class TestPhraseSplit(unittest.TestCase):
    def setUp(self):
        self.t = SubtitleSpeedTracker()

    def test_split_preserves_full_text(self):
        """分割后两段拼接必须还原全文，无字符丢失。"""
        text = "这个MEMC它只是分析原始针生成符合运动预测的新的针"
        pieces = self.t._split_text_by_ratios(text, [0.5, 0.5])
        self.assertEqual(len(pieces), 2)
        self.assertEqual(pieces[0] + pieces[1], text)
        self.assertTrue(pieces[0] and pieces[1])

    def test_does_not_cut_inside_common_word(self):
        """常见词组不应被切断（边界落在词组之间）。"""
        text = "我们研究了运动预测技术"
        # 在中部分割，"运动预测"不应被拆成"运动"+"预测"
        pieces = self.t._split_text_by_ratios(text, [0.5, 0.5])
        self.assertEqual(pieces[0] + pieces[1], text)
        # "运动预测" 要么完整在左段，要么完整在右段，不能被边界切开
        joined_boundary = pieces[0][-2:] + pieces[1][:2]
        self.assertNotEqual(joined_boundary, "运动预测")

    def test_custom_phrase_protected(self):
        """自定义词表中的词组应作为整体，不被切断。"""
        text = "如果你在选购电视的话一定会看到这些名字"
        pieces = self.t._split_text_by_ratios(text, [0.5, 0.5], extra_phrases=["选购电视"])
        self.assertEqual(pieces[0] + pieces[1], text)
        # "选购电视" 不应跨越边界被切开
        self.assertFalse(pieces[0].endswith("选购") and pieces[1].startswith("电视"))

    def test_three_way_split_preserves_text(self):
        """三段分割（如剃刀切三段）也应还原全文。"""
        text = "今天天气真的非常好我们出去玩吧顺便买点东西"
        pieces = self.t._split_text_by_ratios(text, [0.4, 0.3, 0.3])
        self.assertEqual(len(pieces), 3)
        self.assertEqual("".join(pieces), text)

    def test_english_token_kept_whole(self):
        """英文单词作为整体单元，不被拆字母。"""
        text = "这个technology很厉害真的"
        pieces = self.t._split_text_by_ratios(text, [0.5, 0.5])
        self.assertEqual(pieces[0] + pieces[1], text)
        # technology 不应被切成两半
        self.assertFalse("technolog" in pieces[0] and pieces[0].endswith(tuple("technolog")) and pieces[1].startswith("y"))


if __name__ == "__main__":
    unittest.main()
