import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { Mic, FolderOpen, AlertCircle, Monitor, Upload, FileAudio } from 'lucide-react';
import MacSelect from './MacSelect';

function TranscribeView({ importedVideos, onTranscriptReady, apiBaseUrl, projectId }) {
    const [selectedVideo, setSelectedVideo] = useState(() => localStorage.getItem(`transcribe_selectedVideo_${projectId}`) || (importedVideos.length > 0 ? importedVideos[0].path : ''));
    const [loading, setLoading] = useState(false);
    const [step, setStep] = useState('');
    const [error, setError] = useState(null);
    const [sourceType, setSourceType] = useState(() => localStorage.getItem(`transcribe_sourceType_${projectId}`) || (importedVideos.length > 0 ? 'imported' : 'timeline'));

    // ── 拖拽文件 ──
    const [isDragOver, setIsDragOver] = useState(false);
    const dragCounterRef = React.useRef(0);

    useEffect(() => {
        localStorage.setItem(`transcribe_selectedVideo_${projectId}`, selectedVideo);
        localStorage.setItem(`transcribe_sourceType_${projectId}`, sourceType);
    }, [selectedVideo, sourceType, projectId]);

    useEffect(() => {
        if (!selectedVideo && importedVideos.length > 0) {
            setSelectedVideo(importedVideos[0].path);
        }
    }, [importedVideos, selectedVideo]);

    // ── 判断当前选中的文件是否来自已导入列表 ──
    const isSelectedFromImported = importedVideos.some(v => v.path === selectedVideo);

    // ── 拖拽事件 ──
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
        // Electron / Tauri webview 环境下可通过 file.path 获取完整路径
        const filePath = file.path || null;

        if (filePath) {
            setError(null);
            setSourceType('imported');
            setSelectedVideo(filePath);
        } else {
            setError('无法读取拖拽文件的完整路径，请使用「选择文件」按钮或确认运行环境支持文件拖拽。');
        }
    }, []);

    // ── Tauri 原生拖拽事件监听（v2 API） ──
    useEffect(() => {
        // 仅在 Tauri 环境下注册
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
                            setSourceType('imported');
                            setSelectedVideo(paths[0]);
                        }
                    }
                    // 'over' 事件反复触发，不用于状态管理
                });
            } catch (e) {
                // Tauri API 不可用，回退到 HTML5 拖拽
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

    const handleGenerate = async () => {
        let videoPath = selectedVideo;
        let timelineMeta = null;

        setError(null);
        try {
            const modelRes = await axios.get(`${apiBaseUrl}/api/backend/funasr/models`);
            if (!modelRes.data?.ready) {
                const missing = Array.isArray(modelRes.data?.missing_labels) && modelRes.data.missing_labels.length > 0
                    ? `缺少：${modelRes.data.missing_labels.join('、')}`
                    : '请先下载语音识别模型';
                setError(`语音识别模型未安装，${missing}。请前往「偏好设置 → 模型依赖」安装后再转录。`);
                setLoading(false);
                setStep('');
                return;
            }
        } catch (e) {
            setError(e.response?.data?.detail || '无法检查语音识别模型状态，请确认后端已启动');
            setLoading(false);
            setStep('');
            return;
        }

        if (sourceType === 'timeline') {
            setLoading(true);
            setStep('exporting');
            try {
                const exportRes = await axios.post(`${apiBaseUrl}/api/subtitle/export-audio`);
                if (exportRes.data.audio_path) {
                    videoPath = exportRes.data.audio_path;
                    timelineMeta = {
                        sourceType: exportRes.data.source_type || 'timeline',
                        clipMapping: exportRes.data.clip_mapping || null,
                        frameRate: exportRes.data.frame_rate || 24,
                        originalFilename: exportRes.data.original_filename || exportRes.data.timeline_name || '',
                    };
                } else {
                    setError('从时间线导出音频失败');
                    setLoading(false); setStep(''); return;
                }
            } catch (e) {
                setError(e.response?.data?.detail || '导出音频失败，请确认达芬奇已连接');
                setLoading(false); setStep(''); return;
            }
        }

        if (!videoPath) { setError("请选择音频来源"); setLoading(false); setStep(''); return; }

        if (!loading) setLoading(true);
        setStep('transcribing');
        try {
            const transRes = await axios.post(`${apiBaseUrl}/api/transcribe/path`, null, {
                params: { video_path: videoPath }
            });
            const transcriptData = transRes.data.transcript;
            onTranscriptReady({
                videoPath,
                transcript: transcriptData,
                sourceType: timelineMeta?.sourceType || 'file',
                clipMapping: timelineMeta?.clipMapping || null,
                frameRate: timelineMeta?.frameRate || 24,
                originalFilename: timelineMeta?.originalFilename || videoPath.split(/[/\\]/).pop() || '',
            });
        } catch (e) {
            if (e.response?.status === 409) {
                setError(e.response?.data?.detail || '语音识别模型未安装，请先在「偏好设置 → 模型依赖」下载模型。');
            } else {
                setError(e.response?.data?.detail || e.message);
            }
        } finally { setLoading(false); setStep(''); }
    };

    const handleSelectVideo = async () => {
        if (window.electronAPI?.selectVideo) {
            try { const filePath = await window.electronAPI.selectVideo(); if (filePath) setSelectedVideo(filePath); }
            catch (e) { setError('选择文件失败: ' + e.message); }
        } else { setError('无法调用文件选择器'); }
    };

    const stepLabels = { exporting: '正在从达芬奇时间线导出音频...', transcribing: '正在进行本地语音转录...' };

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

                {error && (
                    <div style={{ background: 'rgba(255, 59, 48, 0.1)', color: '#FF3B30', padding: '12px 16px', borderRadius: '10px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <AlertCircle size={16} /> {error}
                    </div>
                )}
                
                {/* 数据源选择 */}
                <div className="mac-settings-section">
                    <div className="mac-settings-title">数据来源</div>
                    <div className="mac-settings-group">
                        <div className="mac-settings-row">
                            <div className="mac-settings-row-left">
                                <div className="mac-settings-icon-wrapper" style={{ background: '#0A84FF', color: '#fff' }}>
                                    <Monitor size={16} />
                                </div>
                                <div className="mac-settings-text-block">
                                    <div className="mac-settings-label">当前时间线</div>
                                    <div className="mac-settings-desc">直接读取达芬奇当前激活时间线的音频</div>
                                </div>
                            </div>
                            <div className="mac-settings-row-right">
                                <input 
                                    type="radio" 
                                    checked={sourceType === 'timeline'} 
                                    onChange={() => setSourceType('timeline')}
                                    style={{ cursor: 'pointer', transform: 'scale(1.2)' }}
                                />
                            </div>
                        </div>

                        <div className="mac-settings-row">
                            <div className="mac-settings-row-left">
                                <div className="mac-settings-icon-wrapper" style={{ background: '#FF9500', color: '#fff' }}>
                                    <FolderOpen size={16} />
                                </div>
                                <div className="mac-settings-text-block">
                                    <div className="mac-settings-label">本地文件</div>
                                    <div className="mac-settings-desc">
                                        {importedVideos.length > 0 ? "选择已导入的视频文件，或直接拖拽文件到页面中" : "当前项目尚未导入视频文件，可直接拖拽音视频文件到页面"}
                                    </div>
                                </div>
                            </div>
                            <div className="mac-settings-row-right">
                                <input 
                                    type="radio" 
                                    checked={sourceType === 'imported'} 
                                    onChange={() => { if (importedVideos.length > 0 || selectedVideo) setSourceType('imported'); }}
                                    disabled={importedVideos.length === 0 && !selectedVideo}
                                    style={{ cursor: (importedVideos.length > 0 || selectedVideo) ? 'pointer' : 'not-allowed', transform: 'scale(1.2)' }}
                                />
                            </div>
                        </div>

                        {sourceType === 'imported' && (
                            <>
                                {importedVideos.length > 0 && (
                                    <div className="mac-settings-row" style={{ background: 'var(--mac-bg-secondary)', paddingBottom: (selectedVideo && !isSelectedFromImported) ? '8px' : '16px' }}>
                                        <MacSelect 
                                            value={isSelectedFromImported ? selectedVideo : ''} 
                                            onChange={val => setSelectedVideo(val)}
                                            options={importedVideos.map(v => ({ value: v.path, label: v.name }))}
                                            placeholder="-- 请选择视频文件 --"
                                        />
                                    </div>
                                )}
                                {selectedVideo && !isSelectedFromImported && (
                                    <div className="mac-settings-row" style={{ background: 'rgba(10,132,255,0.06)', borderTop: importedVideos.length > 0 ? '1px solid var(--mac-border)' : 'none' }}>
                                        <div className="mac-settings-row-left">
                                            <div className="mac-settings-icon-wrapper" style={{ background: '#0A84FF', color: '#fff' }}>
                                                <FileAudio size={16} />
                                            </div>
                                            <div className="mac-settings-text-block">
                                                <div className="mac-settings-label" style={{ color: 'var(--mac-accent)' }}>已拖拽添加</div>
                                                <div className="mac-settings-desc" style={{ wordBreak: 'break-all' }}>{selectedVideo.split(/[/\\]/).pop()}</div>
                                            </div>
                                        </div>
                                    </div>
                                )}
                                {!selectedVideo && importedVideos.length === 0 && (
                                    <div className="mac-settings-row" style={{ background: 'var(--mac-bg-secondary)' }}>
                                        <div className="mac-settings-desc" style={{ color: 'var(--mac-text-secondary)', padding: '8px 0', textAlign: 'center', width: '100%' }}>
                                            拖拽音频或视频文件到页面中，或先在项目设置中导入视频
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>

                {/* 状态与进度 */}
                {(loading || step) && (
                    <div className="mac-settings-section">
                        <div className="mac-settings-title">处理状态</div>
                        <div className="mac-settings-group">
                            <div className="mac-settings-row">
                                <div className="mac-settings-row-left">
                                    <div className="mac-settings-icon-wrapper" style={{ background: 'var(--mac-text-secondary)', color: '#fff' }}>
                                        {loading ? <Upload size={16} className="spin" /> : <Mic size={16} />}
                                    </div>
                                    <div className="mac-settings-text-block">
                                        <div className="mac-settings-label">
                                            {step === 'exporting' ? '正在导出时间线音频...' :
                                             step === 'transcribing' ? '正在识别字幕...' :
                                             '准备就绪'}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

            <div style={{ display: 'flex', width: '100%' }}>
                <button 
                    className="mac-btn primary" 
                    onClick={handleGenerate}
                    disabled={loading || (sourceType === 'imported' && !selectedVideo)}
                    style={{ height: '40px', fontSize: '14px', fontWeight: '500', width: '100%', justifyContent: 'center' }}
                >
                    {loading ? '处理中...' : '开始转录并生成云文档'}
                </button>
            </div>
            </div>
            </div>

            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
    );
}

export default TranscribeView;
