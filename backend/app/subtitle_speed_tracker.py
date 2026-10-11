"""
字幕变速匹配追踪器
基于源媒体时间（Source-Time Anchor Mapping）实现无状态的绝对位置映射。

核心逻辑：
1. 初始化：遍历指定音频轨道，根据重叠度将每个字幕绑定到音频 clip 的源媒体时间段（Source Time）。
2. 轮询：快速比对时间线状态（Hash），若无变化则跳过。
3. 重算：若有变化，根据字幕绑定的 Source Time，在当前音频轨道中查找对应的 clip，并将其绝对映射回时间线位置（Timeline Time）。
这种方式天然支持裁剪、移动、变速、分割等复杂操作，且不会产生状态累积误差。
"""

import time
import copy
import re
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass, field

# ====== 日志收集器 ======
class TrackerLogger:
    """收集追踪过程中的日志，供前端查看"""
    def __init__(self):
        self._logs: List[Dict[str, Any]] = []
        self._max_logs = 300

    def log(self, level: str, message: str, data: Optional[Dict] = None):
        entry = {
            "timestamp": time.strftime("%H:%M:%S"),
            "level": level,
            "message": message,
            "data": data or {},
        }
        self._logs.append(entry)
        if len(self._logs) > self._max_logs:
            self._logs = self._logs[-self._max_logs:]
        prefix = {"info": "[INFO]", "warn": "[WARN]", "error": "[ERROR]", "debug": "[DEBUG]"}.get(level, "[LOG]")
        print(f"{prefix} {message}", data if data else "")

    def get_logs(self, limit: int = 50) -> List[Dict[str, Any]]:
        return self._logs[-limit:]

    def clear(self):
        self._logs = []

_tracker_logger = TrackerLogger()

# ====== jieba 中文分词（惰性加载，不可用时回退单字切分）======
_JIEBA = None
_JIEBA_FAILED = False
_JIEBA_ADDED_WORDS = set()


def _get_jieba():
    """惰性加载 jieba，失败时记录并返回 None，调用方回退单字模式。"""
    global _JIEBA, _JIEBA_FAILED
    if _JIEBA is not None:
        return _JIEBA
    if _JIEBA_FAILED:
        return None
    try:
        import jieba
        jieba.setLogLevel(60)  # 关闭 jieba 的初始化日志
        _JIEBA = jieba
        return _JIEBA
    except Exception as e:
        _JIEBA_FAILED = True
        _tracker_logger.log("warn", f"[分词] jieba 不可用，回退单字切分: {e}")
        return None


def _register_phrases_to_jieba(phrases: Optional[List[str]]) -> None:
    """把用户自定义词表加入 jieba 词典，确保这些词不被切断。"""
    jb = _get_jieba()
    if jb is None:
        return
    for phrase in (phrases or []):
        word = str(phrase or "").strip()
        if word and word not in _JIEBA_ADDED_WORDS:
            try:
                jb.add_word(word)
                _JIEBA_ADDED_WORDS.add(word)
            except Exception:
                pass

_TEXT_UNIT_RE = re.compile(r"[\u4e00-\u9fff]|[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*")
_STRONG_BREAK_PUNCT = ("。", "！", "？", "!", "?", ";", "；")
_MEDIUM_BREAK_PUNCT = ("，", ",", "、", ":", "：")
# 中文逗号/顿号/冒号（，、：）是句子内部的自然朗读停顿，在 _presplit_at_strong_punctuation
# 中作为断句点，避免一个逗号串联的长句被按比例硬切产生不自然的断点
# 中文+西文标点字符集 — 最终字幕输出时去除，内部断句仍依赖标点作切分线索
_PUNCT_CHARS = (
    '，。！？；：、""''（）【】《》「」『』…—～'
    '.,!?;:\'"()[]{}<>/#@&*+=_|~`$%^'
    '﹑﹐﹒﹔﹕﹖﹗'  # CJK 兼容标点（whisper 偶有输出）
)
_PUNCT_TABLE = str.maketrans('', '', _PUNCT_CHARS)

# 繁→简映射：whisper 有时输出繁体，后处理时统一转为简体
# 覆盖常用繁简对应，str.translate 一次扫描完成，性能优异
_T2S_MAP = str.maketrans({
    '個': '个', '們': '们', '這': '这', '會': '会', '說': '说', '時': '时', '來': '来',
    '後': '后', '麼': '么', '過': '过', '對': '对', '從': '从', '開': '开', '關': '关',
    '現': '现', '學': '学', '為': '为', '還': '还', '沒': '没', '問': '问', '點': '点',
    '聽': '听', '讓': '让', '給': '给', '請': '请', '謝': '谢', '體': '体', '頭': '头',
    '機': '机', '氣': '气', '愛': '爱', '號': '号', '國': '国', '圖': '图', '網': '网',
    '電': '电', '話': '话', '視': '视', '覺': '觉', '見': '见', '親': '亲', '認': '认',
    '識': '识', '語': '语', '讀': '读', '寫': '写', '買': '买', '賣': '卖', '車': '车',
    '門': '门', '間': '间', '進': '进', '發': '发', '當': '当', '動': '动', '運': '运',
    '樣': '样', '經': '经', '應': '应', '種': '种', '實': '实', '長': '长', '隻': '只',
    '係': '系', '員': '员', '業': '业', '場': '场', '萬': '万', '邊': '边', '聲': '声',
    '處': '处', '歲': '岁', '裡': '里', '麵': '面', '臺': '台', '灣': '湾', '與': '与',
    '義': '义', '衛': '卫', '風': '风', '飛': '飞', '馬': '马', '魚': '鱼', '鳥': '鸟',
    '龍': '龙', '華': '华', '爾': '尔', '亞': '亚', '歐': '欧', '羅': '罗', '蘭': '兰',
    '蘇': '苏', '貝': '贝', '億': '亿', '廠': '厂', '廣': '广', '產': '产', '導': '导',
    '報': '报', '達': '达', '連': '连', '戰': '战', '爭': '争', '權': '权', '術': '术',
    '節': '节', '標': '标', '準': '准', '確': '确', '獨': '独', '獲': '获', '遲': '迟',
    '選': '选', '雖': '虽', '將': '将', '軍': '军', '師': '师', '隊': '队', '醫': '医',
    '藥': '药', '護': '护', '雙': '双', '參': '参', '觀': '观', '記': '记', '計': '计',
    '設': '设', '許': '许', '講': '讲', '變': '变', '議': '议', '證': '证', '離': '离',
    '難': '难', '際': '际', '隨': '随', '險': '险', '陽': '阳', '陰': '阴', '階': '阶',
    '雜': '杂', '響': '响', '顯': '显', '顧': '顾', '預': '预', '領': '领', '類': '类',
    '驗': '验', '驚': '惊', '麗': '丽', '靈': '灵', '題': '题', '廳': '厅', '園': '园',
    '飯': '饭', '館': '馆', '飲': '饮', '餓': '饿', '飽': '饱', '飯': '饭', '鐵': '铁',
    '線': '线', '約': '约', '結': '结', '縣': '县', '鎮': '镇', '舊': '旧', '畫': '画',
    '積': '积', '極': '极', '紅': '红', '綠': '绿', '黃': '黄', '藍': '蓝', '銀': '银',
    '輕': '轻', '輸': '输', '轉': '转', '輪': '轮', '較': '较', '軟': '软', '幹': '干',
    '樹': '树', '樂': '乐', '歷': '历', '曆': '历', '壓': '压', '擔': '担', '據': '据',
    '數': '数', '整': '整', '斷': '断', '繼': '继', '續': '续', '總': '总', '統': '统',
    '創': '创', '造': '造', '傳': '传', '統': '统', '優': '优', '勢': '势', '劃': '划',
    '圍': '围', '團': '团', '困': '困', '際': '际', '衝': '冲', '復': '复', '複': '复',
    '嚴': '严', '簡': '简', '單': '单', '盡': '尽', '異': '异', '導': '导', '島': '岛',
    '豐': '丰', '歡': '欢', '戲': '戏', '擊': '击', '數': '数', '據': '据', '條': '条',
    '滿': '满', '濟': '济', '漢': '汉', '澤': '泽', '潤': '润', '潔': '洁', '滅': '灭',
    '燒': '烧', '煙': '烟', '燈': '灯', '熱': '热', '營': '营', '獎': '奖', '狀': '状',
    '裝': '装', '裡': '里', '補': '补', '製': '制', '複': '复', '褲': '裤', '襪': '袜',
    '誤': '误', '試': '试', '調': '调', '談': '谈', '論': '论', '訴': '诉', '評': '评',
    '課': '课', '誰': '谁', '謝': '谢', '讚': '赞', '賓': '宾', '賓': '宾', '齊': '齐',
    '齒': '齿', '齡': '龄', '鬥': '斗', '鬱': '郁', '龜': '龟', '龍': '龙', '鳳': '凤',
})

