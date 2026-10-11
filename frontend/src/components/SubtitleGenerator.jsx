import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import {
    Subtitles, Upload, Play, Loader2, CheckCircle2, AlertTriangle,
    Sparkles, Copy, Download, FileText,
    Monitor, Volume2, Languages, Plus, Trash2, BookOpen, ExternalLink, FileAudio, Users, WrapText, X
} from 'lucide-react';

function ToggleSwitch({ checked, onChange, color = '#FF9500' }) {
    return (
        <div 
            onClick={() => onChange(!checked)}
            style={{
                width: 44, height: 24, borderRadius: 12, cursor: 'pointer',
                background: checked ? color : 'rgba(128,128,128,0.25)',
                transition: 'all 0.2s', position: 'relative', flexShrink: 0
            }}
        >
            <div style={{
                width: 20, height: 20, borderRadius: 10,
                background: '#FFF', position: 'absolute', top: 2,
                left: checked ? 22 : 2, transition: 'all 0.2s',
                boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
            }} />
        </div>
    );
}

const getSubtitleWorkspaceStorageKey = (projectId) => `quickclip:subtitle-workspace:${projectId || 'default'}`;

const loadSubtitleWorkspaceDraft = (projectId, workspaceState = null) => {
    const fallback = {
        videoPath: '',
        language: localStorage.getItem('sub_gen_language') || 'zh',
        segments: [],
        sourceType: localStorage.getItem('sub_gen_sourceType') || 'timeline',
        feishuDocUrl: null,
        clipMapping: null,
        originalFilename: '',
        frameRate: 24,
        activeTranscriptId: null,
        showProjectManager: false,
        expandedLanguageGroups: { regional: false, extended: false },
        loading: false,
        loadingText: '',
        loadingStage: '',
        loadingDetail: '',
        transcriptionProgress: null,
        elapsedSeconds: null,
        transcriptionStartTime: null,
        message: null,
        error: null,
        feishuSyncing: false,
        installingModels: false,
    };

    try {
        const raw = localStorage.getItem(getSubtitleWorkspaceStorageKey(projectId));
        const parsed = raw ? JSON.parse(raw) : {};
        // 清除含旧版 FunASR 文案的缓存消息（两处来源都要清理）
        if (typeof parsed?.message === 'string' && parsed.message.includes('FunASR')) {
            delete parsed.message;
        }
        const safeWorkspace = workspaceState && typeof workspaceState === 'object' ? { ...workspaceState } : {};
        if (typeof safeWorkspace?.message === 'string' && safeWorkspace.message.includes('FunASR')) {
            delete safeWorkspace.message;
        }
        const merged = {
            ...fallback,
            ...safeWorkspace,
            ...(parsed && typeof parsed === 'object' ? parsed : {}), // localStorage 优先
        };
        return merged;
    } catch {
        return {
            ...fallback,
            ...(workspaceState && typeof workspaceState === 'object' ? workspaceState : {}),
        };
    }
};

const normalizeTranscriptSegments = (incomingSegments, previousSegments = []) => {
    if (!Array.isArray(incomingSegments)) return [];
    const previousByIndex = Array.isArray(previousSegments) ? previousSegments : [];
    const seenIds = new Set();

    return incomingSegments.map((segment, index) => {
        const previous = previousByIndex[index] || {};
        let nextId = segment?.id ?? previous?.id ?? index;
        while (seenIds.has(String(nextId))) {
            nextId = `${nextId}-${index}`;
        }
        seenIds.add(String(nextId));
        return {
            ...previous,
            ...segment,
            id: nextId,
            deleted: Boolean(segment?.deleted ?? previous?.deleted ?? false),
            bold: Boolean(segment?.bold ?? previous?.bold ?? false),
            words: Array.isArray(segment?.words)
                ? segment.words
                : (Array.isArray(previous?.words) ? previous.words : []),
        };
    });
};

const formatElapsed = (seconds) => {
    const s = Math.abs(seconds);
    if (s < 60) return `${s.toFixed(1)}秒`;
    const m = Math.floor(s / 60);
    const sec = Math.round(s % 60);
    return sec > 0 ? `${m}分${sec}秒` : `${m}分钟`;
};

