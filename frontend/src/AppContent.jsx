import { Suspense, useState, useEffect, useRef, useCallback, useTransition, useMemo } from 'react';

import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  Search, Clapperboard, Scissors,
  Search as CheckIcon, FileVideo, Settings, Sun, Moon,
  LayoutGrid, CheckCircle2, ChevronRight, ChevronLeft, Subtitles, FileText, Package, MessageSquare, Library, ClipboardPaste
} from 'lucide-react';
import WelcomeView from './components/WelcomeView';
import ProjectSetup from './components/ProjectSetup';
import FolderConfigGraph from './components/FolderConfigGraph';
import AutoEditView from './components/AutoEditView';
import ExportView from './components/ExportView';
import CheckView from './components/CheckView';
import SettingsView from './components/SettingsView';
import StatusBar from './components/StatusBar';
import SubtitleGenerator from './components/SubtitleGenerator';
import SubtitleEditorView from './components/SubtitleEditorView';
import SoundEffectsView from './components/SoundEffectsView';
import MaterialPackager from './components/MaterialPackager';
import FileHierarchyManager from './components/FileHierarchyManager';
import ReviewSync from './components/ReviewSync';
import ClipImportView from './components/ClipImportView';
import { TranscriptProjectTabs, TranscriptBindingToggle, TranscriptProjectManager, loadMeta as loadTranscriptMeta, saveMeta as saveTranscriptMeta } from './components/TranscriptProjectManager';
import { API_BASE_URL } from './config';
import { saveWorkspace, loadWorkspace } from './idbStorage';

const DEFAULT_TRANSCRIPT_WORKSPACE = {
    transcriptData: null,
    subtitleData: null,
    subtitleDraft: null,
    activeTranscriptId: null,
};

// 模块级缓存：切换 workspace（/app ↔ /sfx）时 AppContent 卸载再挂载，
// React state 会丢失，但模块变量不丢，直接从这里恢复。
let _workspaceCache = null;

function getTranscriptWorkspaceStorageKey(projectId) {
    return `quickclip:transcript-workspace:${projectId || 'default'}`;
}

function sanitizeTranscriptWorkspace(raw) {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_TRANSCRIPT_WORKSPACE };
    if (raw?.subtitleDraft && typeof raw.subtitleDraft === 'object' && typeof raw.subtitleDraft.message === 'string' && raw.subtitleDraft.message.includes('FunASR')) {
        delete raw.subtitleDraft.message;
    }
    const merged = {
        ...DEFAULT_TRANSCRIPT_WORKSPACE,
        ...raw,
    };
    if (merged.subtitleDraft && typeof merged.subtitleDraft === 'object' && merged.subtitleDraft.loading) {
        merged.subtitleDraft = {
            ...merged.subtitleDraft,
            loading: false,
            loadingText: '',
            loadingStage: '',
            loadingDetail: '',
            transcriptionProgress: null,
            elapsedSeconds: null,
            feishuSyncing: false,
            message: null,
            error: null,
        };
    }
    return merged;
}

function loadTranscriptWorkspace(projectId) {
    try {
        const raw = localStorage.getItem(getTranscriptWorkspaceStorageKey(projectId));
        if (!raw) return { ...DEFAULT_TRANSCRIPT_WORKSPACE };
        return sanitizeTranscriptWorkspace(JSON.parse(raw));
    } catch {
        return { ...DEFAULT_TRANSCRIPT_WORKSPACE };
    }
}

