import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import axios from 'axios';
import {
    RefreshCcw, Scissors, FileText, AlertCircle,
    CheckCircle2, ArrowDown, AlertTriangle, Eye, Eraser, FolderOpen, X, ChevronDown, Settings, LayoutList, Table2, MapPin, Folder, Monitor, Info
} from 'lucide-react';
import { TranscriptProjectTabs, TranscriptBindingToggle, TranscriptProjectManager } from './TranscriptProjectManager';
import MacSelect from './MacSelect';


function AutoEditView({
    transcriptData,
    apiBaseUrl,
    transcriptProjects = [],
    activeTranscriptId = null,
    onLoadTranscriptProject,
    onDeleteTranscriptProject,
    onRefreshTranscriptProjects,
    resolveStatus = { connected: false, project: null },
    onUpdateTranscriptProjectMeta,
    onDeleteTranscriptProjectMeta,
    onSwitchTranscriptProject,
}) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [message, setMessage] = useState(null);
    const [applyMethod, setApplyMethod] = useState('new_timeline');
    const [showConfirm, setShowConfirm] = useState(false);
    const [selectedCount, setSelectedCount] = useState(0);
    const [totalDuration, setTotalDuration] = useState(0);
    const [activeSpeakerKeys, setActiveSpeakerKeys] = useState(null);
    const [normalizedVersion, setNormalizedVersion] = useState(0);
    const [speakerNames, setSpeakerNames] = useState({});
    const [customSpeakers, setCustomSpeakers] = useState([]);
    const [renamingSpeaker, setRenamingSpeaker] = useState(null);
    const [addingSpeaker, setAddingSpeaker] = useState(false);
    const [newSpeakerName, setNewSpeakerName] = useState('');
    const [editingSegmentId, setEditingSegmentId] = useState(null);
    const [editingWord, setEditingWord] = useState(null);
    const [openSpeakerMenu, setOpenSpeakerMenu] = useState(null);
    const [splitCursor, setSplitCursor] = useState(null);
    const [undoStack, setUndoStack] = useState([]);
    const [allCollapsed, setAllCollapsed] = useState(false);
    const [expandedSpeakerKeys, setExpandedSpeakerKeys] = useState(new Set());
    const [manageMode, setManageMode] = useState(false);
    const [viewMode, setViewMode] = useState('block');
    const [showSegmentButtons, setShowSegmentButtons] = useState(true);
    const [timeFormat, setTimeFormat] = useState('timecode');
    const [frameRate, setFrameRate] = useState(24);
    const [maxCharsPerLine, setMaxCharsPerLine] = useState(() => {
        try { return parseInt(localStorage.getItem('autoedit_maxchars'), 10) || 20; }
        catch { return 20; }
    });
    const mergeGapSeconds = 0.5;
    const clickTimersRef = useRef({});
    const lastClickRef = useRef({});
    const dragSelectionRef = useRef(null);
    const scrollContainerRef = useRef(null);
    const autoScrollFrameRef = useRef(null);
    const wordAnchorRef = useRef({});
    const lastClickedIndexRef = useRef(-1);
    const tableDragRef = useRef(null);
    const didTableDragRef = useRef(false);

    // 跨项目导入设置
    const [importLocalFolder, setImportLocalFolder] = useState('');
    const [importDavinciFolder, setImportDavinciFolder] = useState('');
    const [localFolderOptions, setLocalFolderOptions] = useState([]);
    const [davinciFolderOptions, setDavinciFolderOptions] = useState([]);
    const [importSettingsLoaded, setImportSettingsLoaded] = useState(false);

    // 检测是否跨项目：当前达芬奇项目与转录项目的原始项目不同
    const isCrossProject = useMemo(() => {
        if (!resolveStatus?.project) return false;
        const activeProject = transcriptProjects.find(p => p.id === activeTranscriptId);
        const boundProject = activeProject?.davinci_project || activeProject?.boundDavinciProject;
        return !!(boundProject && boundProject !== resolveStatus.project);
    }, [resolveStatus?.project, transcriptProjects, activeTranscriptId]);

    // 跨项目时加载文件夹列表
    useEffect(() => {
        if (!isCrossProject) return;
        const fetchFolders = async () => {
            try {
                const [localRes, davinciRes] = await Promise.all([
                    axios.get(`${apiBaseUrl}/api/clip-import/local-folders`),
                    axios.get(`${apiBaseUrl}/api/clip-import/davinci-folders`),
                ]);
                setLocalFolderOptions(localRes.data.folders || []);
                setDavinciFolderOptions(davinciRes.data.folders || []);
            } catch {
                setLocalFolderOptions([]);
                setDavinciFolderOptions([]);
            }
        };
        fetchFolders();
    }, [isCrossProject, apiBaseUrl]);

    // 持久化跨项目导入设置（按转录项目存储）
    const importSettingsKey = `autoedit_import_${activeTranscriptId || 'default'}`;
    useEffect(() => {
        if (!isCrossProject) return;
        try {
            const saved = localStorage.getItem(importSettingsKey);
            if (saved) {
                const parsed = JSON.parse(saved);
                if (parsed.localFolder) setImportLocalFolder(parsed.localFolder);
                if (parsed.davinciFolder) setImportDavinciFolder(parsed.davinciFolder);
            }
        } catch {}
        setImportSettingsLoaded(true);
    }, [isCrossProject, importSettingsKey]);

    useEffect(() => {
        if (!importSettingsLoaded) return;
        try {
            localStorage.setItem(importSettingsKey, JSON.stringify({
                localFolder: importLocalFolder,
                davinciFolder: importDavinciFolder,
            }));
        } catch {}
    }, [importLocalFolder, importDavinciFolder, importSettingsLoaded, importSettingsKey]);


    const handleLoadProject = async (projectId) => {
        if (!onLoadTranscriptProject) return;
        setError(null);
        const result = await onLoadTranscriptProject(projectId);
        if (result?.ok) {
            setMessage(`已切换到转录项目「${result.data?.metadata?.name || projectId}」`);
        } else if (result?.error) {
            setError(result.error);
        }
    };

    const handleDeleteProject = async (projectId) => {
        if (!onDeleteTranscriptProject) return;
        setError(null);
        const result = await onDeleteTranscriptProject(projectId);
        if (result?.ok) {
            setMessage('转录项目已删除');
        } else if (result?.error) {
            setError(result.error);
        }
    };

    const getSpeakerKey = (entity) => {
        if (!entity || typeof entity !== 'object') return null;
        return entity.speaker
            ?? entity.speaker_label
            ?? entity.speakerLabel
            ?? entity.speaker_name
            ?? entity.speakerName
            ?? entity.speaker_id
            ?? entity.speakerId
            ?? entity.spk
            ?? null;
    };

    const formatSpeakerLabel = (speakerKey) => {
        if (speakerKey === null || speakerKey === undefined || speakerKey === '') return '未区分说话人';
        if (speakerKey === 'unknown') return '未区分说话人';
        if (speakerKey === 'mixed') return '多人说话';
        if (typeof speakerKey === 'number') return `说话人 ${speakerKey}`;
        const normalized = String(speakerKey).trim();
        if (!normalized) return '未区分说话人';
        if (/^speaker[\s_-]*\d+$/i.test(normalized)) {
            return normalized.replace(/^speaker/i, '说话人').replace(/[_-]/g, ' ');
        }
        if (/^spk[\s_-]*\d+$/i.test(normalized)) {
            return normalized.replace(/^spk/i, '说话人').replace(/[_-]/g, ' ');
        }
        if (/^\d+$/.test(normalized)) {
            return `说话人 ${normalized}`;
        }
        return normalized;
    };

    const getSpeakerLabel = (speakerKey) => speakerNames[speakerKey] || formatSpeakerLabel(speakerKey);

    const normalizeSpeakerKey = (key) => {
        if (key === null || key === undefined || key === '') return 'unknown';
        const str = String(key).trim();
        if (!str || str === 'unknown') return 'unknown';
        if (str === 'mixed') return 'mixed';
        const numMatch = str.match(/^(\d+)$/);
        if (numMatch) return Number(numMatch[1]);
        const speakerMatch = str.match(/^speaker[_\s-]*(\d+)$/i);
        if (speakerMatch) return Number(speakerMatch[1]);
        const spkMatch = str.match(/^spk[_\s-]*(\d+)$/i);
        if (spkMatch) return Number(spkMatch[1]);
        return str;
    };

    const handleRenameSpeaker = (spk, name) => {
        const trimmed = (name || '').trim();
        setSpeakerNames(prev => {
            const next = {...prev};
            if (trimmed) next[spk] = trimmed; else delete next[spk];
            return next;
        });
        setRenamingSpeaker(null);
    };

    const handleAddSpeaker = () => {
        const name = newSpeakerName.trim();
        if (!name) {
            setAddingSpeaker(false);
            setNewSpeakerName('');
            return;
        }
        const key = `custom_${Date.now()}`;
        setSpeakerNames(prev => ({...prev, [key]: name}));
        setCustomSpeakers(prev => [...prev, {key, label: name, mixed: false}]);
        setActiveSpeakerKeys(prev => prev === null ? [...allSpeakers.map((s) => s.key), key] : [...prev, key]);
        setAddingSpeaker(false);
        setNewSpeakerName('');
    };

    const handleDeleteSpeaker = (speakerKey) => {
        setCustomSpeakers(prev => prev.filter(cs => String(cs.key) !== String(speakerKey)));
        setSpeakerNames(prev => {
            const next = {...prev};
            delete next[speakerKey];
            return next;
        });
        setActiveSpeakerKeys(prev => prev === null ? allSpeakers.map((s) => s.key).filter(k => String(k) !== String(speakerKey)) : prev.filter(k => String(k) !== String(speakerKey)));
    };

    const pushUndo = (description) => {
        if (!transcriptData?.transcript?.segments) return;
        const snapshot = JSON.parse(JSON.stringify(transcriptData.transcript.segments));
        setUndoStack(prev => [...prev.slice(-49), { description, snapshot }]);
    };

    const handleUndo = () => {
        if (!transcriptData?.transcript?.segments || undoStack.length === 0) return;
        const entry = undoStack[undoStack.length - 1];
        transcriptData.transcript.segments.length = 0;
        entry.snapshot.forEach(seg => transcriptData.transcript.segments.push(seg));
        setUndoStack(prev => prev.slice(0, -1));
        setNormalizedVersion(v => v + 1);
    };

    const mutateSegments = (mutator, undoDescription = null) => {
        if (!transcriptData?.transcript?.segments) return;
        if (undoDescription) pushUndo(undoDescription);
        mutator();
        setNormalizedVersion(v => v + 1);
    };

    const handleChangeSegmentSpeaker = (segId, newSpk) => {
        mutateSegments(() => {
            const idx = segments.findIndex(s => s.id === segId);
            if (idx >= 0) segments[idx] = {...segments[idx], speaker: newSpk, speaker_label: getSpeakerLabel(newSpk)};
        }, '修改段落说话人');
    };

    const handleChangeSectionSpeaker = (oldSpk, newSpk, sectionSegs) => {
        if (String(oldSpk) === String(newSpk)) return;
        const segmentIds = sectionSegs.map(s => s.id);
        const fromLabel = getSpeakerLabel(oldSpk);
        const toLabel = getSpeakerLabel(newSpk);
        mutateSegments(() => {
            const ids = new Set(segmentIds);
            for (let i = 0; i < segments.length; i++) {
                if (ids.has(segments[i].id)) {
                    segments[i] = {...segments[i], speaker: newSpk, speaker_label: toLabel};
                }
            }
        }, `切换说话人 ${fromLabel} → ${toLabel}`);
    };

    const handleUpdateSegmentText = (segId, text) => {
        mutateSegments(() => {
            const idx = segments.findIndex(s => s.id === segId);
            if (idx >= 0) segments[idx] = {...segments[idx], text, raw_text: text};
        }, '编辑段落文本');
        setEditingSegmentId(null);
    };

    const handleUpdateWord = (segId, wordIndex, newText) => {
        const trimmed = (newText || '').trim();
        if (!trimmed) {
            setEditingWord(null);
            return;
        }
        mutateSegments(() => {
            const seg = segments.find(s => s.id === segId);
            if (!seg || !Array.isArray(seg.words) || wordIndex >= seg.words.length) return;
            seg.words[wordIndex] = { ...seg.words[wordIndex], word: trimmed };
            const fullText = seg.words.map(w => getWordText(w)).join('');
            seg.text = fullText;
            seg.raw_text = fullText;
        }, '编辑单词');
        setEditingWord(null);
    };

    const handleSplitSegment = (segId) => {
        mutateSegments(() => {
            const idx = segments.findIndex(s => s.id === segId);
            if (idx < 0) return;
            const seg = segments[idx];
            const text = (seg.text || '').trim();
            if (text.length < 2) return;
            const mid = Math.floor(text.length / 2);
            const leftText = text.slice(0, mid).trim();
            const rightText = text.slice(mid).trim();
            if (!leftText || !rightText) return;
            const midTime = seg.start + (seg.end - seg.start) / 2;
            const left = {...seg, id: segId + '_a', text: leftText, raw_text: leftText, end: midTime};
            const right = {...seg, id: segId + '_b', text: rightText, raw_text: rightText, start: midTime};
            segments.splice(idx, 1, left, right);
        }, '分割段落');
        setEditingSegmentId(null);
    };

    const handleSmartSplit = async () => {
        const sourceSegments = transcriptData?.transcript?.segments;
        if (!Array.isArray(sourceSegments)) return;
        try {
            const res = await axios.post(`${apiBaseUrl}/api/subtitle/smart-split`, {
                segments: sourceSegments,
                max_chars_per_line: maxCharsPerLine,
            });
            if (res.data?.segments) {
                mutateSegments(() => {
                    sourceSegments.length = 0;
                    res.data.segments.forEach(seg => sourceSegments.push(seg));
                }, '智能分句');
                setMessage(`智能分句完成，共 ${res.data.count} 段`);
                try { localStorage.setItem('autoedit_maxchars', String(maxCharsPerLine)); } catch {}
            }
        } catch (e) {
            setError('智能分句失败: ' + (e.response?.data?.detail || e.message));
        }
    };

    const getSpeakerColor = (speakerKey, alpha = 0.16) => {
        const palette = [
            { rgb: '0,122,255', text: '#0A84FF' },
            { rgb: '52,199,89', text: '#34C759' },
            { rgb: '255,149,0', text: '#FF9500' },
            { rgb: '175,82,222', text: '#AF52DE' },
            { rgb: '255,59,48', text: '#FF3B30' },
            { rgb: '90,200,250', text: '#5AC8FA' },
        ];
        if (speakerKey === 'unknown') {
            return {
                background: `rgba(142,142,147, ${alpha})`,
                border: `rgba(142,142,147, ${Math.min(alpha + 0.12, 0.38)})`,
                text: '#8E8E93',
            };
        }
        const normalized = String(speakerKey ?? 'default');
        let hash = 0;
        for (let i = 0; i < normalized.length; i += 1) {
            hash = (hash * 31 + normalized.charCodeAt(i)) % 2147483647;
        }
        const paletteItem = palette[Math.abs(hash) % palette.length];
        return {
            background: `rgba(${paletteItem.rgb}, ${alpha})`,
            border: `rgba(${paletteItem.rgb}, ${Math.min(alpha + 0.12, 0.38)})`,
            text: paletteItem.text,
        };
    };

    const getWordText = (word) => (
        (word?.word
        ?? word?.text
        ?? word?.token
        ?? word?.value
        ?? '').trim()
    );

    const isCJKChar = (ch) => /[一-鿿㐀-䶿豈-﫿]/.test(ch);

    const tokenizeDisplayText = (displayText) => {
        const text = String(displayText || '').trim();
        if (!text) return [];
        const tokens = [];
        const pattern = /[A-Za-z0-9]+(?:[''-][A-Za-z0-9]+)*|[\u4e00-\u9fff]+/gu;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            if (match[0]) {
                tokens.push(match[0]);
            }
        }
        return tokens;
    };

    const normalizeComparableText = (value) => String(value || '')
        .replace(/[^A-Za-z0-9\u4e00-\u9fff]+/gu, '')
        .toLowerCase();

    const normalizeSegmentWordsForEditor = (segment) => {
        if (!Array.isArray(segment?.words) || segment.words.length === 0) return false;

        const currentTokens = segment.words.map((word) => getWordText(word)).filter(Boolean);
        const targetTokens = tokenizeDisplayText(segment.text || segment.raw_text || '');
        if (currentTokens.length === 0 || targetTokens.length === 0) return false;

        if (targetTokens.length !== currentTokens.length) {
            return false;
        }

        const currentComparable = normalizeComparableText(currentTokens.join(''));
        const targetComparable = normalizeComparableText(targetTokens.join(''));
        const alreadyAligned = currentTokens.every((token, index) => token === targetTokens[index]);
        const looksFragmented = currentTokens.some((token) => token.length <= 2) && targetTokens.some((token) => token.length > 2);

        if (alreadyAligned) {
            return false;
        }

        if (currentComparable !== targetComparable && !looksFragmented) {
            return false;
        }

        segment.words = segment.words.map((word, index) => ({
            ...word,
            word: targetTokens[index] ?? getWordText(word),
        }));

        return true;
    };

    const needsSpaceBetweenTokens = (previousToken, token) => {
        if (!previousToken) return false;
        const prevLastChar = previousToken.slice(-1);
        const currFirstChar = token.slice(0, 1);
        // 两个 CJK 字词之间绝不插入空格
        if (isCJKChar(prevLastChar) && isCJKChar(currFirstChar)) return false;
        // 仅在拉丁语系 token 之间插入空格
        return /[A-Za-z0-9)]$/.test(previousToken) && /^[A-Za-z0-9(]/.test(token);
    };

    const isPunctuationToken = (token) => {
        if (!token) return true;
        return !/[A-Za-z0-9一-鿿]/.test(token);
    };

    const joinWordTexts = (words) => {
        let result = '';
        let previousToken = '';
        words.forEach((word) => {
            const token = getWordText(word);
            if (!token) return;
            result += needsSpaceBetweenTokens(previousToken, token) ? ` ${token}` : token;
            previousToken = token;
        });
        return result;
    };

    const getWordFlowKey = (segId, wordIndex) => `${segId}:${wordIndex}`;

    const getSelectedWordIndices = (segment) => {
        if (!Array.isArray(segment?.selectedWordIndices)) return [];
        return [...segment.selectedWordIndices].sort((a, b) => a - b);
    };

    const getSegmentById = (segId) => transcriptData?.transcript?.segments?.find((segment) => segment.id === segId);

    const getSegmentSpeakerMeta = (segment) => {
        const directSpeaker = getSpeakerKey(segment);
        if (directSpeaker !== null && directSpeaker !== undefined && directSpeaker !== '') {
            return {
                key: String(directSpeaker),
                label: getSpeakerLabel(directSpeaker),
                mixed: false,
            };
        }

        const wordSpeakers = Array.isArray(segment?.words)
            ? segment.words
                .map((word) => getSpeakerKey(word))
                .filter((value) => value !== null && value !== undefined && value !== '')
                .map((value) => String(value))
            : [];
        const uniqueWordSpeakers = [...new Set(wordSpeakers)];

        if (uniqueWordSpeakers.length === 1) {
            return {
                key: uniqueWordSpeakers[0],
                label: formatSpeakerLabel(uniqueWordSpeakers[0]),
                mixed: false,
            };
        }

        if (uniqueWordSpeakers.length > 1) {
            return {
                key: 'mixed',
                label: `多人说话 (${uniqueWordSpeakers.length})`,
                mixed: true,
            };
        }

        return {
            key: 'unknown',
            label: formatSpeakerLabel('unknown'),
            mixed: false,
        };
    };

    const getSpeakerSummary = (sourceSegments) => {
        const uniqueSpeakers = [];
        const seen = new Set();

        (sourceSegments || []).forEach((segment) => {
            const speakerMeta = getSegmentSpeakerMeta(segment);
            const normKey = String(normalizeSpeakerKey(speakerMeta?.key) ?? 'unknown');
            if (!speakerMeta?.label || seen.has(normKey)) return;
            seen.add(normKey);
            uniqueSpeakers.push({ ...speakerMeta, key: normalizeSpeakerKey(speakerMeta.key) });
        });

        return uniqueSpeakers;
    };

    const applyWordRangeSelection = (segment, startIdx, endIdx, mode = 'add', baseSelection = null) => {
        if (!segment?.words?.length) return;
        const from = Math.max(0, Math.min(startIdx, endIdx));
        const to = Math.min(segment.words.length - 1, Math.max(startIdx, endIdx));
        const nextSelection = new Set(baseSelection ?? getSelectedWordIndices(segment));

        for (let idx = from; idx <= to; idx += 1) {
            if (mode === 'remove') {
                nextSelection.delete(idx);
            } else {
                nextSelection.add(idx);
            }
        }

        segment.selectedWordIndices = Array.from(nextSelection).sort((a, b) => a - b);
        segment.bold = false;
    };

    const createSelectionSnapshot = (sourceSegments) => {
        const snapshot = new Map();
        (sourceSegments || []).forEach((segment) => {
            if (!Array.isArray(segment?.words) || segment.words.length === 0) {
                snapshot.set(segment.id, {
                    selectedIndices: [],
                    bold: Boolean(segment?.bold),
                });
                return;
            }

            snapshot.set(segment.id, {
                selectedIndices: segment.bold
                    ? segment.words.map((_, index) => index)
                    : getSelectedWordIndices(segment),
                bold: Boolean(segment.bold),
            });
        });
        return snapshot;
    };

    const buildSelectedSegments = (sourceSegments) => {
        const selectedSegments = [];
        let currentRun = null;

        const flushCurrentRun = () => {
            if (!currentRun) return;
            const mergedText = joinWordTexts(currentRun.words).trim()
                || String(currentRun.textFallback || currentRun.baseSegment?.text || '').trim();
            selectedSegments.push({
                ...currentRun.baseSegment,
                id: currentRun.id,
                start: Number(currentRun.start ?? currentRun.baseSegment?.start ?? 0),
                end: Number(currentRun.end ?? currentRun.baseSegment?.end ?? 0),
                text: mergedText,
                raw_text: mergedText,
                words: currentRun.words.map((word) => ({ ...word })),
                bold: true,
                selectedWordIndices: [],
            });
            currentRun = null;
        };

        (sourceSegments || []).forEach((segment) => {
            const hasWordLevel = Array.isArray(segment?.words) && segment.words.length > 0;
            const selectedWordIndices = getSelectedWordIndices(segment);

            if (!hasWordLevel) {
                const isSelected = Boolean(segment?.bold) || selectedWordIndices.length > 0;
                if (!isSelected) {
                    flushCurrentRun();
                    return;
                }
                const segmentText = String(segment?.text || '').trim();
                if (!currentRun) {
                    currentRun = {
                        id: `${segment.id}__run_0`,
                        baseSegment: segment,
                        start: Number(segment?.start ?? 0),
                        end: Number(segment?.end ?? 0),
                        words: [],
                        textFallback: segmentText,
                    };
                } else {
                    currentRun.end = Number(segment?.end ?? currentRun.end ?? 0);
                    currentRun.textFallback = `${currentRun.textFallback ? `${currentRun.textFallback} ` : ''}${segmentText}`.trim();
                }
                return;
            }

            segment.words.forEach((word, wordIndex) => {
                const isWordSelected = Boolean(segment.bold) || selectedWordIndices.includes(wordIndex);
                if (!isWordSelected) {
                    flushCurrentRun();
                    return;
                }

                const wordText = getWordText(word);
                if (!wordText) return;

                const wordStart = Number.isFinite(Number(word?.start)) ? Number(word.start) : Number(segment?.start ?? 0);
                const wordEnd = Number.isFinite(Number(word?.end)) ? Number(word.end) : Number(segment?.end ?? wordStart);

                if (!currentRun) {
                    currentRun = {
                        id: `${segment.id}__run_${wordIndex}`,
                        baseSegment: segment,
                        start: wordStart,
                        end: wordEnd,
                        words: [{ ...word }],
                        textFallback: '',
                    };
                    return;
                }

                currentRun.end = wordEnd;
                currentRun.words.push({ ...word });
            });
        });

        flushCurrentRun();
        return selectedSegments.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    };

    const updateSelectionStats = (sourceSegments) => {
        const selectedSegments = buildSelectedSegments(sourceSegments);
        setSelectedCount(selectedSegments.length);
        setTotalDuration(selectedSegments.reduce((sum, segment) => sum + (segment.end - segment.start), 0));
        return selectedSegments;
    };

    const updateEditorStats = (sourceSegments) => {
        updateSelectionStats(sourceSegments);
    };

    useEffect(() => {
        if (!transcriptData?.transcript?.segments) return;
        let normalized = false;
        transcriptData.transcript.segments.forEach((segment) => {
            if (normalizeSegmentWordsForEditor(segment)) {
                normalized = true;
            }
        });
        if (normalized) {
            setNormalizedVersion((value) => value + 1);
        }
        updateEditorStats(transcriptData.transcript.segments);
    }, [transcriptData]);

    useEffect(() => {
        const stopDragSelection = () => {
            dragSelectionRef.current = null;
            tableDragRef.current = null;
        };
        window.addEventListener('pointerup', stopDragSelection);
        return () => {
            window.removeEventListener('pointerup', stopDragSelection);
        };
    }, []);

    useEffect(() => {
        if (!openSpeakerMenu) return;
        const close = (e) => {
            if (e.target?.closest?.('.speaker-menu-trigger') || e.target?.closest?.('.speaker-menu-dropdown')) return;
            setOpenSpeakerMenu(null);
        };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [openSpeakerMenu]);

    useEffect(() => {
        if (!splitCursor) return;
        const onKeyDown = (e) => {
            if (e.key === 'Escape') setSplitCursor(null);
        };
        const onClick = (e) => {
            if (!e.target?.closest?.('.split-marker') && !e.target?.closest?.('button')) {
                setSplitCursor(null);
            }
        };
        window.addEventListener('keydown', onKeyDown);
        document.addEventListener('click', onClick);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('click', onClick);
        };
    }, [splitCursor]);

    useEffect(() => {
        const EDGE_THRESHOLD = 48;
        const MAX_SCROLL_STEP = 18;

        const updatePointerPosition = (event) => {
            if (!dragSelectionRef.current && !tableDragRef.current) return;
            if (dragSelectionRef.current) dragSelectionRef.current.clientY = event.clientY;
            if (tableDragRef.current) tableDragRef.current.clientY = event.clientY;
        };

        const tick = () => {
            const dragState = dragSelectionRef.current || tableDragRef.current;
            const container = scrollContainerRef.current;
            if (dragState && container && Number.isFinite(dragState.clientY)) {
                const rect = container.getBoundingClientRect();
                let delta = 0;

                if (dragState.clientY > rect.bottom - EDGE_THRESHOLD) {
                    const ratio = Math.min(1, (dragState.clientY - (rect.bottom - EDGE_THRESHOLD)) / EDGE_THRESHOLD);
                    delta = Math.ceil(MAX_SCROLL_STEP * ratio);
                } else if (dragState.clientY < rect.top + EDGE_THRESHOLD) {
                    const ratio = Math.min(1, ((rect.top + EDGE_THRESHOLD) - dragState.clientY) / EDGE_THRESHOLD);
                    delta = -Math.ceil(MAX_SCROLL_STEP * ratio);
                }

                if (delta !== 0) {
                    container.scrollTop += delta;
                }
            }
            autoScrollFrameRef.current = window.requestAnimationFrame(tick);
        };

        window.addEventListener('pointermove', updatePointerPosition, { passive: true });
        autoScrollFrameRef.current = window.requestAnimationFrame(tick);
        return () => {
            window.removeEventListener('pointermove', updatePointerPosition);
            if (autoScrollFrameRef.current) {
                window.cancelAnimationFrame(autoScrollFrameRef.current);
                autoScrollFrameRef.current = null;
            }
        };
    }, []);

    const segments = transcriptData?.transcript?.segments || [];

    useEffect(() => {
        if (!splitCursor) return;
        const handleKeyDown = (event) => {
            if (event.key !== 'Enter' || event.shiftKey) return;
            const target = event.target;
            const tagName = String(target?.tagName || '').toLowerCase();
            if (target?.isContentEditable || ['input', 'textarea', 'select'].includes(tagName)) return;
            event.preventDefault();
            const { segId, afterWordIndex } = splitCursor;
            mutateSegments(() => {
                const idx = segments.findIndex(s => s.id === segId);
                if (idx < 0) return;
                const seg = segments[idx];
                const words = Array.isArray(seg.words) ? seg.words : [];
                if (words.length === 0) return;
                const leftWords = words.slice(0, afterWordIndex + 1);
                const rightWords = words.slice(afterWordIndex + 1);
                if (leftWords.length === 0 && rightWords.length === 0) return;
                let splitTime;
                if (leftWords.length === 0) {
                    splitTime = rightWords[0].start ?? seg.start;
                } else if (rightWords.length === 0) {
                    splitTime = leftWords[leftWords.length - 1].end ?? seg.end;
                } else {
                    const lastLeft = leftWords[leftWords.length - 1];
                    const firstRight = rightWords[0];
                    splitTime = ((lastLeft.end ?? lastLeft.start ?? 0) + (firstRight.start ?? firstRight.end ?? 0)) / 2;
                }
                if (!Number.isFinite(splitTime)) splitTime = seg.start + (seg.end - seg.start) * (Math.max(leftWords.length, 1) / words.length);
                const leftText = leftWords.map(w => getWordText(w)).join('');
                const rightText = rightWords.map(w => getWordText(w)).join('');
                const left = {...seg, id: segId + '_a', words: leftWords.length > 0 ? leftWords : undefined, text: leftText, raw_text: leftText, end: splitTime, sectionBreakAfter: true};
                const right = {...seg, id: segId + '_b', words: rightWords.length > 0 ? rightWords : undefined, text: rightText, raw_text: rightText, start: splitTime};
                segments.splice(idx, 1, left, right);
            }, '分割段落');
            setSplitCursor(null);
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [splitCursor, segments, transcriptData, normalizedVersion]);

    useEffect(() => {
        const handleUndoKey = (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'z' && !event.shiftKey) {
                const target = event.target;
                const tagName = String(target?.tagName || '').toLowerCase();
                if (target?.isContentEditable || ['input', 'textarea', 'select'].includes(tagName)) return;
                event.preventDefault();
                handleUndo();
            }
        };
        window.addEventListener('keydown', handleUndoKey);
        return () => window.removeEventListener('keydown', handleUndoKey);
    }, [undoStack, transcriptData, normalizedVersion]);

    const speakerSummary = useMemo(() => getSpeakerSummary(segments), [transcriptData, segments, normalizedVersion]);
    const allSpeakers = useMemo(() => {
        const merged = speakerSummary.map(s => ({...s}));
        customSpeakers.forEach(cs => {
            if (!merged.some(s => String(s.key) === String(cs.key))) {
                merged.push({...cs});
            }
        });
        return merged;
    }, [speakerSummary, customSpeakers]);
    const speakerKeySignature = allSpeakers.map((speaker) => speaker.key).join('|');

    const storageKey = `autoedit_speaker_${activeTranscriptId || 'default'}`;

    // 每次挂载无条件重置筛选为全部可见
    useEffect(() => {
        setActiveSpeakerKeys(null);
        setAllCollapsed(false);
        setExpandedSpeakerKeys(new Set());
    }, []);

    const prevTranscriptIdRef = useRef(null);
    useEffect(() => {
        if (prevTranscriptIdRef.current !== activeTranscriptId) {
            prevTranscriptIdRef.current = activeTranscriptId;
            try { localStorage.removeItem(`autoedit_speaker_${activeTranscriptId || 'default'}`); } catch (_) {}
            setActiveSpeakerKeys(null);
            setAllCollapsed(false);
            setExpandedSpeakerKeys(new Set());
            return;
        }

        if (speakerSummary.length === 0 && customSpeakers.length === 0) {
            setActiveSpeakerKeys(null);
            return;
        }

        setActiveSpeakerKeys((currentKeys) => {
            if (currentKeys && currentKeys.length > 0) {
                const nextKeys = currentKeys.filter((key) => allSpeakers.some((speaker) => speaker.key === key));
                if (nextKeys.length > 0) return nextKeys;
            }

            try {
                const saved = localStorage.getItem(storageKey);
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (parsed.activeSpeakerKeys && Array.isArray(parsed.activeSpeakerKeys) && parsed.activeSpeakerKeys.length > 0) {
                        const validKeys = parsed.activeSpeakerKeys.filter((key) => allSpeakers.some((speaker) => speaker.key === key));
                        if (validKeys.length > 0) {
                            if (parsed.speakerNames && typeof parsed.speakerNames === 'object') {
                                setSpeakerNames(parsed.speakerNames);
                            }
                            if (parsed.customSpeakers && Array.isArray(parsed.customSpeakers)) {
                                setCustomSpeakers(parsed.customSpeakers);
                            }
                            return validKeys;
                        }
                    }
                }
            } catch (_) { /* ignore corrupt storage */ }

            // 默认显示全部（null），而非 allSpeakers 的 keys 数组
            // 避免因 key 格式不匹配导致过滤后无内容
            return null;
        });
    }, [speakerKeySignature, storageKey]);

    useEffect(() => {
        try {
            localStorage.setItem(storageKey, JSON.stringify({ activeSpeakerKeys, speakerNames, customSpeakers }));
        } catch (_) { /* ignore quota errors */ }
    }, [activeSpeakerKeys, speakerNames, customSpeakers, storageKey]);

    const visibleSegments = useMemo(() => {
        if (!segments.length) return [];
        if (activeSpeakerKeys === null) return [...segments].sort((a, b) => {
            const startDiff = Number(a?.start ?? 0) - Number(b?.start ?? 0);
            if (startDiff !== 0) return startDiff;
            const endDiff = Number(a?.end ?? 0) - Number(b?.end ?? 0);
            if (endDiff !== 0) return endDiff;
            return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
        });
        const filtered = activeSpeakerKeys.length === 0
            ? []
            : segments.filter((segment) => {
                const segmentKey = normalizeSpeakerKey(getSegmentSpeakerMeta(segment).key);
                return activeSpeakerKeys.some((k) => normalizeSpeakerKey(k) === segmentKey);
            });
        return filtered.sort((a, b) => {
            const startDiff = Number(a?.start ?? 0) - Number(b?.start ?? 0);
            if (startDiff !== 0) return startDiff;
            const endDiff = Number(a?.end ?? 0) - Number(b?.end ?? 0);
            if (endDiff !== 0) return endDiff;
            return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
        });
    }, [segments, activeSpeakerKeys, normalizedVersion]);

    const visibleWordItems = useMemo(() => (
        visibleSegments.flatMap((segment) => (
            Array.isArray(segment?.words)
                ? segment.words.map((word, wordIndex) => ({
                    key: getWordFlowKey(segment.id, wordIndex),
                    segId: segment.id,
                    wordIndex,
                    start: word.start ?? segment.start ?? 0,
                }))
                : []
        ))
    ), [visibleSegments, normalizedVersion]);

    const visibleWordIndexLookup = useMemo(() => {
        const lookup = new Map();
        visibleWordItems.forEach((item, index) => {
            lookup.set(item.key, index);
        });
        return lookup;
    }, [visibleWordItems]);

    const applyFlowSelectionRange = (sourceSegments, startFlowIndex, endFlowIndex, mode = 'add', baseSnapshot = null) => {
        if (!Array.isArray(sourceSegments) || visibleWordItems.length === 0) return;

        const from = Math.max(0, Math.min(startFlowIndex, endFlowIndex));
        const to = Math.min(visibleWordItems.length - 1, Math.max(startFlowIndex, endFlowIndex));
        const snapshot = baseSnapshot ?? createSelectionSnapshot(sourceSegments);
        const nextSelectionMap = new Map();

        (sourceSegments || []).forEach((segment) => {
            const previousState = snapshot.get(segment.id);
            nextSelectionMap.set(segment.id, new Set(previousState?.selectedIndices || []));
        });

        const touchedSegments = new Set();
        for (let flowIndex = from; flowIndex <= to; flowIndex += 1) {
            const wordItem = visibleWordItems[flowIndex];
            if (!wordItem) continue;
            const selectionSet = nextSelectionMap.get(wordItem.segId) || new Set();
            if (mode === 'remove') {
                selectionSet.delete(wordItem.wordIndex);
            } else {
                selectionSet.add(wordItem.wordIndex);
            }
            nextSelectionMap.set(wordItem.segId, selectionSet);
            touchedSegments.add(wordItem.segId);
        }

        (sourceSegments || []).forEach((segment) => {
            const previousState = snapshot.get(segment.id);
            if (!Array.isArray(segment?.words) || segment.words.length === 0) {
                segment.bold = Boolean(previousState?.bold);
                return;
            }

            if (!touchedSegments.has(segment.id)) {
                segment.bold = Boolean(previousState?.bold);
                segment.selectedWordIndices = previousState?.bold ? [] : [...(previousState?.selectedIndices || [])];
                return;
            }

            const nextSelectedIndices = Array.from(nextSelectionMap.get(segment.id) || []).sort((a, b) => a - b);
            const allWordsSelected = nextSelectedIndices.length === segment.words.length && segment.words.length > 0;
            if (allWordsSelected) {
                segment.bold = true;
                segment.selectedWordIndices = [];
            } else {
                segment.selectedWordIndices = nextSelectedIndices;
                segment.bold = false;
            }
        });
    };

    const getWordFlowIndex = (segId, wordIndex) => visibleWordIndexLookup.get(getWordFlowKey(segId, wordIndex));

    const isWordCurrentlySelected = (segment, wordIndex) => {
        if (!segment) return false;
        if (segment.bold) return true;
        return getSelectedWordIndices(segment).includes(wordIndex);
    };

    const speakerSections = useMemo(() => {
        const runs = [];

        visibleSegments.forEach((segment, index) => {
            const speaker = getSegmentSpeakerMeta(segment);
            const previousRun = runs[runs.length - 1];
            const previousSegment = index > 0 ? visibleSegments[index - 1] : null;
            const forceBreak = Boolean(previousSegment?.sectionBreakAfter);

            if (!previousRun || previousRun.speaker.key !== speaker.key || forceBreak) {
                runs.push({
                    speaker,
                    segments: [segment],
                    start: Number(segment?.start ?? 0),
                    end: Number(segment?.end ?? 0),
                });
                return;
            }

            previousRun.segments.push(segment);
            previousRun.end = Number(segment?.end ?? previousRun.end ?? 0);
        });

        return runs;
    }, [visibleSegments, normalizedVersion]);

    const handleToggleSelect = (segId) => {
        if (!transcriptData?.transcript?.segments) return;
        const segment = getSegmentById(segId);
        if (!segment) return;
        segment.bold = !segment.bold;
        if (segment.bold) {
            segment.selectedWordIndices = [];
        }
        setNormalizedVersion((v) => v + 1);
        updateEditorStats(transcriptData.transcript.segments);
    };

    const handleSelectRange = (fromIndex, toIndex) => {
        if (!transcriptData?.transcript?.segments) return;
        const [start, end] = fromIndex < toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
        for (let i = start; i <= end; i++) {
            const seg = visibleSegments[i];
            if (seg) {
                seg.bold = true;
                seg.selectedWordIndices = [];
            }
        }
        setNormalizedVersion((v) => v + 1);
        updateEditorStats(transcriptData.transcript.segments);
    };

    const handleRowClick = (segId, index, shiftKey) => {
        if (!transcriptData?.transcript?.segments) return;
        if (shiftKey && lastClickedIndexRef.current >= 0 && lastClickedIndexRef.current !== index) {
            handleSelectRange(lastClickedIndexRef.current, index);
        } else {
            handleToggleSelect(segId);
        }
        lastClickedIndexRef.current = index;
    };

    const handleRowMouseDown = (e, segId, index, isSelected) => {
        if (e.button !== 0) return;
        if (!transcriptData?.transcript?.segments) return;

        const snapshot = visibleSegments.map(seg => !!seg.bold);
        tableDragRef.current = {
            anchorIndex: index,
            mode: isSelected ? 'deselect' : 'select',
            snapshot,
        };
        didTableDragRef.current = false;
    };

    const handleClearWordSelection = (segId) => {
        if (!transcriptData?.transcript?.segments) return;
        const segment = getSegmentById(segId);
        if (!segment) return;
        segment.selectedWordIndices = [];
        segment.bold = false;
        setNormalizedVersion((v) => v + 1);
        updateEditorStats(transcriptData.transcript.segments);
    };

    const handleClearAllSelections = () => {
        if (!transcriptData?.transcript?.segments) return;
        transcriptData.transcript.segments.forEach((segment) => {
            segment.bold = false;
            segment.selectedWordIndices = [];
        });
        setNormalizedVersion((v) => v + 1);
        updateEditorStats(transcriptData.transcript.segments);
    };

    const handleSelectSectionSelections = (sectionSegments) => {
        if (!Array.isArray(sectionSegments) || sectionSegments.length === 0) return;
        sectionSegments.forEach((segment) => {
            segment.bold = true;
            segment.selectedWordIndices = [];
        });
        setNormalizedVersion((v) => v + 1);
        updateEditorStats(transcriptData?.transcript?.segments || []);
    };

    const handleClearSectionSelections = (sectionSegments) => {
        if (!Array.isArray(sectionSegments) || sectionSegments.length === 0) return;
        sectionSegments.forEach((segment) => {
            segment.bold = false;
            segment.selectedWordIndices = [];
        });
        setNormalizedVersion((v) => v + 1);
        updateEditorStats(transcriptData?.transcript?.segments || []);
    };

    const handleSelectAllVisible = () => {
        if (!transcriptData?.transcript?.segments) return;
        visibleSegments.forEach((segment) => {
            segment.bold = true;
            segment.selectedWordIndices = [];
        });
        setNormalizedVersion((v) => v + 1);
        updateEditorStats(transcriptData.transcript.segments);
    };



    const handleWordPointerDown = (e, segId, wordIndex) => {
        setSplitCursor(null);
        setEditingWord(null);
        e.stopPropagation();
        if (!transcriptData?.transcript?.segments) {
            dragSelectionRef.current = null;
            return;
        }

        const flowIndex = getWordFlowIndex(segId, wordIndex);
        const segment = getSegmentById(segId);
        if (flowIndex === undefined || !segment) {
            dragSelectionRef.current = null;
            return;
        }

        const snapshot = createSelectionSnapshot(transcriptData.transcript.segments);
        const mode = isWordCurrentlySelected(segment, wordIndex) ? 'remove' : 'add';

        dragSelectionRef.current = {
            anchorFlowIndex: flowIndex,
            lastFlowIndex: flowIndex,
            mode,
            snapshot,
            clientY: e.clientY,
        };
    };

    const handleWordPointerEnter = (segId, wordIndex) => {
        if (!transcriptData?.transcript?.segments) return;
        const dragState = dragSelectionRef.current;
        if (!dragState) return;

        const flowIndex = getWordFlowIndex(segId, wordIndex);
        if (flowIndex === undefined || flowIndex === dragState.lastFlowIndex) return;

        applyFlowSelectionRange(
            transcriptData.transcript.segments,
            dragState.anchorFlowIndex,
            flowIndex,
            dragState.mode,
            dragState.snapshot,
        );
        dragState.lastFlowIndex = flowIndex;
        setNormalizedVersion((v) => v + 1);
        updateEditorStats(transcriptData.transcript.segments);
    };

    const handleWordClick = (e, segId = null, wordIndex = null) => {
        e.stopPropagation();
        setSplitCursor(null);
        if (segId == null || segId === '') return;
        if (wordIndex == null) return;

        const segment = getSegmentById(segId);
        if (!segment) return;

        if (e.shiftKey && wordAnchorRef.current.segId) {
            // Shift+点击: 从锚点范围选择
            const anchorFlow = getWordFlowIndex(wordAnchorRef.current.segId, wordAnchorRef.current.wordIndex);
            const currentFlow = getWordFlowIndex(segId, wordIndex);
            if (anchorFlow !== undefined && currentFlow !== undefined && transcriptData?.transcript?.segments) {
                const snapshot = createSelectionSnapshot(transcriptData.transcript.segments);
                const startFlow = Math.min(anchorFlow, currentFlow);
                const endFlow = Math.max(anchorFlow, currentFlow);
                applyFlowSelectionRange(transcriptData.transcript.segments, startFlow, endFlow, 'add', snapshot);
                setNormalizedVersion(v => v + 1);
                updateEditorStats(transcriptData.transcript.segments);
            }
        } else {
            // 普通点击: 切换当前词 + 设置锚点
            const snapshot = createSelectionSnapshot(transcriptData.transcript.segments);
            const flowIndex = getWordFlowIndex(segId, wordIndex);
            if (flowIndex !== undefined && transcriptData?.transcript?.segments) {
                const mode = isWordCurrentlySelected(segment, wordIndex) ? 'remove' : 'add';
                applyFlowSelectionRange(transcriptData.transcript.segments, flowIndex, flowIndex, mode, snapshot);
                setNormalizedVersion(v => v + 1);
                updateEditorStats(transcriptData.transcript.segments);
            }
            wordAnchorRef.current = { segId, wordIndex };
        }
    };

    const performApply = async () => {
        setShowConfirm(false);
        setLoading(true);
        setMessage(null);
        setError(null);
        try {
            const payloadSegments = buildSelectedSegments(transcriptData.transcript.segments);
            if (payloadSegments.length === 0) {
                setError('请先选择要保留的整句');
                setLoading(false);
                return;
            }
            const res = await axios.post(`${apiBaseUrl}/api/timeline/apply-edit`, {
                segments: payloadSegments,
                source_type: transcriptData.sourceType || 'file',
                original_filename: transcriptData.originalFilename || transcriptData.videoPath?.split(/[/\\]/).pop() || '',
                video_path: transcriptData.videoPath || '',
                local_target_folder: importLocalFolder,
                davinci_folder: importDavinciFolder,
                clip_mapping: transcriptData.clipMapping || null,
                apply_method: applyMethod,
                frame_rate: transcriptData.frameRate || 24,
                merge_gap_seconds: mergeGapSeconds,
            });
            if (res.data.status === 'success') {
                setMessage(res.data.warning ? `${res.data.message}\n${res.data.warning}` : res.data.message);
            } else {
                setError(res.data.message || '应用失败');
            }
        } catch (e) {
            setError(e.response?.data?.detail || e.message);
        } finally {
            setLoading(false);
        }
    };

    const handleApply = async () => {
        await performApply();
    };

    const toggleSpeakerFilter = (speakerKey) => {
        setActiveSpeakerKeys((currentKeys) => {
            if (currentKeys === null) {
                // 当前显示全部，排除该说话人
                return allSpeakers.map((s) => s.key).filter((k) => k !== speakerKey);
            }
            if (!currentKeys.includes(speakerKey)) {
                return [...currentKeys, speakerKey];
            }
            if (currentKeys.length === 1) {
                return currentKeys;
            }
            return currentKeys.filter((key) => key !== speakerKey);
        });
    };


    const formatTime = (seconds) => {
        if (!seconds && seconds !== 0) return '--';
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}:${String(secs).padStart(2, '0')}`;
    };

    const formatTimeFull = (seconds) => {
        if (!seconds && seconds !== 0) return '0:00';
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.round((seconds % 1) * 100);
        if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        return `${minutes}:${String(secs).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
    };

    const formatTimeShort = (seconds) => {
        if (!seconds && seconds !== 0) return '--';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.round((seconds % 1) * 100);
        return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
    };

    const formatTimecode = (seconds) => {
        if (!seconds && seconds !== 0) return '--';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const f = Math.round((seconds % 1) * frameRate);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
    };

    const displayTime = (seconds) => timeFormat === 'timecode' ? formatTimecode(seconds) : formatTimeShort(seconds);

    return (
        <div className="page-panel">
            <div className="page-content">
                <div className="page-content-inner">
                    <div className="mac-settings-section" style={{ marginBottom: '16px' }}>
                            <div className="mac-settings-title">转录项目</div>
                            <div className="mac-settings-group" style={{ padding: '12px 14px' }}>
                                <TranscriptProjectTabs
                                    projects={transcriptProjects}
                                    activeId={activeTranscriptId}
                                    resolveStatus={resolveStatus}
                                    onSwitch={(id) => onSwitchTranscriptProject?.(id)}
                                    onClose={onDeleteTranscriptProject}
                                    onRefresh={onRefreshTranscriptProjects}
                                    onManage={() => setManageMode(true)}
                                />
                                {activeTranscriptId && (() => {
                                    const activeProject = transcriptProjects.find(p => p.id === activeTranscriptId);
                                    const localPath = activeProject?.localImportPath || '';
                                    const mediaPath = activeProject?.mediaPoolPath || '';
                                    if (!localPath && !mediaPath) return null;
                                    return (
                                        <div style={{
                                            marginTop: '8px', display: 'flex', alignItems: 'center', gap: '12px',
                                            padding: '8px 12px', borderRadius: '8px',
                                            background: 'var(--mac-surface-muted)', border: '1px solid var(--mac-border)',
                                            fontSize: '11px', flexWrap: 'wrap',
                                        }}>
                                            {localPath && (
                                                <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--mac-text-secondary)' }}>
                                                    <FolderOpen size={11} />
                                                    <span style={{ opacity: 0.6 }}>导入路径:</span>
                                                    <span style={{ color: 'var(--mac-text)', fontFamily: "'SF Mono', 'Geist Mono', monospace", fontSize: '10px', maxWidth: '340px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{localPath}</span>
                                                </span>
                                            )}
                                            {mediaPath && (
                                                <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--mac-text-secondary)' }}>
                                                    <MapPin size={11} />
                                                    <span style={{ opacity: 0.6 }}>媒体池路径:</span>
                                                    <span style={{ color: 'var(--mac-text)', fontFamily: "'SF Mono', 'Geist Mono', monospace", fontSize: '10px', maxWidth: '340px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mediaPath}</span>
                                                </span>
                                            )}
                                        </div>
                                    );
                                })()}
                            </div>
                        </div>
                    {!manageMode && isCrossProject && importSettingsLoaded && (
                        <div className="mac-settings-section" style={{ marginBottom: '16px' }}>
                            <div className="mac-settings-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <Info size={13} style={{ color: '#FF9500' }} />
                                跨项目导入设置
                            </div>
                            <div className="mac-settings-group" style={{ padding: '14px' }}>
                                <div style={{
                                    background: 'rgba(255, 149, 0, 0.06)',
                                    border: '1px solid rgba(255, 149, 0, 0.15)',
                                    borderRadius: '8px',
                                    padding: '10px 14px',
                                    marginBottom: '14px',
                                    fontSize: '12px',
                                    color: 'var(--mac-text-secondary)',
                                    display: 'flex',
                                    alignItems: 'flex-start',
                                    gap: '8px',
                                }}>
                                    <AlertTriangle size={14} color="#FF9500" style={{ flexShrink: 0, marginTop: '1px' }} />
                                    <span>
                                        当前达芬奇项目（{resolveStatus.project}）与转录来源项目（{(() => {
                                            const activeProject = transcriptProjects.find(p => p.id === activeTranscriptId);
                                            return activeProject?.davinci_project || activeProject?.boundDavinciProject || '未知';
                                        })()}）不同，源素材不在媒体池中。设置导入路径后将自动复制素材并导入。
                                    </span>
                                </div>
                                <div className="mac-settings-row">
                                    <div className="mac-settings-row-left">
                                        <div className="mac-settings-icon-wrapper" style={{ background: 'rgba(10,132,255,0.12)', color: '#0A84FF' }}>
                                            <Folder size={16} />
                                        </div>
                                        <div className="mac-settings-text-block">
                                            <div className="mac-settings-label">本地保存位置</div>
                                            <div className="mac-settings-desc" style={!importLocalFolder ? { color: '#FF9F0A' } : undefined}>
                                                {importLocalFolder ? '源文件将复制到此目录' : '选择当前项目下的目标文件夹'}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="mac-settings-row-right">
                                        <MacSelect
                                            width="220px"
                                            value={importLocalFolder}
                                            onChange={(v) => setImportLocalFolder(v)}
                                            options={localFolderOptions.map(v => ({ value: v, label: v }))}
                                            placeholder={localFolderOptions.length === 0 ? '未检测到项目文件夹' : '请选择本地保存位置'}
                                        />
                                    </div>
                                </div>
                                <div className="mac-settings-row">
                                    <div className="mac-settings-row-left">
                                        <div className="mac-settings-icon-wrapper" style={{ background: 'rgba(175,82,222,0.12)', color: '#AF52DE' }}>
                                            <Monitor size={16} />
                                        </div>
                                        <div className="mac-settings-text-block">
                                            <div className="mac-settings-label">媒体池目录</div>
                                            <div className="mac-settings-desc" style={!importDavinciFolder ? { color: '#FF9F0A' } : undefined}>
                                                {importDavinciFolder ? '素材将导入此媒体池文件夹' : '选择达芬奇媒体池目标文件夹'}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="mac-settings-row-right">
                                        <MacSelect
                                            width="220px"
                                            value={importDavinciFolder}
                                            onChange={(v) => setImportDavinciFolder(v)}
                                            options={davinciFolderOptions.map(v => ({ value: v, label: v }))}
                                            placeholder={davinciFolderOptions.length === 0 ? '请先打开达芬奇' : '请选择媒体池目录'}
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                    {manageMode ? (
                        <TranscriptProjectManager
                            projects={transcriptProjects}
                            resolveStatus={resolveStatus}
                            onUpdate={onUpdateTranscriptProjectMeta}
                            onDelete={handleDeleteProject}
                            onBack={() => setManageMode(false)}
                        />
                    ) : (
                    <>
                    {error && (
                        <div style={{ background: 'rgba(255, 59, 48, 0.1)', color: '#FF3B30', padding: '12px 16px', borderRadius: '10px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                            <AlertCircle size={16} /> {error}
                        </div>
                    )}
                    {message && (
                        <div style={{ background: 'rgba(52, 199, 89, 0.1)', color: '#34C759', padding: '12px 16px', borderRadius: '10px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                            <CheckCircle2 size={16} /> {message}
                        </div>
                    )}

                    <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
                        <div style={{ flex: 1, background: 'var(--mac-surface-solid)', borderRadius: '14px', padding: '14px 16px', border: '1px solid var(--mac-border)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                            <div style={{ fontSize: '11px', fontWeight: 500, color: 'var(--mac-text-secondary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>已选内容</div>
                            <div style={{ fontSize: '22px', fontWeight: '600', color: 'var(--mac-accent)', fontVariantNumeric: 'tabular-nums' }}>
                                {selectedCount} <span style={{ fontSize: '12px', fontWeight: '400', color: 'var(--mac-text-secondary)' }}>个片段</span>
                            </div>
                        </div>
                        <div style={{ flex: 1, background: 'var(--mac-surface-solid)', borderRadius: '14px', padding: '14px 16px', border: '1px solid var(--mac-border)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                            <div style={{ fontSize: '11px', fontWeight: 500, color: 'var(--mac-text-secondary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>选取时长</div>
                            <div style={{ fontSize: '22px', fontWeight: '600', color: '#34C759', fontVariantNumeric: 'tabular-nums' }}>
                                {formatTimeFull(totalDuration)}
                            </div>
                        </div>
                        <div style={{ flex: 1, background: 'var(--mac-surface-solid)', borderRadius: '14px', padding: '14px 16px', border: '1px solid var(--mac-border)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                            <div style={{ fontSize: '11px', fontWeight: 500, color: 'var(--mac-text-secondary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>当前可见</div>
                            <div style={{ fontSize: '22px', fontWeight: '600', color: 'var(--mac-text)', fontVariantNumeric: 'tabular-nums' }}>
                                {visibleSegments.length} <span style={{ fontSize: '12px', fontWeight: '400', color: 'var(--mac-text-secondary)' }}>/ {segments.length} 段</span>
                            </div>
                        </div>
                    </div>
                    <div style={{
                        flex: 1, display: 'flex', flexDirection: 'column',
                        minHeight: 0, background: 'var(--mac-surface-solid)',
                        borderRadius: '14px', border: '1px solid var(--mac-border)',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                        overflow: 'hidden'
                    }}>
                        <div style={{
                            padding: '12px 16px', borderBottom: '1px solid var(--mac-border)',
                            fontSize: '12px', fontWeight: '500', color: 'var(--mac-text-secondary)',
                            display: 'flex', flexDirection: 'column', gap: '10px',
                            background: 'var(--mac-surface-solid)',
                        }}>
                            {allSpeakers.length > 0 && (
                                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                                    {allSpeakers.map((speaker) => {
                                        const color = getSpeakerColor(speaker.key, 0.14);
                                        const isActive = activeSpeakerKeys === null || activeSpeakerKeys.includes(speaker.key);
                                        const speakerSegmentsCount = segments.filter((segment) => getSegmentSpeakerMeta(segment).key === speaker.key).length;
                                        return (
                                            String(renamingSpeaker) === String(speaker.key) ? (
                                                <input key={speaker.key} autoFocus className="mac-input"
                                                    defaultValue={getSpeakerLabel(speaker.key)}
                                                    onBlur={(e) => handleRenameSpeaker(speaker.key, e.target.value)}
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter') handleRenameSpeaker(speaker.key, e.target.value);
                                                        if (e.key === 'Escape') setRenamingSpeaker(null);
                                                    }}
                                                    style={{
                                                        padding: '6px 10px', borderRadius: '999px', fontSize: '11px',
                                                        width: '100px', border: `2px solid ${color.border}`,
                                                        background: color.background, color: color.text, outline: 'none',
                                                    }}
                                                />
                                            ) : (
                                                <button
                                                    key={speaker.key}
                                                    type="button"
                                                    onClick={(e) => {
                                                        if (e.altKey) {
                                                            setActiveSpeakerKeys([speaker.key]);
                                                            return;
                                                        }
                                                        const now = Date.now();
                                                        const last = lastClickRef.current[speaker.key] || 0;
                                                        lastClickRef.current[speaker.key] = now;
                                                        const timerKey = `spk_${speaker.key}`;
                                                        if (now - last < 450) {
                                                            if (clickTimersRef.current[timerKey] && clickTimersRef.current[timerKey] !== 'done') {
                                                                clearTimeout(clickTimersRef.current[timerKey]);
                                                            }
                                                            delete clickTimersRef.current[timerKey];
                                                            setRenamingSpeaker(speaker.key);
                                                            return;
                                                        }
                                                        clickTimersRef.current[timerKey] = setTimeout(() => {
                                                            toggleSpeakerFilter(speaker.key);
                                                            clickTimersRef.current[timerKey] = 'done';
                                                        }, 200);
                                                    }}
                                                    onDoubleClick={(e) => {
                                                        e.preventDefault();
                                                        const timerKey = `spk_${speaker.key}`;
                                                        if (clickTimersRef.current[timerKey] === 'done') {
                                                            toggleSpeakerFilter(speaker.key);
                                                        } else if (clickTimersRef.current[timerKey]) {
                                                            clearTimeout(clickTimersRef.current[timerKey]);
                                                        }
                                                        delete clickTimersRef.current[timerKey];
                                                        setRenamingSpeaker(speaker.key);
                                                    }}
                                                    style={{
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        gap: '6px',
                                                        padding: '6px 10px',
                                                        borderRadius: '999px',
                                                        fontSize: '11px',
                                                        color: isActive ? color.text : 'var(--mac-text-secondary)',
                                                        background: isActive ? color.background : 'transparent',
                                                        border: `1px solid ${isActive ? color.border : 'var(--mac-border)'}`,
                                                        cursor: 'pointer',
                                                    }}
                                                    title={`单击筛选 · 双击重命名 · Option+单击仅查看该说话人`}
                                                >
                                                    <span style={{ width: '6px', height: '6px', borderRadius: '999px', background: isActive ? color.text : 'var(--mac-text-secondary)' }} />
                                                    {getSpeakerLabel(speaker.key)}
                                                    <span style={{ opacity: 0.7 }}>{speakerSegmentsCount}</span>
                                                    <span
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleDeleteSpeaker(speaker.key);
                                                        }}
                                                        style={{
                                                            display: 'inline-flex',
                                                            alignItems: 'center',
                                                            justifyContent: 'center',
                                                            width: '16px',
                                                            height: '16px',
                                                            borderRadius: '50%',
                                                            fontSize: '11px',
                                                            lineHeight: '1',
                                                            color: 'var(--mac-text-secondary)',
                                                            opacity: 0.5,
                                                            cursor: 'pointer',
                                                            transition: 'opacity 0.15s',
                                                            marginLeft: '2px',
                                                        }}
                                                        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = '#FF453A'; }}
                                                        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.5'; e.currentTarget.style.color = 'var(--mac-text-secondary)'; }}
                                                        title={`删除说话人 ${getSpeakerLabel(speaker.key)}`}
                                                    >×</span>
                                                </button>
                                            )
                                        );
                                    })}
                                    {addingSpeaker ? (
                                        <div style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: '4px',
                                        }}>
                                            <input
                                                autoFocus
                                                className="mac-input"
                                                placeholder="说话人名称"
                                                value={newSpeakerName}
                                                onChange={(e) => setNewSpeakerName(e.target.value)}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') handleAddSpeaker();
                                                    if (e.key === 'Escape') { setAddingSpeaker(false); setNewSpeakerName(''); }
                                                }}
                                                onBlur={handleAddSpeaker}
                                                style={{
                                                    padding: '6px 10px',
                                                    borderRadius: '999px',
                                                    fontSize: '11px',
                                                    width: '110px',
                                                    border: '1px solid var(--mac-border)',
                                                    outline: 'none',
                                                }}
                                            />
                                        </div>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() => setAddingSpeaker(true)}
                                            style={{
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                width: '28px',
                                                height: '28px',
                                                borderRadius: '999px',
                                                fontSize: '16px',
                                                fontWeight: '500',
                                                color: 'var(--mac-text-secondary)',
                                                background: 'transparent',
                                                border: '1px dashed var(--mac-border)',
                                                cursor: 'pointer',
                                                transition: 'all 0.15s',
                                            }}
                                            title="新增说话人"
                                        >+</button>
                                    )}
                                </div>
                            )}
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                            </div>
                        </div>

                        {/* 视图切换控件 */}
                        <div style={{
                            display: 'flex', alignItems: 'center', gap: '8px',
                            padding: '8px 14px 4px',
                            borderBottom: '1px solid var(--mac-border)',
                            flexShrink: 0,
                        }}>
                            <div style={{
                                display: 'flex', alignItems: 'center', gap: 0,
                                borderRadius: '7px', overflow: 'hidden',
                                border: '1px solid var(--mac-border)',
                            }}>
                                <button
                                    onClick={() => setViewMode('block')}
                                    title="区块 — 按说话人分组，逐词选择"
                                    style={{
                                        padding: '5px 12px', fontSize: '11px', fontWeight: viewMode === 'block' ? 600 : 400,
                                        border: 'none', cursor: 'pointer',
                                        background: viewMode === 'block' ? 'var(--mac-accent)' : 'var(--mac-input-bg)',
                                        color: viewMode === 'block' ? '#fff' : 'var(--mac-text-secondary)',
                                        transition: 'all 0.15s', fontFamily: 'inherit',
                                        display: 'flex', alignItems: 'center', gap: '4px',
                                    }}
                                >
                                    <LayoutList size={12} /> 区块
                                </button>
                                <button
                                    onClick={() => setViewMode('table')}
                                    title="列表 — 列表形式浏览全部片段"
                                    style={{
                                        padding: '5px 12px', fontSize: '11px', fontWeight: viewMode === 'table' ? 600 : 400,
                                        border: 'none', borderLeft: '1px solid var(--mac-border)',
                                        cursor: 'pointer',
                                        background: viewMode === 'table' ? 'var(--mac-accent)' : 'var(--mac-input-bg)',
                                        color: viewMode === 'table' ? '#fff' : 'var(--mac-text-secondary)',
                                        transition: 'all 0.15s', fontFamily: 'inherit',
                                        display: 'flex', alignItems: 'center', gap: '4px',
                                    }}
                                >
                                    <Table2 size={12} /> 列表
                                </button>
                            </div>
                            <div style={{ flex: 1 }} />
                            {viewMode === 'block' && allSpeakers.length > 0 && (
                                <>
                                    <button type="button" onClick={() => { const allVisible = activeSpeakerKeys === null || activeSpeakerKeys.length === allSpeakers.length; if (allVisible) setActiveSpeakerKeys([]); else setActiveSpeakerKeys(null); }} style={{ border: '1px solid var(--mac-border)', background: (activeSpeakerKeys === null || activeSpeakerKeys.length === allSpeakers.length) ? 'rgba(0, 122, 255, 0.12)' : 'transparent', color: (activeSpeakerKeys === null || activeSpeakerKeys.length === allSpeakers.length) ? 'var(--mac-accent)' : 'var(--mac-text-secondary)', borderRadius: '999px', padding: '5px 10px', fontSize: '11px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px', }}><Eye size={12} />{(activeSpeakerKeys === null || activeSpeakerKeys.length === allSpeakers.length) ? '隐藏全部' : '查看全部'}</button>
                                    <button type="button" onClick={() => { setAllCollapsed((prev) => !prev); setExpandedSpeakerKeys(new Set()); }} disabled={speakerSections.length === 0} style={{ border: '1px solid var(--mac-border)', background: 'transparent', color: 'var(--mac-text-secondary)', borderRadius: '999px', padding: '5px 10px', fontSize: '11px', cursor: speakerSections.length > 0 ? 'pointer' : 'not-allowed', opacity: speakerSections.length > 0 ? 1 : 0.4, }}>{allCollapsed ? '展开全部' : '收起全部'}</button>
                                    {selectedCount === 0 ? (
                                        <button type="button" onClick={handleSelectAllVisible} disabled={visibleSegments.length === 0} style={{ border: '1px solid var(--mac-border)', background: 'transparent', color: 'var(--mac-text-secondary)', borderRadius: '999px', padding: '5px 10px', fontSize: '11px', cursor: visibleSegments.length === 0 ? 'not-allowed' : 'pointer', opacity: visibleSegments.length === 0 ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: '6px', }}><CheckCircle2 size={12} />选择可见</button>
                                    ) : (
                                        <button type="button" onClick={handleClearAllSelections} style={{ border: '1px solid var(--mac-border)', background: 'transparent', color: 'var(--mac-text-secondary)', borderRadius: '999px', padding: '5px 10px', fontSize: '11px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px', }}><Eraser size={12} />清空选择 ({selectedCount})</button>
                                    )}
                                </>
                            )}
                            {viewMode === 'table' && (
                                <>
                                    <span style={{ fontSize: '10px', color: 'var(--mac-text-secondary)' }}>时间格式:</span>
                                    <div style={{
                                        display: 'flex', alignItems: 'center', gap: 0,
                                        borderRadius: '6px', overflow: 'hidden',
                                        border: '1px solid var(--mac-border)',
                                    }}>
                                        <button
                                            onClick={() => setTimeFormat('timecode')}
                                            style={{
                                                padding: '3px 8px', fontSize: '10px', fontWeight: timeFormat === 'timecode' ? 600 : 400,
                                                border: 'none', cursor: 'pointer',
                                                background: timeFormat === 'timecode' ? 'var(--mac-accent)' : 'var(--mac-input-bg)',
                                                color: timeFormat === 'timecode' ? '#fff' : 'var(--mac-text-secondary)',
                                                transition: 'all 0.15s', fontFamily: 'inherit',
                                            }}
                                        >HH:MM:SS:FF</button>
                                        <button
                                            onClick={() => setTimeFormat('seconds')}
                                            style={{
                                                padding: '3px 8px', fontSize: '10px', fontWeight: timeFormat === 'seconds' ? 600 : 400,
                                                border: 'none', borderLeft: '1px solid var(--mac-border)',
                                                cursor: 'pointer',
                                                background: timeFormat === 'seconds' ? 'var(--mac-accent)' : 'var(--mac-input-bg)',
                                                color: timeFormat === 'seconds' ? '#fff' : 'var(--mac-text-secondary)',
                                                transition: 'all 0.15s', fontFamily: 'inherit',
                                            }}
                                        >MM:SS.ms</button>
                                    </div>
                                </>
                            )}
                            {viewMode === 'block' && (
                                <button
                                    onClick={() => setShowSegmentButtons(!showSegmentButtons)}
                                    title={showSegmentButtons ? '隐藏「整句/取消」操作' : '显示「整句/取消」操作'}
                                    style={{
                                        padding: '5px 10px', fontSize: '11px', fontWeight: 500,
                                        border: '1px solid var(--mac-border)', borderRadius: '999px',
                                        cursor: 'pointer',
                                        background: showSegmentButtons ? 'var(--mac-input-bg)' : 'transparent',
                                        color: 'var(--mac-text-secondary)',
                                        transition: 'all 0.15s', fontFamily: 'inherit',
                                        display: 'flex', alignItems: 'center', gap: '4px',
                                    }}
                                >
                                    <Eye size={12} />
                                    {showSegmentButtons ? '隐藏操作' : '显示操作'}
                                </button>
                            )}
                            <div style={{ flex: 1 }} />
                            {viewMode === 'block' && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span style={{ fontSize: '10px', color: 'var(--mac-text-secondary)', whiteSpace: 'nowrap' }}>单行上限:</span>
                                <input
                                    type="number"
                                    min={5}
                                    max={60}
                                    value={maxCharsPerLine}
                                    onChange={(e) => setMaxCharsPerLine(Math.max(5, parseInt(e.target.value, 10) || 20))}
                                    style={{
                                        width: '38px', padding: '3px 4px', fontSize: '11px',
                                        border: '1px solid var(--mac-border)', borderRadius: '5px',
                                        background: 'var(--mac-input-bg)', color: 'var(--mac-text)',
                                        textAlign: 'center', outline: 'none',
                                    }}
                                    title="每行最多字符数（中文按字计，英文按词计）"
                                />
                                <button
                                    type="button"
                                    onClick={handleSmartSplit}
                                    disabled={!transcriptData}
                                    style={{
                                        padding: '5px 10px', fontSize: '11px', fontWeight: 500,
                                        border: '1px solid var(--mac-border)', borderRadius: '999px',
                                        cursor: transcriptData ? 'pointer' : 'not-allowed',
                                        background: 'transparent', color: 'var(--mac-text-secondary)',
                                        display: 'flex', alignItems: 'center', gap: '4px',
                                        transition: 'all 0.15s', fontFamily: 'inherit',
                                        opacity: transcriptData ? 1 : 0.4,
                                    }}
                                    title={`按自然断点智能拆分为每行 ≤${maxCharsPerLine} 字的字幕片段`}
                                >
                                    <Scissors size={12} /> 智能分句
                                </button>
                            </div>
                            )}
                        </div>

                        {viewMode === 'block' ? (
                        <div ref={scrollContainerRef} style={{ flex: 1, overflowY: 'auto', padding: '14px' }}>
                            {!transcriptData ? (
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '200px', color: 'var(--mac-text-secondary)', fontSize: '13px' }}>
                                    <FileText size={32} style={{ opacity: 0.3, marginBottom: '12px' }} />
                                    暂无转录数据，请先在「音频转录」中导入
                                </div>
                            ) : speakerSections.length === 0 ? (
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '200px', color: 'var(--mac-text-secondary)', fontSize: '13px' }}>
                                    当前筛选条件下暂无内容
                                </div>
                            ) : (
                                speakerSections.map(({ speaker, segments: sectionSegments, start, end }, sectionIndex) => {
                                    const speakerColor = getSpeakerColor(speaker.key, 0.12);
                                    return (
                                        <section
                                            key={`${speaker.key}-${start}`}
                                            style={{
                                                marginBottom: '18px',
                                                padding: '14px',
                                                borderRadius: '12px',
                                                border: '1px solid var(--mac-border)',
                                                background: 'rgba(255,255,255,0.02)',
                                            }}
                                        >
                                            <div style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '8px',
                                                marginBottom: (allCollapsed ? expandedSpeakerKeys.has(speaker.key) : !expandedSpeakerKeys.has(speaker.key)) ? '12px' : '0px',
                                                flexWrap: 'wrap',
                                                cursor: 'pointer',
                                            }}
                                                onClick={(e) => {
                                                    if (e.target.closest('button, input, select, textarea, a, [role="button"]')) return;
                                                    setExpandedSpeakerKeys(prev => {
                                                        const next = new Set(prev);
                                                        if (next.has(speaker.key)) next.delete(speaker.key);
                                                        else next.add(speaker.key);
                                                        return next;
                                                    });
                                                }}
                                                title="点击展开/折叠">
                                                {String(renamingSpeaker) === String(speaker.key) ? (
                                                    <input className="mac-input"
                                                        defaultValue={getSpeakerLabel(speaker.key)}
                                                        onBlur={(e) => handleRenameSpeaker(speaker.key, e.target.value)}
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter') handleRenameSpeaker(speaker.key, e.target.value);
                                                            if (e.key === 'Escape') setRenamingSpeaker(null);
                                                        }}
                                                        style={{
                                                            padding: '4px 10px', borderRadius: '999px', fontSize: '11px',
                                                            width: '100px', border: `2px solid ${speakerColor.border}`,
                                                            background: speakerColor.background, color: speakerColor.text, outline: 'none',
                                                        }}
                                                    />
                                                ) : (
                                                    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                                                        <span
                                                            onDoubleClick={(e) => { e.preventDefault(); setRenamingSpeaker(speaker.key); }}
                                                            style={{
                                                                display: 'inline-flex', alignItems: 'center', gap: '4px',
                                                                padding: '4px 10px', borderRadius: '999px 0 0 999px', fontSize: '11px',
                                                                color: speakerColor.text, background: speakerColor.background,
                                                                border: `1px solid ${speakerColor.border}`, cursor: 'pointer',
                                                                userSelect: 'none',
                                                            }}
                                                            title="双击重命名"
                                                        >
                                                            <span style={{ width: '6px', height: '6px', borderRadius: '999px', background: speakerColor.text }} />
                                                            {getSpeakerLabel(speaker.key)}
                                                        </span>
                                                        <button
                                                            type="button"
                                                            className="speaker-menu-trigger"
                                                            onClick={() => {
                                                                const menuKey = `${speaker.key}-${start}`;
                                                                setOpenSpeakerMenu(prev => prev?.key === menuKey ? null : { key: menuKey });
                                                            }}
                                                            style={{
                                                                padding: '4px 6px', borderRadius: '0 999px 999px 0', fontSize: '11px',
                                                                color: speakerColor.text, background: speakerColor.background,
                                                                border: `1px solid ${speakerColor.border}`, borderLeft: 'none',
                                                                cursor: 'pointer', outline: 'none',
                                                            }}
                                                            title="切换说话人"
                                                        >
                                                            <ChevronDown size={10} />
                                                        </button>
                                                        {openSpeakerMenu?.key === `${speaker.key}-${start}` && (
                                                            <div
                                                                className="speaker-menu-dropdown"
                                                                style={{
                                                                    position: 'absolute', top: '100%', left: 0, zIndex: 100,
                                                                    marginTop: '4px', minWidth: '140px',
                                                                    background: 'var(--mac-surface-solid)', borderRadius: '10px',
                                                                    border: '1px solid var(--mac-border)',
                                                                    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                                                                    overflow: 'hidden', padding: '4px',
                                                                }}
                                                            >
                                                                {allSpeakers.map(s => (
                                                                    <button
                                                                        key={s.key} type="button"
                                                                        onClick={() => {
                                                                            if (String(s.key) !== String(speaker.key)) {
                                                                                const targetSpk = normalizeSpeakerKey(s.key);
                                                                                handleChangeSectionSpeaker(speaker.key, targetSpk, sectionSegments);
                                                                            }
                                                                            setOpenSpeakerMenu(null);
                                                                        }}
                                                                        style={{
                                                                            display: 'block', width: '100%', textAlign: 'left',
                                                                            padding: '6px 10px', border: 'none', borderRadius: '6px',
                                                                            fontSize: '12px', cursor: 'pointer',
                                                                            color: String(s.key) === String(speaker.key) ? 'var(--mac-accent)' : 'var(--mac-text)',
                                                                            background: String(s.key) === String(speaker.key) ? 'rgba(0,122,255,0.1)' : 'transparent',
                                                                        }}
                                                                    >
                                                                        {getSpeakerLabel(s.key)}
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                                <span style={{ fontSize: '11px', color: 'var(--mac-text-secondary)', fontFamily: 'monospace' }}>
                                                    {formatTime(start)} - {formatTime(end)}
                                                </span>
                                                <span style={{ fontSize: '11px', color: 'var(--mac-text-secondary)' }}>
                                                    {sectionSegments.length} 段
                                                </span>
                                                <button
                                                    type="button"
                                                    onClick={() => handleSelectSectionSelections(sectionSegments)}
                                                    style={{
                                                        border: '1px solid var(--mac-border)',
                                                        background: 'transparent',
                                                        color: 'var(--mac-text-secondary)',
                                                        borderRadius: '999px',
                                                        padding: '4px 10px',
                                                        fontSize: '11px',
                                                        cursor: 'pointer',
                                                    }}
                                                >
                                                    选择本块
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => handleClearSectionSelections(sectionSegments)}
                                                    style={{
                                                        border: '1px solid var(--mac-border)',
                                                        background: 'transparent',
                                                        color: 'var(--mac-text-secondary)',
                                                        borderRadius: '999px',
                                                        padding: '4px 10px',
                                                        fontSize: '11px',
                                                        cursor: 'pointer',
                                                    }}
                                                >
                                                    清空本块
                                                </button>
                                            </div>

                                            {(allCollapsed ? expandedSpeakerKeys.has(speaker.key) : !expandedSpeakerKeys.has(speaker.key)) && (
                                            <div style={{ fontSize: '15px', lineHeight: 2, color: 'var(--mac-text)', wordBreak: 'break-word' }}>
                                                {sectionSegments.map((segment, segIndex) => {
                                                    const selectedWordIndices = getSelectedWordIndices(segment);
                                                    const hasWordLevel = Array.isArray(segment.words) && segment.words.length > 0;
                                                    const isSelected = segment.bold || selectedWordIndices.length > 0;

                                                    return (
                                                        <React.Fragment key={segment.id}>
                                                            {(() => {
                                                                if (hasWordLevel) {
                                                                    if (editingSegmentId === segment.id) {
                                                                        return (
                                                                            <input
                                                                                autoFocus
                                                                                className="mac-input"
                                                                                defaultValue={segment.text || segment.raw_text || segment.words.map(w => getWordText(w)).join('')}
                                                                                onBlur={(e) => handleUpdateSegmentText(segment.id, e.target.value)}
                                                                                onKeyDown={(e) => {
                                                                                    if (e.key === 'Enter' && !e.shiftKey) {
                                                                                        e.preventDefault();
                                                                                        const pos = e.target.selectionStart;
                                                                                        const val = e.target.value;
                                                                                        if (pos > 0 && pos < val.length) {
                                                                                            const left = val.slice(0, pos).trim();
                                                                                            const right = val.slice(pos).trim();
                                                                                            if (left && right) {
                                                                                                mutateSegments(() => {
                                                                                                    const idx = segments.findIndex(s => s.id === segment.id);
                                                                                                    if (idx < 0) return;
                                                                                                    const seg = segments[idx];
                                                                                                    const midTime = seg.start + (seg.end - seg.start) * (pos / val.length);
                                                                                                    const leftSeg = {...seg, id: seg.id + '_a', text: left, raw_text: left, end: midTime, sectionBreakAfter: true};
                                                                                                    const rightSeg = {...seg, id: seg.id + '_b', text: right, raw_text: right, start: midTime};
                                                                                                    segments.splice(idx, 1, leftSeg, rightSeg);
                                                                                                }, '分割段落');
                                                                                                setEditingSegmentId(null);
                                                                                                return;
                                                                                            }
                                                                                        }
                                                                                        handleUpdateSegmentText(segment.id, val);
                                                                                    }
                                                                                    if (e.key === 'Escape') setEditingSegmentId(null);
                                                                                }}
                                                                                style={{
                                                                                    flex: 1, padding: '4px 8px', fontSize: 'inherit',
                                                                                    border: '2px solid var(--mac-accent)', borderRadius: '6px',
                                                                                    background: 'var(--mac-input-bg)', color: 'var(--mac-text)',
                                                                                    outline: 'none', marginRight: '10px',
                                                                                }}
                                                                            />
                                                                        );
                                                                    }
                                                                    const isSplitStart = splitCursor?.segId === segment.id && splitCursor?.afterWordIndex === -1;
                                                                    const isSplitEnd = splitCursor?.segId === segment.id && splitCursor?.afterWordIndex === segment.words.length - 1;
                                                                    return (
                                                                        <>
                                                                            {segIndex > 0 && (
                                                                                <span
                                                                                    className="split-marker"
                                                                                    onClick={(e) => { e.stopPropagation(); setSplitCursor({ segId: segment.id, afterWordIndex: -1 }); }}
                                                                                    style={{ cursor: 'col-resize', userSelect: 'none', padding: '0 6px' }}
                                                                                    title="点击后按回车在句首分段"
                                                                                ></span>
                                                                            )}
                                                                            {isSplitStart && (
                                                                                <span className="split-cursor-bar" style={{
                                                                                    display: 'inline-block', width: '2px', height: '1.2em',
                                                                                    background: 'var(--mac-accent)', marginRight: '1px', verticalAlign: 'middle',
                                                                                }} />
                                                                            )}
                                                                            {segment.words.map((word, wordIndex) => {
                                                                                const wordText = getWordText(word);
                                                                                const previousToken = wordIndex > 0 ? getWordText(segment.words[wordIndex - 1]) : '';
                                                                                const isWordSelected = segment.bold || selectedWordIndices.includes(wordIndex);
                                                                                if (!wordText) return null;

                                                                                const isSplitBefore = splitCursor?.segId === segment.id && splitCursor?.afterWordIndex === wordIndex - 1;

                                                                                return (
                                                                                    <React.Fragment key={`${segment.id}-${wordIndex}-${word.start ?? wordIndex}`}>
                                                                                        {needsSpaceBetweenTokens(previousToken, wordText) && (
                                                                                            <span
                                                                                                className="split-marker"
                                                                                                onClick={(e) => { e.stopPropagation(); setSplitCursor({ segId: segment.id, afterWordIndex: wordIndex - 1 }); }}
                                                                                                style={{ cursor: 'col-resize', userSelect: 'none', padding: '0 1px' }}
                                                                                                title="点击后按回车在此处分段"
                                                                                            > </span>
                                                                                        )}
                                                                                        {isSplitBefore && (
                                                                                            <span
                                                                                                style={{
                                                                                                    display: 'inline-block', width: '2px', height: '1.2em',
                                                                                                    background: 'var(--mac-accent)', marginRight: '1px',
                                                                                                    verticalAlign: 'middle',
                                                                                                }}
                                                                                                className="split-cursor-bar"
                                                                                            />
                                                                                        )}
                                                                                        {editingWord?.segId === segment.id && editingWord?.wordIndex === wordIndex ? (
                                                                                            <input
                                                                                                autoFocus
                                                                                                defaultValue={wordText}
                                                                                                size={wordText.length || 1}
                                                                                                onBlur={(e) => handleUpdateWord(segment.id, wordIndex, e.target.value)}
                                                                                                onKeyDown={(e) => {
                                                                                                    if (e.key === 'Enter') handleUpdateWord(segment.id, wordIndex, e.target.value);
                                                                                                    if (e.key === 'Escape') setEditingWord(null);
                                                                                                }}
                                                                                                style={{
                                                                                                    border: 'none',
                                                                                                    background: 'rgba(0, 122, 255, 0.16)',
                                                                                                    color: 'var(--mac-text)',
                                                                                                    borderRadius: '6px',
                                                                                                    padding: '1px 3px',
                                                                                                    margin: 0,
                                                                                                    fontSize: 'inherit',
                                                                                                    fontFamily: 'inherit',
                                                                                                    lineHeight: 'inherit',
                                                                                                    textDecorationLine: 'underline',
                                                                                                    textDecorationColor: 'var(--mac-accent)',
                                                                                                    textUnderlineOffset: '4px',
                                                                                                    outline: 'none',
                                                                                                }}
                                                                                            />
                                                                                        ) : isPunctuationToken(wordText) ? (
                                                                                            <span
                                                                                                style={{
                                                                                                    display: 'inline',
                                                                                                    color: 'inherit',
                                                                                                    pointerEvents: 'none',
                                                                                                    userSelect: 'none',
                                                                                                    WebkitUserSelect: 'none',
                                                                                                }}
                                                                                            >
                                                                                                {wordText}
                                                                                            </span>
                                                                                        ) : (
                                                                                            <button
                                                                                                type="button"
                                                                                                onPointerDown={(e) => handleWordPointerDown(e, segment.id, wordIndex)}
                                                                                                onPointerEnter={() => handleWordPointerEnter(segment.id, wordIndex)}
                                                                                                onClick={(e) => handleWordClick(e, segment.id, wordIndex)}
                                                                                                onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditingWord({ segId: segment.id, wordIndex }); }}
                                                                                                style={{
                                                                                                    border: 'none',
                                                                                                    background: isWordSelected ? 'rgba(0, 122, 255, 0.16)' : 'transparent',
                                                                                                    color: isWordSelected ? 'var(--mac-text)' : 'var(--mac-text-secondary)',
                                                                                                    borderRadius: '4px',
                                                                                                    padding: /^[一-鿿㐀-䶿豈-﫿]+$/.test(wordText) ? '0' : '1px 1px',
                                                                                                    margin: 0,
                                                                                                    cursor: 'text',
                                                                                                    fontSize: 'inherit',
                                                                                                    fontFamily: 'inherit',
                                                                                                    lineHeight: 'inherit',
                                                                                                    textDecorationLine: isWordSelected ? 'underline' : 'none',
                                                                                                    textDecorationColor: 'var(--mac-accent)',
                                                                                                    textUnderlineOffset: '4px',
                                                                                                    opacity: 1,
                                                                                                    userSelect: 'none',
                                                                                                    WebkitUserSelect: 'none',
                                                                                                }}
                                                                                                title={`${formatTimeFull(word.start ?? segment.start)} - ${formatTimeFull(word.end ?? segment.end)}`}
                                                                                            >
                                                                                                {wordText}
                                                                                            </button>
                                                                                        )}
                                                                                    </React.Fragment>
                                                                                );
                                                                            })}
                                                                            <span
                                                                                className="split-marker"
                                                                                onClick={(e) => { e.stopPropagation(); setSplitCursor({ segId: segment.id, afterWordIndex: segment.words.length - 1 }); }}
                                                                                style={{ cursor: 'col-resize', userSelect: 'none', padding: '0 6px' }}
                                                                                title="点击后按回车在句尾分段"
                                                                            ></span>
                                                                            {isSplitEnd && (
                                                                                <span className="split-cursor-bar" style={{
                                                                                    display: 'inline-block', width: '2px', height: '1.2em',
                                                                                    background: 'var(--mac-accent)', marginRight: '1px', verticalAlign: 'middle',
                                                                                }} />
                                                                            )}
                                                                            {showSegmentButtons && (
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => handleToggleSelect(segment.id)}
                                                                                style={{
                                                                                    marginLeft: '6px',
                                                                                    marginRight: '10px',
                                                                                    border: '1px solid var(--mac-border)',
                                                                                    background: isSelected ? 'rgba(0, 122, 255, 0.08)' : 'transparent',
                                                                                    color: isSelected ? 'var(--mac-accent)' : 'var(--mac-text-secondary)',
                                                                                    borderRadius: '999px',
                                                                                    padding: '2px 8px',
                                                                                    fontSize: '10px',
                                                                                    cursor: 'pointer',
                                                                                }}
                                                                            >
                                                                                {segment.bold ? '取消' : '整句'}
                                                                            </button>
                                                                            )}
                                                                        </>
                                                                    );
                                                                }
                                                                if (editingSegmentId === segment.id) {
                                                                    return (
                                                                        <input
                                                                            autoFocus
                                                                            className="mac-input"
                                                                            defaultValue={segment.text}
                                                                            onBlur={(e) => handleUpdateSegmentText(segment.id, e.target.value)}
                                                                            onKeyDown={(e) => {
                                                                                if (e.key === 'Enter' && !e.shiftKey) {
                                                                                    e.preventDefault();
                                                                                    const pos = e.target.selectionStart;
                                                                                    const val = e.target.value;
                                                                                    if (pos > 0 && pos < val.length) {
                                                                                        const left = val.slice(0, pos).trim();
                                                                                        const right = val.slice(pos).trim();
                                                                                        if (left && right) {
                                                                                            mutateSegments(() => {
                                                                                                const idx = segments.findIndex(s => s.id === segment.id);
                                                                                                if (idx < 0) return;
                                                                                                const seg = segments[idx];
                                                                                                const midTime = seg.start + (seg.end - seg.start) * (pos / val.length);
                                                                                                const leftSeg = {...seg, id: seg.id + '_a', text: left, raw_text: left, end: midTime, sectionBreakAfter: true};
                                                                                                const rightSeg = {...seg, id: seg.id + '_b', text: right, raw_text: right, start: midTime};
                                                                                                segments.splice(idx, 1, leftSeg, rightSeg);
                                                                                            }, '分割段落');
                                                                                            setEditingSegmentId(null);
                                                                                            return;
                                                                                        }
                                                                                    }
                                                                                    handleUpdateSegmentText(segment.id, val);
                                                                                }
                                                                                if (e.key === 'Escape') setEditingSegmentId(null);
                                                                            }}
                                                                            style={{
                                                                                flex: 1, padding: '4px 8px', fontSize: 'inherit',
                                                                                border: '2px solid var(--mac-accent)', borderRadius: '6px',
                                                                                background: 'var(--mac-input-bg)', color: 'var(--mac-text)',
                                                                                outline: 'none', marginRight: '10px',
                                                                            }}
                                                                        />
                                                                    );
                                                                }
                                                                return (
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => handleToggleSelect(segment.id)}
                                                                        onDoubleClick={(e) => { e.preventDefault(); setEditingSegmentId(segment.id); }}
                                                                        style={{
                                                                            border: 'none',
                                                                            background: isSelected ? 'rgba(0, 122, 255, 0.12)' : 'transparent',
                                                                            color: isSelected ? 'var(--mac-text)' : 'var(--mac-text-secondary)',
                                                                            borderRadius: '6px',
                                                                            padding: '1px 4px',
                                                                            marginRight: showSegmentButtons ? '10px' : '0px',
                                                                            cursor: 'pointer',
                                                                            fontSize: 'inherit',
                                                                            lineHeight: 'inherit',
                                                                            textDecoration: 'none',
                                                                            opacity: 1,
                                                                        }}
                                                                        title="双击编辑文本 · 在文字中间按 Enter 分割段落"
                                                                    >
                                                                        {segment.text}
                                                                    </button>
                                                                );
                                                            })()}
                                                        {!showSegmentButtons && segIndex < sectionSegments.length - 1 && (
                                                            <span key={`sep-${segment.id}`} style={{
                                                                display: 'inline-block',
                                                                width: '5px',
                                                                height: '13px',
                                                                background: 'var(--mac-accent)',
                                                                borderRadius: '3px',
                                                                margin: '0 5px',
                                                                opacity: 0.45,
                                                                verticalAlign: 'middle',
                                                            }} />
                                                        )}
                                                        </React.Fragment>
                                                    );
                                                })}
                                            </div>
                                            )}
                                        </section>
                                    );
                                })
                            )}
                        </div>
                    ) : (
                    /* ── 表视图 ── */
                    <div ref={scrollContainerRef} style={{ flex: 1, overflowY: 'auto', padding: '14px' }}>
                        {!transcriptData ? (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '200px', color: 'var(--mac-text-secondary)', fontSize: '13px' }}>
                                <FileText size={32} style={{ opacity: 0.3, marginBottom: '12px' }} />
                                暂无转录数据，请先在「音频转录」中导入
                            </div>
                        ) : (
                            <div style={{
                                background: 'var(--mac-surface-solid)',
                                borderRadius: '14px',
                                border: '1px solid var(--mac-border)',
                                boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                                overflow: 'hidden',
                            }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr style={{ boxShadow: '0 1px 0 0 var(--mac-border)' }}>
                                            <th style={{ padding: '10px 6px 10px 16px', fontSize: '11px', fontWeight: 600, color: 'var(--mac-text-secondary)', textAlign: 'center', width: '40px', background: 'var(--mac-surface-muted)' }}>#</th>
                                            <th style={{ padding: '10px 6px', fontSize: '11px', fontWeight: 600, color: 'var(--mac-text-secondary)', width: '110px', textAlign: 'center', background: 'var(--mac-surface-muted)' }}>开始时间</th>
                                            <th style={{ padding: '10px 6px', fontSize: '11px', fontWeight: 600, color: 'var(--mac-text-secondary)', width: '110px', textAlign: 'center', background: 'var(--mac-surface-muted)' }}>结束时间</th>
                                            <th style={{ padding: '10px 6px', fontSize: '11px', fontWeight: 600, color: 'var(--mac-text-secondary)', width: '100px', background: 'var(--mac-surface-muted)' }}>说话人</th>
                                            <th style={{ padding: '10px 6px', fontSize: '11px', fontWeight: 600, color: 'var(--mac-text-secondary)', textAlign: 'left', background: 'var(--mac-surface-muted)' }}>文本</th>
                                            <th style={{ padding: '10px 16px 10px 6px', fontSize: '11px', fontWeight: 600, color: 'var(--mac-text-secondary)', width: '48px', textAlign: 'center', background: 'var(--mac-surface-muted)' }}></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {visibleSegments.length === 0 ? (
                                            <tr>
                                                <td colSpan="6">
                                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', color: 'var(--mac-text-secondary)', fontSize: '13px' }}>
                                                        当前筛选条件下暂无内容
                                                    </div>
                                                </td>
                                            </tr>
                                        ) : (
                                            visibleSegments.map((segment, idx) => {
                                                const speaker = getSegmentSpeakerMeta(segment);
                                                const speakerColor = getSpeakerColor(speaker.key, 0.12);
                                                const isSelected = segment.bold || (Array.isArray(segment.selectedWordIndices) && segment.selectedWordIndices.length > 0);
                                                return (
                                                    <tr key={segment.id || idx} style={{
                                                        borderBottom: idx < visibleSegments.length - 1 ? '1px solid var(--mac-border)' : 'none',
                                                        background: isSelected ? 'rgba(0, 122, 255, 0.08)' : (idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)'),
                                                        opacity: segment.deleted ? 0.35 : 1,
                                                        cursor: 'pointer',
                                                        userSelect: 'none',
                                                    }}
                                                    onMouseDown={(e) => handleRowMouseDown(e, segment.id, idx, isSelected)}
                                                    onClick={(e) => {
                                                        if (didTableDragRef.current) {
                                                            didTableDragRef.current = false;
                                                            return;
                                                        }
                                                        handleRowClick(segment.id, idx, e.shiftKey);
                                                    }}
                                                    onMouseEnter={(e) => {
                                                        const dragState = tableDragRef.current;
                                                        if (dragState) {
                                                            didTableDragRef.current = true;
                                                            visibleSegments.forEach((seg, i) => {
                                                                seg.bold = dragState.snapshot[i];
                                                                seg.selectedWordIndices = [];
                                                            });
                                                            const start = Math.min(dragState.anchorIndex, idx);
                                                            const end = Math.max(dragState.anchorIndex, idx);
                                                            for (let i = start; i <= end; i++) {
                                                                visibleSegments[i].bold = (dragState.mode === 'select');
                                                                visibleSegments[i].selectedWordIndices = [];
                                                            }
                                                            setNormalizedVersion((v) => v + 1);
                                                            updateEditorStats(transcriptData.transcript.segments);
                                                        } else if (!isSelected) {
                                                            e.currentTarget.style.background = 'var(--mac-input-bg)';
                                                        }
                                                    }}
                                                    onMouseLeave={(e) => {
                                                        if (!tableDragRef.current && !isSelected) {
                                                            e.currentTarget.style.background = idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)';
                                                        }
                                                    }}
                                                    >
                                                        <td style={{ padding: '8px 6px 8px 16px', fontSize: '12px', color: 'var(--mac-text-secondary)', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                                                            {idx + 1}
                                                        </td>
                                                        <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                                                            <span style={{
                                                                fontSize: '12px', fontFamily: "'SF Mono', 'Geist Mono', monospace",
                                                                color: 'var(--mac-text-secondary)', letterSpacing: '0.02em',
                                                            }}>
                                                                {displayTime(segment.start)}
                                                            </span>
                                                        </td>
                                                        <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                                                            <span style={{
                                                                fontSize: '12px', fontFamily: "'SF Mono', 'Geist Mono', monospace",
                                                                color: 'var(--mac-text-secondary)', letterSpacing: '0.02em',
                                                            }}>
                                                                {displayTime(segment.end)}
                                                            </span>
                                                        </td>
                                                        <td style={{ padding: '8px 6px' }}>
                                                            <span style={{
                                                                display: 'inline-block',
                                                                padding: '2px 8px',
                                                                borderRadius: '999px',
                                                                fontSize: '11px',
                                                                fontWeight: 500,
                                                                background: speakerColor.background,
                                                                color: speakerColor.text,
                                                                border: `1px solid ${speakerColor.border}`,
                                                                maxWidth: '90px',
                                                                overflow: 'hidden',
                                                                textOverflow: 'ellipsis',
                                                                whiteSpace: 'nowrap',
                                                            }}>
                                                                {getSpeakerLabel(speaker.key)}
                                                            </span>
                                                        </td>
                                                        <td style={{ padding: '8px 6px' }}>
                                                            <span style={{
                                                                fontSize: '13px', lineHeight: 1.5,
                                                                color: isSelected ? 'var(--mac-text)' : 'var(--mac-text-secondary)',
                                                                display: 'block',
                                                                padding: '4px 8px',
                                                            }}>
                                                                {segment.text || '(无文本)'}
                                                            </span>
                                                        </td>
                                                        <td style={{ padding: '8px 16px 8px 6px', textAlign: 'center' }}>
                                                            {isSelected && (
                                                                <CheckCircle2 size={16} style={{ color: 'var(--mac-accent)', strokeWidth: 2.5 }} />
                                                            )}
                                                        </td>
                                                    </tr>
                                                );
                                            })
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                    )}

                    <div style={{ marginTop: '16px' }}>
                        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                            {[
                                { key: 'new_timeline', icon: <Scissors size={14} />, label: '创建新时间线' },
                                { key: 'append', icon: <ArrowDown size={14} />, label: '追加到末尾' },
                            ].map((method) => (
                                <button
                                    key={method.key}
                                    onClick={() => setApplyMethod(method.key)}
                                    style={{
                                        flex: 1,
                                        padding: '10px 12px',
                                        border: 'none',
                                        borderRadius: '8px',
                                        cursor: 'pointer',
                                        background: applyMethod === method.key ? 'var(--mac-accent)' : 'var(--mac-bg-secondary)',
                                        color: applyMethod === method.key ? '#fff' : 'var(--mac-text-secondary)',
                                        fontSize: '12px',
                                        fontWeight: applyMethod === method.key ? '500' : '400',
                                        borderColor: applyMethod === method.key ? 'transparent' : 'var(--mac-border)',
                                        borderStyle: 'solid',
                                        borderWidth: '1px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        gap: '6px',
                                        transition: 'all 0.15s',
                                    }}
                                >
                                    {method.icon} {method.label}
                                </button>
                            ))}
                        </div>

                        <div style={{
                            background: 'rgba(255, 149, 0, 0.06)',
                            padding: '10px 14px',
                            borderRadius: '8px',
                            fontSize: '11px',
                            color: 'var(--mac-text-secondary)',
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: '8px',
                            marginBottom: '12px',
                            border: '1px solid rgba(255, 149, 0, 0.15)',
                        }}>
                            <AlertTriangle size={14} color="#FF9500" style={{ flexShrink: 0, marginTop: '1px' }} />
                            <span>
                                新时间线中的片段将从源素材重新插入，原始片段的缩放、调色、特效等属性不会被保留。
                            </span>
                        </div>

                        <button
                            className="mac-btn primary"
                            onClick={() => setShowConfirm(true)}
                            disabled={loading || !transcriptData || selectedCount === 0}
                            style={{ height: '40px', fontSize: '14px', fontWeight: '500', width: '100%', justifyContent: 'center', display: 'flex', alignItems: 'center', gap: '8px' }}
                        >
                            {loading ? (
                                <><RefreshCcw size={16} className="spin" /> 正在应用...</>
                            ) : (
                                <><Scissors size={16} /> 应用修改 ({selectedCount} 段, {formatTimeFull(totalDuration)})</>
                            )}
                        </button>
                    </div>

                    {showConfirm && (
                        <div
                            style={{
                                position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                                background: 'rgba(0,0,0,0.5)', zIndex: 1000,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                backdropFilter: 'blur(4px)',
                            }}
                            onClick={() => setShowConfirm(false)}
                        >
                            <div
                                style={{
                                    background: 'var(--mac-bg)', borderRadius: '14px',
                                    padding: '24px', width: '360px', maxWidth: '90vw',
                                    boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
                                    border: '1px solid var(--mac-border)',
                                }}
                                onClick={(e) => e.stopPropagation()}
                            >
                                <div style={{ fontSize: '15px', fontWeight: '600', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <AlertTriangle size={18} color="#FF9500" />
                                    确认应用修改
                                </div>
                                <div style={{ fontSize: '13px', color: 'var(--mac-text-secondary)', lineHeight: '1.6', marginBottom: '16px' }}>
                                    <p style={{ margin: '0 0 8px 0' }}>
                                        将{
                                            applyMethod === 'new_timeline'
                                                ? '创建新时间线'
                                                : '追加到当前时间线末尾'
                                        }，
                                        包含 <b style={{ color: 'var(--mac-text)' }}>{selectedCount}</b> 个选取片段，总时长 <b style={{ color: 'var(--mac-text)' }}>{formatTimeFull(totalDuration)}</b>。
                                    </p>
                                    <p style={{ margin: 0, color: '#FF9500', fontSize: '12px' }}>
                                        片段将从源素材重新插入，缩放、调色、特效等属性不会保留。
                                    </p>
                                </div>
                                <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                                    <button className="mac-btn" onClick={() => setShowConfirm(false)} style={{ padding: '8px 16px', fontSize: '13px' }}>
                                        取消
                                    </button>
                                    <button
                                        className="mac-btn primary"
                                        onClick={handleApply}
                                        style={{ padding: '8px 16px', fontSize: '13px', fontWeight: '500' }}
                                    >
                                        确认应用
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                    {/* 关闭内容面板 */}
                    </div>
                    <style>{`
                        .spin { animation: spin 1s linear infinite; }
                        @keyframes spin { to { transform: rotate(360deg); } }
                    `}</style>
                    </>
                    )}
                </div>
            </div>
        </div>
    );
}

export default AutoEditView;