# zhconv 繁→简转换（惰性加载，优先级高于 _T2S_MAP）
# zhconv 基于 MediaWiki 转换表，覆盖所有汉字繁简对应；
# 不可用时回退 _T2S_MAP（手动维护的常用字表，覆盖率有限但无外部依赖）
_zhconv_convert_t2s = [None]  # [0]: None=未初始化, False=不可用, callable=转换函数

def to_simplified_chinese(text: str) -> str:
    """将文本中的繁体汉字转为简体（优先 zhconv，回退 _T2S_MAP）。"""
    if not text:
        return text
    fn = _zhconv_convert_t2s[0]
    if fn is None:
        try:
            from zhconv import convert as _conv
            fn = _zhconv_convert_t2s[0] = _conv
        except Exception:
            _zhconv_convert_t2s[0] = False
            fn = False
    if fn is not False:
        try:
            return fn(text, "zh-hans")
        except Exception:
            pass
    return text.translate(_T2S_MAP)
_DISCOURSE_BREAK_PREFIXES = (
    "and", "but", "so", "because", "if", "when", "while", "then", "however", "though",
    "although", "therefore", "meanwhile", "also", "or", "yet",
    "但是", "不过", "可是", "如果", "那么", "所以", "因此", "然后", "于是", "并且", "而且", "同时", "另外", "不过", "后来", "结果",
)
_DISCOURSE_BREAK_SUFFIXES = (
    "first", "then", "finally", "because", "if", "when",
    "先", "再", "后", "后面", "之后", "之前", "因为", "如果", "所以", "但是",
)
_PROTECTED_PHRASES = (
    "because of", "due to", "in order", "as soon as", "rather than", "such as", "instead of",
    "want to", "going to", "have to", "used to", "not only", "but also",
    "因为", "所以", "如果", "那么", "但是", "不是", "而是", "为了", "以及", "并且", "而且", "或者", "比如", "例如", "然后", "虽然", "可是",
)
_ZH_LEADING_ATTACHERS = (
    "像", "把", "被", "给", "跟", "和", "同", "向", "往", "朝", "对", "比", "从", "到", "在", "让", "拿", "将", "使", "按", "依", "照",
)
_EN_LEADING_ATTACHERS = (
    "like", "of", "to", "for", "with", "into", "onto", "about", "around", "through",
    "than", "as", "toward", "towards", "from", "under", "over", "between", "without", "within", "before", "after",
)


def _parse_frame_rate_value(raw_value: Any) -> Optional[float]:
    if raw_value in (None, ""):
        return None
    if isinstance(raw_value, (int, float)):
        value = float(raw_value)
        return value if value > 0 else None
    match = re.search(r"\d+(?:\.\d+)?", str(raw_value).strip())
    if not match:
        return None
    try:
        value = float(match.group(0))
    except Exception:
        return None
    return value if value > 0 else None


def _safe_int_frame(raw_value: Any, default: int = 0) -> int:
    try:
        return int(float(raw_value))
    except Exception:
        return default

@dataclass
class ClipSnapshot:
    """单个 clip 的快照数据，全部使用秒为单位"""
    clip_name: str
    clip_path: str
    timeline_start: float  # 时间线起始秒数
    timeline_end: float    # 时间线结束秒数
    source_start: float    # 源媒体起始秒数
    source_end: float      # 源媒体结束秒数
    speed: float           # 绝对变速比例
    media_id: str = ""                   # 媒体池唯一 ID，解决同路径多实例歧义
    source_frame_rate: float = 24.0      # 源素材帧率
    track_type: str = ""                 # "audio" or "video"
    track_index: int = 0                 # track index (1-based)

@dataclass
class SubtitleBinding:
    """字幕与源媒体时间的绑定关系"""
    subtitle_index: int
    media_path: str
    sub_source_start: float  # 字幕在源媒体中的起始秒数
    sub_source_end: float    # 字幕在源媒体中的结束秒数
    root_id: str = ""
    root_source_start: Optional[float] = None
    root_source_end: Optional[float] = None
    root_text: str = ""


