import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { FileText, Download, Monitor, CheckCircle2, AlertTriangle, Loader2, Gauge, Activity, ChevronDown, ChevronUp, RefreshCcw, FolderOpen, X, MapPin, Search, Save } from 'lucide-react';
import { TranscriptProjectTabs, TranscriptBindingToggle, TranscriptProjectManager } from './TranscriptProjectManager';

function ToggleSwitch({ checked, onChange, loading = false, color = '#FF9500' }) {
    return (
        <div
            onClick={() => !loading && onChange(!checked)}
            style={{
                width: 44, height: 24, borderRadius: 12,
                cursor: loading ? 'wait' : 'pointer',
                background: checked ? color : 'transparent',
                border: checked ? `1px solid ${color}` : '1px solid var(--mac-border)',
                boxSizing: 'border-box',
                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                position: 'relative', flexShrink: 0,
                boxShadow: checked ? `0 0 8px ${color}40` : 'none',
                opacity: loading ? 0.7 : 1
            }}
        >
            <div style={{
                width: 20, height: 20, borderRadius: 10,
                background: '#FFF', position: 'absolute', top: '50%', transform: 'translateY(-50%)',
                left: checked ? 20 : 2,
                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
            }} />
        </div>
    );
}

function SubtitleEditorView({
    subtitleData,
    transcriptSegments,
    clipMapping,
    sourceFrameRate,
    sourceType,
    apiBaseUrl,
    setSubtitleData,
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
    const safeSubtitleData = Array.isArray(subtitleData) ? subtitleData : [];
    const fullTranscriptSegments = Array.isArray(transcriptSegments) && transcriptSegments.length > 0
        ? transcriptSegments : safeSubtitleData;
    const hasClipMapping = Array.isArray(clipMapping) && clipMapping.length > 0;
    const [frameRate, setFrameRate] = useState(24);
    const [message, setMessage] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [syncLoading, setSyncLoading] = useState(false);
    const [saveLoading, setSaveLoading] = useState(false);

    // 搜索替换相关状态
    const [searchVisible, setSearchVisible] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [replaceText, setReplaceText] = useState('');
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
    const [replaceSnapshot, setReplaceSnapshot] = useState(null);
    const [minGapSec, setMinGapSec] = useState(1.0);
    const [manageMode, setManageMode] = useState(false);
    const [timeFormat, setTimeFormat] = useState('timecode');
    const searchInputRef = useRef(null);
    const matchRowRefs = useRef({});

    // 自动同步字幕相关状态
    const [speedMatchEnabled, setSpeedMatchEnabled] = useState(false);
    const [speedMatchActive, setSpeedMatchActive] = useState(false);
    const [speedMatchLoading, setSpeedMatchLoading] = useState(false);
    const [speedMatchMessage, setSpeedMatchMessage] = useState(null);
    const [selectedTrack, setSelectedTrack] = useState({ type: 'audio', index: 1 });
    const [availableTracks, setAvailableTracks] = useState([]);
    const [trackListLoading, setTrackListLoading] = useState(false);
    const [trackerLogs, setTrackerLogs] = useState([]);
    const [trackDropdownOpen, setTrackDropdownOpen] = useState(false);
    const trackDropdownRef = useRef(null);
    const pollTimerRef = useRef(null);
    const pollInFlightRef = useRef(false);
    const speedMatchActiveRef = useRef(false);
    const subtitleDataRef = useRef(subtitleData);

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

    // 保持 ref 同步
    useEffect(() => {
        subtitleDataRef.current = safeSubtitleData;
    }, [safeSubtitleData]);

    useEffect(() => {
        speedMatchActiveRef.current = speedMatchActive;
    }, [speedMatchActive]);

    const formatTime = (seconds) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.round((seconds % 1) * 1000);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    };

    const formatTimeShort = (seconds) => {
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.round((seconds % 1) * 100);
        return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
    };

    const formatTimecode = (seconds) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const f = Math.round((seconds % 1) * frameRate);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
    };

    const fetchAudioTracks = useCallback(async () => {
        setTrackListLoading(true);
        try {
            const tracksRes = await axios.get(`${apiBaseUrl}/api/subtitle/speed-match/tracks`);
            if (tracksRes.data.status === 'success') {
                const tracks = tracksRes.data.tracks || [];
                setAvailableTracks(tracks);
                return tracks;
            }
            return [];
        } catch (e) {
            throw new Error(e.response?.data?.detail || '无法获取音频轨道列表');
        } finally {
            setTrackListLoading(false);
        }
    }, [apiBaseUrl]);

    const startSpeedMatchTracking = useCallback(async (trackOverride = null) => {
        setSpeedMatchEnabled(true);
        setSpeedMatchLoading(true);
        setError(null);
        pollInFlightRef.current = false;
        if (pollTimerRef.current) {
            clearTimeout(pollTimerRef.current);
            pollTimerRef.current = null;
        }

        try {
            const [fetchRes, tracks] = await Promise.all([
                axios.get(`${apiBaseUrl}/api/subtitle/fetch-from-resolve`),
                fetchAudioTracks(),
            ]);

            if (!(fetchRes.data.status === 'success' && fetchRes.data.segments?.length > 0)) {
                throw new Error('时间线上未找到字幕轨道，请先将字幕插入到达芬奇时间线');
            }

            if (fetchRes.data.fps) setFrameRate(fetchRes.data.fps);
            if (!tracks || tracks.length === 0) {
                throw new Error('当前时间线上没有找到音频轨道');
            }

            const davinciSubtitles = fetchRes.data.segments || [];
            const currentEditedSegments = Array.isArray(subtitleDataRef.current) ? subtitleDataRef.current : [];
            const currentSubtitles = currentEditedSegments.length > 0
                ? davinciSubtitles.map(dvSeg => {
                    const userSeg = currentEditedSegments.find(s =>
                        Math.abs(s.start - dvSeg.start) < 0.5 && Math.abs(s.end - dvSeg.end) < 0.5
                    );
                    return userSeg ? { ...dvSeg, text: userSeg.text } : dvSeg;
                })
                : davinciSubtitles;
            setSubtitleData(currentSubtitles);

            const bestTrack = tracks.reduce((best, t) => (t.clip_count > best.clip_count ? t : best), tracks[0]);
            const preferredTrack = trackOverride || selectedTrack;
            const chosenTrack = tracks.find(
                t => (t.track_type || 'audio') === (preferredTrack?.type || 'audio') && t.track_index === preferredTrack?.index
            ) || bestTrack;

            const nextSelectedTrack = {
                type: chosenTrack.track_type || 'audio',
                index: chosenTrack.track_index,
            };
            setSelectedTrack(nextSelectedTrack);

            const startRes = await axios.post(`${apiBaseUrl}/api/subtitle/speed-match/start`, {
                track_type: nextSelectedTrack.type,
                track_index: nextSelectedTrack.index,
                segments: currentSubtitles,
                frame_rate: fetchRes.data.fps || frameRate,
            });

            if (startRes.data.status !== 'success') {
                throw new Error(startRes.data.message || '启动自动同步字幕失败');
            }

            setSpeedMatchActive(true);
            setSpeedMatchEnabled(true);
        } catch (e) {
            setError(e.response?.data?.detail || e.message || '启动自动同步字幕失败');
            setSpeedMatchEnabled(false);
            setSpeedMatchActive(false);
        } finally {
            setSpeedMatchLoading(false);
        }
    }, [apiBaseUrl, fetchAudioTracks, frameRate, selectedTrack, setSubtitleData]);

    const exportSRT = () => safeSubtitleData.map((seg, idx) => `${idx + 1}\n${formatTime(seg.start)} --> ${formatTime(seg.end)}\n${seg.text || ''}\n`).join('\n');
    
    const copyToClipboard = () => { 
        navigator.clipboard.writeText(exportSRT()); 
        setMessage('SRT 已复制到剪贴板'); 
        setTimeout(() => setMessage(null), 3000);
    };

    const downloadSRT = () => {
        const activeProject = transcriptProjects.find(p => p.id === activeTranscriptId);
        const projectName = activeProject?.name || 'subtitle';
        const safeName = projectName.replace(/[\\/:*?"<>|]/g, '_');
        const blob = new Blob([exportSRT()], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${safeName}.srt`; a.click();
        URL.revokeObjectURL(url);
    };

    const handleSegmentChange = (idx, field, value) => {
        const newSegments = [...subtitleData]; 
        newSegments[idx] = { ...newSegments[idx], [field]: value }; 
        setSubtitleData(newSegments);
    };

    const handleDeleteSegment = (idx) => {
        setSubtitleData(subtitleData.filter((_, i) => i !== idx));
    };

    const handleMergeWithPrevious = (idx) => {
        if (idx <= 0 || idx >= subtitleData.length) return;
        const prev = { ...subtitleData[idx - 1] };
        const current = { ...subtitleData[idx] };

        const mergedText = ((prev.text || '').trim() + ' ' + (current.text || '').trim()).trim();

        const merged = {
            ...prev,
            end: current.end,
            text: mergedText,
        };

        if (Array.isArray(prev.words) && Array.isArray(current.words)) {
            merged.words = [...prev.words, ...current.words];
        } else if (Array.isArray(prev.words)) {
            merged.words = prev.words;
        }

        const newSegments = [...subtitleData];
        newSegments.splice(idx - 1, 2, merged);
        setSubtitleData(newSegments);
    };

    const handleLocateSegment = async (seg) => {
        setError(null);
        try {
            const frame = Math.round((seg.start || 0) * frameRate);
            await axios.post(`${apiBaseUrl}/api/timeline/locate`, { frame });
            // 定位成功无声提示，避免干扰用户注意力
        } catch (e) {
            const detail = e.response?.data?.detail;
            const errMsg = typeof detail === 'string' ? detail
                : Array.isArray(detail) ? detail.map(d => d.msg || '').join('; ')
                : '定位失败';
            setError(errMsg || '定位失败');
        }
    };

    // 智能换行与向上合并逻辑
    const handleKeyDown = (e, idx) => {
        // Backspace 在文本开头 → 向上合并
        if (e.key === 'Backspace') {
            const input = e.target;
            if (input.selectionStart === 0 && input.selectionEnd === 0 && idx > 0) {
                e.preventDefault();
                handleMergeWithPrevious(idx);
                return;
            }
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            const input = e.target;
            const cursorPosition = input.selectionStart;
            const originalText = subtitleData[idx].text;
            
            if (cursorPosition === 0 || cursorPosition === originalText.length) return;
            
            const part1 = originalText.substring(0, cursorPosition).trim();
            const part2 = originalText.substring(cursorPosition).trim();
            
            if (!part1 || !part2) return;

            const segment = subtitleData[idx];
            let splitTime = segment.start + (segment.end - segment.start) * (part1.length / originalText.length);

            if (segment.words && segment.words.length > 0) {
                let charCount = 0;
                for (let i = 0; i < segment.words.length; i++) {
                    charCount += segment.words[i].word.length;
                    if (charCount >= part1.length) {
                        splitTime = segment.words[i].end;
                        break;
                    }
                }
            }

            const newSeg1 = { ...segment, end: splitTime, text: part1 };
            const newSeg2 = { ...segment, start: splitTime, text: part2 };
            
            if (segment.words && segment.words.length > 0) {
                const words1 = [];
                const words2 = [];
                for (let i = 0; i < segment.words.length; i++) {
                    if (segment.words[i].end <= splitTime + 0.01) {
                        words1.push(segment.words[i]);
                    } else {
                        words2.push(segment.words[i]);
                    }
                }
                newSeg1.words = words1;
                newSeg2.words = words2;
            }

            const newSegments = [...subtitleData];
            newSegments.splice(idx, 1, newSeg1, newSeg2);
            setSubtitleData(newSegments);
        }
    };

    const handleInsertTimeline = async () => {
        setLoading(true);
        setError(null);
        setMessage(null);
        try {
            // 直接插入当前页面显示的字幕数据（可能已被同步预览修改过位置）
            const res = await axios.post(`${apiBaseUrl}/api/subtitle/insert-timeline`, {
                segments: safeSubtitleData,
            });
            if (res.data.status === 'success' || res.data.mode === 'mock') {
                setMessage(`字幕已插入时间线！共 ${safeSubtitleData.length} 条`);
                setTimeout(() => setMessage(null), 3000);
            } else if (res.data.status === 'partial') {
                // 自动导入未成功，SRT 文件已保存
                setError(`自动导入未成功。${res.data.manual_instructions || `SRT 文件已保存到：${res.data.srt_path}`}`);
            } else {
                setError(res.data.message);
            }
        } catch (e) {
            const detail = e.response?.data?.detail;
            const errMsg = typeof detail === 'string' ? detail
                : Array.isArray(detail) ? detail.map(d => d.msg || '').join('; ')
                : e.message || '插入字幕失败';
            setError(errMsg);
        } finally {
            setLoading(false);
        }
    };

    const handleSyncPreview = async () => {
        if (!hasClipMapping) return;
        setSyncLoading(true);
        setError(null);
        try {
            const res = await axios.post(`${apiBaseUrl}/api/subtitle/sync-timeline`, {
                segments: fullTranscriptSegments,
                clip_mapping: clipMapping,
                source_type: sourceType || 'file',
                frame_rate: sourceFrameRate || frameRate,
                dry_run: true,
                transcript_id: activeTranscriptId || '',
                track_type: 'audio',
                track_index: 1,
                min_gap_sec: minGapSec,
            });
            const merged = res.data.merged_segments || res.data.synced_segments;
            if (merged?.length > 0) {
                setSubtitleData(merged);
                const existCount = res.data.existing_count || 0;
                const gapCount = res.data.synced_count || 0;
                setMessage(`同步完成: 保留 ${existCount} 条已有字幕，补缺 ${gapCount} 条 (共 ${merged.length} 条)，请检查预览后插入`);
                setTimeout(() => setMessage(null), 5000);
            } else {
                setMessage(res.data.message || '未找到匹配的时间线片段');
                setTimeout(() => setMessage(null), 3000);
            }
        } catch (e) {
            setError(e.response?.data?.detail || '同步预览失败');
        } finally {
            setSyncLoading(false);
        }
    };

    const handleFetchFromDaVinci = async () => {
        setLoading(true);
        setError(null);
        setMessage(null);
        try {
            const res = await axios.get(`${apiBaseUrl}/api/subtitle/fetch-from-resolve`);
            if (res.data.status === 'success' && res.data.segments?.length > 0) {
                setSubtitleData(res.data.segments);
                if (res.data.fps) setFrameRate(res.data.fps);
                setMessage(`成功从达芬奇获取 ${res.data.count} 条字幕！`);
                setTimeout(() => setMessage(null), 3000);
            } else {
                setError('时间线上未找到字幕');
            }
        } catch (e) {
            setError(e.response?.data?.detail || '从达芬奇获取字幕失败');
        } finally {
            setLoading(false);
        }
    };

    const handleSaveSubtitleProject = async () => {
        if (!activeTranscriptId) {
            setError('请先选择一个转录项目，再保存字幕修改');
            return;
        }
        setSaveLoading(true);
        setError(null);
        setMessage(null);
        try {
            const res = await axios.put(`${apiBaseUrl}/api/transcript/projects/${activeTranscriptId}`, {
                segments: safeSubtitleData,
            });
            setMessage(res.data?.message || `已保存 ${safeSubtitleData.length} 条字幕`);
            onRefreshTranscriptProjects?.();
            setTimeout(() => setMessage(null), 3000);
        } catch (e) {
            setError(e.response?.data?.detail || '保存字幕修改失败');
        } finally {
            setSaveLoading(false);
        }
    };

    const handleImportLocal = async () => {
        try {
            let content = '';
            // 尝试 Tauri 原生文件对话框
            try {
                const { open } = await import('@tauri-apps/plugin-dialog');
                const selected = await open({
                    multiple: false,
                    filters: [{ name: 'SRT 字幕', extensions: ['srt'] }],
                });
                if (selected) {
                    const { readTextFile } = await import('@tauri-apps/plugin-fs');
                    content = await readTextFile(selected);
                }
            } catch {
                // Tauri API 不可用时降级到浏览器 FileReader
                content = await new Promise((resolve, reject) => {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = '.srt';
                    input.onchange = (e) => {
                        const file = e.target.files[0];
                        if (file) {
                            const reader = new FileReader();
                            reader.onload = () => resolve(reader.result);
                            reader.onerror = reject;
                            reader.readAsText(file);
                        } else {
                            resolve('');
                        }
                    };
                    input.click();
                    setTimeout(() => { if (!content) resolve(''); }, 30000);
                });
            }
            if (!content) return;

            const blocks = content.trim().split(/\n\s*\n/);
            const parsed = blocks.map(block => {
                const lines = block.split('\n').map(l => l.trim()).filter(l => l);
                if (lines.length >= 3) {
                    const times = lines[1].split('-->').map(t => t.trim());
                    if (times.length !== 2) return null;
                    const parseTime = (timeStr) => {
                        const parts = timeStr.split(/[:,]/);
                        if (parts.length === 4) {
                            return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]) + parseInt(parts[3]) / 1000;
                        }
                        return 0;
                    };
                    const start = parseTime(times[0]);
                    const end = parseTime(times[1]);
                    const text = lines.slice(2).join('\n');
                    return { start, end, text };
                }
                return null;
            }).filter(b => b !== null);

            if (parsed.length > 0) {
                setSubtitleData(parsed);
                setMessage(`成功导入 ${parsed.length} 条字幕！`);
                // 导入本地字幕后取消转录项目选择
                if (onLoadTranscriptProject) {
                    onLoadTranscriptProject(null);
                }
                setTimeout(() => setMessage(null), 3000);
            } else {
                setError('解析 SRT 文件失败，未找到有效字幕段落。');
            }
        } catch (err) {
            setError('解析 SRT 文件失败，请检查文件格式。');
        }
    };

    // ==================== 自动同步字幕逻辑 ====================

    // 检查追踪状态
    const checkSpeedMatchStatus = useCallback(async () => {
        try {
            const res = await axios.get(`${apiBaseUrl}/api/subtitle/speed-match/status`);
            setSpeedMatchActive(res.data.active === true);
            setSpeedMatchEnabled(res.data.active === true);
            if (res.data.active) {
                setSelectedTrack({
                    type: res.data.track_type || 'audio',
                    index: res.data.track_index || 1,
                });
            }
        } catch (e) {
            setSpeedMatchActive(false);
        }
    }, [apiBaseUrl]);

    // 停止自动同步字幕
    const handleStopSpeedMatch = async () => {
        try {
            await axios.post(`${apiBaseUrl}/api/subtitle/speed-match/stop`);
            setSpeedMatchActive(false);
            setSpeedMatchEnabled(false);
            setSpeedMatchMessage('自动同步字幕已停止');
            if (pollTimerRef.current) {
                clearTimeout(pollTimerRef.current);
                pollTimerRef.current = null;
            }
            setTimeout(() => setSpeedMatchMessage(null), 3000);
        } catch (e) {
            console.warn('停止自动同步字幕失败', e);
        }
    };

    // 轮询快照对比
    const pollSnapshot = useCallback(async () => {
        const currentData = Array.isArray(subtitleDataRef.current) ? subtitleDataRef.current : [];
        if (!currentData || currentData.length === 0 || pollInFlightRef.current) return;
        pollInFlightRef.current = true;
        try {
            const res = await axios.post(`${apiBaseUrl}/api/subtitle/speed-match/poll`, {
                segments: currentData,
            });

            // 更新日志
            if (res.data.logs && res.data.logs.length > 0) {
                setTrackerLogs(prev => {
                    const newLogs = res.data.logs;
                    // 去重合并
                    const seen = new Set(prev.map(l => l.timestamp + l.message));
                    const merged = [...prev, ...newLogs.filter(l => !seen.has(l.timestamp + l.message))];
                    return merged.slice(-100);
                });
            }

            const nextSegments = res.data.updated_segments || res.data.timeline_subtitles;
            if (res.data.has_changes && nextSegments) {
                console.log('[poll] 收到更新:', res.data.change_log);
                console.log('[poll] 更新前:', subtitleDataRef.current?.map(s => `${s.start.toFixed(2)}-${s.end.toFixed(2)}`).slice(0, 5));
                setSubtitleData(nextSegments);
                console.log('[poll] 更新后:', nextSegments?.map(s => `${s.start.toFixed(2)}-${s.end.toFixed(2)}`).slice(0, 5));
                // 对齐校验的常规修复不再弹 message，避免页面周期性跳动
                // 只有真正的变化检测（非 realign）才显示提示
                if (res.data.message && !res.data.message.includes('对齐校验')) {
                    setSpeedMatchMessage(res.data.message);
                    setTimeout(() => setSpeedMatchMessage(null), 4000);
                }
            }
        } catch (e) {
            // 静默失败，避免干扰用户
            console.warn('轮询快照对比失败', e);
        } finally {
            pollInFlightRef.current = false;
            if (speedMatchActiveRef.current) {
                if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
                pollTimerRef.current = setTimeout(pollSnapshot, 100);
            }
        }
    }, [apiBaseUrl, setSubtitleData]);

    // 开关自动同步字幕 — 一键自动流程
    const handleToggleSpeedMatch = async (enabled) => {
        if (enabled) {
            await startSpeedMatchTracking(selectedTrack);
        } else {
            // 关闭：立即停止追踪
            if (speedMatchActive) {
                await handleStopSpeedMatch();
            }
            setSpeedMatchEnabled(false);
        }
    };

    // 自动同步字幕开启后，启动轮询
    useEffect(() => {
        if (speedMatchActive) {
            // 立即执行一次
            pollSnapshot();
        } else {
            if (pollTimerRef.current) {
                clearTimeout(pollTimerRef.current);
                pollTimerRef.current = null;
            }
        }

        return () => {
            if (pollTimerRef.current) {
                clearTimeout(pollTimerRef.current);
                pollTimerRef.current = null;
            }
        };
    }, [speedMatchActive, pollSnapshot]);

    // 组件挂载时检查状态
    useEffect(() => {
        checkSpeedMatchStatus();
        fetchAudioTracks().catch(() => {});
    }, [checkSpeedMatchStatus, fetchAudioTracks]);

    // 组件卸载时停止追踪
    useEffect(() => {
        return () => {
            if (speedMatchActive) {
                axios.post(`${apiBaseUrl}/api/subtitle/speed-match/stop`).catch(() => {});
            }
        };
    }, []);

    const selectedTrackValue = `${selectedTrack.type || 'audio'}:${selectedTrack.index || 1}`;

    // 点击外部关闭轨道下拉菜单
    useEffect(() => {
        if (!trackDropdownOpen) return;
        const handleClickOutside = (e) => {
            if (trackDropdownRef.current && !trackDropdownRef.current.contains(e.target)) {
                setTrackDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [trackDropdownOpen]);

    // Ctrl+F / Cmd+F 搜索替换快捷键
    useEffect(() => {
        const handleKeyDown = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                setSearchVisible(true);
                setTimeout(() => searchInputRef.current?.focus(), 50);
            }
            if (e.key === 'Escape' && searchVisible) {
                setSearchVisible(false);
                setSearchQuery('');
                setReplaceText('');
                setReplaceSnapshot(null);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [searchVisible]);

    // ==================== 搜索匹配工具函数 ====================

    const buildSearchRegex = (query, caseSensitive, wholeWord) => {
        if (!query) return null;
        let pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (wholeWord) {
            pattern = '(?<![\\w\\u4e00-\\u9fff])' + pattern + '(?![\\w\\u4e00-\\u9fff])';
        }
        const flags = caseSensitive ? 'g' : 'gi';
        try {
            return new RegExp(pattern, flags);
        } catch {
            return null;
        }
    };

    const getMatchIndices = (segments, regex) => {
        if (!regex) return [];
        return segments.reduce((acc, seg, idx) => {
            if (regex.test(seg.text || '')) {
                regex.lastIndex = 0;
                acc.push(idx);
            }
            return acc;
        }, []);
    };

    const splitTextByMatch = (text, query, caseSensitive) => {
        if (!query || !text) return [{ text, highlight: false }];
        const flags = caseSensitive ? 'g' : 'gi';
        const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${pattern})`, flags);
        const parts = [];
        let lastIndex = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
            if (match.index > lastIndex) {
                parts.push({ text: text.slice(lastIndex, match.index), highlight: false });
            }
            parts.push({ text: match[1], highlight: true });
            lastIndex = regex.lastIndex;
            if (match[0].length === 0) regex.lastIndex++;
        }
        if (lastIndex < text.length) {
            parts.push({ text: text.slice(lastIndex), highlight: false });
        }
        return parts.length > 0 ? parts : [{ text, highlight: false }];
    };

    const searchRegexForRender = searchVisible ? buildSearchRegex(searchQuery, caseSensitive, wholeWord) : null;
    const matchIndicesForRender = searchVisible ? getMatchIndices(safeSubtitleData, searchRegexForRender) : [];
    const safeCurrentIndexForRender = matchIndicesForRender.length > 0 ? Math.min(currentMatchIndex, matchIndicesForRender.length - 1) : 0;
    const filteredSubtitleData = searchVisible && searchQuery
        ? safeSubtitleData.filter((_, idx) => matchIndicesForRender.includes(idx))
        : safeSubtitleData;

    return (
        <div className="page-panel" style={{ padding: '24px 0 0', display: 'flex', flexDirection: 'column', height: '100%' }}>
            {!manageMode && (
                <div style={{ padding: '0 20px', flexShrink: 0 }}>
                    <div className="mac-settings-section" style={{ marginBottom: '12px' }}>
                        <div className="mac-settings-title">转录项目</div>
                        <div className="mac-settings-group" style={{ padding: '12px 14px' }}>
                            <TranscriptProjectTabs
                                projects={transcriptProjects}
                                activeId={activeTranscriptId}
                                resolveStatus={resolveStatus}
                                disabled={speedMatchActive || speedMatchLoading}
                                disabledReason="自动同步字幕运行中，请先关闭后再切换项目"
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
                </div>
            )}
            {manageMode && (
                <div style={{ padding: '0 20px', flex: 1, overflowY: 'auto' }}>
                    <TranscriptProjectManager
                        projects={transcriptProjects}
                        resolveStatus={resolveStatus}
                        onUpdate={onUpdateTranscriptProjectMeta}
                        onDelete={onDeleteTranscriptProjectMeta}
                        onBack={() => setManageMode(false)}
                    />
                </div>
            )}
            {!manageMode && (
            <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {/* 顶部工具栏 */}
            <div style={{ padding: '10px 20px 16px', background: 'var(--mac-bg)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
                    {/* 两排统一使用 4 列 Grid，完美对齐 */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: '8px', width: '100%' }}>
                        <button className="mac-btn" onClick={handleFetchFromDaVinci} style={{ fontSize: '12px', padding: '8px 0', gap: '6px', height: '36px', justifyContent: 'center', background: 'rgba(255,255,255,0.06)' }}>
                            <Monitor size={13} /> 从达芬奇拉取
                        </button>
                        <button className="mac-btn" onClick={handleImportLocal} style={{ fontSize: '12px', padding: '8px 0', gap: '6px', height: '36px', justifyContent: 'center', background: 'rgba(255,255,255,0.06)' }}>
                            <FileText size={13} /> 导入本地字幕
                        </button>
                        <button className="mac-btn" onClick={handleSaveSubtitleProject} disabled={saveLoading || safeSubtitleData.length === 0 || !activeTranscriptId} style={{ fontSize: '12px', padding: '8px 0', gap: '6px', height: '36px', justifyContent: 'center', background: 'rgba(255,255,255,0.06)' }}>
                            {saveLoading ? <Loader2 size={13} className="spin" /> : <Save size={13} />} 保存修改
                        </button>
                        <button className="mac-btn" onClick={() => { setSearchVisible(true); setTimeout(() => searchInputRef.current?.focus(), 50); }} style={{ fontSize: '12px', padding: '8px 0', gap: '6px', height: '36px', justifyContent: 'center', background: 'rgba(255,255,255,0.06)' }}>
                            <Search size={13} /> 查找替换
                        </button>
                        <button className="mac-btn" onClick={downloadSRT} disabled={safeSubtitleData.length === 0} style={{ fontSize: '12px', padding: '8px 0', gap: '6px', height: '36px', justifyContent: 'center', background: 'rgba(255,255,255,0.06)' }}>
                            <Download size={13} /> 下载 SRT
                        </button>
                    </div>
                    {hasClipMapping && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '8px', width: '100%', alignItems: 'center' }}>
                        <div style={{ gridColumn: '1 / 3', display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'center', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: '1px solid var(--mac-border)', height: '36px', padding: '0 8px' }}>
                            <span style={{ fontSize: '11px', color: 'var(--mac-text-secondary)', whiteSpace: 'nowrap' }}>间隔</span>
                            <input type="range" min="0" max="5" step="0.1" value={minGapSec} onChange={(e) => setMinGapSec(parseFloat(e.target.value))} style={{ flex: 1, minWidth: 0, height: '4px', accentColor: 'var(--mac-accent)' }} />
                            <span style={{ fontSize: '11px', color: 'var(--mac-text-secondary)', minWidth: '28px', fontVariantNumeric: 'tabular-nums' }}>{minGapSec.toFixed(1)}s</span>
                        </div>
                        <button className="mac-btn" onClick={handleSyncPreview} disabled={syncLoading} style={{ fontSize: '12px', padding: '8px 0', gap: '6px', height: '36px', justifyContent: 'center', background: 'rgba(255,255,255,0.06)' }}>
                            {syncLoading ? <Loader2 size={13} className="spin" /> : <RefreshCcw size={13} />} 同步时间线
                        </button>
                        <button className="mac-btn primary" onClick={handleInsertTimeline} disabled={loading || safeSubtitleData.length === 0} style={{ fontSize: '12px', padding: '8px 0', gap: '6px', height: '36px', fontWeight: 600, justifyContent: 'center' }}>
                            {loading ? <Loader2 size={13} className="spin" /> : <Monitor size={13} />} {loading ? '插入中...' : '插入字幕'}
                        </button>
                    </div>
                    )}
                    {!hasClipMapping && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '8px', width: '100%' }}>
                        <button className="mac-btn primary" onClick={handleInsertTimeline} disabled={loading || safeSubtitleData.length === 0} style={{ gridColumn: '1 / -1', fontSize: '12px', padding: '8px 0', gap: '6px', height: '36px', fontWeight: 600, justifyContent: 'center' }}>
                            {loading ? <Loader2 size={13} className="spin" /> : <Monitor size={13} />} {loading ? '插入中...' : '插入字幕'}
                        </button>
                    </div>
                    )}
                </div>
            </div>

            {/* 提示信息 */}
            <div style={{ padding: '0 20px' }}>
                {message && <div style={{ background: 'rgba(52, 199, 89, 0.1)', color: '#34C759', padding: '9px 12px', borderRadius: '12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', margin: '10px 0 8px' }}><CheckCircle2 size={14} /> {message}</div>}
                {error && <div style={{ background: 'rgba(255, 59, 48, 0.1)', color: '#FF3B30', padding: '9px 12px', borderRadius: '12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', margin: '10px 0 8px' }}><AlertTriangle size={14} /> {error}</div>}
            </div>

            {/* 自动同步字幕面板 */}
            <div style={{ padding: '0 20px' }}>
                <div style={{
                    background: speedMatchActive
                        ? 'linear-gradient(180deg, rgba(10, 132, 255, 0.06), rgba(10, 132, 255, 0.02))'
                        : 'var(--mac-surface-solid)',
                    borderRadius: '16px',
                    border: `1px solid ${speedMatchActive ? 'rgba(10, 132, 255, 0.18)' : 'var(--mac-border)'}`,
                    padding: '16px 18px',
                    marginBottom: '8px',
                    boxShadow: speedMatchActive
                        ? '0 2px 16px rgba(10,132,255,0.06), 0 0 0 1px rgba(10,132,255,0.04)'
                        : '0 1px 3px rgba(0,0,0,0.04), 0 0 0 1px rgba(0,0,0,0.02)',
                    transition: 'background 0.3s ease, border-color 0.3s ease, box-shadow 0.3s ease',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                            <div style={{
                                width: '36px', height: '36px', borderRadius: '10px',
                                background: speedMatchActive ? 'rgba(0, 122, 255, 0.12)' : 'var(--mac-input-bg)',
                                border: speedMatchActive ? '1px solid rgba(0, 122, 255, 0.18)' : '1px solid var(--mac-border)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                transition: 'all 0.2s'
                            }}>
                                <Gauge size={18} color={speedMatchActive ? '#0A84FF' : 'var(--mac-text-secondary)'} />
                            </div>
                            <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--mac-text)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    自动同步字幕
                                    {speedMatchActive && (
                                        <span style={{
                                            fontSize: '10px', background: 'rgba(0, 122, 255, 0.15)',
                                            color: '#0A84FF', padding: '2px 8px', borderRadius: '6px',
                                            fontWeight: '600', display: 'flex', alignItems: 'center', gap: '4px'
                                        }}>
                                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#0A84FF', animation: 'pulse 1.5s ease-in-out infinite' }} />
                                            追踪中
                                        </span>
                                    )}
                                </div>
                                <div style={{ fontSize: '11px', color: 'var(--mac-text-secondary)', marginTop: '2px' }}>
                                    {speedMatchActive
                                        ? `正在监听 ${selectedTrack.type === 'audio' ? 'A' : 'V'}${selectedTrack.index}，轮询间隔约 100ms`
                                        : '开启后自动获取字幕、监听所选音频轨道，并按新增回车切分字幕'}
                                </div>
                            </div>
                        </div>
                        <ToggleSwitch
                            checked={speedMatchEnabled}
                            onChange={handleToggleSpeedMatch}
                            loading={speedMatchLoading}
                            color="#0A84FF"
                        />
                    </div>

                    {speedMatchMessage && (
                        <div style={{ marginTop: '12px', padding: '10px 12px', borderRadius: '12px', background: 'rgba(10, 132, 255, 0.09)', color: '#0A84FF', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <Activity size={14} /> {speedMatchMessage}
                        </div>
                    )}

                    {/* 自动追踪提示（加载中） */}
                    {speedMatchLoading && !speedMatchActive && (
                        <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--mac-border)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <Loader2 size={14} className="spin" style={{ color: '#0A84FF' }} />
                            <span style={{ fontSize: '12px', color: 'var(--mac-text-secondary)' }}>正在并行获取字幕与轨道信息，并建立跟随绑定...</span>
                        </div>
                    )}
                </div>
            </div>

            {/* 绑定音频轨道（独立卡片，供自动同步字幕和字幕处理共用） */}
            <div style={{ padding: '0 20px', marginBottom: '8px' }}>
                <div style={{
                    background: 'var(--mac-surface-solid)',
                    borderRadius: '12px',
                    border: '1px solid var(--mac-border)',
                    padding: '10px 18px',
                    display: 'flex', alignItems: 'center', gap: '10px',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                        <Activity size={14} style={{ color: 'var(--mac-accent)' }} />
                        <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--mac-text)', whiteSpace: 'nowrap' }}>绑定音频轨道</span>
                    </div>
                    <div style={{ position: 'relative', minWidth: '220px' }} ref={trackDropdownRef}>
                        <button
                            type="button"
                            disabled={trackListLoading || speedMatchLoading}
                            onClick={() => setTrackDropdownOpen(!trackDropdownOpen)}
                            style={{
                                width: '100%',
                                background: 'var(--mac-input-bg)',
                                color: 'var(--mac-text)',
                                border: `1px solid ${trackDropdownOpen ? 'var(--mac-accent)' : 'var(--mac-border)'}`,
                                borderRadius: '8px',
                                padding: '8px 10px',
                                fontSize: '11px',
                                outline: 'none',
                                cursor: 'pointer',
                                transition: 'all 0.2s',
                                textAlign: 'left',
                                boxShadow: trackDropdownOpen ? '0 0 0 2px var(--mac-accent-bg)' : 'none',
                                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px',
                            }}
                        >
                            <span style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                            {trackListLoading ? (
                                <><Loader2 size={12} className="spin" /> 加载轨道...</>
                            ) : availableTracks.length === 0 ? (
                                '暂无可选轨道'
                            ) : (
                                <>
                                    <span style={{
                                        width: '18px', height: '18px', borderRadius: '5px',
                                        background: (selectedTrack.type || 'audio') === 'audio' ? 'rgba(10,132,255,0.2)' : 'rgba(255,149,0,0.2)',
                                        color: (selectedTrack.type || 'audio') === 'audio' ? '#0A84FF' : '#FF9500',
                                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                        fontSize: '9px', fontWeight: '700', flexShrink: 0,
                                    }}>
                                        {(selectedTrack.type || 'audio') === 'audio' ? 'A' : 'V'}{selectedTrack.index}
                                    </span>
                                    {availableTracks.find(t => (t.track_type || 'audio') === (selectedTrack.type || 'audio') && t.track_index === selectedTrack.index)?.clip_count || '?'} 个片段
                                </>
                            )}
                            </span>
                            <ChevronDown size={12} style={{ flexShrink: 0, transform: trackDropdownOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', color: 'var(--mac-text-secondary)' }} />
                        </button>
                        {trackDropdownOpen && (
                            <div style={{
                                position: 'absolute',
                                top: 'calc(100% + 6px)',
                                left: 0,
                                zIndex: 100,
                                background: 'var(--mac-surface-solid)',
                                border: '1px solid var(--mac-border)',
                                borderRadius: '12px',
                                boxShadow: 'var(--mac-shadow)',
                                overflow: 'hidden',
                                maxHeight: '200px',
                                overflowY: 'auto',
                                minWidth: '220px',
                            }}>
                                {availableTracks.map(track => {
                                    const isSelected = (track.track_type || 'audio') === (selectedTrack.type || 'audio') && track.track_index === selectedTrack.index;
                                    return (
                                        <button
                                            key={`${track.track_type || 'audio'}:${track.track_index}`}
                                            type="button"
                                            onClick={() => {
                                                setSelectedTrack({ type: track.track_type || 'audio', index: track.track_index });
                                                setTrackDropdownOpen(false);
                                            }}
                                            style={{
                                                width: '100%',
                                                padding: '9px 12px',
                                                border: 'none',
                                                background: isSelected ? 'var(--mac-accent-bg)' : 'transparent',
                                                color: isSelected ? 'var(--mac-accent)' : 'var(--mac-text)',
                                                fontSize: '12px',
                                                cursor: 'pointer',
                                                textAlign: 'left',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '8px',
                                                transition: 'background 0.1s',
                                                borderLeft: isSelected ? '3px solid var(--mac-accent)' : '3px solid transparent',
                                            }}
                                            onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--mac-input-bg)'; }}
                                            onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                                        >
                                            <span style={{
                                                width: '18px', height: '18px', borderRadius: '5px',
                                                background: (track.track_type || 'audio') === 'audio' ? 'rgba(10,132,255,0.2)' : 'rgba(255,149,0,0.2)',
                                                color: (track.track_type || 'audio') === 'audio' ? '#0A84FF' : '#FF9500',
                                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                                fontSize: '9px', fontWeight: '700', flexShrink: 0,
                                            }}>
                                                {(track.track_type || 'audio') === 'audio' ? 'A' : 'V'}{track.track_index}
                                            </span>
                                            <span style={{ flex: 1 }}>{(track.track_type || 'audio') === 'audio' ? '音频轨道' : '视频轨道'} {track.track_index}</span>
                                            <span style={{ fontSize: '10px', color: 'var(--mac-text-secondary)' }}>{track.clip_count} 个片段</span>
                                            {isSelected && <CheckCircle2 size={12} color="var(--mac-accent)" />}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                    <button className="mac-btn" onClick={() => fetchAudioTracks().catch((e) => setError(e.message))} style={{ fontSize: '11px', padding: '6px 10px', gap: '4px', flexShrink: 0 }}>
                        <RefreshCcw size={12} /> 刷新轨道
                    </button>
                </div>
            </div>

            {searchVisible && (() => {
                const searchRegex = buildSearchRegex(searchQuery, caseSensitive, wholeWord);
                const matchIndices = getMatchIndices(safeSubtitleData, searchRegex);
                const totalMatches = matchIndices.length;
                const safeCurrentIndex = totalMatches > 0 ? Math.min(currentMatchIndex, totalMatches - 1) : 0;
                return (
                    <div style={{
                        background: 'var(--mac-bg-secondary)',
                        border: '1px solid var(--mac-border)',
                        borderRadius: '10px',
                        padding: '10px 14px',
                        margin: '10px 20px 6px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                    }}>
                        {/* 第一行：搜索 + 导航 + 替换 */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <Search size={14} style={{ color: 'var(--mac-text-secondary)' }} />
                            <input
                                ref={searchInputRef}
                                type="text"
                                className="mac-input"
                                placeholder="查找..."
                                value={searchQuery}
                                onChange={(e) => { setSearchQuery(e.target.value); setCurrentMatchIndex(0); }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.shiftKey && totalMatches > 0) {
                                        e.preventDefault();
                                        const next = (safeCurrentIndex + 1) % totalMatches;
                                        setCurrentMatchIndex(next);
                                        matchRowRefs.current[next]?.scrollIntoView({ block: 'nearest' });
                                    }
                                    if (e.key === 'Enter' && e.shiftKey && totalMatches > 0) {
                                        e.preventDefault();
                                        const prev = (safeCurrentIndex - 1 + totalMatches) % totalMatches;
                                        setCurrentMatchIndex(prev);
                                        matchRowRefs.current[prev]?.scrollIntoView({ block: 'nearest' });
                                    }
                                }}
                                style={{ flex: 1, fontSize: '13px', padding: '6px 10px', borderRadius: '6px' }}
                            />
                            <span style={{ fontSize: '12px', color: 'var(--mac-text-secondary)', whiteSpace: 'nowrap' }}>
                                {searchQuery ? `${safeCurrentIndex + 1}/${totalMatches}` : '0/0'}
                            </span>
                            <button
                                className="mac-btn"
                                disabled={totalMatches === 0}
                                onClick={() => {
                                    if (totalMatches === 0) return;
                                    const prev = (safeCurrentIndex - 1 + totalMatches) % totalMatches;
                                    setCurrentMatchIndex(prev);
                                    matchRowRefs.current[prev]?.scrollIntoView({ block: 'nearest' });
                                }}
                                style={{ fontSize: '12px', padding: '4px 8px', lineHeight: 1 }}
                            ><ChevronUp size={12} /></button>
                            <button
                                className="mac-btn"
                                disabled={totalMatches === 0}
                                onClick={() => {
                                    if (totalMatches === 0) return;
                                    const next = (safeCurrentIndex + 1) % totalMatches;
                                    setCurrentMatchIndex(next);
                                    matchRowRefs.current[next]?.scrollIntoView({ block: 'nearest' });
                                }}
                                style={{ fontSize: '12px', padding: '4px 8px', lineHeight: 1 }}
                            ><ChevronDown size={12} /></button>
                            <input
                                type="text"
                                className="mac-input"
                                placeholder="替换为..."
                                value={replaceText}
                                onChange={(e) => setReplaceText(e.target.value)}
                                style={{ flex: 1, fontSize: '13px', padding: '6px 10px', borderRadius: '6px' }}
                            />
                        </div>
                        {/* 第二行：选项 + 操作按钮 */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                            <label style={{ fontSize: '11px', color: 'var(--mac-text-secondary)', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                                <input type="checkbox" checked={caseSensitive} onChange={(e) => { setCaseSensitive(e.target.checked); setCurrentMatchIndex(0); }} style={{ accentColor: '#FF9500' }} />
                                区分大小写
                            </label>
                            <label style={{ fontSize: '11px', color: 'var(--mac-text-secondary)', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                                <input type="checkbox" checked={wholeWord} onChange={(e) => { setWholeWord(e.target.checked); setCurrentMatchIndex(0); }} style={{ accentColor: '#FF9500' }} />
                                全词匹配
                            </label>
                            <div style={{ flex: 1 }} />
                            <button
                                className="mac-btn"
                                disabled={totalMatches === 0}
                                onClick={() => {
                                    if (totalMatches === 0) return;
                                    const targetDataIdx = matchIndices[safeCurrentIndex];
                                    if (targetDataIdx === undefined) return;
                                    const newData = [...safeSubtitleData];
                                    const oldText = newData[targetDataIdx].text || '';
                                    const regex = buildSearchRegex(searchQuery, caseSensitive, wholeWord);
                                    newData[targetDataIdx] = { ...newData[targetDataIdx], text: oldText.replace(regex, replaceText) };
                                    setSubtitleData(newData);
                                }}
                                style={{ fontSize: '12px', padding: '4px 12px' }}
                            >替换</button>
                            <button
                                className="mac-btn"
                                disabled={totalMatches === 0}
                                onClick={() => {
                                    if (totalMatches === 0) return;
                                    setReplaceSnapshot(JSON.parse(JSON.stringify(safeSubtitleData)));
                                    const newData = [...safeSubtitleData];
                                    const regex = buildSearchRegex(searchQuery, caseSensitive, wholeWord);
                                    matchIndices.forEach((dataIdx) => {
                                        const oldText = newData[dataIdx].text || '';
                                        newData[dataIdx] = { ...newData[dataIdx], text: oldText.replace(regex, replaceText) };
                                    });
                                    setSubtitleData(newData);
                                }}
                                style={{ fontSize: '12px', padding: '4px 12px' }}
                            >全部替换</button>
                            {replaceSnapshot && (
                                <button
                                    className="mac-btn"
                                    onClick={() => {
                                        if (replaceSnapshot) {
                                            setSubtitleData(replaceSnapshot);
                                            setReplaceSnapshot(null);
                                        }
                                    }}
                                    style={{ fontSize: '12px', padding: '4px 12px', color: '#FF9500' }}
                                >撤销</button>
                            )}
                            <button
                                className="mac-btn"
                                onClick={() => {
                                    setSearchVisible(false);
                                    setSearchQuery('');
                                    setReplaceText('');
                                    setReplaceSnapshot(null);
                                }}
                                style={{ fontSize: '12px', padding: '4px 10px', lineHeight: 1 }}
                            ><X size={12} /></button>
                        </div>
                    </div>
                );
            })()}

            {/* 字幕表格区域 */}
            <div style={{ padding: '0 20px 20px' }}>
                {/* 时间格式切换 */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', marginBottom: '6px' }}>
                    <span style={{ fontSize: '10px', color: 'var(--mac-text-secondary)' }}>时间格式:</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 0, borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--mac-border)' }}>
                        <button onClick={() => setTimeFormat('timecode')} style={{ padding: '3px 8px', fontSize: '10px', fontWeight: timeFormat === 'timecode' ? 600 : 400, border: 'none', cursor: 'pointer', background: timeFormat === 'timecode' ? 'var(--mac-accent)' : 'var(--mac-input-bg)', color: timeFormat === 'timecode' ? '#fff' : 'var(--mac-text-secondary)', transition: 'all 0.15s', fontFamily: 'inherit' }}>HH:MM:SS:FF</button>
                        <button onClick={() => setTimeFormat('seconds')} style={{ padding: '3px 8px', fontSize: '10px', fontWeight: timeFormat === 'seconds' ? 600 : 400, border: 'none', borderLeft: '1px solid var(--mac-border)', cursor: 'pointer', background: timeFormat === 'seconds' ? 'var(--mac-accent)' : 'var(--mac-input-bg)', color: timeFormat === 'seconds' ? '#fff' : 'var(--mac-text-secondary)', transition: 'all 0.15s', fontFamily: 'inherit' }}>MM:SS.ms</button>
                    </div>
                </div>
                {/* 表头 — 双层：外层 sticky 矩形背景匹配窗口底色，内层圆角裁切 */}
                <div style={{ position: 'sticky', top: 0, zIndex: 5, background: 'var(--mac-bg)' }}>
                    <div style={{ borderRadius: '14px 14px 0 0', overflowX: 'auto', overflowY: 'hidden', border: '1px solid var(--mac-border)', borderBottom: 'none', background: 'var(--mac-surface-muted)' }}>
                    <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', minWidth: '100%' }}>
                        <colgroup>
                            <col style={{ width: '56px' }} />
                            <col style={{ width: '120px' }} />
                            <col style={{ width: '120px' }} />
                            <col />
                            <col style={{ width: '100px' }} />
                            <col style={{ width: '58px' }} />
                        </colgroup>
                        <thead>
                            <tr>
                                <th style={{ padding: '10px 6px 10px 20px', fontSize: '11px', fontWeight: '600', color: 'var(--mac-text-secondary)', textAlign: 'center', letterSpacing: '0.04em', background: 'var(--mac-surface-muted)' }}>#</th>
                                <th style={{ padding: '10px 6px', fontSize: '11px', fontWeight: '600', color: 'var(--mac-text-secondary)', letterSpacing: '0.04em', background: 'var(--mac-surface-muted)' }}>开始时间</th>
                                <th style={{ padding: '10px 6px', fontSize: '11px', fontWeight: '600', color: 'var(--mac-text-secondary)', letterSpacing: '0.04em', background: 'var(--mac-surface-muted)' }}>结束时间</th>
                                <th style={{ padding: '10px 6px', fontSize: '11px', fontWeight: '600', color: 'var(--mac-text-secondary)', textAlign: 'left', letterSpacing: '0.04em', background: 'var(--mac-surface-muted)' }}>字幕文本 (Enter 拆分 · 行首 Backspace 合并)</th>
                                <th style={{ padding: '10px 6px', fontSize: '11px', fontWeight: '600', color: 'var(--mac-text-secondary)', textAlign: 'center', letterSpacing: '0.04em', background: 'var(--mac-surface-muted)' }}>操作</th>
                                <th style={{ padding: '10px 20px 10px 6px', fontSize: '11px', fontWeight: '600', color: 'var(--mac-text-secondary)', textAlign: 'center', letterSpacing: '0.04em', background: 'var(--mac-surface-muted)' }}></th>
                            </tr>
                        </thead>
                    </table>
                    </div>
                </div>
                {/* 表体 — 圆角在底部 */}
                <div style={{ borderRadius: '0 0 14px 14px', overflowX: 'auto', overflowY: 'hidden', border: '1px solid var(--mac-border)', borderTop: 'none', background: 'var(--mac-surface-solid)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                    <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', minWidth: '100%' }}>
                        <colgroup>
                            <col style={{ width: '56px' }} />
                            <col style={{ width: '120px' }} />
                            <col style={{ width: '120px' }} />
                            <col />
                            <col style={{ width: '100px' }} />
                            <col style={{ width: '58px' }} />
                        </colgroup>
                        <tbody>
                        {safeSubtitleData.length === 0 ? (
                            <tr>
                                <td colSpan="6">
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 20px', color: 'var(--mac-text-secondary)' }}>
                                        <div style={{ width: '56px', height: '56px', borderRadius: '14px', background: 'var(--mac-input-bg)', border: '1px solid var(--mac-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '20px' }}>
                                            <FileText size={24} style={{ opacity: 0.35 }} />
                                        </div>
                                        <div style={{ fontSize: '14px', fontWeight: 500, color: 'var(--mac-text)', marginBottom: '6px' }}>暂无字幕数据</div>
                                        <div style={{ fontSize: '12px', color: 'var(--mac-text-secondary)' }}>请先在「生成字幕」工具中转录，或导入本地字幕文件</div>
                                    </div>
                                </td>
                            </tr>
                        ) : (
                            filteredSubtitleData.map((seg, filteredIdx) => {
                                const origIdx = safeSubtitleData.indexOf(seg);
                                const isLastRow = filteredIdx === filteredSubtitleData.length - 1;
                                const displayTime = (seconds) => timeFormat === 'timecode' ? formatTimecode(seconds) : formatTimeShort(seconds);
                                return (
                                <tr key={filteredIdx} ref={(el) => {
                                    if (el && searchVisible) {
                                        const matchIdx = matchIndicesForRender.indexOf(origIdx);
                                        if (matchIdx >= 0) matchRowRefs.current[matchIdx] = el;
                                    }
                                }} style={{
                                    borderBottom: isLastRow ? 'none' : '1px solid var(--mac-border)',
                                    opacity: seg.deleted ? 0.35 : 1,
                                    textDecoration: seg.deleted ? 'line-through' : 'none',
                                    background: searchVisible && matchIndicesForRender.indexOf(origIdx) === safeCurrentIndexForRender
                                        ? 'rgba(255, 149, 0, 0.08)'
                                        : filteredIdx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                                    transition: 'background 0.1s ease',
                                    minHeight: '44px',
                                }}
                                onMouseEnter={(e) => {
                                    if (!searchVisible || matchIndicesForRender.indexOf(origIdx) !== safeCurrentIndexForRender) {
                                        e.currentTarget.style.background = 'var(--mac-input-bg)';
                                    }
                                }}
                                onMouseLeave={(e) => {
                                    if (searchVisible && matchIndicesForRender.indexOf(origIdx) === safeCurrentIndexForRender) {
                                        e.currentTarget.style.background = 'rgba(255, 149, 0, 0.08)';
                                    } else {
                                        e.currentTarget.style.background = filteredIdx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)';
                                    }
                                }}>
                                    <td style={{ padding: '8px 6px', fontSize: '12px', color: 'var(--mac-text-secondary)', textAlign: 'center', paddingLeft: '20px', fontVariantNumeric: 'tabular-nums' }}>
                                        {origIdx + 1}
                                        {seg.deleted && <span style={{ color: '#FF3B30', marginLeft: '4px', fontSize: '10px' }}>已删</span>}
                                    </td>
                                    <td style={{ padding: '8px 6px' }}>
                                        <span style={{
                                            display: 'block',
                                            fontSize: '12px', padding: '6px 8px', textAlign: 'center',
                                            borderRadius: '6px',
                                            fontFamily: "'SF Mono', 'Geist Mono', monospace",
                                            letterSpacing: '0.02em',
                                            color: seg.deleted ? '#FF3B30' : 'var(--mac-text-secondary)',
                                            background: 'var(--mac-input-bg)',
                                            border: '1px solid transparent',
                                        }}>
                                            {displayTime(seg.start)}
                                        </span>
                                    </td>
                                    <td style={{ padding: '8px 6px' }}>
                                        <span style={{
                                            display: 'block',
                                            fontSize: '12px', padding: '6px 8px', textAlign: 'center',
                                            borderRadius: '6px',
                                            fontFamily: "'SF Mono', 'Geist Mono', monospace",
                                            letterSpacing: '0.02em',
                                            color: seg.deleted ? '#FF3B30' : 'var(--mac-text-secondary)',
                                            background: 'var(--mac-input-bg)',
                                            border: '1px solid transparent',
                                        }}>
                                            {displayTime(seg.end)}
                                        </span>
                                    </td>
                                    <td style={{ padding: '8px 6px' }}>
                                        {searchQuery ? (
                                            <span style={{ fontSize: '14px', padding: '8px 12px', display: 'block', borderRadius: '8px', lineHeight: '1.4' }}>
                                                {splitTextByMatch(seg.text || '', searchQuery, caseSensitive).map((part, pi) =>
                                                    part.highlight ? (
                                                        <mark key={pi} style={{
                                                            background: 'rgba(255, 149, 0, 0.3)',
                                                            color: 'var(--mac-text)',
                                                            borderRadius: '2px',
                                                            padding: '0 1px',
                                                        }}>{part.text}</mark>
                                                    ) : (
                                                        <span key={pi}>{part.text}</span>
                                                    )
                                                )}
                                            </span>
                                        ) : (
                                            <input
                                                type="text"
                                                className="mac-input"
                                                value={seg.text}
                                                onChange={(e) => handleSegmentChange(origIdx, 'text', e.target.value)}
                                                onKeyDown={(e) => handleKeyDown(e, origIdx)}
                                                style={{
                                                    fontSize: '14px', padding: '8px 12px', width: '100%', borderRadius: '8px',
                                                    textDecoration: seg.deleted ? 'line-through' : 'none',
                                                    minHeight: '36px',
                                                }}
                                            />
                                        )}
                                    </td>
                                    <td style={{ padding: '6px 6px', textAlign: 'center', verticalAlign: 'middle' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                                            <button
                                                onClick={() => handleLocateSegment(seg)}
                                                style={{
                                                    width: 32, height: 32,
                                                    background: 'rgba(255,255,255,0.06)',
                                                    border: '1px solid var(--mac-border)',
                                                    borderRadius: '8px',
                                                    cursor: 'pointer',
                                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                    color: 'var(--mac-text-secondary)',
                                                    transition: 'all 0.15s ease',
                                                }}
                                                title="定位到时间线"
                                                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(10,132,255,0.15)'; e.currentTarget.style.color = '#0A84FF'; e.currentTarget.style.borderColor = 'rgba(10,132,255,0.3)'; }}
                                                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = 'var(--mac-text-secondary)'; e.currentTarget.style.borderColor = 'var(--mac-border)'; }}
                                            ><MapPin size={16} /></button>
                                            <button
                                                onClick={() => handleMergeWithPrevious(origIdx)}
                                                disabled={origIdx === 0}
                                                style={{
                                                    width: 32, height: 32,
                                                    background: 'rgba(255,255,255,0.06)',
                                                    border: '1px solid var(--mac-border)',
                                                    borderRadius: '8px',
                                                    cursor: origIdx === 0 ? 'not-allowed' : 'pointer',
                                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                    color: 'var(--mac-text-secondary)',
                                                    opacity: origIdx === 0 ? 0.3 : 1,
                                                    transition: 'all 0.15s ease',
                                                }}
                                                title="向上合并到前一条字幕"
                                                onMouseEnter={(e) => { if (origIdx > 0) { e.currentTarget.style.background = 'rgba(10,132,255,0.15)'; e.currentTarget.style.color = '#0A84FF'; e.currentTarget.style.borderColor = 'rgba(10,132,255,0.3)'; } }}
                                                onMouseLeave={(e) => { if (origIdx > 0) { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = 'var(--mac-text-secondary)'; e.currentTarget.style.borderColor = 'var(--mac-border)'; } }}
                                            ><ChevronUp size={16} /></button>
                                        </div>
                                    </td>
                                    <td style={{ padding: '6px 20px 6px 6px', textAlign: 'center', verticalAlign: 'middle' }}>
                                        <button
                                            onClick={() => handleDeleteSegment(origIdx)}
                                            style={{
                                                width: 32, height: 32,
                                                background: 'rgba(255,255,255,0.06)',
                                                border: '1px solid var(--mac-border)',
                                                borderRadius: '8px',
                                                cursor: 'pointer',
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                color: 'var(--mac-text-secondary)',
                                                transition: 'all 0.15s ease',
                                            }}
                                            title="删除字幕"
                                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,59,48,0.12)'; e.currentTarget.style.color = '#FF3B30'; e.currentTarget.style.borderColor = 'rgba(255,59,48,0.25)'; }}
                                            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = 'var(--mac-text-secondary)'; e.currentTarget.style.borderColor = 'var(--mac-border)'; }}
                                        ><X size={16} /></button>
                                    </td>
                                </tr>
                            );
                            })
                    )}
                    </tbody>
                </table>
                </div>
                <div style={{ padding: '8px 4px 0', fontSize: '10px', color: 'var(--mac-text-secondary)', opacity: 0.6, textAlign: 'right' }}>
                    Enter = 智能拆分 &nbsp;|&nbsp; 光标在行首按 Backspace = 向上合并
                </div>
            </div>
            <style>{`
                .spin { animation: spin 1s linear infinite; }
                @keyframes spin { to { transform: rotate(360deg); } }
                @keyframes pulse { 
                    0%, 100% { opacity: 1; } 
                    50% { opacity: 0.4; } 
                }
            `}</style>
            </div>
            )}
        </div>
    );
};

export default SubtitleEditorView;