export default function AppContent() {
    const navigate = useNavigate();
    const [currentStep, setCurrentStep] = useState(() => {
        const saved = sessionStorage.getItem('main.currentStep');
        if (!saved) return 'setup';
        if (saved === 'sound_effects') return 'setup';
        return saved;
    });
    const [importedVideos, setImportedVideos] = useState([]);
    const [projectContext, setProjectContext] = useState(() => {
        try { const saved = sessionStorage.getItem('projectContext'); return saved ? JSON.parse(saved) : null; } catch { return null; }
    });
    const [transcriptWorkspace, setTranscriptWorkspace] = useState(() =>
        _workspaceCache || loadTranscriptWorkspace('default')
    );
    const [transcriptProjects, setTranscriptProjects] = useState([]);
    const [transcriptProjectMeta, setTranscriptProjectMeta] = useState(() => {
        try {
            const raw = localStorage.getItem('quickclip:transcript-project-meta');
            return raw ? JSON.parse(raw) : { projects: [], activeId: null };
        } catch { return { projects: [], activeId: null }; }
    });
    const [transcriptManageMode, setTranscriptManageMode] = useState(false);
    const [resolveStatus, setResolveStatus] = useState(() => {
        try { const saved = sessionStorage.getItem('resolveStatus'); return saved ? JSON.parse(saved) : { connected: false, project: null }; } catch { return { connected: false, project: null }; }
    });
    const mergedTranscriptProjects = useMemo(() => {
        return (transcriptProjects || []).map(bp => {
            const meta = (transcriptProjectMeta.projects || []).find(m => m.id === bp.id);
            const bindingScope = meta?.bindingScope
                || (meta?.isGlobal ? 'global' : undefined)
                || 'project';
            return {
                ...bp,
                bindingScope,
                isGlobal: bindingScope === 'global' || (meta?.isGlobal ?? false),
                boundDavinciProject: bindingScope === 'global' ? null
                    : bindingScope === 'current' ? resolveStatus.project
                    : meta && 'boundDavinciProject' in meta ? meta.boundDavinciProject
                    : (bp.davinci_project || resolveStatus.project),
                localImportPath: meta?.localImportPath ?? '',
                mediaPoolPath: meta?.mediaPoolPath ?? '',
                createdAt: meta?.createdAt ?? Date.now(),
            };
        });
    }, [transcriptProjects, transcriptProjectMeta, resolveStatus.project]);
    const [backendHealth, setBackendHealth] = useState({ ffmpeg: null });
    const [wasConnected, setWasConnected] = useState(false);
    const reconnectTimerRef = useRef(null);
    const reconnectStartRef = useRef(0);
    const autoSwitchDoneRef = useRef(false);
    const [currentTimeline, setCurrentTimeline] = useState(() => {
        try { const saved = sessionStorage.getItem('currentTimeline'); return saved ? JSON.parse(saved) : { name: null, resolution: null }; } catch { return { name: null, resolution: null }; }
    });
    const [theme, setTheme] = useState(() => {
        const saved = localStorage.getItem('app-theme');
        if (saved === 'dark' || saved === 'light') {
            document.documentElement.setAttribute('data-theme', saved);
            return saved;
        }
        const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
        return 'auto';
    });
    const [searchQuery, setSearchQuery] = useState('');
    const [isNavScrolling, setIsNavScrolling] = useState(false);
    const navScrollHideTimerRef = useRef(null);
    const [showReconnectHint, setShowReconnectHint] = useState(false);
    const reconnectHintDismissedRef = useRef(false);
    const [showContent, setShowContent] = useState(false);
    const [, startContentTransition] = useTransition();

    const [history, setHistory] = useState([{ id: 'setup', subPage: null }]);
    const [historyIndex, setHistoryIndex] = useState(0);
    const currentSubPage = history[historyIndex]?.subPage || null;
    const projectId = projectContext?.project_name || resolveStatus.project || 'default';
    const transcriptData = transcriptWorkspace?.transcriptData || null;
    const subtitleData = transcriptWorkspace?.subtitleData
        || (transcriptData?.transcript?.segments ? transcriptData.transcript.segments : null);
    const subtitleDraft = transcriptWorkspace?.subtitleDraft || null;
    const activeTranscriptId = transcriptWorkspace?.activeTranscriptId || null;

    const handleStepChange = (stepId, subPage = null) => {
        if (stepId === 'sound_effects') {
            navigate('/sfx/library');
            return;
        }
        const currentHistoryItem = history[historyIndex];
        if (stepId === currentStep && subPage === currentHistoryItem.subPage) return;

        const newHistory = history.slice(0, historyIndex + 1);
        newHistory.push({ id: stepId, subPage });
        if (newHistory.length > 50) {
            newHistory.splice(0, newHistory.length - 50);
        }
        setHistory(newHistory);
        setHistoryIndex(newHistory.length - 1);

        setCurrentStep(stepId);
    };

    useEffect(() => {
        sessionStorage.setItem('main.currentStep', currentStep);
    }, [currentStep]);

    // Defer heavy content rendering to let workspace tab animation start first
    useEffect(() => {
        let cancelled = false;
        requestAnimationFrame(() => {
            if (!cancelled) {
                startContentTransition(() => setShowContent(true));
            }
        });
        return () => { cancelled = true; };
    }, []);

    const handleGoBack = () => {
        if (historyIndex > 0) {
            const prevIndex = historyIndex - 1;
            const prevItem = history[prevIndex];
            setHistoryIndex(prevIndex);
            setCurrentStep(prevItem.id);
        }
    };

    const handleGoForward = () => {
        if (historyIndex < history.length - 1) {
            const nextIndex = historyIndex + 1;
            const nextItem = history[nextIndex];
            setHistoryIndex(nextIndex);
            setCurrentStep(nextItem.id);
        }
    };

    useEffect(() => {
        const mql = window.matchMedia('(prefers-color-scheme: dark)');

        const updateTheme = (e) => {
            const saved = localStorage.getItem('app-theme');
            if (saved === 'dark' || saved === 'light') return;
            const newTheme = e.matches ? 'dark' : 'light';
            document.documentElement.setAttribute('data-theme', newTheme);
        };

        const saved = localStorage.getItem('app-theme');
        if (!saved || saved === 'auto') {
            const isDark = mql.matches;
            document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
        }
        mql.addEventListener('change', updateTheme);

        checkBackendHealth();
        fetchCurrentTimeline();
        if (!resolveStatus.connected) {
            startStagedReconnect();
        }
        const healthTimer = setInterval(checkBackendHealth, 15000);
        const timelineTimer = setInterval(fetchCurrentTimeline, 5000);

        return () => {
            clearInterval(healthTimer);
            clearInterval(timelineTimer);
            stopStagedReconnect();
            mql.removeEventListener('change', updateTheme);
            if (navScrollHideTimerRef.current) {
                clearTimeout(navScrollHideTimerRef.current);
            }
        };
    }, []);

    useEffect(() => {
        if (!resolveStatus.connected && !reconnectHintDismissedRef.current) {
            const timer = setTimeout(() => setShowReconnectHint(true), 3000);
            return () => clearTimeout(timer);
        } else {
            setShowReconnectHint(false);
            if (resolveStatus.connected) {
                reconnectHintDismissedRef.current = false;
            }
        }
    }, [resolveStatus.connected]);

    useEffect(() => { sessionStorage.setItem('resolveStatus', JSON.stringify(resolveStatus)); }, [resolveStatus]);
    useEffect(() => { sessionStorage.setItem('currentTimeline', JSON.stringify(currentTimeline)); }, [currentTimeline]);
    useEffect(() => { sessionStorage.setItem('projectContext', JSON.stringify(projectContext)); }, [projectContext]);

    const handleNavScroll = () => {
        setIsNavScrolling(true);
        if (navScrollHideTimerRef.current) clearTimeout(navScrollHideTimerRef.current);
        navScrollHideTimerRef.current = setTimeout(() => {
            setIsNavScrolling(false);
        }, 1000);
    };

    const stopStagedReconnect = () => {
        if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
        }
    };

    const startStagedReconnect = () => {
        if (reconnectTimerRef.current) return;
        reconnectStartRef.current = Date.now();

        const attemptReconnect = async () => {
            let connected = false;

            try {
                const res = await axios.get(`${API_BASE_URL}/api/status`);
                if (res.data.connected) {
                    setResolveStatus({ connected: true, project: res.data.project });
                    setWasConnected(true);
                    connected = true;
                }
            } catch {}

            if (!connected) {
                try {
                    const reconnectRes = await axios.post(`${API_BASE_URL}/api/reconnect`);
                    if (reconnectRes.data.connected) {
                        setResolveStatus({ connected: true, project: reconnectRes.data.project });
                        setWasConnected(true);
                        connected = true;
                    }
                } catch {}
            }

            if (connected) {
                reconnectTimerRef.current = null;
                return;
            }

            const elapsed = (Date.now() - reconnectStartRef.current) / 1000;
            let nextInterval;
            if (elapsed < 10) {
                nextInterval = 1000;
            } else if (elapsed < 30) {
                nextInterval = 2000;
            } else {
                nextInterval = 5000;
            }
            reconnectTimerRef.current = setTimeout(attemptReconnect, nextInterval);
        };

        attemptReconnect();
    };

    const checkBackendHealth = async () => {
        let backendReachable = false;
        try {
            const res = await axios.get(`${API_BASE_URL}/api/status`);
            const newConnected = res.data.connected === true;
            backendReachable = true;
            setResolveStatus({
                connected: newConnected,
                project: res.data.project
            });
            if (newConnected) {
                setWasConnected(true);
                stopStagedReconnect();
            } else if (!reconnectTimerRef.current) {
                startStagedReconnect();
            }
        } catch (error) {
            setResolveStatus({ connected: false, project: null });
        }

        try {
            const healthRes = await axios.get(`${API_BASE_URL}/api/backend/health`);
            backendReachable = true;
            setBackendHealth({
                ffmpeg: healthRes.data.ffmpeg,
            });
        } catch {
            setBackendHealth({ ffmpeg: null });
        }

        // 后端可达后拉取转录项目列表（处理首次挂载时后端尚未就绪的情况）
        if (backendReachable) {
            fetchTranscriptProjects();
        }
    };

    const fetchCurrentTimeline = async () => {
        try {
            const res = await axios.get(`${API_BASE_URL}/api/timeline/current`);
            if (res.data.status === 'success') {
                setCurrentTimeline({
                    name: res.data.timeline_name,
                    resolution: res.data.timeline_resolution
                });
            } else {
                setCurrentTimeline({ name: null, resolution: null });
            }
        } catch (error) {
            setCurrentTimeline({ name: null, resolution: null });
        }
    };

    const refreshProjectContext = async () => {
        try {
            const res = await axios.get(`${API_BASE_URL}/api/project/context`);
            const context = res.data?.context || null;
            setProjectContext(context);
            setImportedVideos(context?.imported_videos || []);
        } catch (error) {
            setProjectContext(null);
            setImportedVideos([]);
        }
    };

    const fetchTranscriptProjects = useCallback(async () => {
        try {
            const res = await axios.get(`${API_BASE_URL}/api/transcript/projects?all=true`);
            setTranscriptProjects(res.data.projects || []);
        } catch {
            setTranscriptProjects([]);
        }
    }, []);

    // 持久化转录项目元数据
    useEffect(() => {
        try {
            localStorage.setItem('quickclip:transcript-project-meta', JSON.stringify(transcriptProjectMeta));
        } catch {}
    }, [transcriptProjectMeta]);

    // 更新转录项目元数据
    const handleUpdateTranscriptProjectMeta = useCallback((id, updates) => {
        setTranscriptProjectMeta(prev => {
            const projects = (prev.projects || []).map(p =>
                p.id === id ? { ...p, ...updates } : p
            );
            if (!projects.find(p => p.id === id)) {
                projects.push({ id, ...updates, createdAt: Date.now() });
            }
            return { ...prev, projects };
        });
    }, []);

    // 删除转录项目元数据
    const handleDeleteTranscriptProjectMeta = useCallback((id) => {
        setTranscriptProjectMeta(prev => ({
            projects: (prev.projects || []).filter(p => p.id !== id),
            activeId: prev.activeId === id ? null : prev.activeId,
        }));
    }, []);

    useEffect(() => {
        if (resolveStatus.connected && resolveStatus.project) {
            refreshProjectContext();
        } else {
            setProjectContext(null);
            setImportedVideos([]);
        }
    }, [resolveStatus.connected, resolveStatus.project]);

    useEffect(() => {
        fetchTranscriptProjects();
    }, [fetchTranscriptProjects, projectId]);

    const handleReconnect = async () => {
        setShowReconnectHint(false);
        try {
            const res = await axios.post(`${API_BASE_URL}/api/reconnect`);
            if (res.data.connected) {
                setResolveStatus({
                    connected: true,
                    project: res.data.project
                });
                setWasConnected(true);
                stopStagedReconnect();
            } else {
                setResolveStatus({ connected: false, project: null });
                startStagedReconnect();
            }
        } catch (error) {
            setResolveStatus({ connected: false, project: null });
            startStagedReconnect();
        }
    };

    const handleProjectCreated = (data) => {
        setImportedVideos(data.imported_videos || []);
        refreshProjectContext();
    };

    const handleTranscriptReady = useCallback((data) => {
        const mapped = {
            videoPath: data.videoPath || '',
            transcript: data.transcript,
            transcriptId: data.transcriptId || null,
            sourceType: data.sourceType || 'file',
            originalFilename: data.originalFilename || (data.videoPath ? data.videoPath.split(/[/\\]/).pop() : ''),
            clipMapping: Array.isArray(data.clipMapping) ? data.clipMapping : null,
            frameRate: data.frameRate || 24,
        };
        setTranscriptWorkspace(prev => ({
            ...prev,
            transcriptData: mapped,
            activeTranscriptId: mapped.transcriptId || prev?.activeTranscriptId || null,
        }));
        fetchTranscriptProjects();
    }, [fetchTranscriptProjects]);

    const handleSubtitleReady = useCallback((data) => {
        setTranscriptWorkspace(prev => ({ ...prev, subtitleData: data }));
    }, []);

    const handleSubtitleDataChange = useCallback((data) => {
        setTranscriptWorkspace(prev => ({ ...prev, subtitleData: data }));
    }, []);

    const handleSubtitleWorkspaceChange = useCallback((draft) => {
        setTranscriptWorkspace(prev => ({ ...prev, subtitleDraft: draft }));
    }, []);

    const handleLoadTranscriptProject = useCallback(async (transcriptId) => {
        // null = 取消选择
        if (!transcriptId) {
            setTranscriptWorkspace(prev => ({
                ...prev,
                activeTranscriptId: null,
            }));
            return { ok: true };
        }
        try {
            const res = await axios.post(`${API_BASE_URL}/api/transcript/projects/${transcriptId}/load`);
            const data = res.data;
            const nextTranscriptData = data.transcript
                ? {
                    videoPath: data.metadata?.source_info?.audio_path || '',
                    transcript: data.transcript,
                    sourceType: data.metadata?.source_type || 'file',
                    originalFilename: data.metadata?.source_info?.original_filename || data.metadata?.name || '',
                    clipMapping: data.clip_mapping || null,
                    frameRate: data.metadata?.frame_rate || 24,
                    transcriptId,
                  }
                : null;

            setTranscriptWorkspace(prev => ({
                ...prev,
                activeTranscriptId: transcriptId,
                transcriptData: nextTranscriptData || prev.transcriptData,
                subtitleData: data.transcript?.segments || prev.subtitleData,
                subtitleDraft: {
                    ...(prev.subtitleDraft || {}),
                    videoPath: data.metadata?.source_info?.audio_path || '',
                    segments: data.transcript?.segments || [],
                    sourceType: data.metadata?.source_type || 'file',
                    clipMapping: data.clip_mapping || null,
                    originalFilename: data.metadata?.source_info?.original_filename || data.metadata?.name || '',
                    frameRate: data.metadata?.frame_rate || 24,
                    activeTranscriptId: transcriptId,
                },
            }));
            return { ok: true, data };
        } catch (error) {
            return {
                ok: false,
                error: error.response?.data?.detail || '加载转录项目失败',
            };
        }
    }, []);

    const handleDeleteTranscriptProject = useCallback(async (transcriptId) => {
        try {
            await axios.delete(`${API_BASE_URL}/api/transcript/projects/${transcriptId}`);
            setTranscriptWorkspace(prev => {
                const isDeletedProjectActive =
                    prev.activeTranscriptId === transcriptId ||
                    prev.transcriptData?.transcriptId === transcriptId ||
                    prev.subtitleDraft?.activeTranscriptId === transcriptId;

                if (!isDeletedProjectActive) return prev;
                return { ...DEFAULT_TRANSCRIPT_WORKSPACE };
            });
            handleDeleteTranscriptProjectMeta(transcriptId);
            fetchTranscriptProjects();
            return { ok: true };
        } catch (error) {
            return {
                ok: false,
                error: error.response?.data?.detail || '删除转录项目失败',
            };
        }
    }, [fetchTranscriptProjects, handleDeleteTranscriptProjectMeta]);

    // 切换转录项目
    const handleSwitchTranscriptProject = useCallback((id) => {
        setTranscriptProjectMeta(prev => ({ ...prev, activeId: id }));
        if (id) handleLoadTranscriptProject(id);
    }, [handleLoadTranscriptProject]);

    // 达芬奇项目切换时自动切换到绑定的转录项目
    useEffect(() => {
        autoSwitchDoneRef.current = false;
    }, [resolveStatus?.project]);

    useEffect(() => {
        if (!resolveStatus?.project) return;
        if (autoSwitchDoneRef.current) return;
        if (transcriptProjects.length === 0) return;
        const visible = mergedTranscriptProjects.filter(p => {
            if (p.bindingScope === 'global' || p.bindingScope === 'current') return true;
            if (p.bindingScope === 'project') return p.boundDavinciProject === resolveStatus.project;
            return !p.boundDavinciProject || p.boundDavinciProject === resolveStatus.project;
        });
        if (visible.length === 0) {
            autoSwitchDoneRef.current = true;
            // 当前项目无转录数据，清除残留的其他项目内容
            _workspaceCache = null;
            try { localStorage.removeItem(getTranscriptWorkspaceStorageKey(projectId)); } catch {}
            saveWorkspace(projectId, null).catch(() => {});
            setTranscriptWorkspace(prev => ({ ...prev, activeTranscriptId: null, transcriptData: null, subtitleData: null }));
            return;
        }
        const activeId = transcriptProjectMeta.activeId;
        if (activeId) {
            const active = visible.find(p => p.id === activeId);
            if (!active) {
                const bound = visible.find(p => p.bindingScope === 'project' && p.boundDavinciProject === resolveStatus.project);
                if (bound) {
                    handleSwitchTranscriptProject(bound.id);
                } else {
                    // 活跃转录不属于当前项目且无匹配项目可切换，清除残留内容
                    setTranscriptWorkspace(prev => ({ ...prev, activeTranscriptId: null, transcriptData: null, subtitleData: null }));
                }
            } else {
                handleLoadTranscriptProject(activeId);
            }
        } else {
            const bound = visible.find(p => p.bindingScope === 'project' && p.boundDavinciProject === resolveStatus.project);
            if (bound) handleSwitchTranscriptProject(bound.id);
        }
        autoSwitchDoneRef.current = true;
    }, [resolveStatus?.project, transcriptProjects.length]);

    // 当转录项目的绑定（全局/当前/特定项目）在管理页被修改时，
    // 若活跃转录不再匹配当前达芬奇项目，则清除残留内容
    useEffect(() => {
        if (!resolveStatus?.project) return;
        if (!transcriptProjectMeta.activeId) return;
        if (transcriptProjects.length === 0) return;
        const activeMeta = transcriptProjectMeta.projects?.find(p => p.id === transcriptProjectMeta.activeId);
        if (!activeMeta) return;
        const bindingScope = activeMeta.bindingScope || (activeMeta.isGlobal ? 'global' : 'project');
        if (bindingScope === 'global' || bindingScope === 'current') return;
        if (bindingScope === 'project' && activeMeta.boundDavinciProject === resolveStatus.project) return;
        // 活跃转录的绑定项目与当前达芬奇项目不匹配 → 清除内容
        _workspaceCache = null;
        try { localStorage.removeItem(getTranscriptWorkspaceStorageKey(projectId)); } catch {}
        saveWorkspace(projectId, null).catch(() => {});
        setTranscriptWorkspace(prev => ({ ...prev, activeTranscriptId: null, transcriptData: null, subtitleData: null }));
    }, [transcriptProjectMeta.projects, resolveStatus?.project, transcriptProjects.length]);

    const setThemeMode = (mode) => {
        setTheme(mode);
        localStorage.setItem('app-theme', mode);
        if (mode === 'auto') {
            const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
        } else {
            document.documentElement.setAttribute('data-theme', mode);
        }
    };

    const navBodyRef = useRef(null);
    const scrollThumbRef = useRef(null);
    const scrollTrackRef = useRef(null);
    const [isScrolling, setIsScrolling] = useState(false);
    const [isThumbVisible, setIsThumbVisible] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const scrollTimeoutRef = useRef(null);

    const updateScrollThumb = () => {
        if (!navBodyRef.current || !scrollThumbRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = navBodyRef.current;

        if (scrollHeight > clientHeight) {
            setIsThumbVisible(true);
            const scrollRatio = scrollTop / (scrollHeight - clientHeight);
            const thumbHeight = Math.max((clientHeight / scrollHeight) * clientHeight, 20);
            const maxThumbTop = clientHeight - thumbHeight;
            const thumbTop = scrollRatio * maxThumbTop;

            scrollThumbRef.current.style.height = `${thumbHeight}px`;
            scrollThumbRef.current.style.top = `${thumbTop}px`;
        } else {
            setIsThumbVisible(false);
        }
    };

    const handleScroll = () => {
        updateScrollThumb();
        setIsScrolling(true);
        if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
        scrollTimeoutRef.current = setTimeout(() => {
            if (!isDragging) setIsScrolling(false);
        }, 1000);
    };

    useEffect(() => {
        updateScrollThumb();
        window.addEventListener('resize', updateScrollThumb);
        return () => window.removeEventListener('resize', updateScrollThumb);
    }, [currentStep, searchQuery]);

    const handleThumbMouseDown = (e) => {
        e.preventDefault();
        setIsDragging(true);
        setIsScrolling(true);
        const startY = e.clientY;
        const startScrollTop = navBodyRef.current.scrollTop;
        const { scrollHeight, clientHeight } = navBodyRef.current;
        const maxThumbTop = clientHeight - parseFloat(scrollThumbRef.current.style.height);

        const handleMouseMove = (moveEvent) => {
            const deltaY = moveEvent.clientY - startY;
            const deltaScroll = (deltaY / maxThumbTop) * (scrollHeight - clientHeight);
            navBodyRef.current.scrollTop = startScrollTop + deltaScroll;
        };

        const handleMouseUp = () => {
            setIsDragging(false);
            if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
            scrollTimeoutRef.current = setTimeout(() => {
                setIsScrolling(false);
            }, 1000);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    };

    const viewVariants = {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 }
    };

    const isTauri = !!(window.__TAURI__ || window.__TAURI_INTERNALS__);

    const navGroups = [
        {
            label: "项目管理",
            items: [
                { id: 'setup', label: '项目初始化', icon: <Clapperboard size={18} />, color: '#0A84FF' },
                { id: 'folder_hierarchy', label: '文件层级管理', icon: <LayoutGrid size={18} />, color: '#5AC8FA' },
                { id: 'pack', label: '素材打包', icon: <Package size={18} />, color: '#FF9500' },
                { id: 'export', label: '导出与备份', icon: <FileVideo size={18} />, color: '#34C759' },
            ]
        },
        {
            label: "AI 工作流",
            items: [
                { id: 'subtitle', label: '音频转录', icon: <Subtitles size={18} />, color: '#AF52DE' },
                { id: 'autoedit', label: '文本剪辑', icon: <Scissors size={18} />, color: '#FF2D55' },
                { id: 'subtitle_edit', label: '字幕处理', icon: <FileText size={18} />, color: '#BF5AF2' },
            ]
        },
        {
            label: "实用工具",
            items: [
                { id: 'review_sync', label: '同步审阅', icon: <MessageSquare size={18} />, color: '#30D158' },
                { id: 'check', label: '时间线检查', icon: <CheckIcon size={18} />, color: '#FF9500' },
                { id: 'clip_import', label: '剪贴导入', icon: <ClipboardPaste size={18} />, color: '#0A84FF' },
            ]
        },
        {
            label: "系统",
            items: [
                { id: 'settings', label: '偏好设置', icon: <Settings size={18} />, color: '#8E8E93' },
            ]
        }
    ];

    useEffect(() => {
        if (resolveStatus.connected && resolveStatus.project) {
            setTranscriptWorkspace(prev => {
                if (prev.transcriptData || prev.subtitleData) return prev;
                return loadTranscriptWorkspace(projectId);
            });
            loadWorkspace(projectId).then(data => {
                if (data) {
                    setTranscriptWorkspace(prev => {
                        // prev 已有有效数据（同步 localStorage 或异步 handleLoadTranscriptProject 已恢复）则不覆盖
                        if (prev.transcriptData || prev.subtitleData) return prev;
                        return { ...DEFAULT_TRANSCRIPT_WORKSPACE, ...sanitizeTranscriptWorkspace(data) };
                    });
                }
            }).catch(() => {});
        } else {
            setTranscriptWorkspace({ ...DEFAULT_TRANSCRIPT_WORKSPACE });
        }
    }, [projectId, resolveStatus.connected, resolveStatus.project]);

    useEffect(() => {
        const data = transcriptWorkspace || DEFAULT_TRANSCRIPT_WORKSPACE;
        _workspaceCache = data;
        try { localStorage.setItem(getTranscriptWorkspaceStorageKey(projectId), JSON.stringify(data)); } catch {}
        saveWorkspace(projectId, data).catch(() => {});
    }, [projectId, transcriptWorkspace]);

    const getHeaderInfo = () => {
        const info = {
            'setup': { title: '项目初始化', desc: '选择素材路径后，我们将为您自动创建达芬奇项目及标准化的媒体池结构。' },
            'autoedit': { title: '文本剪辑', desc: '选取想要的转录片段，一键创建编辑时间线或追加到当前时间线。' },
            'folder_hierarchy': { title: '文件层级管理', desc: '查看媒体池文件夹层级，将深层素材展平到指定的保留层级。' },
            'pack': { title: '素材打包', desc: '勾选当前时间线指定的轨道素材，一键打包到目标目录。' },
            'subtitle': { title: '音频转录', desc: '本地语音转录引擎（字级时间戳），支持说话人分离、热词优化与文本剪辑。' },
            'subtitle_edit': { title: '字幕处理', desc: '支持快捷键 Enter 智能换行，点击插入到达芬奇当前时间线。' },
            'check': { title: '时间线检查', desc: '自动扫描当前时间线，检测离群片段、极短空隙及轨道异常情况。' },
            'sound_effects': { title: '音效管理', desc: '浏览音效库，拖拽音效到时间线。未使用的音效自动清理，已使用的自动归档到媒体池。' },
            'export': { title: '导出与备份', desc: '组合文件名模板，自动备份当前时间线并开始达芬奇渲染。' },
            'settings': { title: '偏好设置', desc: '配置全局依赖与第三方平台账号。目前为多用户隔离环境，各用户的配置独立保存。' },
            'review_sync': { title: '同步审阅', desc: '粘贴审阅分享链接，拉取带时间戳的审阅评论，对照时间线高效修改。' },
            'clip_import': { title: '剪贴导入', desc: '剪贴板图片自动导入到达芬奇媒体池' }
        };
        return info[currentStep] || { title: 'DaVinci 助手', desc: '' };
    };

    const headerInfo = (() => {
        if (currentStep === 'setup' && currentSubPage === 'local') {
            return { title: '本地文件结构', desc: '管理项目在硬盘上的实际文件夹目录。' };
        }
        if (currentStep === 'setup' && currentSubPage === 'davinci') {
            return { title: '达芬奇媒体池结构', desc: '管理导入到达芬奇内部的箱(Bin)结构。' };
        }
        if (currentStep === 'setup' && currentSubPage === 'mapping') {
            return { title: '导入映射规则', desc: '配置本地目录到媒体池的对应关系。' };
        }
        return getHeaderInfo();
    })();

    return (
        <div className="app-container main-workspace">
            <aside className="sidebar" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative', zIndex: 100 }}>
                <div className="sidebar-native-titlebar-spacer"></div>

                <div style={{ height: '80px', flexShrink: 0 }} />

                <div className="nav-body-container" style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    <nav
                        className="nav-body"
                        ref={navBodyRef}
                        onScroll={handleScroll}
                        style={{ flex: 1, overflowY: 'auto' }}
                    >
                        {navGroups.map((group, gIdx) => (
                            <div key={gIdx} className="nav-group">
                                <div className="nav-label">{group.label}</div>
                                {group.items.filter(item =>
                                    item.label.toLowerCase().includes(searchQuery.toLowerCase())
                                ).map((item) => (
                                    <div
                                        key={item.id}
                                        className={`nav-item ${currentStep === item.id ? 'active' : ''}`}
                                        onClick={() => handleStepChange(item.id)}
                                    >
                                        <span className="nav-icon" style={{
                                            color: currentStep === item.id ? item.color : 'var(--mac-text-secondary)',
                                            background: currentStep === item.id ? `${item.color}25` : 'rgba(128,128,128,0.08)',
                                            borderRadius: '6px',
                                            padding: '4px',
                                            transition: 'all 0.2s ease'
                                        }}>
                                            {item.icon}
                                        </span>
                                        <span style={{
                                            fontWeight: currentStep === item.id ? '600' : '500',
                                            color: currentStep === item.id ? 'var(--mac-text)' : 'var(--mac-text-secondary)',
                                            transition: 'color 0.2s ease'
                                        }}>
                                            {item.label}
                                        </span>
                                        {currentStep === item.id && <ChevronRight size={14} style={{ marginLeft: 'auto', opacity: 0.5, color: item.color }} />}
                                    </div>
                                ))}
                            </div>
                        ))}
                    </nav>

                    <div
                        className={`custom-scrollbar-track ${isThumbVisible ? 'visible' : 'hidden'}`}
                        ref={scrollTrackRef}
                        onMouseEnter={() => {
                            if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
                        }}
                        onMouseLeave={() => {
                            if (!isDragging) {
                                scrollTimeoutRef.current = setTimeout(() => setIsScrolling(false), 1000);
                            }
                        }}
                    >
                        <div
                            className={`custom-scrollbar-thumb ${isScrolling ? 'scrolling' : ''} ${isDragging ? 'dragging' : ''}`}
                            ref={scrollThumbRef}
                            onMouseDown={handleThumbMouseDown}
                        />
                    </div>
                </div>

                <div style={{ flexShrink: 0, padding: '0' }}>
                </div>
            </aside>

            <main className="main-content">
                <header className="header">
                    <div style={{ display: 'flex', alignItems: 'flex-start' }}>
                        <div className="nav-actions-container">
                            <button
                                className="nav-action-btn"
                                onClick={handleGoBack}
                                disabled={historyIndex <= 0}
                            >
                                <ChevronLeft size={16} strokeWidth={2.5} />
                            </button>
                            <button
                                className="nav-action-btn"
                                onClick={handleGoForward}
                                disabled={historyIndex >= history.length - 1}
                            >
                                <ChevronRight size={16} strokeWidth={2.5} />
                            </button>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <h1 style={{ fontSize: '15px', fontWeight: '600', margin: 0, color: 'var(--mac-text)' }}>{headerInfo.title}</h1>
                                <div id="global-nav-actions" style={{ display: 'flex', gap: '4px' }}>
                                </div>
                            </div>
                            {headerInfo.desc && <span style={{ fontSize: '11px', color: 'var(--mac-text-secondary)', fontWeight: '400', marginTop: '2px' }}>{headerInfo.desc}</span>}
                        </div>
                    </div>
                    <div id="page-header-actions" style={{ display: 'flex', alignItems: 'center' }}>
                    </div>
                </header>

                <div className="content-body">
                    <AnimatePresence mode="wait">
                            <motion.div
                            key={currentStep + (currentSubPage || '')}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            variants={viewVariants}
                            transition={{ duration: 0.12 }}
                            style={{ height: '100%', width: '100%', position: 'relative', display: 'flex', flexDirection: 'column' }}
                        >
                            {!showContent ? (
                                <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--mac-text-secondary)', fontSize: '12px' }}>
                                </div>
                            ) : (
                                <>
                                    {currentStep === 'setup' && !currentSubPage && (
                                        <ProjectSetup
                                            onProjectCreated={handleProjectCreated}
                                            apiBaseUrl={API_BASE_URL}
                                            projectId={projectId}
                                            projectContext={projectContext}
                                            onRefreshContext={refreshProjectContext}
                                            onNavigateToFolder={(page) => handleStepChange('setup', page)}
                                        />
                                    )}
                                    {currentStep === 'setup' && currentSubPage && (
                                        <FolderConfigGraph
                                            apiBaseUrl={API_BASE_URL}
                                            activePage={currentSubPage}
                                            setActivePage={(page) => handleStepChange('setup', page)}
                                        />
                                    )}
                                    {currentStep === 'autoedit' && (
                                        <AutoEditView
                                            key={`autoedit-${projectId}`}
                                            transcriptData={transcriptData}
                                            apiBaseUrl={API_BASE_URL}
                                            transcriptProjects={mergedTranscriptProjects}
                                            activeTranscriptId={activeTranscriptId}
                                            onLoadTranscriptProject={handleLoadTranscriptProject}
                                            onDeleteTranscriptProject={handleDeleteTranscriptProject}
                                            onRefreshTranscriptProjects={fetchTranscriptProjects}
                                            resolveStatus={resolveStatus}
                                            onUpdateTranscriptProjectMeta={handleUpdateTranscriptProjectMeta}
                                            onDeleteTranscriptProjectMeta={handleDeleteTranscriptProjectMeta}
                                            onSwitchTranscriptProject={handleSwitchTranscriptProject}
                                        />
                                    )}
                                    {currentStep === 'folder_hierarchy' && (
                                        <FileHierarchyManager
                                            apiBaseUrl={API_BASE_URL}
                                            resolveStatus={resolveStatus}
                                        />
                                    )}
                                    {currentStep === 'pack' && (
                                        <MaterialPackager apiBaseUrl={API_BASE_URL} resolveStatus={resolveStatus} />
                                    )}
                                    {currentStep === 'subtitle' && (
                                        <SubtitleGenerator
                                            key={`subtitle-${projectId}`}
                                            apiBaseUrl={API_BASE_URL}
                                            onSubtitleReady={handleSubtitleReady}
                                            onTranscriptReady={handleTranscriptReady}
                                            onWorkspaceStateChange={handleSubtitleWorkspaceChange}
                                            workspaceState={subtitleDraft}
                                            transcriptProjects={mergedTranscriptProjects}
                                            activeTranscriptId={activeTranscriptId}
                                            projectId={projectId}
                                        />
                                    )}
                                    {currentStep === 'subtitle_edit' && (
                                        <SubtitleEditorView
                                            key={`subtitle-edit-${projectId}`}
                                            subtitleData={subtitleData}
                                            transcriptSegments={transcriptData?.transcript?.segments || null}
                                            clipMapping={transcriptData?.clipMapping || null}
                                            sourceFrameRate={transcriptData?.frameRate || 24}
                                            sourceType={transcriptData?.sourceType || 'file'}
                                            apiBaseUrl={API_BASE_URL}
                                            setSubtitleData={handleSubtitleDataChange}
                                            transcriptProjects={mergedTranscriptProjects}
                                            activeTranscriptId={activeTranscriptId}
                                            onLoadTranscriptProject={handleLoadTranscriptProject}
                                            onDeleteTranscriptProject={handleDeleteTranscriptProject}
                                            onRefreshTranscriptProjects={fetchTranscriptProjects}
                                            projectId={projectId}
                                            resolveStatus={resolveStatus}
                                            onUpdateTranscriptProjectMeta={handleUpdateTranscriptProjectMeta}
                                            onDeleteTranscriptProjectMeta={handleDeleteTranscriptProjectMeta}
                                            onSwitchTranscriptProject={handleSwitchTranscriptProject}
                                        />
                                    )}
                                    {currentStep === 'check' && (
                                        <CheckView key={`check-${projectId}-${currentTimeline.name}`} apiBaseUrl={API_BASE_URL} projectId={projectId} timelineName={currentTimeline.name} />
                                    )}
                                    {currentStep === 'sound_effects' && (
                                        <SoundEffectsView apiBaseUrl={API_BASE_URL} projectContext={projectContext} resolveStatus={resolveStatus} />
                                    )}
                                    {currentStep === 'export' && (
                                        <ExportView key={`export-${projectId}`} apiBaseUrl={API_BASE_URL} projectId={projectId} projectContext={projectContext} resolveStatus={resolveStatus} hasTimeline={!!currentTimeline.name} onRefreshContext={refreshProjectContext} />
                                    )}
                                    {currentStep === 'review_sync' && (
                                        <ReviewSync apiBaseUrl={API_BASE_URL} resolveStatus={resolveStatus} />
                                    )}
                                    {currentStep === 'clip_import' && (
                                        <ClipImportView apiBaseUrl={API_BASE_URL} />
                                    )}
                                    {currentStep === 'settings' && (
                                        <SettingsView apiBaseUrl={API_BASE_URL} theme={theme} onThemeChange={setThemeMode} />
                                    )}
                                </>
                            )}
                        </motion.div>
                    </AnimatePresence>
                </div>

                <div style={{
                    height: '28px',
                    borderTop: '1px solid var(--mac-border)',
                    background: 'var(--mac-bg)',
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 16px',
                    fontSize: '11px',
                    color: 'var(--mac-text-secondary)',
                    gap: '16px',
                    flexShrink: 0,
                    position: 'relative'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1 }}>
                        <div style={{
                            width: '6px', height: '6px', borderRadius: '50%',
                            background: resolveStatus.connected ? '#34C759' : (wasConnected && reconnectTimerRef.current ? '#FF9500' : '#FF3B30'),
                            flexShrink: 0
                        }} />
                        <span style={{ fontWeight: '500', color: 'var(--mac-text)' }}>
                            {resolveStatus.connected ? (resolveStatus.project || '已连接') : (wasConnected && reconnectTimerRef.current ? '重新连接中...' : '未连接')}
                        </span>
                        {currentTimeline.name && (
                            <>
                                <span style={{ color: 'var(--mac-border)' }}>|</span>
                                <span>{currentTimeline.name}</span>
                                {currentTimeline.resolution && (
                                    <span style={{ fontSize: '10px', opacity: 0.7 }}>
                                        {currentTimeline.resolution.width}×{currentTimeline.resolution.height}
                                    </span>
                                )}
                            </>
                        )}
                    </div>
                    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                        <div
                            style={{
                                cursor: !resolveStatus.connected ? 'pointer' : 'default',
                                fontSize: '10px',
                                padding: '2px 8px',
                                borderRadius: '4px',
                                background: resolveStatus.connected ? 'rgba(52, 199, 89, 0.1)' : (wasConnected && reconnectTimerRef.current ? 'rgba(255, 149, 0, 0.1)' : 'rgba(255, 59, 48, 0.1)'),
                                color: resolveStatus.connected ? '#34C759' : (wasConnected && reconnectTimerRef.current ? '#FF9500' : '#FF3B30'),
                                transition: 'all 0.2s'
                            }}
                            onClick={!resolveStatus.connected ? handleReconnect : undefined}
                            title={!resolveStatus.connected ? '点击重新连接达芬奇' : undefined}
                        >
                            {resolveStatus.connected ? '在线' : (wasConnected && reconnectTimerRef.current ? '重连中' : '离线')}
                        </div>
                        <AnimatePresence>
                            {showReconnectHint && !resolveStatus.connected && (
                                <motion.div
                                    initial={{ opacity: 0, y: 4, scale: 0.95 }}
                                    animate={{ opacity: 1, y: 0, scale: 1 }}
                                    exit={{ opacity: 0, y: 4, scale: 0.95 }}
                                    transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                                    style={{
                                        position: 'absolute',
                                        bottom: 'calc(100% + 8px)',
                                        right: 0,
                                        background: 'var(--mac-bg)',
                                        border: '1px solid var(--mac-border)',
                                        borderRadius: '8px',
                                        padding: '8px 12px',
                                        fontSize: '12px',
                                        color: 'var(--mac-text)',
                                        whiteSpace: 'nowrap',
                                        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
                                        zIndex: 200,
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        pointerEvents: 'auto'
                                    }}
                                >
                                    <span style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        width: '18px', height: '18px',
                                        borderRadius: '50%',
                                        background: 'rgba(255, 149, 0, 0.15)',
                                        color: '#FF9500',
                                        fontSize: '11px',
                                        fontWeight: '600',
                                        flexShrink: 0
                                    }}>!</span>
                                    <span>点击「离线」可重新连接达芬奇</span>
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setShowReconnectHint(false);
                                            reconnectHintDismissedRef.current = true;
                                        }}
                                        style={{
                                            background: 'none',
                                            border: 'none',
                                            color: 'var(--mac-text-secondary)',
                                            cursor: 'pointer',
                                            fontSize: '14px',
                                            lineHeight: 1,
                                            padding: '0 2px',
                                            marginLeft: '2px'
                                        }}
                                    >×</button>
                                    <div style={{
                                        position: 'absolute',
                                        bottom: '-5px',
                                        right: '20px',
                                        width: 0,
                                        height: 0,
                                        borderLeft: '5px solid transparent',
                                        borderRight: '5px solid transparent',
                                        borderTop: '5px solid var(--mac-border)'
                                    }} />
                                    <div style={{
                                        position: 'absolute',
                                        bottom: '-4px',
                                        right: '20px',
                                        width: 0,
                                        height: 0,
                                        borderLeft: '5px solid transparent',
                                        borderRight: '5px solid transparent',
                                        borderTop: '5px solid var(--mac-bg)'
                                    }} />
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </div>
            </main>
        </div>
    );
}