function SubtitleGenerator({
    apiBaseUrl,
    onSubtitleReady,
    onTranscriptReady,
    onWorkspaceStateChange,
    workspaceState,
    activeTranscriptId: currentTranscriptId,
    projectId,
}) {
    const initialWorkspace = loadSubtitleWorkspaceDraft(projectId, workspaceState);
    const [videoPath, setVideoPath] = useState(() => initialWorkspace.videoPath || '');
    const [language, setLanguage] = useState(() => initialWorkspace.language || 'zh');
    const [segments, setSegments] = useState(() => Array.isArray(initialWorkspace.segments) ? initialWorkspace.segments : []);
    const [loading, setLoading] = useState(() => Boolean(initialWorkspace.loading));
    const [loadingText, setLoadingText] = useState(() => initialWorkspace.loadingText || '');
    const [loadingStage, setLoadingStage] = useState(() => initialWorkspace.loadingStage || '');
    const [loadingDetail, setLoadingDetail] = useState(() => initialWorkspace.loadingDetail || '');
    const [transcriptionProgress, setTranscriptionProgress] = useState(() => (
        typeof initialWorkspace.transcriptionProgress === 'number' ? initialWorkspace.transcriptionProgress : null
    ));
    const [elapsedSeconds, setElapsedSeconds] = useState(() => (
        typeof initialWorkspace.elapsedSeconds === 'number' ? initialWorkspace.elapsedSeconds : null
    ));
    const [transcriptionStartTime, setTranscriptionStartTime] = useState(() => (
        typeof initialWorkspace.transcriptionStartTime === 'number' ? initialWorkspace.transcriptionStartTime : null
    ));
    const [message, setMessage] = useState(() => initialWorkspace.message || null);
    const [error, setError] = useState(() => initialWorkspace.error || null);
    const [sourceType, setSourceType] = useState(() => initialWorkspace.sourceType || 'timeline');
    const [feishuDocUrl, setFeishuDocUrl] = useState(() => initialWorkspace.feishuDocUrl || null);
    const [feishuSyncing, setFeishuSyncing] = useState(() => Boolean(initialWorkspace.feishuSyncing));
    // 新增：时间码映射和源信息
    const [clipMapping, setClipMapping] = useState(() => initialWorkspace.clipMapping || null);
    const [originalFilename, setOriginalFilename] = useState(() => initialWorkspace.originalFilename || '');
    const [frameRate, setFrameRate] = useState(() => initialWorkspace.frameRate || 24);
    // 转录项目管理
    const [activeTranscriptId, setActiveTranscriptId] = useState(() => initialWorkspace.activeTranscriptId || null);
    const [showProjectManager, setShowProjectManager] = useState(() => Boolean(initialWorkspace.showProjectManager));
    const [modelStatus, setModelStatus] = useState(() => initialWorkspace.modelStatusCached || null);
    const [modelStatusLoading, setModelStatusLoading] = useState(() => !initialWorkspace.modelStatusCached);
    const [installingModels, setInstallingModels] = useState(() => Boolean(initialWorkspace.installingModels));
    const [deletingModels, setDeletingModels] = useState(false);
    const [expandedLanguageGroups, setExpandedLanguageGroups] = useState(() => initialWorkspace.expandedLanguageGroups || {
        regional: false,
        extended: false,
    });

    const [enableAI, setEnableAI] = useState(() => localStorage.getItem('sub_gen_enableAI') === 'true');
    const [enableSpeaker, setEnableSpeaker] = useState(() => localStorage.getItem('sub_gen_enableSpeaker') === 'true');
    const [speakerThreshold, setSpeakerThreshold] = useState(() => {
        const saved = localStorage.getItem('sub_gen_speakerThreshold');
        return saved ? parseFloat(saved) : 0.5;
    });
    const [maxCharsPerLine, setMaxCharsPerLine] = useState(() => {
        const saved = localStorage.getItem('sub_gen_maxCharsPerLine');
        return saved ? parseInt(saved, 10) : 16;
    });
    const [aiApiKey, setAiApiKey] = useState(localStorage.getItem('ai_api_key') || '');
    const [aiBaseUrl, setAiBaseUrl] = useState(localStorage.getItem('ai_base_url') || 'https://api.poixe.com/v1');
    const [aiModel, setAiModel] = useState(localStorage.getItem('ai_model') || 'gpt-5-mini:free');

    // ── 拖拽文件 ──
    const [isDragOver, setIsDragOver] = useState(false);
    const dragCounterRef = React.useRef(0);

    const handleDragOver = useCallback((e) => {
        e.preventDefault();
        e.stopPropagation();
    }, []);

    const handleDragEnter = useCallback((e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounterRef.current += 1;
        if (dragCounterRef.current === 1) {
            setIsDragOver(true);
        }
    }, []);

    const handleDragLeave = useCallback((e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounterRef.current -= 1;
        if (dragCounterRef.current <= 0) {
            dragCounterRef.current = 0;
            setIsDragOver(false);
        }
    }, []);

    const handleDrop = useCallback((e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounterRef.current = 0;
        setIsDragOver(false);

        const files = e.dataTransfer?.files;
        if (!files || files.length === 0) return;

        const file = files[0];
        const filePath = file.path || null;

        if (filePath) {
            setError(null);
            setSourceType('file');
            setVideoPath(filePath);
        } else {
            setError('无法读取拖拽文件的完整路径，请使用「选择文件」按钮或确认运行环境支持文件拖拽。');
        }
    }, []);

    // ── Tauri 原生拖拽事件监听（v2 API） ──
    useEffect(() => {
        if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return;

        let unlisten = null;

        const setupTauriDragDrop = async () => {
            try {
                const { getCurrentWebview } = await import('@tauri-apps/api/webview');
                const webview = getCurrentWebview();
                unlisten = await webview.onDragDropEvent((event) => {
                    const { type, paths } = event.payload;
                    if (type === 'enter') {
                        setIsDragOver(true);
                    } else if (type === 'leave') {
                        setIsDragOver(false);
                    } else if (type === 'drop') {
                        setIsDragOver(false);
                        if (paths && paths.length > 0) {
                            setError(null);
                            setSourceType('file');
                            setVideoPath(paths[0]);
                        }
                    }
                    // 'over' 事件反复触发，不用于状态管理
                });
            } catch (e) {
                console.warn('Tauri drag-drop API 不可用，使用 HTML5 拖拽:', e);
            }
        };

        setupTauriDragDrop();

        return () => {
            if (unlisten) {
                unlisten();
            }
        };
    }, []);

    // 专有名词集合
    const [nounCollections, setNounCollections] = useState(() => {
        try { return JSON.parse(localStorage.getItem('noun_collections') || '{}'); } catch { return {}; }
    });
    const [activeCollection, setActiveCollection] = useState(localStorage.getItem('active_noun_collection') || '');
    const [showCollectionManager, setShowCollectionManager] = useState(false);
    const [newCollectionName, setNewCollectionName] = useState('');
    const [editingCollection, setEditingCollection] = useState(null);
    const [editNouns, setEditNouns] = useState('');
    const [isCreatingCollection, setIsCreatingCollection] = useState(false);
    const [renameValue, setRenameValue] = useState('');

    const properNouns = activeCollection && nounCollections[activeCollection] 
        ? nounCollections[activeCollection].join('\n') : '';

    const modelStatusRef = React.useRef(initialWorkspace.modelStatusCached || null);

    const persistWorkspaceDraft = useCallback((overrides = {}) => {
        const draft = {
            videoPath,
            language,
            segments,
            sourceType,
            feishuDocUrl,
            clipMapping,
            originalFilename,
            frameRate,
            activeTranscriptId,
            showProjectManager,
            expandedLanguageGroups,
            loading,
            loadingText,
            loadingStage,
            loadingDetail,
            transcriptionProgress,
            elapsedSeconds,
            transcriptionStartTime,
            message,
            error,
            feishuSyncing,
            installingModels,
            modelStatusCached: modelStatusRef.current,
            ...overrides,
        };
        try {
            localStorage.setItem(getSubtitleWorkspaceStorageKey(projectId), JSON.stringify(draft));
        } catch {
            // ignore persistence failures
        }
        if (onWorkspaceStateChange) {
            onWorkspaceStateChange(draft);
        }
        return draft;
    }, [
        projectId,
        videoPath,
        language,
        segments,
        sourceType,
        feishuDocUrl,
        clipMapping,
        originalFilename,
        frameRate,
        activeTranscriptId,
        showProjectManager,
        expandedLanguageGroups,
        loading,
        loadingText,
        loadingStage,
        loadingDetail,
        transcriptionProgress,
        transcriptionStartTime,
        message,
        error,
        feishuSyncing,
        installingModels,
        onWorkspaceStateChange,
    ]);

    const fetchModelStatus = useCallback(async () => {
        setModelStatusLoading(true);
        try {
            const res = await axios.get(`${apiBaseUrl}/api/backend/funasr/models`);
            setModelStatus(res.data);
            modelStatusRef.current = res.data;
            persistWorkspaceDraft({ modelStatusCached: res.data });
        } catch (e) {
            // 后端不可达时保留上一次的状态，避免误报"工具包缺少"
            setModelStatus(prev => {
                if (prev?.ready) return prev;
                return {
                    ready: false,
                    models: [],
                    missing_labels: [],
                    error: '无法连接后端服务，请检查后端是否运行',
                };
            });
        } finally {
            setModelStatusLoading(false);
        }
    }, [apiBaseUrl, persistWorkspaceDraft]);

    useEffect(() => {
        fetchModelStatus();
    }, [fetchModelStatus]);

    // faster-whisper 支持 99+ 语言，所有 label 用中文
    const languages = [
        { value: 'auto', label: '自动检测', flag: '🌐', profile: 'core', backendValue: 'auto' },
        { value: 'zh', label: '中文', flag: '🇨🇳', profile: 'core', backendValue: 'zh' },
        { value: 'en', label: '英文', flag: '🇺🇸', profile: 'core', backendValue: 'en' },
        { value: 'ja', label: '日文', flag: '🇯🇵', profile: 'core', backendValue: 'ja' },
        { value: 'ko', label: '韩文', flag: '🇰🇷', profile: 'core', backendValue: 'ko' },
        { value: 'de', label: '德文', flag: '🇩🇪', profile: 'core', backendValue: 'de' },
        { value: 'fr', label: '法文', flag: '🇫🇷', profile: 'core', backendValue: 'fr' },
        { value: 'es', label: '西班牙文', flag: '🇪🇸', profile: 'core', backendValue: 'es' },
        { value: 'pt', label: '葡萄牙文', flag: '🇵🇹', profile: 'core', backendValue: 'pt' },
        { value: 'it', label: '意大利文', flag: '🇮🇹', profile: 'core', backendValue: 'it' },
        { value: 'ru', label: '俄文', flag: '🇷🇺', profile: 'core', backendValue: 'ru' },
        { value: 'ar', label: '阿拉伯文', flag: '🇸🇦', profile: 'core', backendValue: 'ar' },
        { value: 'hi', label: '印地文', flag: '🇮🇳', profile: 'core', backendValue: 'hi' },
        { value: 'vi', label: '越南文', flag: '🇻🇳', profile: 'core', backendValue: 'vi' },
        { value: 'th', label: '泰文', flag: '🇹🇭', profile: 'core', backendValue: 'th' },
        { value: 'id', label: '印尼文', flag: '🇮🇩', profile: 'core', backendValue: 'id' },
        { value: 'nl', label: '荷兰文', flag: '🇳🇱', profile: 'core', backendValue: 'nl' },
        { value: 'pl', label: '波兰文', flag: '🇵🇱', profile: 'core', backendValue: 'pl' },
        { value: 'sv', label: '瑞典文', flag: '🇸🇪', profile: 'core', backendValue: 'sv' },
        { value: 'tr', label: '土耳其文', flag: '🇹🇷', profile: 'core', backendValue: 'tr' },
        { value: 'uk', label: '乌克兰文', flag: '🇺🇦', profile: 'core', backendValue: 'uk' },
        { value: 'cs', label: '捷克文', flag: '🇨🇿', profile: 'core', backendValue: 'cs' },
        { value: 'da', label: '丹麦文', flag: '🇩🇰', profile: 'core', backendValue: 'da' },
        { value: 'fi', label: '芬兰文', flag: '🇫🇮', profile: 'core', backendValue: 'fi' },
        { value: 'el', label: '希腊文', flag: '🇬🇷', profile: 'core', backendValue: 'el' },
        { value: 'hu', label: '匈牙利文', flag: '🇭🇺', profile: 'core', backendValue: 'hu' },
        { value: 'ro', label: '罗马尼亚文', flag: '🇷🇴', profile: 'core', backendValue: 'ro' },
        { value: 'sk', label: '斯洛伐克文', flag: '🇸🇰', profile: 'core', backendValue: 'sk' },
        { value: 'bg', label: '保加利亚文', flag: '🇧🇬', profile: 'core', backendValue: 'bg' },
        { value: 'lt', label: '立陶宛文', flag: '🇱🇹', profile: 'core', backendValue: 'lt' },
        { value: 'lv', label: '拉脱维亚文', flag: '🇱🇻', profile: 'core', backendValue: 'lv' },
        { value: 'et', label: '爱沙尼亚文', flag: '🇪🇪', profile: 'core', backendValue: 'et' },
        { value: 'sl', label: '斯洛文尼亚文', flag: '🇸🇮', profile: 'core', backendValue: 'sl' },
        { value: 'hr', label: '克罗地亚文', flag: '🇭🇷', profile: 'core', backendValue: 'hr' },
    ];
    const languageGroups = [
        { key: 'common', label: '常用语言', values: ['zh', 'en', 'ja', 'ko'] },
        { key: 'europe', label: '欧洲语言', values: ['de', 'fr', 'es', 'pt', 'it', 'ru', 'nl', 'pl', 'sv', 'tr', 'uk', 'cs', 'da', 'fi', 'el', 'hu', 'ro', 'sk', 'bg', 'lt', 'lv', 'et', 'sl', 'hr'] },
        { key: 'asia', label: '亚洲及中东语言', values: ['ar', 'hi', 'vi', 'th', 'id'] },
    ];

    const languageMeta = languages.find((item) => item.value === language) || languages[0];
    const requestLanguage = languageMeta.backendValue || languageMeta.value;
    const effectiveModelProfile = 'core';
    const effectiveModelLabel = 'faster-whisper (small)';

    useEffect(() => {
        localStorage.setItem('sub_gen_videoPath', videoPath);
        localStorage.setItem('sub_gen_language', language);
        localStorage.setItem('sub_gen_sourceType', sourceType);
        localStorage.setItem('sub_gen_enableAI', enableAI);
        localStorage.setItem('sub_gen_enableSpeaker', enableSpeaker);
        localStorage.setItem('sub_gen_speakerThreshold', speakerThreshold);
        localStorage.setItem('sub_gen_maxCharsPerLine', maxCharsPerLine);
        localStorage.setItem('ai_api_key', aiApiKey);
        localStorage.setItem('ai_base_url', aiBaseUrl);
        localStorage.setItem('ai_model', aiModel);
    }, [videoPath, language, sourceType, enableAI, enableSpeaker, speakerThreshold, maxCharsPerLine, aiApiKey, aiBaseUrl, aiModel]);

    useEffect(() => {
        localStorage.setItem('noun_collections', JSON.stringify(nounCollections));
    }, [nounCollections]);

    useEffect(() => {
        localStorage.setItem('active_noun_collection', activeCollection);
    }, [activeCollection]);

    useEffect(() => {
        if (currentTranscriptId !== undefined) {
            setActiveTranscriptId(currentTranscriptId || null);
        }
    }, [currentTranscriptId]);

    useEffect(() => {
        if (!installingModels) {
            return undefined;
        }

        const timer = window.setInterval(async () => {
            try {
                const res = await axios.get(`${apiBaseUrl}/api/backend/funasr/models`);
                const nextStatus = res.data;
                setModelStatus(nextStatus);
                if (nextStatus?.ready) {
                    const nextMessage = `${nextStatus?.package?.label || nextStatus?.preset || '语音识别工具包'} 安装完成`;
                    setInstallingModels(false);
                    setMessage(nextMessage);
                    persistWorkspaceDraft({
                        installingModels: false,
                        message: nextMessage,
                        error: null,
                    });
                }
            } catch {
                // ignore polling errors and let next interval retry
            }
        }, 2000);

        return () => window.clearInterval(timer);
    }, [apiBaseUrl, installingModels, persistWorkspaceDraft]);

    // 僵尸会话检测：仅在挂载时运行一次
    // 父组件没传 loading（不是页面切换回来），但 localStorage 里记了 loading → 清扫
    useLayoutEffect(() => {
        if (loading && !workspaceState?.loading) {
            setLoading(false);
            setLoadingText('');
            setLoadingStage('');
            setLoadingDetail('');
            setTranscriptionProgress(null);
            setElapsedSeconds(null);
            setFeishuSyncing(false);
            setMessage(null);
            setError(null);
        }
    }, []);

    useEffect(() => {
        persistWorkspaceDraft();
    }, [persistWorkspaceDraft]);

    // 防守：segments 已填充就不再显示"转录音频-进行中"
    useEffect(() => {
        if (segments.length > 0 && loading && loadingStage === 'transcribing') {
            const nextStage = enableAI && aiApiKey ? 'ai' : 'syncing';
            const nextText = enableAI && aiApiKey ? '正在优化字幕...' : '正在传输结果...';
            const nextDetail = enableAI && aiApiKey
                ? '转录完成，正在结合 AI 优化字幕文本。'
                : '转录完成，正在同步云端文档。';
            setLoadingStage(nextStage);
            setLoadingText(nextText);
            setLoadingDetail(nextDetail);
            setTranscriptionProgress(null);
            persistWorkspaceDraft({
                loadingStage: nextStage,
                loadingText: nextText,
                loadingDetail: nextDetail,
                transcriptionProgress: null,
            });
        }
    }, [segments, loading, loadingStage, enableAI, aiApiKey, persistWorkspaceDraft]);

    const prevLoadingRef = useRef(loading);
    useEffect(() => {
        const justStartedLoading = loading && !prevLoadingRef.current;
        prevLoadingRef.current = loading;

        if (!loading) {
            if (!feishuSyncing && typeof elapsedSeconds === 'number') {
                setElapsedSeconds(null);
            }
            return undefined;
        }
        // 新一轮转录刚开始 → 重置计时器从 0 开始
        if (justStartedLoading) {
            setTranscriptionStartTime(Date.now());
            return undefined;
        }
        // 切换页面后回来 → transcriptionStartTime 已持久化，直接恢复计时
        if (!transcriptionStartTime) {
            setTranscriptionStartTime(Date.now());
            return undefined;
        }
        const timer = window.setInterval(() => {
            setElapsedSeconds((Date.now() - transcriptionStartTime) / 1000);
        }, 100);
        return () => window.clearInterval(timer);
    }, [loading, feishuSyncing, transcriptionStartTime]);

    const handleSelectFile = async () => {
        if (window.electronAPI?.selectVideo) {
            const path = await window.electronAPI.selectVideo();
            if (path) setVideoPath(path);
        }
    };

    const handleExportTimelineAudio = async () => {
        setLoading(true);
        setLoadingText('正在渲染音频...');
        setLoadingStage('rendering');
        setLoadingDetail('正在从当前达芬奇时间线渲染并导出音频，请稍候。');
        setTranscriptionProgress(null);
        setError(null);
        setMessage(null);
        persistWorkspaceDraft({
            loading: true,
            loadingText: '正在渲染音频...',
            loadingStage: 'rendering',
            loadingDetail: '正在从当前达芬奇时间线渲染并导出音频，请稍候。',
            transcriptionProgress: null,
            error: null,
            message: null,
        });
        try {
            const res = await axios.post(`${apiBaseUrl}/api/subtitle/export-audio`);
            if (res.data.audio_path) { 
                setVideoPath(res.data.audio_path); 
                setClipMapping(res.data.clip_mapping || null);
                setOriginalFilename(res.data.original_filename || res.data.timeline_name || '');
                setFrameRate(res.data.frame_rate || 24);
                setMessage('音频导出成功！'); 
                setLoadingStage('');
                setLoadingDetail('');
                setTranscriptionProgress(null);
                persistWorkspaceDraft({
                    videoPath: res.data.audio_path,
                    clipMapping: res.data.clip_mapping || null,
                    originalFilename: res.data.original_filename || res.data.timeline_name || '',
                    frameRate: res.data.frame_rate || 24,
                    loading: false,
                    loadingText: '',
                    loadingStage: '',
                    loadingDetail: '',
                    transcriptionProgress: null,
                    message: '音频导出成功！',
                    error: null,
                });
            }
            else {
                const nextError = res.data.message || '导出音频失败';
                setError(nextError);
                persistWorkspaceDraft({ loading: false, loadingText: '', loadingStage: '', loadingDetail: '', transcriptionProgress: null, error: nextError });
            }
        } catch (e) {
            const nextError = e.response?.data?.detail || '导出音频失败';
            setError(nextError);
            persistWorkspaceDraft({ loading: false, loadingText: '', loadingStage: '', loadingDetail: '', transcriptionProgress: null, error: nextError });
        } finally {
            setLoading(false);
            setLoadingText('');
            setLoadingStage('');
            setLoadingDetail('');
            setTranscriptionProgress(null);
        }
    };

    const createCollection = () => {
        const name = newCollectionName.trim();
        if (name) {
            if (!nounCollections[name]) {
                const updated = { ...nounCollections, [name]: [] };
                setNounCollections(updated);
            }
            setActiveCollection(name);
            setEditingCollection(name);
            setEditNouns((nounCollections[name] || []).join('\n'));
            setRenameValue(name);
        }
        setNewCollectionName('');
        setIsCreatingCollection(false);
    };

    const deleteCollection = (name) => {
        const updated = { ...nounCollections };
        delete updated[name];
        setNounCollections(updated);
        if (activeCollection === name) setActiveCollection('');
        if (editingCollection === name) {
            setEditingCollection(null);
            setEditNouns('');
        }
    };

    const startEditCollection = (name) => {
        setEditingCollection(name);
        setEditNouns((nounCollections[name] || []).join('\n'));
        setRenameValue(name);
    };

    const handleRenameCollection = (oldName, newName) => {
        const trimmedNewName = newName.trim();
        if (!trimmedNewName || trimmedNewName === oldName) {
            setRenameValue(oldName);
            return;
        }
        if (nounCollections[trimmedNewName]) {
            setRenameValue(oldName);
            return; // Name already exists
        }
        
        const updated = { ...nounCollections };
        updated[trimmedNewName] = updated[oldName];
        delete updated[oldName];
        setNounCollections(updated);
        
        if (activeCollection === oldName) setActiveCollection(trimmedNewName);
        if (editingCollection === oldName) {
            setEditingCollection(trimmedNewName);
            setRenameValue(trimmedNewName);
        }
    };

    const handleEditNounsChange = (value) => {
        setEditNouns(value);
        if (editingCollection) {
            const nouns = value.split('\n').filter(n => n.trim());
            setNounCollections(prev => ({ ...prev, [editingCollection]: nouns }));
        }
    };

    const handleInstallModels = async () => {
        setInstallingModels(true);
        setError(null);
        setMessage(null);
        persistWorkspaceDraft({
            installingModels: true,
            error: null,
            message: null,
        });
        try {
            const res = await axios.post(`${apiBaseUrl}/api/backend/funasr/models/install`, {
                force: false,
            });
            setMessage(res.data.message || '语音识别工具包安装完成');
            setModelStatus(res.data.model_status || null);
            await fetchModelStatus();
        } catch (e) {
            setError(e.response?.data?.detail || '语音识别工具包安装失败');
        } finally {
            setInstallingModels(false);
            persistWorkspaceDraft({ installingModels: false });
        }
    };

    const handleDeleteModels = async () => {
        setDeletingModels(true);
        setError(null);
        setMessage(null);
        try {
            const res = await axios.post(`${apiBaseUrl}/api/backend/funasr/models/delete`, {});
            setMessage(res.data.message || '语音识别工具包已删除');
            setModelStatus(res.data.model_status || null);
            await fetchModelStatus();
        } catch (e) {
            setError(e.response?.data?.detail || '语音识别工具包删除失败');
        } finally {
            setDeletingModels(false);
        }
    };

    const handleGenerate = async () => {
        if (sourceType === 'file' && !videoPath) {
            const nextError = '请先选择视频或音频文件';
            setError(nextError);
            persistWorkspaceDraft({ error: nextError, loading: false, loadingText: '', loadingStage: '', loadingDetail: '', transcriptionProgress: null });
            return;
        }
        if (!effectiveModelReady) {
            const nextError = '语音识别模型未安装，请前往「偏好设置 → 模型依赖」安装。';
            setError(nextError);
            persistWorkspaceDraft({ error: nextError, loading: false, loadingText: '', loadingStage: '', loadingDetail: '', transcriptionProgress: null });
            return;
        }
        
        // 清空上一次转录的旧结果，避免用户误以为新转录已完成
        setSegments([]);
        if (onSubtitleReady) onSubtitleReady([]);

        // 处理时间线音频导出（修复 stale state bug：使用局部变量）
        let currentAudioPath = videoPath;
        let currentClipMapping = clipMapping;
        let currentOriginalFilename = originalFilename;
        let currentFrameRate = frameRate;
        
        if (sourceType === 'timeline') {
            try {
                setLoading(true); setLoadingText('正在渲染音频...'); setLoadingStage('rendering'); setLoadingDetail('正在从当前达芬奇时间线渲染并导出音频，请稍候。'); setTranscriptionProgress(null); setError(null);
                setMessage(null);
                persistWorkspaceDraft({
                    loading: true,
                    loadingText: '正在渲染音频...',
                    loadingStage: 'rendering',
                    loadingDetail: '正在从当前达芬奇时间线渲染并导出音频，请稍候。',
                    transcriptionProgress: null,
                    error: null,
                    message: null,
                });
                const exportRes = await axios.post(`${apiBaseUrl}/api/subtitle/export-audio`);
                if (!exportRes.data.audio_path) {
                    const nextError = '导出音频失败';
                    setError(nextError); setLoading(false); setLoadingText(''); setLoadingStage(''); setLoadingDetail(''); setTranscriptionProgress(null);
                    persistWorkspaceDraft({ loading: false, loadingText: '', loadingStage: '', loadingDetail: '', transcriptionProgress: null, error: nextError });
                    return;
                }
                currentAudioPath = exportRes.data.audio_path;
                setVideoPath(currentAudioPath);
                currentClipMapping = exportRes.data.clip_mapping || null;
                setClipMapping(currentClipMapping);
                currentOriginalFilename = exportRes.data.original_filename || exportRes.data.timeline_name || '';
                setOriginalFilename(currentOriginalFilename);
                currentFrameRate = exportRes.data.frame_rate || 24;
                setFrameRate(currentFrameRate);
                persistWorkspaceDraft({
                    videoPath: currentAudioPath,
                    clipMapping: currentClipMapping,
                    originalFilename: currentOriginalFilename,
                    frameRate: currentFrameRate,
                    loading: true,
                    loadingText: '正在转录音频...',
                    loadingStage: 'transcribing',
                    loadingDetail: '音频渲染完成，正在识别语音内容。',
                    transcriptionProgress: effectiveModelSupportsProgress ? 0 : null,
                    error: null,
                    message: null,
                });
                setLoadingText('正在转录音频...');
                setLoadingStage('transcribing');
                setLoadingDetail('音频渲染完成，正在识别语音内容。');
                setTranscriptionProgress(effectiveModelSupportsProgress ? 0 : null);
            } catch (e) {
                const nextError = e.response?.data?.detail || '导出音频失败';
                setError(nextError); setLoading(false); setLoadingText(''); setLoadingStage(''); setLoadingDetail(''); setTranscriptionProgress(null);
                persistWorkspaceDraft({ loading: false, loadingText: '', loadingStage: '', loadingDetail: '', transcriptionProgress: null, error: nextError });
                return;
            }
        }
        
        setLoading(true); setError(null); setMessage(null);
        try {
            setLoadingText('正在转录音频...');
            setLoadingStage('transcribing');
            setLoadingDetail(sourceType === 'timeline' ? '音频已准备完成，正在识别语音内容。' : '正在处理你选择的本地音频/视频文件。');
            setTranscriptionProgress(effectiveModelSupportsProgress ? 0 : null);
            persistWorkspaceDraft({
                loading: true,
                loadingText: '正在转录音频...',
                loadingStage: 'transcribing',
                loadingDetail: sourceType === 'timeline' ? '音频已准备完成，正在识别语音内容。' : '正在处理你选择的本地音频/视频文件。',
                transcriptionProgress: effectiveModelSupportsProgress ? 0 : null,
                error: null,
                message: null,
            });
            const transcribeRes = await axios.post(`${apiBaseUrl}/api/subtitle/transcribe`, { 
                video_path: currentAudioPath, 
                language: requestLanguage,
                source_type: sourceType,
                original_filename: sourceType === 'file' ? currentAudioPath.split(/[/\\]/).pop() : currentOriginalFilename,
                clip_mapping: currentClipMapping,
                hotwords: properNouns.split('\n').map(word => word.trim()).filter(Boolean),
                enable_speaker: enableSpeaker,
                speaker_threshold: speakerThreshold,
                max_chars_per_line: maxCharsPerLine,
                model_profile: effectiveModelProfile,
            });
            if (!transcribeRes.data.segments?.length) {
                setError('转录结果为空'); setLoading(false); setLoadingText(''); setLoadingStage(''); setLoadingDetail(''); setTranscriptionProgress(null);
                persistWorkspaceDraft({ loading: false, loadingText: '', loadingStage: '', loadingDetail: '', transcriptionProgress: null, error: '转录结果为空' });
                return;
            }
            let resultSegments = normalizeTranscriptSegments(transcribeRes.data.segments);
            const apiElapsed = typeof transcribeRes.data.elapsed_seconds === 'number' ? transcribeRes.data.elapsed_seconds : null;
            if (apiElapsed != null) {
                setElapsedSeconds(apiElapsed);
            }
            const elapsedStr = apiElapsed != null ? `，耗时 ${formatElapsed(apiElapsed)}` : '';
            setMessage(`转录完成！共 ${resultSegments.length} 个片段${elapsedStr}`);
            persistWorkspaceDraft({
                segments: resultSegments,
                loading: true,
                loadingText: enableAI && aiApiKey ? '正在优化字幕...' : '正在传输结果...',
                loadingStage: enableAI && aiApiKey ? 'ai' : 'syncing',
                loadingDetail: enableAI && aiApiKey ? '正在结合 AI 优化字幕文本。' : '转录完成，正在同步云端文档。',
                transcriptionProgress: null,
                elapsedSeconds: apiElapsed,
                message: enableAI && aiApiKey ? null : `转录完成！共 ${resultSegments.length} 个片段${elapsedStr}`,
                error: null,
            });
            setLoadingStage(enableAI && aiApiKey ? 'ai' : 'syncing');
            setLoadingDetail(enableAI && aiApiKey ? '正在结合 AI 优化字幕文本。' : '转录完成，正在同步云端文档。');
            setTranscriptionProgress(null);
            if (enableAI && aiApiKey) {
                setLoadingText('正在优化字幕...');
                setMessage(null);
                persistWorkspaceDraft({
                    loading: true,
                    loadingText: '正在优化字幕...',
                    loadingStage: 'ai',
                    loadingDetail: '正在结合 AI 优化字幕文本。',
                    transcriptionProgress: null,
                    message: null,
                    error: null,
                });
                const subtitleText = resultSegments.map(s => `[${s.start}-${s.end}] ${s.text}`).join('\n');
                const aiRes = await axios.post(`${apiBaseUrl}/api/subtitle/ai-optimize`, {
                    subtitle_text: subtitleText, api_key: aiApiKey, base_url: aiBaseUrl, model: aiModel,
                    enable_typo_fix: false,
                    enable_sentence_break: false,
                    enable_proper_noun: true,
                    proper_nouns: properNouns.split('\n').filter(n => n.trim())
                });
                if (aiRes.data.optimized_segments?.length) {
                    resultSegments = normalizeTranscriptSegments(aiRes.data.optimized_segments, resultSegments);
                    setMessage(`转录 + AI优化完成！共 ${resultSegments.length} 个片段${elapsedStr}`);
                    persistWorkspaceDraft({
                        segments: resultSegments,
                        loading: true,
                        loadingText: '正在传输结果...',
                        loadingStage: 'syncing',
                        loadingDetail: 'AI 优化完成，正在同步云端文档。',
                        transcriptionProgress: null,
                        elapsedSeconds: apiElapsed,
                        message: `转录 + AI优化完成！共 ${resultSegments.length} 个片段${elapsedStr}`,
                        error: null,
                    });
                }
                else {
                    setMessage(`转录完成（AI优化未返回有效结果，已保留原始转录）${elapsedStr}`);
                    persistWorkspaceDraft({
                        loading: true,
                        loadingText: '正在传输结果...',
                        loadingStage: 'syncing',
                        loadingDetail: 'AI 优化未返回有效结果，正在同步原始转录结果。',
                        transcriptionProgress: null,
                        elapsedSeconds: apiElapsed,
                        message: `转录完成（AI优化未返回有效结果，已保留原始转录）${elapsedStr}`,
                        error: null,
                    });
                }
            }
            setSegments(resultSegments);
            if (onSubtitleReady) {
                onSubtitleReady(resultSegments);
            }
            if (onTranscriptReady) {
                onTranscriptReady({ 
                    videoPath: currentAudioPath, 
                    transcript: { segments: resultSegments }, 
                    sourceType,
                    originalFilename: sourceType === 'file' ? currentAudioPath.split(/[/\\]/).pop() : currentOriginalFilename,
                    clipMapping: currentClipMapping,
                    frameRate: currentFrameRate,
                    transcriptId: transcribeRes.data.transcript_id || null,
                });
            }
            persistWorkspaceDraft({
                segments: resultSegments,
                feishuDocUrl: feishuDocUrl,
                loading: false,
                loadingText: '',
                loadingStage: '',
                loadingDetail: '',
                transcriptionProgress: null,
                feishuSyncing: false,
                message: message || (enableAI && aiApiKey
                    ? `转录 + AI优化完成！共 ${resultSegments.length} 个片段`
                    : `转录完成！共 ${resultSegments.length} 个片段`),
                error: null,
            });
        } catch (e) {
            const nextError = e.response?.data?.detail || e.message || '生成失败';
            setError(nextError);
            persistWorkspaceDraft({
                loading: false,
                loadingText: '',
                loadingStage: '',
                loadingDetail: '',
                transcriptionProgress: null,
                feishuSyncing: false,
                error: nextError,
            });
        }
        finally { setLoading(false); setLoadingText(''); setLoadingStage(''); setLoadingDetail(''); setTranscriptionProgress(null);
            // 延迟释放后端语音模型内存，避免长时间占用
            setTimeout(() => {
                axios.post(`${apiBaseUrl}/api/backend/transcription/release-memory`).catch(() => {});
            }, 5000);
        }
    };

    const handleSegmentChange = (idx, field, value) => {
        const newSegments = [...segments]; newSegments[idx] = { ...newSegments[idx], [field]: value }; setSegments(newSegments);
    };
    const handleDeleteSegment = (idx) => setSegments(segments.filter((_, i) => i !== idx));

    const formatTime = (seconds) => {
        const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = Math.floor(seconds % 60), ms = Math.round((seconds % 1) * 1000);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    };
    const formatTimeShort = (seconds) => {
        const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60), ms = Math.round((seconds % 1) * 100);
        return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
    };
    const exportSRT = () => segments.map((seg, idx) => `${idx + 1}\n${formatTime(seg.start)} --> ${formatTime(seg.end)}\n${seg.text}\n`).join('\n');
    const copyToClipboard = () => { navigator.clipboard.writeText(exportSRT()); setMessage('SRT 已复制到剪贴板'); };
    const downloadSRT = () => {
        const blob = new Blob([exportSRT()], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'subtitle.srt'; a.click(); URL.revokeObjectURL(url);
    };

    const runtimeUnavailable = modelStatus?.funasr_available === false;
    const coreProfileStatus = (modelStatus?.profiles || []).find(p => p.key === 'core') || { installed: false, ready: false, missing_labels: modelStatus?.missing_labels || [] };
    const packageStatus = modelStatus?.package || {};
    const toolkitInstalled = Boolean(coreProfileStatus.installed)
        || Boolean((modelStatus?.models || []).some((item) => item.installed));
    const effectiveModelSupportsProgress = false;  // faster-whisper 不支持实时进度
    const effectiveModelReady = Boolean(modelStatus?.ready);
    const shouldInstallMissingModels = toolkitInstalled && !effectiveModelReady;
    // 派生阶段：只要 segments 已到达，就不再显示"转录音频-进行中"
    const activeStatusStage = (() => {
        if (feishuSyncing) return 'syncing';
        if (!loading) return '';
        if (segments.length > 0 && loadingStage === 'transcribing') {
            return enableAI && aiApiKey ? 'ai' : 'syncing';
        }
        return loadingStage;
    })();
    const statusFlow = [
        ...(sourceType === 'timeline' ? [{ key: 'rendering', label: '渲染音频' }] : []),
        { key: 'transcribing', label: '转录音频' },
        ...(enableAI && aiApiKey ? [{ key: 'ai', label: '优化字幕' }] : []),
        { key: 'syncing', label: '传输结果' },
    ];
    const currentStageIndex = statusFlow.findIndex((item) => item.key === activeStatusStage);
    const modelSummaryText = modelStatusLoading
        ? '正在检查模型状态...'
        : modelStatus?.error
            ? modelStatus.error
            : runtimeUnavailable
                ? '语音识别模型未安装，请前往「偏好设置 → 模型依赖」安装。'
                : effectiveModelReady
                    ? `${packageStatus?.label || modelStatus?.preset || '语音识别工具包'} 已就绪`
                    : '语音识别模型未安装，请前往「偏好设置 → 模型依赖」安装。';

    const getGroupLanguages = (group) => group.values
        .map((value) => languages.find((item) => item.value === value))
        .filter(Boolean);

    const getDefaultVisibleCount = (groupKey) => {
        return 4;  // 每个分组默认展示 4 个
    };

    const getVisibleLanguages = (group) => {
        const allLanguages = getGroupLanguages(group);
        if (expandedLanguageGroups[group.key]) {
            return allLanguages;
        }
        const defaultVisible = allLanguages.slice(0, getDefaultVisibleCount(group.key));
        const selectedLanguage = allLanguages.find((item) => item.value === language);
        if (selectedLanguage && !defaultVisible.some((item) => item.value === selectedLanguage.value)) {
            return [selectedLanguage];
        }
        return defaultVisible;
    };

    return (
        <div 
            className="page-panel"
            onDragOver={handleDragOver}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            <div className="page-content">
                {/* ── 拖拽遮罩：作为 page-content 直接子级，覆盖完整滚动区域 ── */}
                {isDragOver && (
                    <div style={{
                        position: 'absolute', inset: 0, zIndex: 100,
                        background: 'rgba(10,132,255,0.06)',
                        border: '2px dashed var(--mac-accent)',
                        borderRadius: '0',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        pointerEvents: 'none',
                    }}>
                        <div style={{
                            background: 'rgba(10,132,255,0.12)',
                            borderRadius: '16px',
                            padding: '24px 32px',
                            textAlign: 'center',
                            color: 'var(--mac-accent)',
                            fontSize: '15px',
                            fontWeight: '600',
                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px',
                        }}>
                            <FileAudio size={32} />
                            <span>释放文件以添加到本地文件模式</span>
                        </div>
                    </div>
                )}

                <div className="page-content-inner">
                        {!effectiveModelReady && (
                            <div style={{
                                marginTop: '12px',
                                background: 'rgba(255,149,0,0.08)',
                                border: '1px solid rgba(255,149,0,0.2)',
                                borderRadius: '10px',
                                padding: '10px 12px',
                                fontSize: '12px',
                                color: 'var(--mac-text-secondary)',
                                lineHeight: 1.6,
                            }}>
                                {runtimeUnavailable
                                    ? '首次使用时需要安装语音识别模型。'
                                    : '首次使用时需要安装语音识别模型。'
                                }
                            </div>
                        )}

                        {(loading || activeStatusStage) && (
                            <div style={{
                                marginTop: '12px',
                                background: 'rgba(10,132,255,0.08)',
                                border: '1px solid rgba(10,132,255,0.18)',
                                borderRadius: '12px',
                                padding: '12px 14px',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '10px',
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--mac-text)' }}>
                                    <Loader2 size={15} className="spin" />
                                    <span style={{ fontSize: '13px', fontWeight: 600 }}>{loadingText || '处理中...'}</span>
                                </div>
                                <div style={{ fontSize: '12px', color: 'var(--mac-text-secondary)', lineHeight: 1.6 }}>
                                    {loadingDetail || '正在处理当前任务，请稍候。'}
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: `repeat(${statusFlow.length}, minmax(0, 1fr))`, gap: '8px' }}>
                                    {statusFlow.map((item, index) => {
                                        const isDone = currentStageIndex > -1 && index < currentStageIndex;
                                        const isActive = item.key === activeStatusStage;
                                        return (
                                            <div
                                                key={item.key}
                                                style={{
                                                    borderRadius: '10px',
                                                    padding: '8px 10px',
                                                    border: `1px solid ${isActive ? 'rgba(10,132,255,0.35)' : isDone ? 'rgba(52,199,89,0.28)' : 'var(--mac-border)'}`,
                                                    background: isActive
                                                        ? 'rgba(10,132,255,0.12)'
                                                        : isDone
                                                            ? 'rgba(52,199,89,0.08)'
                                                            : 'rgba(255,255,255,0.03)',
                                                }}
                                            >
                                                <div style={{ fontSize: '11px', fontWeight: 600, color: isActive ? '#0A84FF' : isDone ? '#34C759' : 'var(--mac-text-secondary)' }}>
                                                    {item.label}
                                                </div>
                                                <div style={{ fontSize: '10px', marginTop: '4px', color: isActive ? 'var(--mac-text)' : 'var(--mac-text-secondary)' }}>
                                                    {isActive ? '进行中' : isDone ? '已完成' : '等待中'}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                                {effectiveModelSupportsProgress && activeStatusStage === 'transcribing' && typeof transcriptionProgress === 'number' && (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px', color: 'var(--mac-text-secondary)' }}>
                                            <span>转录进度</span>
                                            <span>{Math.max(0, Math.min(100, Math.round(transcriptionProgress)))}%</span>
                                        </div>
                                        <div style={{ height: '8px', borderRadius: '999px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                                            <div style={{
                                                width: `${Math.max(0, Math.min(100, transcriptionProgress))}%`,
                                                height: '100%',
                                                background: 'linear-gradient(90deg, #0A84FF 0%, #34C759 100%)',
                                                transition: 'width 0.2s ease',
                                            }} />
                                        </div>
                                    </div>
                                )}
                                {activeStatusStage && typeof elapsedSeconds === 'number' && (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--mac-text-secondary)' }}>
                                        <span>已耗时</span>
                                        <span style={{ fontWeight: 600, color: 'var(--mac-text)' }}>{formatElapsed(elapsedSeconds)}</span>
                                    </div>
                                )}
                            </div>
                        )}
                </div>

                {/* 音频来源 */}
                <div className="mac-settings-section">
                    <div className="mac-settings-title">音频来源</div>
                    <div className="mac-settings-group">
                        <div className="mac-settings-row">
                            <div className="mac-settings-row-left" style={{ flex: 1 }}>
                                <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
                                    {[{ key: 'timeline', icon: <Monitor size={14} />, label: '达芬奇时间线' }, { key: 'file', icon: <Upload size={14} />, label: '本地文件' }].map(s => (
                                        <button key={s.key} onClick={() => setSourceType(s.key)} style={{
                                            flex: 1, padding: '8px 10px', border: 'none', borderRadius: '8px', cursor: 'pointer',
                                            background: sourceType === s.key ? 'var(--mac-accent)' : 'transparent',
                                            color: sourceType === s.key ? '#fff' : 'var(--mac-text-secondary)',
                                            fontSize: '13px', fontWeight: sourceType === s.key ? '500' : '400',
                                            border: `1px solid ${sourceType === s.key ? 'transparent' : 'var(--mac-border)'}`,
                                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', transition: 'all 0.15s'
                                        }}>{s.icon} {s.label}</button>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {sourceType === 'file' && (
                            <div className="mac-settings-row" style={{ background: 'var(--mac-bg-secondary)', flexDirection: 'column', alignItems: 'stretch', gap: '8px' }}>
                                <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
                                    <input type="text" className="mac-input" value={videoPath} onChange={(e) => setVideoPath(e.target.value)} placeholder="选择视频或音频文件，或拖拽文件到页面中" style={{ flex: 1, fontSize: '13px', padding: '6px 10px' }} />
                                    <button className="mac-btn" onClick={handleSelectFile} style={{ padding: '6px 12px', flexShrink: 0 }}><Upload size={14} style={{ marginRight: '6px' }} /> 选择文件</button>
                                </div>

                            </div>
                        )}
                        {sourceType === 'timeline' && (
                            <div className="mac-settings-row" style={{ background: 'var(--mac-bg-secondary)' }}>
                                <div className="mac-settings-row-left">
                                    <div className="mac-settings-icon-wrapper" style={{ background: '#0A84FF', color: '#fff' }}>
                                        <Monitor size={16} />
                                    </div>
                                    <div className="mac-settings-text-block">
                                        <div className="mac-settings-label">从时间线导出音频</div>
                                        <div className="mac-settings-desc">系统将自动从当前达芬奇时间线导出音频，用于语音转录</div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* 语言选择 - 按钮组 */}
                <div className="mac-settings-section">
                    <div className="mac-settings-title">语言设置</div>
                    <div className="mac-settings-group" style={{ padding: '16px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                            <div>
                                <div style={{ fontSize: '12px', color: 'var(--mac-text-secondary)', marginBottom: '8px' }}>自动</div>
                                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                    {languages.filter((item) => item.value === 'auto').map((l) => (
                                        <button key={l.value} onClick={() => setLanguage(l.value)} style={{
                                            padding: '8px 16px', borderRadius: '8px', cursor: 'pointer',
                                            background: language === l.value ? 'var(--mac-accent)' : 'var(--mac-input-bg)',
                                            color: language === l.value ? '#fff' : 'var(--mac-text)',
                                            fontSize: '13px', fontWeight: language === l.value ? '500' : '400',
                                            border: `1px solid ${language === l.value ? 'transparent' : 'var(--mac-border)'}`,
                                            display: 'flex', alignItems: 'center', gap: '6px', transition: 'all 0.15s'
                                        }}>
                                            <span style={{ fontSize: '14px' }}>{l.flag}</span> {l.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {languageGroups.map((group) => {
                                const groupLanguages = getGroupLanguages(group);
                                const visibleLanguages = getVisibleLanguages(group);
                                const hiddenCount = Math.max(groupLanguages.length - visibleLanguages.length, 0);
                                const expanded = expandedLanguageGroups[group.key];
                                return (
                                    <div key={group.key}>
                                        <div style={{ fontSize: '12px', color: 'var(--mac-text-secondary)', marginBottom: '8px' }}>{group.label}</div>
                                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                                            {visibleLanguages.map((l) => (
                                                <button key={l.value} onClick={() => setLanguage(l.value)} style={{
                                                    padding: '8px 16px', borderRadius: '8px', cursor: 'pointer',
                                                    background: language === l.value ? 'var(--mac-accent)' : 'var(--mac-input-bg)',
                                                    color: language === l.value ? '#fff' : 'var(--mac-text)',
                                                    fontSize: '13px', fontWeight: language === l.value ? '500' : '400',
                                                    border: `1px solid ${language === l.value ? 'transparent' : 'var(--mac-border)'}`,
                                                    display: 'flex', alignItems: 'center', gap: '6px', transition: 'all 0.15s'
                                                }}>
                                                    <span style={{ fontSize: '14px' }}>{l.flag}</span> {l.label}
                                                </button>
                                            ))}
                                            {!expanded && hiddenCount > 0 && (
                                                <button
                                                    type="button"
                                                    onClick={() => setExpandedLanguageGroups((prev) => ({ ...prev, [group.key]: true }))}
                                                    style={{
                                                        padding: '8px 14px',
                                                        borderRadius: '8px',
                                                        cursor: 'pointer',
                                                        background: 'transparent',
                                                        color: 'var(--mac-text-secondary)',
                                                        fontSize: '13px',
                                                        border: '1px dashed var(--mac-border)',
                                                        transition: 'all 0.15s',
                                                    }}
                                                >
                                                    +{hiddenCount}种
                                                </button>
                                            )}
                                            {expanded && groupLanguages.length > getDefaultVisibleCount(group.key) && (
                                                <button
                                                    type="button"
                                                    onClick={() => setExpandedLanguageGroups((prev) => ({ ...prev, [group.key]: false }))}
                                                    style={{
                                                        padding: '8px 14px',
                                                        borderRadius: '8px',
                                                        cursor: 'pointer',
                                                        background: 'transparent',
                                                        color: 'var(--mac-text-secondary)',
                                                        fontSize: '13px',
                                                        border: '1px dashed var(--mac-border)',
                                                        transition: 'all 0.15s',
                                                    }}
                                                >
                                                    收起
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>

                {/* 高级选项 */}
                <div className="mac-settings-section">
                    <div className="mac-settings-title">高级选项</div>
                    <div className="mac-settings-group">
                        {/* 每行字数上限 */}
                        <div className="mac-settings-row" style={{ borderBottom: 'none' }}>
                            <div className="mac-settings-row-left">
                                <div className="mac-settings-icon-wrapper" style={{ background: '#FF9500', color: '#fff' }}>
                                    <WrapText size={16} />
                                </div>
                                <div className="mac-settings-text-block">
                                    <div className="mac-settings-label">每行字数上限</div>
                                    <div className="mac-settings-desc">控制单行字幕最多显示的字数，超出后自动断行</div>
                                </div>
                            </div>
                            <div className="mac-settings-row-right">
                                <span style={{ fontSize: '13px', fontWeight: '600', color: '#FF9500', fontVariantNumeric: 'tabular-nums' }}>{maxCharsPerLine} 字</span>
                            </div>
                        </div>
                        <div style={{ paddingLeft: '16px', paddingRight: '16px', paddingBottom: '12px' }}>
                            <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: '12px', border: '1px solid var(--mac-border)', padding: '12px 14px' }}>
                                <input
                                    type="range"
                                    min="8"
                                    max="30"
                                    step="1"
                                    value={maxCharsPerLine}
                                    onChange={(e) => setMaxCharsPerLine(parseInt(e.target.value, 10))}
                                    style={{ flex: 1, minWidth: 0, width: '100%', height: '4px', accentColor: '#FF9500' }}
                                />
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px' }}>
                                    <span style={{ fontSize: '10px', color: 'var(--mac-text-tertiary)' }}>更短 (8)</span>
                                    <span style={{ fontSize: '10px', color: 'var(--mac-text-tertiary)' }}>更长 (30)</span>
                                </div>
                            </div>
                        </div>

                        {/* 说话人检测 */}
                        <div className="mac-settings-row" style={enableSpeaker ? { borderBottom: 'none' } : undefined}>
                            <div className="mac-settings-row-left">
                                <div className="mac-settings-icon-wrapper" style={{ background: '#AF52DE', color: '#fff' }}>
                                    <Users size={16} />
                                </div>
                                <div className="mac-settings-text-block">
                                    <div className="mac-settings-label">
                                        说话人检测
                                    </div>
                                    <div className="mac-settings-desc">开启后自动区分不同说话人，为每段字幕标注说话人标签</div>
                                </div>
                            </div>
                            <div className="mac-settings-row-right">
                                <ToggleSwitch checked={enableSpeaker} onChange={setEnableSpeaker} color="#AF52DE" />
                            </div>
                        </div>

                        {/* 说话人聚类阈值 — 仅在开启说话人检测时显示 */}
                        {enableSpeaker && (
                            <div style={{ paddingLeft: '16px', paddingRight: '16px', paddingBottom: '12px' }}>
                                <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: '12px', border: '1px solid var(--mac-border)', padding: '12px 14px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                                        <span style={{ fontSize: '12px', fontWeight: '500', color: 'var(--mac-text-secondary)' }}>聚类阈值</span>
                                        <span style={{ fontSize: '12px', fontWeight: '600', color: '#AF52DE', fontVariantNumeric: 'tabular-nums' }}>{speakerThreshold.toFixed(2)}</span>
                                    </div>
                                    <input
                                        type="range"
                                        min="0.2"
                                        max="0.8"
                                        step="0.05"
                                        value={speakerThreshold}
                                        onChange={(e) => setSpeakerThreshold(parseFloat(e.target.value))}
                                        style={{ flex: 1, minWidth: 0, width: '100%', height: '4px', accentColor: '#AF52DE' }}
                                    />
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px' }}>
                                        <span style={{ fontSize: '10px', color: 'var(--mac-text-tertiary)' }}>更多说话人</span>
                                        <span style={{ fontSize: '10px', color: 'var(--mac-text-tertiary)' }}>更少说话人</span>
                                    </div>
                                </div>
                            </div>
                        )}


                        {/* 热词优化 */}
                        <div className="mac-settings-row" style={enableAI ? { borderBottom: 'none' } : undefined}>
                            <div className="mac-settings-row-left">
                                <div className="mac-settings-icon-wrapper" style={{ background: '#FF9500', color: '#fff' }}>
                                    <Sparkles size={16} />
                                </div>
                                <div className="mac-settings-text-block">
                                    <div className="mac-settings-label">
                                        热词优化
                                    </div>
                                    <div className="mac-settings-desc">开启后结合热词集合优化转录文本中的术语、人名和品牌名</div>
                                </div>
                            </div>
                            <div className="mac-settings-row-right">
                                <ToggleSwitch checked={enableAI} onChange={setEnableAI} color="#FF9500" />
                            </div>
                        </div>

                    {enableAI && (
                        <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '12px', paddingLeft: '16px', paddingRight: '16px', paddingBottom: '16px' }}>
                            {/* 热词集合 */}
                            <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: '12px', border: '1px solid var(--mac-border)', padding: '10px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: '500' }}>
                                        <BookOpen size={14} color="#FF9500" /> 热词集合
                                    </div>
                                    <button onClick={() => {
                                        if (!showCollectionManager) {
                                            setShowCollectionManager(true);
                                            if (activeCollection && nounCollections[activeCollection]) {
                                                setEditingCollection(activeCollection);
                                                setEditNouns((nounCollections[activeCollection] || []).join('\n'));
                                                setRenameValue(activeCollection);
                                            }
                                        } else {
                                            setShowCollectionManager(false);
                                            setIsCreatingCollection(false);
                                            setEditingCollection(null);
                                        }
                                    }} style={{
                                        background: 'rgba(255,149,0,0.1)', border: 'none', borderRadius: '8px',
                                        padding: '3px 8px', cursor: 'pointer', color: '#FF9500', fontSize: '11px',
                                        display: 'flex', alignItems: 'center', gap: '3px'
                                    }}>
                                        {showCollectionManager ? '完成' : <React.Fragment><Plus size={12} /> 管理</React.Fragment>}
                                    </button>
                                </div>

                                {showCollectionManager ? (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                                            {Object.keys(nounCollections).map(name => (
                                                <div key={name} style={{
                                                    display: 'flex', alignItems: 'center', gap: '4px',
                                                    padding: '4px 8px 4px 10px', borderRadius: '10px',
                                                    background: editingCollection === name ? 'rgba(255,149,0,0.2)' : 'rgba(255,255,255,0.04)',
                                                    border: `1px solid ${editingCollection === name ? 'rgba(255,149,0,0.4)' : 'var(--mac-border)'}`,
                                                    color: editingCollection === name ? '#FF9500' : 'var(--mac-text-secondary)',
                                                    transition: 'all 0.15s', cursor: 'pointer'
                                                }} onClick={() => startEditCollection(name)}>
                                                    <span style={{ fontSize: '11px', fontWeight: editingCollection === name ? '600' : '400' }}>
                                                        {name} <span style={{ opacity: 0.5, fontSize: '10px' }}>({nounCollections[name].length})</span>
                                                    </span>
                                                    <button onClick={(e) => { e.stopPropagation(); deleteCollection(name); }} style={{
                                                        background: 'transparent', border: 'none', padding: '2px', cursor: 'pointer',
                                                        color: 'inherit', opacity: 0.6, display: 'flex', alignItems: 'center', marginLeft: '2px'
                                                    }}>
                                                        <X size={10} />
                                                    </button>
                                                </div>
                                            ))}
                                            
                                            {/* 新建集合按钮/输入框 */}
                                            {isCreatingCollection ? (
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '2px 4px 2px 8px', borderRadius: '10px', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--mac-border)' }}>
                                                    <input 
                                                        autoFocus
                                                        type="text" 
                                                        value={newCollectionName} 
                                                        onChange={(e) => setNewCollectionName(e.target.value)} 
                                                        placeholder="集合名称" 
                                                        style={{ width: '70px', fontSize: '11px', background: 'transparent', border: 'none', color: 'var(--mac-text)', outline: 'none' }} 
                                                        onKeyDown={(e) => { if (e.key === 'Enter') createCollection(); else if (e.key === 'Escape') setIsCreatingCollection(false); }}
                                                        onBlur={() => { if(newCollectionName.trim()) createCollection(); else setIsCreatingCollection(false); }}
                                                    />
                                                </div>
                                            ) : (
                                                <button onClick={() => setIsCreatingCollection(true)} style={{
                                                    padding: '4px 10px', borderRadius: '10px', border: '1px dashed var(--mac-border)', cursor: 'pointer',
                                                    background: 'transparent', color: 'var(--mac-text-secondary)', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px'
                                                }}>
                                                    <Plus size={10} /> 新建
                                                </button>
                                            )}
                                        </div>

                                        {/* 编辑区域 */}
                                        {editingCollection && (
                                            <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: '10px', border: '1px solid var(--mac-border)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                                <div style={{ fontSize: '11px', color: 'var(--mac-text-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                        <span>名称：</span>
                                                        <input 
                                                            type="text" 
                                                            value={renameValue} 
                                                            onChange={(e) => setRenameValue(e.target.value)}
                                                            onBlur={() => handleRenameCollection(editingCollection, renameValue)}
                                                            onKeyDown={(e) => e.key === 'Enter' && handleRenameCollection(editingCollection, renameValue)}
                                                            className="mac-input"
                                                            style={{ fontSize: '11px', padding: '2px 6px', width: '100px', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--mac-border)', borderRadius: '6px' }}
                                                        />
                                                    </div>
                                                    <span style={{ fontSize: '10px', opacity: 0.6 }}>自动保存</span>
                                                </div>
                                                <textarea 
                                                    className="mac-input" 
                                                    value={editNouns} 
                                                    onChange={(e) => handleEditNounsChange(e.target.value)} 
                                                    placeholder="每行一个热词" 
                                                    rows={4} 
                                                    style={{ fontSize: '11px', resize: 'vertical', minHeight: '60px' }} 
                                                />
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    Object.keys(nounCollections).length > 0 ? (
                                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                                            {Object.keys(nounCollections).map(name => (
                                                <button key={name} onClick={() => setActiveCollection(activeCollection === name ? '' : name)} style={{
                                                    padding: '4px 10px', borderRadius: '10px', border: 'none', cursor: 'pointer',
                                                    background: activeCollection === name ? 'rgba(255,149,0,0.2)' : 'rgba(255,255,255,0.04)',
                                                    color: activeCollection === name ? '#FF9500' : 'var(--mac-text-secondary)',
                                                    fontSize: '11px', fontWeight: activeCollection === name ? '600' : '400',
                                                    border: `1px solid ${activeCollection === name ? 'rgba(255,149,0,0.4)' : 'var(--mac-border)'}`,
                                                    transition: 'all 0.15s'
                                                }}>{name} <span style={{ opacity: 0.5, fontSize: '10px' }}>({nounCollections[name].length})</span></button>
                                            ))}
                                        </div>
                                    ) : (
                                        <p style={{ fontSize: '11px', color: 'var(--mac-text-secondary)', margin: 0 }}>暂无集合，点击"管理"创建</p>
                                    )
                                )}
                            </div>
                        </div>
                    )}
                </div>
                </div>

                {/* 生成按钮 */}
                <div style={{ marginTop: '-12px', display: 'flex', justifyContent: 'flex-end', flexDirection: 'column', gap: '16px', width: '100%' }}>
                    <button className="mac-btn primary" onClick={handleGenerate} disabled={loading || (sourceType === 'file' && !videoPath)} style={{ height: '44px', fontSize: '14px', fontWeight: '500', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '10px', width: '100%' }}>
                        {loading ? <React.Fragment><Loader2 size={16} style={{ animation: 'spin 1s linear infinite', marginRight: '4px' }} /> 处理中...</React.Fragment> : <React.Fragment><Play size={16} style={{ marginRight: '4px' }} /> 开始转录</React.Fragment>}
                    </button>

                    {message && <div style={{ background: 'rgba(52, 199, 89, 0.1)', color: '#34C759', padding: '12px 16px', borderRadius: '10px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}><CheckCircle2 size={16} /> {message}</div>}
                    {feishuDocUrl && !feishuSyncing && (
                        <div style={{ background: 'rgba(0, 122, 255, 0.08)', padding: '12px 16px', borderRadius: '10px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <CheckCircle2 size={16} color="#0A84FF" />
                            <span style={{ color: 'var(--mac-text)' }}>已同步至飞书</span>
                            <a href={feishuDocUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#0A84FF', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '4px', marginLeft: 'auto', fontSize: '12px' }}>
                                打开文档 <ExternalLink size={12} />
                            </a>
                        </div>
                    )}
                    {error && <div style={{ background: 'rgba(255, 59, 48, 0.1)', color: '#FF3B30', padding: '12px 16px', borderRadius: '10px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}><AlertTriangle size={16} /> {error}</div>}
                </div>

            </div>
        </div>
    );
}

export default SubtitleGenerator;
