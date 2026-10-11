import { useState, useEffect } from 'react';
import axios from 'axios';
import { MonitorPlay, Film, Image as ImageIcon, CheckCircle2, AlertCircle } from 'lucide-react';

const normalizeThreshold = (value) => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 1) return 1;
    return parsed;
};

const normalizeSafeZone = (value) => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 0) return 0;
    return parsed;
};

const MARKABLE_TYPES = [
    { key: 'black_border', label: '黑边片段' },
    { key: 'flash_frame', label: '夹帧片段' },
    { key: 'black_frame', label: '黑帧片段' }
];

const CheckView = ({ apiBaseUrl, projectId }) => {
    const [flashFrameThreshold, setFlashFrameThreshold] = useState(() => normalizeThreshold(localStorage.getItem(`check_flashFrameThreshold_${projectId}`) || 3));
    const [checkFlashFrames, setCheckFlashFrames] = useState(() => localStorage.getItem(`check_checkFlashFrames_${projectId}`) !== 'false');
    const [checkBlackFrames, setCheckBlackFrames] = useState(() => localStorage.getItem(`check_checkBlackFrames_${projectId}`) !== 'false');
    const [checkBlackBorders, setCheckBlackBorders] = useState(() => localStorage.getItem(`check_checkBlackBorders_${projectId}`) !== 'false');
    const [blackBorderSafeZone, setBlackBorderSafeZone] = useState(() => normalizeSafeZone(localStorage.getItem(`check_blackBorderSafeZone_${projectId}`) || 2));
    const [loading, setLoading] = useState(false);
    const [locatingIssueId, setLocatingIssueId] = useState(null);
    const [markingAll, setMarkingAll] = useState(false);
    const [deletingTags, setDeletingTags] = useState(false);
    const [markOptions, setMarkOptions] = useState(() => {
        try {
            const saved = JSON.parse(localStorage.getItem(`check_markOptions_${projectId}`) || '{}');
            return {
                black_border: saved.black_border !== false,
                flash_frame: saved.flash_frame !== false,
                black_frame: saved.black_frame !== false
            };
        } catch {
            return { black_border: true, flash_frame: true, black_frame: true };
        }
    });
    const [message, setMessage] = useState('');
    const [issues, setIssues] = useState([]);

    useEffect(() => {
        const normalized = normalizeThreshold(flashFrameThreshold);
        if (normalized !== flashFrameThreshold) {
            setFlashFrameThreshold(normalized);
            return;
        }
        localStorage.setItem(`check_flashFrameThreshold_${projectId}`, normalized);
        localStorage.setItem(`check_checkFlashFrames_${projectId}`, checkFlashFrames);
        localStorage.setItem(`check_checkBlackFrames_${projectId}`, checkBlackFrames);
        localStorage.setItem(`check_checkBlackBorders_${projectId}`, checkBlackBorders);
        const safeZone = normalizeSafeZone(blackBorderSafeZone);
        localStorage.setItem(`check_blackBorderSafeZone_${projectId}`, safeZone);
        if (safeZone !== blackBorderSafeZone) setBlackBorderSafeZone(safeZone);
    }, [flashFrameThreshold, checkFlashFrames, checkBlackFrames, checkBlackBorders, blackBorderSafeZone, projectId]);

    useEffect(() => {
        localStorage.setItem(`check_markOptions_${projectId}`, JSON.stringify(markOptions));
    }, [markOptions, projectId]);

    const handleCheck = async () => {
        setLoading(true);
        setMessage('');
        setIssues([]);
        try {
            const normalizedThreshold = normalizeThreshold(flashFrameThreshold);
            setFlashFrameThreshold(normalizedThreshold);
            const res = await axios.post(`${apiBaseUrl}/api/timeline/check`, {
                flash_frame_threshold: normalizedThreshold,
                check_black_frames: checkBlackFrames,
                check_black_borders: checkBlackBorders,
                black_border_safe_zone: normalizeSafeZone(blackBorderSafeZone)
            });
            let results = res.data.issues || [];
            if (!checkFlashFrames) {
                results = results.filter(issue => issue.type !== 'flash_frame');
            }
            setMessage(res.data.message);
            setIssues(results);
        } catch (error) {
            setMessage('检查失败: ' + (error.response?.data?.detail || error.message));
        } finally {
            setLoading(false);
        }
    };

    const handleLocateIssue = async (issue) => {
        setLocatingIssueId(issue.issue_id);
        try {
            const res = await axios.post(`${apiBaseUrl}/api/timeline/locate`, { issue });
            setMessage(res.data.message || '已在时间线上定位');
        } catch (error) {
            setMessage('定位失败: ' + (error.response?.data?.detail || error.message));
        } finally {
            setLocatingIssueId(null);
        }
    };

    const handleMarkAllIssues = async () => {
        if (!issues.length) return;
        const selectedIssues = issues.filter(issue => markOptions[issue.type] !== false);
        if (!selectedIssues.length) {
            setMessage('请至少勾选一种需要标记的问题类型');
            return;
        }
        setMarkingAll(true);
        try {
            const res = await axios.post(`${apiBaseUrl}/api/timeline/mark-issues`, {
                issues: selectedIssues,
                clear_existing: false
            });
            setMessage(res.data.message || '已添加问题标签');
        } catch (error) {
            setMessage('添加标签失败: ' + (error.response?.data?.detail || error.message));
        } finally {
            setMarkingAll(false);
        }
    };

    const handleDeleteSelectedTags = async () => {
        if (!issues.length) return;
        const selectedIssueTypes = Object.entries(markOptions)
            .filter(([, checked]) => checked)
            .map(([key]) => ({ type: key }));
        if (!selectedIssueTypes.length) {
            setMessage('请至少勾选一种需要删除的问题类型');
            return;
        }
        setDeletingTags(true);
        try {
            const res = await axios.post(`${apiBaseUrl}/api/timeline/clear-check-markers`, {
                issues: selectedIssueTypes
            });
            setMessage(res.data.message || '已删除所选标签');
        } catch (error) {
            setMessage('删除标签失败: ' + (error.response?.data?.detail || error.message));
        } finally {
            setDeletingTags(false);
        }
    };

    // 键盘快捷键：Delete / Backspace 删除所选标签
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === 'Delete' || e.key === 'Backspace') {
                // 避免在输入框中误触发
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
                    return;
                }
                if (issues.length > 0 && !deletingTags) {
                    e.preventDefault();
                    handleDeleteSelectedTags();
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [issues, markOptions, deletingTags, apiBaseUrl]);

    return (
        <div className="page-panel">
            <div className="page-content">
                <div className="page-content-inner">

            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                <div className="mac-settings-section">
                    <div className="mac-settings-title">检查选项</div>
                    <div className="mac-settings-group">
                        {/* Flash Frame Option */}
                        <div className="mac-settings-row">
                            <div className="mac-settings-row-left">
                                <div className="mac-settings-icon-wrapper" style={{ background: '#FF9500', color: '#fff' }}>
                                    <Film size={16} />
                                </div>
                                <div className="mac-settings-text-block">
                                    <div className="mac-settings-label">检查夹帧</div>
                                    <div className="mac-settings-desc">识别过短的素材片段</div>
                                </div>
                            </div>
                            <div className="mac-settings-row-right" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <div className="check-threshold-control">
                                    <span className="check-threshold-prefix">≤</span>
                                    <button
                                        type="button"
                                        className="check-threshold-stepper"
                                        onClick={() => setFlashFrameThreshold(prev => normalizeThreshold(prev) - 1)}
                                        disabled={!checkFlashFrames || normalizeThreshold(flashFrameThreshold) <= 1}
                                        aria-label="减少夹帧阈值"
                                    >
                                        -
                                    </button>
                                    <input
                                        type="number"
                                        value={flashFrameThreshold}
                                        min="1"
                                        step="1"
                                        inputMode="numeric"
                                        disabled={!checkFlashFrames}
                                        onChange={e => setFlashFrameThreshold(e.target.value)}
                                        onBlur={e => setFlashFrameThreshold(normalizeThreshold(e.target.value))}
                                        className="check-threshold-input"
                                    />
                                    <button
                                        type="button"
                                        className="check-threshold-stepper"
                                        onClick={() => setFlashFrameThreshold(prev => normalizeThreshold(prev) + 1)}
                                        disabled={!checkFlashFrames}
                                        aria-label="增加夹帧阈值"
                                    >
                                        +
                                    </button>
                                    <span style={{ fontSize: '12px', opacity: 0.6, marginLeft: '4px' }}>帧</span>
                                </div>
                                <input
                                    type="checkbox"
                                    checked={checkFlashFrames}
                                    onChange={() => setCheckFlashFrames(!checkFlashFrames)}
                                    style={{ width: '16px', height: '16px', accentColor: 'var(--mac-accent)', cursor: 'pointer', flexShrink: 0 }}
                                />
                            </div>
                        </div>

                        {/* Black Frames Option */}
                        <div className="mac-settings-row" onClick={() => setCheckBlackFrames(!checkBlackFrames)} style={{ cursor: 'pointer' }}>
                            <div className="mac-settings-row-left">
                                <div className="mac-settings-icon-wrapper" style={{ background: '#FF3B30', color: '#fff' }}>
                                    <MonitorPlay size={16} />
                                </div>
                                <div className="mac-settings-text-block">
                                    <div className="mac-settings-label">检查黑帧间隙</div>
                                    <div className="mac-settings-desc">扫描轨道间的空白无信号区域</div>
                                </div>
                            </div>
                            <div className="mac-settings-row-right">
                                <input type="checkbox" checked={checkBlackFrames} readOnly style={{ width: '16px', height: '16px', accentColor: 'var(--mac-accent)', cursor: 'pointer' }} />
                            </div>
                        </div>

                        {/* Black Borders Option */}
                        <div className="mac-settings-row">
                            <div className="mac-settings-row-left">
                                <div className="mac-settings-icon-wrapper" style={{ background: '#5856D6', color: '#fff' }}>
                                    <ImageIcon size={16} />
                                </div>
                                <div className="mac-settings-text-block">
                                    <div className="mac-settings-label">检查黑边风险</div>
                                    <div className="mac-settings-desc">识别缩放或比例不匹配导致的黑边</div>
                                </div>
                            </div>
                            <div className="mac-settings-row-right" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <div className="check-threshold-control">
                                    <span className="check-threshold-prefix">&gt;</span>
                                    <button
                                        type="button"
                                        className="check-threshold-stepper"
                                        onClick={() => setBlackBorderSafeZone(prev => normalizeSafeZone(prev) - 1)}
                                        disabled={!checkBlackBorders || normalizeSafeZone(blackBorderSafeZone) <= 0}
                                        aria-label="减少黑边安全区"
                                    >
                                        -
                                    </button>
                                    <input
                                        type="number"
                                        value={blackBorderSafeZone}
                                        min="0"
                                        step="1"
                                        inputMode="numeric"
                                        disabled={!checkBlackBorders}
                                        onChange={e => setBlackBorderSafeZone(e.target.value)}
                                        onBlur={e => setBlackBorderSafeZone(normalizeSafeZone(e.target.value))}
                                        className="check-threshold-input"
                                    />
                                    <button
                                        type="button"
                                        className="check-threshold-stepper"
                                        onClick={() => setBlackBorderSafeZone(prev => normalizeSafeZone(prev) + 1)}
                                        disabled={!checkBlackBorders}
                                        aria-label="增加黑边安全区"
                                    >
                                        +
                                    </button>
                                    <span style={{ fontSize: '12px', opacity: 0.6, marginLeft: '4px' }}>px</span>
                                </div>
                                <input
                                    type="checkbox"
                                    checked={checkBlackBorders}
                                    onChange={() => setCheckBlackBorders(!checkBlackBorders)}
                                    style={{ width: '16px', height: '16px', accentColor: 'var(--mac-accent)', cursor: 'pointer', flexShrink: 0 }}
                                />
                            </div>
                        </div>
                    </div>
                </div>

                <div style={{ marginTop: '-12px', display: 'flex', width: '100%' }}>
                    <button 
                        className="mac-btn primary" 
                        onClick={handleCheck} 
                        disabled={loading}
                        style={{ height: '40px', fontSize: '14px', fontWeight: '500', width: '100%', justifyContent: 'center' }}
                    >
                        {loading ? '正在深度扫描中...' : '开始全面检查'}
                    </button>
                </div>

                {/* Results Area */}
                {(message || issues.length > 0) && (
                    <div className="mac-settings-section" style={{ marginTop: '24px' }}>
                        <div className="mac-settings-title">检查结果</div>
                        
                        {!loading && issues.length === 0 && message && !message.includes('失败') ? (
                            <div style={{ textAlign: 'center', padding: '32px 24px', background: 'rgba(52, 199, 89, 0.05)', borderRadius: '12px', border: '1px solid rgba(52, 199, 89, 0.1)' }}>
                                <CheckCircle2 size={48} color="#34C759" style={{ margin: '0 auto 16px' }} />
                                <div style={{ fontSize: '15px', fontWeight: '600', color: '#34C759' }}>状态良好</div>
                                <div style={{ fontSize: '13px', color: 'var(--mac-text-secondary)', marginTop: '8px' }}>未发现任何剪辑异常或比例风险。</div>
                            </div>
                        ) : null}

                        {message && message.includes('失败') && (
                            <div style={{ padding: '12px 16px', background: 'rgba(255, 59, 48, 0.1)', color: '#FF3B30', borderRadius: '10px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                                <AlertCircle size={16} /> {message}
                            </div>
                        )}

                        {issues.length > 0 && (
                            <div className="mac-settings-group" style={{ padding: 0 }}>
                                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--mac-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
                                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                                        {MARKABLE_TYPES.map(option => (
                                            <label key={option.key} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--mac-text-secondary)', cursor: 'pointer' }}>
                                                <input
                                                    type="checkbox"
                                                    checked={markOptions[option.key] !== false}
                                                    onChange={() => setMarkOptions(prev => ({ ...prev, [option.key]: !prev[option.key] }))}
                                                    style={{ width: '14px', height: '14px', accentColor: 'var(--mac-accent)', cursor: 'pointer' }}
                                                />
                                                <span>{option.label}</span>
                                            </label>
                                        ))}
                                    </div>
                                    <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                                        <button
                                            className="mac-btn"
                                            onClick={handleMarkAllIssues}
                                            disabled={markingAll}
                                            style={{ fontSize: '12px', padding: '8px 14px', height: '36px' }}
                                        >
                                            {markingAll ? '正在添加标签...' : '添加标签'}
                                        </button>
                                        <button
                                            className="mac-btn"
                                            onClick={handleDeleteSelectedTags}
                                            disabled={deletingTags}
                                            style={{ fontSize: '12px', padding: '8px 14px', height: '36px', color: '#FF3B30', borderColor: 'rgba(255, 59, 48, 0.3)' }}
                                        >
                                            {deletingTags ? '正在删除标签...' : '删除标签'}
                                        </button>
                                    </div>
                                </div>
                                {(() => {
                                    const filteredIssues = issues.filter(issue => markOptions[issue.type] !== false);
                                    return filteredIssues.map((issue, idx) => (
                                    <div
                                        key={issue.issue_id || idx}
                                        className="mac-settings-row"
                                        style={{ alignItems: 'flex-start', borderBottom: idx < filteredIssues.length - 1 ? '1px solid var(--mac-border)' : 'none', cursor: 'pointer' }}
                                        onDoubleClick={() => handleLocateIssue(issue)}
                                        title="双击可定位到时间线"
                                    >
                                        <div className="mac-settings-row-left" style={{ flex: 1 }}>
                                            <div className="mac-settings-icon-wrapper" style={{ 
                                                background: issue.type === 'flash_frame' ? '#FF9500' : 
                                                            issue.type === 'black_frame' ? '#FF3B30' : '#5856D6',
                                                color: '#fff'
                                            }}>
                                                {issue.type === 'flash_frame' ? <Film size={16} /> : 
                                                 issue.type === 'black_frame' ? <MonitorPlay size={16} /> : <ImageIcon size={16} />}
                                            </div>
                                            <div className="mac-settings-text-block" style={{ flex: 1 }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                                                    <div className="mac-settings-label">
                                                        {issue.type === 'flash_frame' ? '夹帧警告' : 
                                                         issue.type === 'black_frame' ? '黑帧间隙' : '黑边风险'}
                                                    </div>
                                                    <span style={{ fontSize: '11px', background: 'var(--mac-input-bg)', padding: '2px 6px', borderRadius: '4px', border: '1px solid var(--mac-border)', color: 'var(--mac-text-secondary)' }}>
                                                        Track V{issue.track}
                                                    </span>
                                                </div>
                                                <div className="mac-settings-desc" style={{ marginBottom: '8px' }}>{issue.description}</div>
                                                <div style={{ fontSize: '11px', color: 'var(--mac-text-secondary)', display: 'flex', gap: '16px' }}>
                                                    <span><strong style={{ fontWeight: '500' }}>位置:</strong> {issue.start} - {issue.end}</span>
                                                    <span><strong style={{ fontWeight: '500' }}>时长:</strong> {issue.duration} 帧</span>
                                                    <span><strong style={{ fontWeight: '500' }}>时间码:</strong> {issue.timecode || '-'}</span>
                                                </div>
                                            </div>
                                            <div style={{ display: 'flex', alignItems: 'center', paddingLeft: '12px' }}>
                                                <button
                                                    className="mac-btn"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleLocateIssue(issue);
                                                    }}
                                                    disabled={locatingIssueId === issue.issue_id}
                                                    style={{ fontSize: '12px', padding: '8px 12px', minWidth: '108px', height: '34px' }}
                                                >
                                                    {locatingIssueId === issue.issue_id ? '定位中...' : '在时间线上定位'}
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                ));
                                })()}
                            </div>
                        )}
                    </div>
                )}
            </div>
            </div>
        </div>
        </div>
    );
}

export default CheckView;