class SubtitleSpeedTracker:
    """字幕变速匹配追踪器（无状态映射版）"""

    MAX_SESSIONS = 20  # 最多同时保留的会话数，超出时 LRU 淘汰

    def __init__(self):
        # 绑定关系：{session_id: [SubtitleBinding]}
        self._bindings: Dict[str, List[SubtitleBinding]] = {}
        # 会话元数据：{session_id: {fps, track_type, track_index, ...}}
        self._sessions: Dict[str, Dict[str, Any]] = {}
        # 记录上一次时间线的哈希值，避免无意义的重算
        self._last_hash: Dict[str, int] = {}
        # 分别记录音频/字幕哈希，用于区分「音频变化」与「字幕变化」两种触发源
        self._last_audio_hash: Dict[str, int] = {}
        self._last_subtitle_hash: Dict[str, int] = {}
        self._logger = _tracker_logger
        self._access_order: list = []  # LRU 访问顺序，最近使用的在末尾

    def _touch_session(self, session_id: str):
        """标记会话为最近使用"""
        if session_id in self._access_order:
            self._access_order.remove(session_id)
        self._access_order.append(session_id)

    def _evict_lru_if_needed(self):
        """如果会话数超出上限，淘汰最久未使用的"""
        while len(self._sessions) > self.MAX_SESSIONS:
            evicted = self._access_order.pop(0) if self._access_order else next(iter(self._sessions.keys()))
            self._logger.log("warn", f"[LRU 淘汰] session={evicted} 已达上限 {self.MAX_SESSIONS}")
            self._sessions.pop(evicted, None)
            self._bindings.pop(evicted, None)
            self._last_hash.pop(evicted, None)
            self._last_audio_hash.pop(evicted, None)
            self._last_subtitle_hash.pop(evicted, None)

    def get_logs(self, limit: int = 50) -> List[Dict[str, Any]]:
        return self._logger.get_logs(limit)

    def clear_logs(self):
        self._logger.clear()

    def get_bindings(self, session_id: str) -> List[SubtitleBinding]:
        return self._bindings.get(session_id, [])

    def _normalize_phrase_dictionary(self, phrases: Optional[List[str]]) -> List[str]:
        normalized = []
        seen = set()
        for phrase in phrases or []:
            value = str(phrase or "").strip()
            if not value:
                continue
            key = value.lower()
            if key in seen:
                continue
            seen.add(key)
            normalized.append(value)
        return normalized

    def get_session_phrase_dictionary(self, session_id: str) -> List[str]:
        session = self._sessions.get(session_id) or {}
        return list(session.get("phrase_dictionary") or [])

    def _get_root_id(self, binding: SubtitleBinding) -> str:
        if binding.root_id:
            return binding.root_id
        return f"{binding.media_path}:{binding.sub_source_start:.3f}-{binding.sub_source_end:.3f}"

    def _get_root_source_start(self, binding: SubtitleBinding) -> float:
        return binding.root_source_start if binding.root_source_start is not None else binding.sub_source_start

    def _get_root_source_end(self, binding: SubtitleBinding) -> float:
        return binding.root_source_end if binding.root_source_end is not None else binding.sub_source_end

    def _get_root_text(self, binding: SubtitleBinding, fallback_text: str = "") -> str:
        return binding.root_text if binding.root_text else str(fallback_text or "")

    def _extract_text_units(self, text: str) -> List[Tuple[int, int]]:
        """把文本切成切分单元（每个单元的字符区间）。

        优先用 jieba 把中文按词组切成单元，使分割边界只落在词组之间，
        避免切断「电视画质」「运动预测」等词；jieba 不可用时回退到单字/单词正则。
        英文/数字 token 始终作为整体单元。
        """
        if not text:
            return []

        jb = _get_jieba()
        if jb is None:
            return [(m.start(), m.end()) for m in _TEXT_UNIT_RE.finditer(text)]

        try:
            units: List[Tuple[int, int]] = []
            cursor = 0
            for token in jb.tokenize(text):
                # jieba.tokenize 产出 (word, start, end) 字符位置
                word, start, end = token[0], token[1], token[2]
                if not word or word.isspace():
                    cursor = end
                    continue
                units.append((start, end))
                cursor = end
            if units:
                return units
        except Exception as e:
            _tracker_logger.log("warn", f"[分词] jieba 切词异常，回退正则: {e}")

        return [(m.start(), m.end()) for m in _TEXT_UNIT_RE.finditer(text)]

    def _extract_fallback_char_units(self, text: str) -> List[Tuple[int, int]]:
        if not text:
            return []
        units = []
        for idx, ch in enumerate(text):
            if not ch.isspace():
                units.append((idx, idx + 1))
        return units

    def _allocate_unit_counts(self, total_units: int, ratios: List[float]) -> List[int]:
        if total_units <= 0:
            return [0] * len(ratios)

        positive_piece_count = sum(1 for ratio in ratios if ratio > 0)
        if total_units < positive_piece_count:
            return [total_units] + [0] * (len(ratios) - 1)

        total_ratio = sum(max(0.0, ratio) for ratio in ratios) or float(len(ratios))
        raw_counts = []
        for ratio in ratios:
            normalized = max(0.0, ratio) / total_ratio
            raw_counts.append(normalized * total_units)

        counts = [int(value) for value in raw_counts]
        assigned = sum(counts)

        for idx, ratio in enumerate(ratios):
            if ratio > 0 and counts[idx] == 0:
                counts[idx] = 1
        assigned = sum(counts)

        if assigned > total_units:
            overflow = assigned - total_units
            for idx in sorted(range(len(counts)), key=lambda i: counts[i], reverse=True):
                removable = counts[idx] - (1 if ratios[idx] > 0 else 0)
                if removable <= 0:
                    continue
                delta = min(removable, overflow)
                counts[idx] -= delta
                overflow -= delta
                if overflow <= 0:
                    break
        elif assigned < total_units:
            remainder_order = sorted(
                range(len(raw_counts)),
                key=lambda i: (raw_counts[i] - int(raw_counts[i]), ratios[i]),
                reverse=True,
            )
            remaining = total_units - assigned
            while remaining > 0:
                for idx in remainder_order:
                    counts[idx] += 1
                    remaining -= 1
                    if remaining <= 0:
                        break

        return counts

    def _extract_right_phrase_candidates(self, text: str) -> List[str]:
        text = str(text or "").lstrip()
        if not text:
            return []

        candidates = []
        word_match = re.match(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*(?:\s+[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*){0,3}", text)
        if word_match:
            phrase = word_match.group(0).strip()
            if phrase:
                candidates.append(phrase.lower())

        zh_chars = []
        for ch in text:
            if re.match(r"[\u4e00-\u9fff]", ch):
                zh_chars.append(ch)
                if len(zh_chars) >= 6:
                    break
            else:
                break

        if zh_chars:
            joined = "".join(zh_chars)
            for size in range(min(6, len(joined)), 0, -1):
                candidates.append(joined[:size])

        seen = set()
        deduped = []
        for item in candidates:
            key = item.lower()
            if key in seen:
                continue
            seen.add(key)
            deduped.append(item)
        return deduped

    def _get_left_right_tokens(self, left_text: str, right_text: str) -> Tuple[str, str]:
        left = str(left_text or "").rstrip()
        right = str(right_text or "").lstrip()

        left_token = ""
        right_token = ""

        if left:
            left_word_match = re.search(r"([A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*)\s*$", left)
            if left_word_match:
                left_token = left_word_match.group(1).lower()
            else:
                zh_matches = re.findall(r"[\u4e00-\u9fff]+", left)
                if zh_matches:
                    left_token = zh_matches[-1][-2:] if len(zh_matches[-1]) >= 2 else zh_matches[-1]

        if right:
            right_word_match = re.match(r"([A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*)", right)
            if right_word_match:
                right_token = right_word_match.group(1).lower()
            else:
                zh_match = re.match(r"([\u4e00-\u9fff]{1,2})", right)
                if zh_match:
                    right_token = zh_match.group(1)

        return left_token, right_token

    def _score_attachment_penalty(self, left_text: str, right_text: str, custom_phrases: Optional[List[str]] = None) -> float:
        left_token, right_token = self._get_left_right_tokens(left_text, right_text)
        penalty = 0.0
        normalized_custom = [phrase.lower() for phrase in (custom_phrases or [])]
        right_candidates = self._extract_right_phrase_candidates(right_text)

        if left_token in _ZH_LEADING_ATTACHERS:
            penalty -= 10
            if right_candidates:
                penalty -= 4
            if any(candidate in normalized_custom for candidate in right_candidates):
                penalty -= 8

        if left_token in _EN_LEADING_ATTACHERS:
            penalty -= 10
            if right_token:
                penalty -= 4
            if any(candidate in normalized_custom for candidate in right_candidates):
                penalty -= 8

        # 如果右侧命中短语词典，但左侧是典型前导词，则进一步惩罚，优先保护更长的组合结构
        if right_candidates and normalized_custom:
            if left_token in _ZH_LEADING_ATTACHERS or left_token in _EN_LEADING_ATTACHERS:
                longest_candidate_len = max(len(candidate) for candidate in right_candidates)
                penalty -= min(6, float(longest_candidate_len))

        return penalty

    def _boundary_splits_protected_phrase(self, text: str, boundary_pos: int, extra_phrases: Optional[List[str]] = None) -> bool:
        normalized = str(text or "").lower()
        phrase_list = list(_PROTECTED_PHRASES) + list(extra_phrases or [])
        for phrase in phrase_list:
            target = phrase.lower()
            max_start = max(0, boundary_pos - len(target) + 1)
            min_end = min(boundary_pos, len(normalized) - len(target))
            for start in range(max_start, min_end + 1):
                if normalized[start:start + len(target)] == target and start < boundary_pos < start + len(target):
                    return True
        return False

    def _score_split_boundary(self, text: str, units: List[Tuple[int, int]], boundary_index: int, target_index: int, min_index: int, max_index: int, extra_phrases: Optional[List[str]] = None) -> float:
        if boundary_index <= min_index or boundary_index >= max_index:
            return float("-inf")

        boundary_pos = units[boundary_index][0]
        prev_end = units[boundary_index - 1][1]
        gap_text = text[prev_end:boundary_pos]
        left_text = text[:boundary_pos].rstrip()
        right_text = text[boundary_pos:].lstrip()
        left_char = left_text[-1] if left_text else ""
        right_char = right_text[0] if right_text else ""
        left_lower = left_text.lower()
        right_lower = right_text.lower()

        score = 0.0
        distance = abs(boundary_index - target_index)
        score -= distance * 2.5

        if any(p in gap_text or left_char == p for p in _STRONG_BREAK_PUNCT):
            score += 20
        elif any(p in gap_text or left_char == p for p in _MEDIUM_BREAK_PUNCT):
            score += 12
        elif gap_text.strip():
            score += 4

        if any(right_lower.startswith(prefix) for prefix in _DISCOURSE_BREAK_PREFIXES):
            score += 8
        if any(left_lower.endswith(suffix) for suffix in _DISCOURSE_BREAK_SUFFIXES):
            score += 5

        custom_phrases = self._normalize_phrase_dictionary(extra_phrases)
        if self._boundary_splits_protected_phrase(text, boundary_pos, custom_phrases):
            score -= 18

        if any(right_lower.startswith(phrase.lower()) for phrase in custom_phrases):
            score += 11
        if any(left_lower.endswith(phrase.lower()) for phrase in custom_phrases):
            score += 8

        score += self._score_attachment_penalty(left_text, right_text, custom_phrases)

        if right_char in ("，", ",", "。", ".", "！", "!", "？", "?", "；", ";", "、", "：", ":"):
            score -= 6

        left_units = boundary_index - min_index
        right_units = max_index - boundary_index
        if left_units <= 1 or right_units <= 1:
            score -= 10
        elif left_units <= 2 or right_units <= 2:
            score -= 4

        return score

    def _split_text_by_ratios(self, text: str, ratios: List[float], extra_phrases: Optional[List[str]] = None) -> List[str]:
        clean_text = str(text or "")
        if len(ratios) <= 1:
            return [clean_text]

        # 用户自定义词表加入 jieba 词典，确保这些词组不被切断
        _register_phrases_to_jieba(self._normalize_phrase_dictionary(extra_phrases))

        units = self._extract_text_units(clean_text)
        if len(units) < len(ratios):
            units = self._extract_fallback_char_units(clean_text)
        if len(units) <= 1:
            return [clean_text] + [""] * (len(ratios) - 1)

        total_units = len(units)
        counts = self._allocate_unit_counts(total_units, ratios)
        pieces = []
        boundaries = []
        min_boundary = 0
        accumulated_target = 0
        for piece_index in range(len(ratios) - 1):
            accumulated_target += counts[piece_index]
            remaining_pieces = len(ratios) - piece_index - 1
            max_boundary = total_units - remaining_pieces
            target_boundary = max(min_boundary + 1, min(max_boundary, accumulated_target))

            best_boundary = target_boundary
            best_score = float("-inf")
            for candidate in range(min_boundary + 1, max_boundary + 1):
                score = self._score_split_boundary(
                    clean_text,
                    units,
                    candidate,
                    target_boundary,
                    min_boundary,
                    max_boundary,
                    extra_phrases=extra_phrases,
                )
                if score > best_score:
                    best_score = score
                    best_boundary = candidate

            boundaries.append(best_boundary)
            min_boundary = best_boundary

        text_cursor = 0
        for piece_index, boundary in enumerate(boundaries):
            next_boundary = units[boundary][0]
            pieces.append(clean_text[text_cursor:next_boundary])
            text_cursor = next_boundary
        if len(pieces) < len(ratios):
            pieces.append(clean_text[text_cursor:])
        while len(pieces) < len(ratios):
            pieces.append("")

        trimmed_pieces = [piece.strip() for piece in pieces[:len(ratios)]]
        if not any(trimmed_pieces):
            return [clean_text] + [""] * (len(ratios) - 1)
        return trimmed_pieces

    def _line_break_offsets(self, text: str) -> List[int]:
        """返回每个换行符前面的非换行字符数量，用于区分原有/新增回车。"""
        normalized = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
        offsets = []
        char_count = 0
        for ch in normalized:
            if ch == "\n":
                if 0 < char_count:
                    offsets.append(char_count)
            else:
                char_count += 1
        return offsets

    def _split_text_by_added_newlines(self, original_text: str, current_text: str) -> Optional[List[str]]:
        """按当前文本相对原文本新增的换行位置切分。

        原文本已有的换行只被视为显示换行，不触发字幕块拆分。
        """
        current = str(current_text or "").replace("\r\n", "\n").replace("\r", "\n")
        if "\n" not in current:
            return None

        compact = current.replace("\n", "")
        if not compact.strip():
            return None

        original_offsets = set(self._line_break_offsets(original_text))
        current_offsets = self._line_break_offsets(current)
        added_offsets = []
        seen = set()
        for offset in current_offsets:
            if offset in original_offsets or offset in seen:
                continue
            if 0 < offset < len(compact):
                added_offsets.append(offset)
                seen.add(offset)

        if not added_offsets:
            return None

        pieces = []
        cursor = 0
        for offset in sorted(added_offsets):
            piece = compact[cursor:offset].strip()
            if piece:
                pieces.append(piece)
            cursor = offset
        tail = compact[cursor:].strip()
        if tail:
            pieces.append(tail)

        return pieces if len(pieces) >= 2 else None

    def _split_subtitle_by_added_newlines(
        self,
        sub: Dict[str, Any],
        original_text: str,
        current_text: str,
        start: float,
        end: float,
    ) -> Optional[List[Dict[str, Any]]]:
        pieces = self._split_text_by_added_newlines(original_text, current_text)
        if not pieces:
            return None

        duration = max(0.01, float(end) - float(start))
        lengths = [max(1, len(piece)) for piece in pieces]
        total = float(sum(lengths)) or float(len(pieces))
        cursor = float(start)
        result = []
        for idx, piece in enumerate(pieces):
            if idx == len(pieces) - 1:
                piece_end = float(end)
            else:
                piece_end = cursor + duration * (lengths[idx] / total)
            next_sub = dict(sub)
            next_sub["start"] = round(cursor, 3)
            next_sub["end"] = round(max(cursor + 0.01, piece_end), 3)
            next_sub["text"] = piece
            next_sub.pop("hidden", None)
            result.append(next_sub)
            cursor = piece_end

        return result

    def get_timeline_item_text(self, item) -> str:
        """读取达芬奇时间线字幕条的真实文本，优先读取属性文本再回退名称。"""
        text_keys = (
            "Text",
            "text",
            "Subtitle",
            "subtitle",
            "Caption",
            "caption",
            "Styled Text",
            "StyledText",
        )

        try:
            if hasattr(item, "GetProperty"):
                props = item.GetProperty()
                if isinstance(props, dict):
                    for key in text_keys:
                        value = props.get(key)
                        if isinstance(value, str) and value.strip():
                            return value.strip()

                for key in text_keys:
                    try:
                        value = item.GetProperty(key)
                    except Exception:
                        continue
                    if isinstance(value, str) and value.strip():
                        return value.strip()
        except Exception:
            pass

        try:
            return str(item.GetName() or "").strip()
        except Exception:
            return ""

    def read_timeline_subtitles(self, timeline, fps: float) -> List[Dict[str, Any]]:
        """从达芬奇字幕轨道读取所有字幕，返回按 start 排序的列表。"""
        timeline_start_frame = 0
        if hasattr(timeline, "GetStartFrame"):
            try:
                tsf = timeline.GetStartFrame()
                if tsf:
                    timeline_start_frame = int(tsf)
            except Exception:
                pass

        subtitles = []
        track_count = timeline.GetTrackCount("subtitle") or 0
        for track_idx in range(1, track_count + 1):
            items = timeline.GetItemListInTrack("subtitle", track_idx) or []
            for item in items:
                text = self.get_timeline_item_text(item)
                if not text:
                    continue
                start = round((int(item.GetStart()) - timeline_start_frame) / fps, 3)
                end = round((int(item.GetEnd()) - timeline_start_frame) / fps, 3)
                if end <= start:
                    continue
                subtitles.append({
                    "start": start,
                    "end": end,
                    "text": text,
                    "track_index": track_idx,
                })
        subtitles.sort(key=lambda s: s["start"])
        return subtitles

    def detect_blade_cut_groups(self, subtitles: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
        """检测字幕轨道上的剃刀切点组。

        相邻、同轨道、文本完全相同的字幕判定为剃刀切割。
        返回切点组列表，每个组内的字幕共享同一个 root。
        """
        if len(subtitles) < 2:
            return []

        groups = []
        used = set()

        for i in range(len(subtitles) - 1):
            if i in used:
                continue
            curr = subtitles[i]
            if not curr.get("text"):
                continue

            group = [curr]
            for j in range(i + 1, len(subtitles)):
                nxt = subtitles[j]
                if j in used:
                    break
                same_track = curr.get("track_index") == nxt.get("track_index")
                same_text = curr["text"] == nxt["text"]
                adjacent = abs(group[-1]["end"] - nxt["start"]) < 0.05
                if same_track and same_text and adjacent:
                    group.append(nxt)
                else:
                    break

            if len(group) >= 2:
                for g in group:
                    used.add(subtitles.index(g))
                groups.append(group)

        return groups

    # ==================== 状态采集与 Hash ====================

    def get_timeline_hash(self, timeline, track_type: str, track_index: int) -> int:
        """音频轨道 + 字幕轨道的综合哈希（兼容旧调用）。"""
        return hash((
            self.get_audio_hash(timeline, track_type, track_index),
            self.get_subtitle_hash(timeline),
        ))

    def get_audio_hash(self, timeline, track_type: str, track_index: int) -> int:
        """音频轨道哈希：检测音频片段的移动/变速/裁剪。"""
        clips = timeline.GetItemListInTrack(track_type, track_index)
        if not clips:
            return 0
        state = []
        for clip in clips:
            try:
                t_start = int(clip.GetStart())
                t_end = int(clip.GetEnd())
                s_start = int(clip.GetSourceStartFrame()) if hasattr(clip, 'GetSourceStartFrame') else 0
                s_end = int(clip.GetSourceEndFrame()) if hasattr(clip, 'GetSourceEndFrame') else 0
                state.append((t_start, t_end, s_start, s_end))
            except Exception:
                pass
        return hash(tuple(state))

    def _extract_media_frame_rate(self, mp_item, fallback_fps: float) -> float:
        for key in ("FPS", "Frame Rate", "Video Frame Rate", "Clip Frame Rate", "FrameRate"):
            try:
                parsed = _parse_frame_rate_value(mp_item.GetClipProperty(key))
            except Exception:
                parsed = None
            if parsed:
                return parsed

        try:
            all_props = mp_item.GetClipProperty() or {}
        except Exception:
            all_props = {}
        if isinstance(all_props, dict):
            for key in ("FPS", "Frame Rate", "Video Frame Rate", "Clip Frame Rate", "FrameRate"):
                parsed = _parse_frame_rate_value(all_props.get(key))
                if parsed:
                    return parsed

        return _parse_frame_rate_value(fallback_fps) or 24.0

    def _build_clip_snapshot(
        self,
        clip,
        mp_item,
        fps: float,
        timeline_start_frame: int,
        track_type: str,
        track_index: int,
    ) -> ClipSnapshot:
        t_start = (_safe_int_frame(clip.GetStart()) - timeline_start_frame) / fps
        t_end = (_safe_int_frame(clip.GetEnd()) - timeline_start_frame) / fps
        source_fps = self._extract_media_frame_rate(mp_item, fps)

        if hasattr(clip, 'GetSourceStartFrame'):
            s_start = _safe_int_frame(clip.GetSourceStartFrame()) / source_fps
            s_end = _safe_int_frame(clip.GetSourceEndFrame()) / source_fps
        else:
            try:
                media_start = _safe_int_frame(mp_item.GetClipProperty("Start"))
            except Exception:
                media_start = 0
            if hasattr(clip, 'GetLeftOffset'):
                s_start = (media_start + _safe_int_frame(clip.GetLeftOffset())) / source_fps
            else:
                s_start = media_start / source_fps
            s_end = s_start + (t_end - t_start)

        duration = t_end - t_start
        speed = (s_end - s_start) / duration if duration > 0 else 1.0

        return ClipSnapshot(
            clip_name=clip.GetName() or "",
            clip_path=mp_item.GetClipProperty("File Path") or "",
            timeline_start=round(t_start, 3),
            timeline_end=round(t_end, 3),
            source_start=round(s_start, 3),
            source_end=round(s_end, 3),
            speed=round(speed, 4),
            media_id=str(mp_item.GetMediaId() or ""),
            source_frame_rate=source_fps,
            track_type=track_type,
            track_index=track_index,
        )

    def get_subtitle_hash(self, timeline) -> int:
        """字幕轨道哈希：检测字幕的分割/编辑/移动（位置 + 文本）。"""
        try:
            sub_track_count = timeline.GetTrackCount("subtitle") or 0
        except Exception:
            sub_track_count = 0
        state = []
        for ti in range(1, sub_track_count + 1):
            for item in (timeline.GetItemListInTrack("subtitle", ti) or []):
                try:
                    state.append((
                        int(item.GetStart()),
                        int(item.GetEnd()),
                        self.get_timeline_item_text(item),
                    ))
                except Exception:
                    pass
        if not state:
            return 0
        return hash(tuple(state))

    def collect_snapshot(self, timeline, fps: float, track_type: str, track_index: int, session_id: str) -> List[ClipSnapshot]:
        """采集当前轨道的所有 Clip 信息，转换为秒级物理时间（相对于时间线零点）"""
        clips = timeline.GetItemListInTrack(track_type, track_index)
        if not clips:
            return []

        # clip.GetStart()/GetEnd() 返回包含时间线起始偏移的绝对帧号，
        # 需要减去偏移量得到物理帧位置，与字幕 segments 的物理时间对齐
        timeline_start_frame = 0
        if hasattr(timeline, "GetStartFrame"):
            try:
                tsf = timeline.GetStartFrame()
                if tsf:
                    timeline_start_frame = int(tsf)
            except Exception:
                pass

        snapshot: List[ClipSnapshot] = []
        for clip in clips:
            mp_item = clip.GetMediaPoolItem()
            if not mp_item:
                continue

            try:
                snapshot.append(self._build_clip_snapshot(
                    clip,
                    mp_item,
                    fps,
                    timeline_start_frame,
                    track_type,
                    track_index,
                ))
            except Exception as e:
                self._logger.log("debug", f"解析 Clip 快照失败: {e}")

        snapshot.sort(key=lambda item: item.timeline_start)
        return snapshot

    # ==================== 绑定管理 ====================

    def create_bindings(self, segments: List[Dict[str, Any]], snapshot: List[ClipSnapshot], fps: float, session_id: str) -> List[SubtitleBinding]:
        """将字幕绑定到音频 Clip 的源媒体绝对时间"""
        self._logger.log("info", f"[创建绑定] session={session_id} segments={len(segments)} clips={len(snapshot)}")
        bindings = []

        for idx, seg in enumerate(segments):
            if seg.get("deleted", False):
                continue

            best_match = None
            best_overlap = 0

            # 寻找时间线上重叠最多的 Clip
            for clip in snapshot:
                overlap_start = max(seg["start"], clip.timeline_start)
                overlap_end = min(seg["end"], clip.timeline_end)
                overlap = max(0, overlap_end - overlap_start)

                if overlap > best_overlap:
                    best_overlap = overlap
                    best_match = clip

            if best_match and best_overlap > 0:
                # 映射到源媒体时间
                sub_source_start = best_match.source_start + (seg["start"] - best_match.timeline_start) * best_match.speed
                sub_source_end = best_match.source_start + (seg["end"] - best_match.timeline_start) * best_match.speed
                root_id = f"root-{idx}"
                
                bindings.append(SubtitleBinding(
                    subtitle_index=idx,
                    media_path=best_match.clip_path,
                    sub_source_start=sub_source_start,
                    sub_source_end=sub_source_end,
                    root_id=root_id,
                    root_source_start=sub_source_start,
                    root_source_end=sub_source_end,
                    root_text=str(seg.get("text", "")),
                ))
                self._logger.log("debug", f"[绑定] 字幕[{idx}] -> {best_match.clip_name} (Source: {sub_source_start:.2f}s - {sub_source_end:.2f}s)")
            else:
                self._logger.log("warn", f"[绑定失败] 字幕[{idx}] 未找到匹配的音频片段")

        self._bindings[session_id] = bindings
        self._logger.log("info", f"[创建绑定] 完成，共绑定 {len(bindings)}/{len(segments)} 条字幕")
        return bindings

    def create_bindings_from_timeline(
        self, timeline_subtitles: List[Dict[str, Any]],
        snapshot: List[ClipSnapshot], session_id: str
    ) -> List[SubtitleBinding]:
        """从时间线字幕创建绑定；每条字幕独立绑定，不再按切点组共享 root。"""
        self._logger.log("info", f"[创建绑定] session={session_id} subs={len(timeline_subtitles)} clips={len(snapshot)}")

        bindings = []
        for idx, sub in enumerate(timeline_subtitles):
            best_match = None
            best_overlap = 0.0

            for clip in snapshot:
                overlap_start = max(sub["start"], clip.timeline_start)
                overlap_end = min(sub["end"], clip.timeline_end)
                overlap = max(0.0, overlap_end - overlap_start)
                if overlap > best_overlap:
                    best_overlap = overlap
                    best_match = clip

            if best_match and best_overlap > 0:
                sub_source_start = best_match.source_start + (sub["start"] - best_match.timeline_start) * best_match.speed
                sub_source_end = best_match.source_start + (sub["end"] - best_match.timeline_start) * best_match.speed

                bindings.append(SubtitleBinding(
                    subtitle_index=idx,
                    media_path=best_match.clip_path,
                    sub_source_start=sub_source_start,
                    sub_source_end=sub_source_end,
                    root_id=f"sub-{idx}",
                    root_source_start=sub_source_start,
                    root_source_end=sub_source_end,
                    root_text=sub["text"],
                ))
                self._logger.log("debug", f"[绑定] 字幕[{idx}] -> {best_match.clip_name}")
            else:
                self._logger.log("warn", f"[绑定失败] 字幕[{idx}] 未找到匹配的音频片段")

        self._bindings[session_id] = bindings
        self._logger.log("info", f"[创建绑定] 完成: {len(bindings)}/{len(timeline_subtitles)} 条")
        return bindings

    # ==================== 绝对重算逻辑 ====================

    def recalculate_subtitles(
        self, timeline_subtitles: List[Dict[str, Any]],
        snapshot: List[ClipSnapshot], session_id: str
    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """根据当前音频快照重算字幕位置；不再按切点/比例重分配字幕文本。"""
        bindings = self._bindings.get(session_id, [])
        if not bindings:
            return timeline_subtitles, []

        updated_subtitles = []
        change_log = []

        # 按 root_id 分组 bindings；新会话中每条字幕独立 root，保留分组结构兼容旧会话。
        group_lookup: Dict[str, List[SubtitleBinding]] = {}
        ordered_groups: List[List[SubtitleBinding]] = []
        for b in sorted(bindings, key=lambda x: x.subtitle_index):
            if b.root_id not in group_lookup:
                group_lookup[b.root_id] = []
                ordered_groups.append(group_lookup[b.root_id])
            group_lookup[b.root_id].append(b)

        for group in ordered_groups:
            root = group[0]
            root_text = root.root_text or ""
            root_source_start = root.root_source_start if root.root_source_start is not None else root.sub_source_start
            root_source_end = root.root_source_end if root.root_source_end is not None else root.sub_source_end
            recalculated_pieces = []
            for binding in group:
                found = False
                for clip in snapshot:
                    if clip.clip_path != binding.media_path:
                        continue
                    overlap_src_start = max(binding.sub_source_start, clip.source_start)
                    overlap_src_end = min(binding.sub_source_end, clip.source_end)
                    if overlap_src_end - overlap_src_start <= 0.001:
                        continue

                    new_start = clip.timeline_start + (binding.sub_source_start - clip.source_start) / clip.speed
                    new_end = clip.timeline_start + (binding.sub_source_end - clip.source_start) / clip.speed
                    recalculated_pieces.append({
                        "start": round(max(0, new_start), 3),
                        "end": round(max(new_start + 0.01, new_end), 3),
                        "text": root_text,
                    })
                    found = True
                    # 同一段源内容可能在时间线出现多次（如片段被复制/追加到末尾），
                    # 需为每个源重叠的 clip 都生成一条字幕，故继续遍历。

                if not found:
                    idx = binding.subtitle_index
                    if idx < len(timeline_subtitles):
                        orig = dict(timeline_subtitles[idx])
                        orig["hidden"] = True
                        recalculated_pieces.append(orig)

            if not recalculated_pieces:
                continue

            for piece in recalculated_pieces:
                piece["deleted"] = False
                updated_subtitles.append(piece)

            # 生成 change_log
            if len(group) == 1:
                binding = group[0]
                idx = binding.subtitle_index
                if idx < len(timeline_subtitles):
                    old = timeline_subtitles[idx]
                    new = recalculated_pieces[0]
                    if abs(old["start"] - new["start"]) > 0.001 or abs(old["end"] - new["end"]) > 0.001:
                        change_log.append({
                            "subtitle_index": idx,
                            "old_start": old["start"],
                            "old_end": old["end"],
                            "new_start": new["start"],
                            "new_end": new["end"],
                            "description": "位置更新",
                        })

        # 更新 bindings
        new_bindings = []
        for i, seg in enumerate(updated_subtitles):
            if i < len(bindings):
                old_b = bindings[i]
                new_bindings.append(SubtitleBinding(
                    subtitle_index=i,
                    media_path=old_b.media_path,
                    sub_source_start=old_b.sub_source_start,
                    sub_source_end=old_b.sub_source_end,
                    root_id=old_b.root_id,
                    root_source_start=old_b.root_source_start,
                    root_source_end=old_b.root_source_end,
                    root_text=old_b.root_text,
                ))
        self._bindings[session_id] = new_bindings

        return updated_subtitles, change_log

    def realign_existing_subtitles(
        self, timeline_subtitles: List[Dict[str, Any]],
        snapshot: List[ClipSnapshot], session_id: str
    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """自动同步字幕专用：只调整时间线「已有字幕」的位置，区别于 recalculate_subtitles。

        语义（与同步时间线不同）：
        - 以当前时间线字幕为准遍历，文本始终保留当前字幕文本（不还原成绑定时的旧文本）；
        - 不给本身没有字幕的片段新增字幕；
        - 没有匹配到音频片段的字幕（如绑定轨道之外的字幕）原样保留，绝不删除。
        - 只在用户新增回车时拆分字幕；不再按剃刀切点/时长比例重分配文字。

        每条当前字幕通过 subtitle_index 关联到绑定，用绑定的源时间在当前快照中
        重新定位；定位失败则原样保留该字幕。
        """
        bindings = self._bindings.get(session_id, [])
        if not bindings:
            return list(timeline_subtitles), []

        # subtitle_index -> binding（绑定建立时与字幕一一对应）
        binding_by_index: Dict[int, SubtitleBinding] = {}
        root_ref_counts: Dict[str, int] = {}
        for b in bindings:
            binding_by_index.setdefault(b.subtitle_index, b)
            root_ref_counts[b.root_id] = root_ref_counts.get(b.root_id, 0) + 1

        updated_subtitles: List[Dict[str, Any]] = []
        change_log: List[Dict[str, Any]] = []

        for idx, sub in enumerate(timeline_subtitles):
            cur_text = str(sub.get("text", ""))
            binding = binding_by_index.get(idx)
            has_shared_root = binding is not None and root_ref_counts.get(binding.root_id, 0) > 1

            new_pos = None
            if binding is not None and not has_shared_root:
                for clip in snapshot:
                    if clip.clip_path != binding.media_path:
                        continue
                    overlap_src_start = max(binding.sub_source_start, clip.source_start)
                    overlap_src_end = min(binding.sub_source_end, clip.source_end)
                    if overlap_src_end - overlap_src_start <= 0.001:
                        continue
                    new_start = clip.timeline_start + (binding.sub_source_start - clip.source_start) / clip.speed
                    new_end = clip.timeline_start + (binding.sub_source_end - clip.source_start) / clip.speed
                    new_pos = (
                        round(max(0, new_start), 3),
                        round(max(new_start + 0.01, new_end), 3),
                    )
                    break

            newline_pieces = None
            if binding is not None:
                base_start = new_pos[0] if new_pos is not None else float(sub.get("start", 0.0))
                base_end = new_pos[1] if new_pos is not None else float(sub.get("end", base_start + 0.01))
                newline_pieces = self._split_subtitle_by_added_newlines(
                    sub,
                    self._get_root_text(binding, ""),
                    cur_text,
                    base_start,
                    base_end,
                )

            if newline_pieces:
                updated_subtitles.extend(newline_pieces)
                change_log.append({
                    "subtitle_index": idx,
                    "old_start": sub.get("start"),
                    "old_end": sub.get("end"),
                    "new_start": newline_pieces[0]["start"],
                    "new_end": newline_pieces[-1]["end"],
                    "description": "新增换行切分",
                })
                continue

            if new_pos is not None:
                # 匹配成功：更新位置，文本用（可能已重分配的）当前文本
                new_sub = dict(sub)
                old_start, old_end = sub.get("start"), sub.get("end")
                old_text = str(sub.get("text", ""))
                new_sub["start"], new_sub["end"] = new_pos
                new_sub["text"] = cur_text
                new_sub.pop("hidden", None)
                updated_subtitles.append(new_sub)
                pos_changed = (old_start is not None and old_end is not None and
                               (abs(old_start - new_pos[0]) > 0.001 or abs(old_end - new_pos[1]) > 0.001))
                text_changed = cur_text != old_text
                if pos_changed or text_changed:
                    change_log.append({
                        "subtitle_index": idx,
                        "old_start": old_start,
                        "old_end": old_end,
                        "new_start": new_pos[0],
                        "new_end": new_pos[1],
                        "description": "位置更新" if pos_changed else "文本更新",
                    })
            else:
                # 没有绑定或没匹配到音频片段：原样保留，绝不删除。
                updated_subtitles.append(dict(sub))

        return updated_subtitles, change_log

    # ==================== 会话管理 ====================

    def create_session(self, session_id: str, fps: float, track_type: str, track_index: int, phrase_dictionary: Optional[List[str]] = None):
        self._evict_lru_if_needed()
        self._logger.log("info", f"[创建会话] session={session_id} track={track_type}{track_index} fps={fps}")
        self._sessions[session_id] = {
            "fps": fps,
            "track_type": track_type,
            "track_index": track_index,
            "phrase_dictionary": self._normalize_phrase_dictionary(phrase_dictionary),
            "created_at": time.time(),
        }
        self._bindings[session_id] = []
        self._last_hash.pop(session_id, None)
        self._last_audio_hash.pop(session_id, None)
        self._last_subtitle_hash.pop(session_id, None)
        self._touch_session(session_id)

    def destroy_session(self, session_id: str):
        self._sessions.pop(session_id, None)
        self._bindings.pop(session_id, None)
        self._last_hash.pop(session_id, None)
        self._last_audio_hash.pop(session_id, None)
        self._last_subtitle_hash.pop(session_id, None)
        if session_id in self._access_order:
            self._access_order.remove(session_id)

    def has_session(self, session_id: str) -> bool:
        exists = session_id in self._sessions
        if exists:
            self._touch_session(session_id)
        return exists

    def get_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        session = self._sessions.get(session_id)
        if session is not None:
            self._touch_session(session_id)
        return session

    def list_audio_tracks(self, timeline) -> List[Dict[str, Any]]:
        tracks = []
        audio_track_count = timeline.GetTrackCount("audio") or 0
        for track_idx in range(1, audio_track_count + 1):
            clips = timeline.GetItemListInTrack("audio", track_idx)
            clip_infos = []
            if clips:
                for clip in clips:
                    mp_item = clip.GetMediaPoolItem()
                    if not mp_item:
                        continue
                    clip_infos.append({
                        "name": clip.GetName() or "",
                        "path": mp_item.GetClipProperty("File Path") or "",
                        "duration_frames": clip.GetEnd() - clip.GetStart(),
                    })
            tracks.append({
                "track_type": "audio",
                "track_index": track_idx,
                "track_name": f"音频轨道 A{track_idx}",
                "clip_count": len(clip_infos),
                "clips": clip_infos,
            })
        return tracks

def clip_snapshots_to_dicts(snapshots: List[ClipSnapshot], fps: float = 24.0) -> List[Dict[str, Any]]:
    """将 ClipSnapshot 列表转为 API 可序列化的 dict 列表。
    包含向后兼容的旧字段名（_frame 后缀），供尚未迁移的消费者使用。
    """
    result = []
    for s in snapshots:
        # 向后兼容：旧的帧数字段
        src_fps = s.source_frame_rate or fps
        source_start_frame = int(round(s.source_start * src_fps))
        source_end_frame = int(round(s.source_end * src_fps))
        timeline_start_frame = int(round(s.timeline_start * fps))
        timeline_end_frame = int(round(s.timeline_end * fps))

        result.append({
            # 新字段（秒为单位）
            "clip_name": s.clip_name,
            "clip_path": s.clip_path,
            "media_id": s.media_id,
            "timeline_start": s.timeline_start,
            "timeline_end": s.timeline_end,
            "source_start": s.source_start,
            "source_end": s.source_end,
            "speed": s.speed,
            "source_frame_rate": s.source_frame_rate,
            # 向后兼容字段（帧为单位）
            "source_start_frame": source_start_frame,
            "source_end_frame": source_end_frame,
            "source_in_frame": source_start_frame,
            "source_out_frame": source_end_frame,
            "timeline_start_frame": timeline_start_frame,
            "timeline_end_frame": timeline_end_frame,
            "timeline_start_frame_absolute": timeline_start_frame,
            "timeline_end_frame_absolute": timeline_end_frame,
            "timeline_start_frame_relative": timeline_start_frame,
            "timeline_end_frame_relative": timeline_end_frame,
            "timeline_frame_rate": fps,
            "track_type": s.track_type or "audio",
            "track_index": s.track_index or 1,
            "is_reference_track": bool(s.track_type == "audio" and s.track_index == 1),
            "media_start_frame": source_start_frame,
            "media_end_frame": source_end_frame,
        })
    return result


def _count_effective_chars(text: str) -> int:
    cjk = len(re.findall(r'[一-鿿]', text))
    latin = len(re.findall(r'[A-Za-z0-9]+', text))
    return cjk + latin


def strip_chinese_punctuation(text: str) -> str:
    """去除中文及常见标点符号，用于字幕最终输出。"""
    if not text:
        return text
    return text.translate(_PUNCT_TABLE).strip()


def _presplit_at_strong_punctuation(text: str) -> List[str]:
    """在强标点（。！？!?;；）和中文逗号/顿号/冒号（，、：）处拆分子句。

    标点归属于前一个子句（后续 strip_chinese_punctuation 会统一去除）。
    中文逗号标记自然的朗读停顿，拆开后字幕更短更易读；
    英文 comma 在中文转录中极少出现，不影响行为。
    """
    if not text:
        return [text]
    # 切分点：句末标点 + 中文逗号/顿号/冒号
    parts = re.split(r'(?<=[。！？!?;；，、：])', text)
    merged: List[str] = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if merged and _count_effective_chars(merged[-1]) <= 1:
            merged[-1] = merged[-1] + p
        else:
            merged.append(p)
    return merged if merged else [text]


def smart_split_segment(
    text: str,
    words: Optional[List[Dict[str, Any]]],
    start_time: float,
    end_time: float,
    max_chars: int = 20,
    extra_phrases: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    if not text or not text.strip():
        return [{"text": text, "start": start_time, "end": end_time, "words": words or [], "piece_index": 0}]

    if max_chars <= 0:
        return [{"text": strip_chinese_punctuation(text), "start": start_time, "end": end_time, "words": words or [], "piece_index": 0}]

    # ── 1. 先在强标点处预拆分为子句 ──
    raw_pieces = _presplit_at_strong_punctuation(text)
    # ── 2. 对超长子句再用比例拆分 ──
    tracker = SubtitleSpeedTracker()
    all_pieces: List[str] = []
    for raw in raw_pieces:
        effective = _count_effective_chars(raw)
        if effective <= max_chars:
            all_pieces.append(raw)
        else:
            num = max(2, (effective + max_chars - 1) // max_chars)
            ratios = [1.0 / num] * num
            subs = tracker._split_text_by_ratios(raw, ratios, extra_phrases=extra_phrases)
            subs = [s for s in subs if s.strip()]
            all_pieces.extend(subs)

    all_pieces = [p for p in all_pieces if p.strip()]
    if not all_pieces:
        return [{"text": text.strip(), "start": start_time, "end": end_time, "words": words or [], "piece_index": 0}]

    # ── 3. 输出：去标点、计算时间 ──
    total_chars = max(1, len(text))
    seg_dur = end_time - start_time if end_time > start_time else 1.0

    result = []
    char_cursor = 0
    for pi, piece_text in enumerate(all_pieces):
        piece_len = len(piece_text)
        ratio_before = char_cursor / total_chars
        ratio_after = (char_cursor + piece_len) / total_chars
        piece_start = start_time + ratio_before * seg_dur
        piece_end = start_time + ratio_after * seg_dur

        piece_words = []
        if words:
            for w in words:
                w_start = float(w.get("start", 0))
                if piece_start - 0.001 <= w_start <= piece_end + 0.001:
                    piece_words.append(dict(w))
            if not piece_words:
                for w in words:
                    w_mid = (float(w.get("start", 0)) + float(w.get("end", 0))) / 2
                    if piece_start - 0.001 <= w_mid <= piece_end + 0.001:
                        piece_words.append(dict(w))

        if piece_words:
            piece_start = min(w["start"] for w in piece_words)
            piece_end = max(w["end"] for w in piece_words)

        result.append({
            "text": strip_chinese_punctuation(piece_text),
            "start": round(piece_start, 3),
            "end": round(piece_end, 3),
            "words": piece_words,
            "piece_index": pi,
        })

        char_cursor = text.find(piece_text, char_cursor)
        if char_cursor >= 0:
            char_cursor += piece_len
        else:
            char_cursor = int(ratio_after * total_chars)

    return result


speed_tracker = SubtitleSpeedTracker()
