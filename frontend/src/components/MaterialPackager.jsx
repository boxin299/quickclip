import React, { useEffect, useMemo, useState, useRef } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import {
    AlertCircle,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Clapperboard,
    FileAudio,
    FolderOpen,
    FolderSearch,
    Layers,
    Package,
    RefreshCw,
} from 'lucide-react';

function getClipKey(clip) {
    return clip?.item_key || clip?.id || '';
}

function getFusionKey(clip, path, index) {
    return `fusion:${getClipKey(clip)}:${index}:${path}`;
}

function isClipPackable(clip) {
    return clip?.packaging_supported !== false && Boolean(clip?.path);
}

function collectClipPaths(clip, collector) {
    if (isClipPackable(clip)) collector.add(clip.path);
    (clip?.fusion_clips || []).forEach((path) => {
        if (path) collector.add(path);
    });
    (clip?.sub_clips || []).forEach((child) => collectClipPaths(child, collector));
}

function collectAvailableNodeKeys(clip, collector) {
    const clipKey = getClipKey(clip);
    if (clipKey && isClipPackable(clip)) collector.add(clipKey);
    (clip?.fusion_clips || []).forEach((path, index) => {
        if (path) collector.add(getFusionKey(clip, path, index));
    });
    (clip?.sub_clips || []).forEach((child) => collectAvailableNodeKeys(child, collector));
}

function collectClipSelectionKeys(clip, collector, clipLookup, { includeLinked = true, visited = new Set() } = {}) {
    const clipKey = getClipKey(clip);
    if (!clipKey || visited.has(clipKey)) return;
    visited.add(clipKey);
    if (!isClipPackable(clip)) return;
    collector.add(clipKey);

    (clip?.fusion_clips || []).forEach((path, index) => {
        if (path) collector.add(getFusionKey(clip, path, index));
    });

    (clip?.sub_clips || []).forEach((child) => {
        collectClipSelectionKeys(child, collector, clipLookup, { includeLinked, visited });
    });

    if (!includeLinked) return;

    (clip?.linked_items || []).forEach((linkedItem) => {
        const linkedClip = clipLookup.get(linkedItem?.item_key);
        if (linkedClip) {
            collectClipSelectionKeys(linkedClip, collector, clipLookup, { includeLinked: false, visited });
        }
    });
}

function getTrackSelectionSummary(track, selectedNodeKeys) {
    const selectedClipKeys = new Set();
    const selectedPaths = [];

    (track?.clips || []).forEach((clip) => {
        if (!isClipPackable(clip)) return;
        const clipKey = getClipKey(clip);
        if (!clipKey || !selectedNodeKeys.has(clipKey)) return;
        selectedClipKeys.add(clipKey);
        if (clip.path) selectedPaths.push(clip.path);
    });

    const uniquePaths = new Set(selectedPaths);
    return {
        selectedClipCount: selectedClipKeys.size,
        duplicateAssetCount: Math.max(0, selectedPaths.length - uniquePaths.size),
    };
}

// 模块级缓存——切换页面不会丢失扫描结果
let _scanCache = null;
let _cacheProjectName = '';

export default function MaterialPackager({ apiBaseUrl, resolveStatus }) {
    const [tracks, setTracks] = useState(_scanCache?.tracks || []);
    const [summary, setSummary] = useState(_scanCache?.summary || null);
    const [timelineName, setTimelineName] = useState(_scanCache?.timelineName || '');
    const [warnings, setWarnings] = useState(_scanCache?.warnings || []);
    const [notice, setNotice] = useState(null);
    const [loading, setLoading] = useState(false);
    const [packing, setPacking] = useState(false);
    const [selectedNodeKeys, setSelectedNodeKeys] = useState(new Set());
    const [destDir, setDestDir] = useState('');
    const [expandedTracks, setExpandedTracks] = useState(new Set());
    const [expandedClips, setExpandedClips] = useState(new Set());
    const [packResult, setPackResult] = useState(null);
    const [fetchAttempted, setFetchAttempted] = useState(!!_scanCache);
    const [folderConfig, setFolderConfig] = useState({
        source: 'mediapool',
        direction: 'forward',
        depth: 0,
    });
    const [hierarchyTree, setHierarchyTree] = useState(null);  // { tree, summary }
    const [hierarchyLoading, setHierarchyLoading] = useState(false);
    const [projectBasePath, setProjectBasePath] = useState('');

    const clipLookup = useMemo(() => {
        const lookup = new Map();
        const walk = (clip) => {
            const clipKey = getClipKey(clip);
            if (clipKey) lookup.set(clipKey, clip);
            (clip?.sub_clips || []).forEach(walk);
        };
        tracks.forEach((track) => (track.clips || []).forEach(walk));
        return lookup;
    }, [tracks]);

    const fusionLookup = useMemo(() => {
        const lookup = new Map();
        const walk = (clip) => {
            (clip?.fusion_clips || []).forEach((path, index) => {
                if (path) lookup.set(getFusionKey(clip, path, index), path);
            });
            (clip?.sub_clips || []).forEach(walk);
        };
        tracks.forEach((track) => (track.clips || []).forEach(walk));
        return lookup;
    }, [tracks]);

    const selectedPaths = useMemo(() => {
        const collector = new Set();
        selectedNodeKeys.forEach((nodeKey) => {
            if (fusionLookup.has(nodeKey)) {
                collector.add(fusionLookup.get(nodeKey));
                return;
            }
            const clip = clipLookup.get(nodeKey);
            if (clip) collectClipPaths(clip, collector);
        });
        return Array.from(collector);
    }, [clipLookup, fusionLookup, selectedNodeKeys]);

    const selectedCount = selectedPaths.length;

    // 构建 path → { media_pool_folder, source_path } 映射，供预览和打包接口使用
    const clipPathMap = useMemo(() => {
        const map = {};
        tracks.forEach((track) => {
            (track.clips || []).forEach((clip) => {
                if (!isClipPackable(clip)) return;
                const pathSet = new Set();
                collectClipPaths(clip, pathSet);
                pathSet.forEach((p) => {
                    if (p && !map[p]) {
                        map[p] = {
                            media_pool_folder: clip.media_pool_folder || '',
                            source_path: clip.source_path || p,
                        };
                    }
                });
            });
        });
        return map;
    }, [tracks]);

    const fetchMaterials = async ({ silent = false } = {}) => {
        if (!silent) setNotice(null);
        setLoading(true);
        setFetchAttempted(false);
        try {
            const res = await axios.get(`${apiBaseUrl}/api/pack/timeline_materials`);
            const data = res.data || {};
            console.log('[MATERIAL PACK] API response:', {
                status: data.status,
                timeline_name: data.timeline_name,
                track_count: data.summary?.track_count,
                clip_count: data.summary?.clip_count,
                asset_count: data.summary?.asset_count,
                warning_count: data.warnings?.length,
                tracks_length: data.tracks?.length,
            });

            if (data.status === 'success') {
                const nextTracks = data.tracks || [];
                setTracks(nextTracks);
                setSummary(data.summary || null);
                setTimelineName(data.timeline_name || '');
                setWarnings(data.warnings || []);
                setProjectBasePath(data.project_base_path || '');
                setExpandedTracks(new Set());
                setExpandedClips(new Set());
                setFetchAttempted(true);
                // 写入模块级缓存——切换页面不丢失
                _scanCache = {
                    tracks: nextTracks,
                    summary: data.summary || null,
                    timelineName: data.timeline_name || '',
                    warnings: data.warnings || [],
                    projectBasePath: data.project_base_path || '',
                };
                setSelectedNodeKeys((prev) => {
                    const available = new Set();
                    nextTracks.forEach((track) => {
                        (track.clips || []).forEach((clip) => collectAvailableNodeKeys(clip, available));
                    });
                    return new Set(Array.from(prev).filter((nodeKey) => available.has(nodeKey)));
                });
                return;
            }

            setTracks([]);
            setSummary(null);
            setTimelineName('');
            setWarnings([]);
            setExpandedTracks(new Set());
            setExpandedClips(new Set());
            setFetchAttempted(true);
            setNotice({
                type: data.status === 'idle' ? 'warning' : 'error',
                message: data.message || '获取时间线失败',
            });
        } catch (err) {
            console.error(err);
            const detail = err.response?.data?.detail || err.message || '获取时间线异常';
            setTracks([]);
            setSummary(null);
            setTimelineName('');
            setWarnings([]);
            setExpandedTracks(new Set());
            setExpandedClips(new Set());
            setFetchAttempted(true);
            setNotice({ type: 'error', message: detail });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (resolveStatus?.connected) {
            // 有缓存则直接恢复，无需重新扫描
            if (_scanCache) {
                setTracks(_scanCache.tracks);
                setSummary(_scanCache.summary);
                setTimelineName(_scanCache.timelineName);
                setWarnings(_scanCache.warnings);
                setProjectBasePath(_scanCache.projectBasePath);
                setExpandedTracks(new Set());
                setExpandedClips(new Set());
                setFetchAttempted(true);
            } else {
                fetchMaterials({ silent: true });
            }
        } else {
            setTracks([]);
            setSummary(null);
            setTimelineName('');
            setWarnings([]);
            setExpandedTracks(new Set());
            setExpandedClips(new Set());
            setFetchAttempted(false);
            _scanCache = null;
            _cacheProjectName = '';
            setNotice({ type: 'warning', message: '当前未连接到达芬奇，请先连接项目后再扫描。' });
        }
    }, [resolveStatus?.connected]);

    // folderConfig 或 selectedPaths 变化时自动刷新预览
    useEffect(() => {
        if (folderConfig.depth > 0 && selectedPaths.length > 0) {
            fetchHierarchyPreview();
        } else {
            setHierarchyTree(null);
        }
    }, [folderConfig, selectedPaths.length]);

    const handleFolderConfigChange = (key, value) => {
        setFolderConfig((prev) => ({ ...prev, [key]: value }));
    };

    const toggleTrackExpand = (trackKey) => {
        setExpandedTracks((prev) => {
            const next = new Set(prev);
            if (next.has(trackKey)) next.delete(trackKey);
            else next.add(trackKey);
            return next;
        });
    };

    const toggleExpand = (id) => {
        setExpandedClips((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const isClipFullySelected = (clip, options = {}) => {
        const selectionKeys = new Set();
        collectClipSelectionKeys(clip, selectionKeys, clipLookup, options);
        if (selectionKeys.size === 0) return false;
        return Array.from(selectionKeys).every((key) => selectedNodeKeys.has(key));
    };

    const toggleClipSelection = (clip, checked, options = {}) => {
        const selectionKeys = new Set();
        collectClipSelectionKeys(clip, selectionKeys, clipLookup, options);
        setSelectedNodeKeys((prev) => {
            const next = new Set(prev);
            selectionKeys.forEach((key) => {
                if (checked) next.add(key);
                else next.delete(key);
            });
            return next;
        });
    };

    const getTrackSelectableKeys = (track) => {
        const collector = new Set();
        (track.clips || []).forEach((clip) => collectClipSelectionKeys(clip, collector, clipLookup));
        return Array.from(collector);
    };

    const isTrackFullySelected = (track) => {
        const keys = getTrackSelectableKeys(track);
        if (keys.length === 0) return false;
        return keys.every((key) => selectedNodeKeys.has(key));
    };

    const toggleTrackSelection = (track, checked) => {
        const keys = getTrackSelectableKeys(track);
        setSelectedNodeKeys((prev) => {
            const next = new Set(prev);
            keys.forEach((key) => {
                if (checked) next.add(key);
                else next.delete(key);
            });
            return next;
        });
    };

    const selectAllTracksByType = (trackType) => {
        const allKeys = new Set();
        tracks.filter(t => t.track_type === trackType).forEach((track) => {
            getTrackSelectableKeys(track).forEach(key => allKeys.add(key));
        });
        if (allKeys.size === 0) return;

        const tracksOfType = tracks.filter(t => t.track_type === trackType);
        const allFullySelected = tracksOfType.every(t => isTrackFullySelected(t));

        setSelectedNodeKeys((prev) => {
            const next = new Set(prev);
            allKeys.forEach((key) => {
                if (allFullySelected) next.delete(key);
                else next.add(key);
            });
            return next;
        });
    };

    const videoTracks = tracks.filter(t => t.track_type === 'video');
    const audioTracks = tracks.filter(t => t.track_type === 'audio');
    const allVideoSelected = videoTracks.length > 0 && videoTracks.every(t => isTrackFullySelected(t));
    const allAudioSelected = audioTracks.length > 0 && audioTracks.every(t => isTrackFullySelected(t));

    const handleSelectDirectory = async () => {
        if (!window.electronAPI?.selectDirectory) {
            setNotice({ type: 'error', message: '当前环境不支持选择文件夹，请手动填写目标路径。' });
            return;
        }
        try {
            const dir = await window.electronAPI.selectDirectory({ title: '选择素材打包目录' });
            if (dir) setDestDir(dir);
        } catch (err) {
            console.error(err);
            setNotice({ type: 'error', message: '打开文件夹选择器失败。' });
        }
    };

    const fetchHierarchyPreview = async () => {
        if (selectedPaths.length === 0 || folderConfig.depth === 0) {
            setHierarchyTree(null);
            return;
        }
        setHierarchyLoading(true);
        try {
            const res = await axios.post(`${apiBaseUrl}/api/pack/preview_hierarchy`, {
                selected_paths: selectedPaths,
                folder_config: folderConfig,
                clip_path_map: clipPathMap,
                project_base_path: projectBasePath,
            });
            if (res.data?.status === 'success') {
                setHierarchyTree({
                    tree: res.data.tree || [],
                    summary: {
                        file_count: res.data.file_count,
                        folder_count: res.data.folder_count,
                        conflict_count: res.data.conflict_count,
                    },
                });
            }
        } catch (err) {
            console.error('Preview hierarchy failed:', err);
            setHierarchyTree(null);
        } finally {
            setHierarchyLoading(false);
        }
    };

    const handlePack = async () => {
        if (selectedPaths.length === 0) {
            setNotice({ type: 'warning', message: '请先勾选需要打包的素材' });
            return;
        }
        if (!destDir.trim()) {
            setNotice({ type: 'warning', message: '请先选择打包目标文件夹' });
            return;
        }
        setPacking(true);
        setNotice(null);
        try {
            const res = await axios.post(`${apiBaseUrl}/api/pack/execute`, {
                selected_paths: selectedPaths,
                dest_dir: destDir.trim(),
                folder_config: folderConfig.depth > 0 ? folderConfig : null,
                clip_folder_map: folderConfig.depth > 0 ? clipPathMap : {},
                project_base_path: projectBasePath,
            });
            setPackResult(res.data || null);
            if (res.data?.packed_count > 0) {
                setNotice({ type: 'success', message: `打包完成：${res.data.packed_count} 个文件${res.data.failed_count > 0 ? `，${res.data.failed_count} 个失败` : ''}` });
            } else {
                setNotice({ type: 'error', message: '全部打包失败，请查看详情' });
            }
        } catch (err) {
            const detail = err.response?.data?.detail || err.message || '打包失败';
            setNotice({ type: 'error', message: detail });
        } finally {
            setPacking(false);
        }
    };

    const handleRevealInFinder = async () => {
        if (!destDir.trim()) {
            setNotice({ type: 'warning', message: '请先指定打包目标目录。' });
            return;
        }
        if (!window.electronAPI?.revealInFinder) {
            setNotice({ type: 'error', message: '当前环境不支持在访达中打开目录。' });
            return;
        }
        const result = await window.electronAPI.revealInFinder(destDir.trim());
        if (result?.status === 'error') {
            setNotice({ type: 'error', message: result.message || '打开目录失败。' });
        }
    };

    const renderClip = (clip, depth = 0) => {
        const hasSubClips = (clip.sub_clips || []).length > 0;
        const hasFusion = (clip.fusion_clips || []).length > 0;
        const hasLinked = (clip.linked_items || []).length > 0;
        const isExpanded = expandedClips.has(clip.id);
        const isExpandable = hasSubClips || hasFusion || hasLinked;
        const isAudioTrack = clip.track_type === 'audio';
        const isPackable = isClipPackable(clip);

        return (
            <div key={clip.id}>
                <div style={{
                    display: 'flex', alignItems: 'center', padding: '5px 14px 5px 0',
                    gap: '6px', minHeight: '28px'
                }}>
                    {/* 展开箭头 */}
                    <button
                        type="button"
                        aria-label={isExpanded ? '收起' : '展开'}
                        onClick={() => isExpandable && toggleExpand(clip.id)}
                        style={{
                            width: '14px', height: '14px', display: 'inline-flex',
                            alignItems: 'center', justifyContent: 'center',
                            cursor: isExpandable ? 'pointer' : 'default',
                            opacity: isExpandable ? 1 : 0, flexShrink: 0,
                            border: 'none', background: 'transparent', padding: 0,
                            color: 'inherit'
                        }}>
                        <ChevronRight size={12} style={{
                            transition: 'transform 0.15s',
                            transform: isExpanded ? 'rotate(90deg)' : 'none'
                        }} />
                    </button>

                    {/* 复选框 */}
                    <input
                        type="checkbox"
                        checked={isClipFullySelected(clip)}
                        onChange={(e) => toggleClipSelection(clip, e.target.checked)}
                        disabled={!isPackable}
                        style={{ flexShrink: 0, accentColor: 'var(--mac-accent)' }}
                    />

                    {/* 类型图标 */}
                    {hasSubClips ? (
                        <Layers size={14} style={{ color: '#FF9500', flexShrink: 0 }} />
                    ) : isAudioTrack ? (
                        <FileAudio size={14} style={{ color: '#AF52FA', flexShrink: 0 }} />
                    ) : (
                        <Clapperboard size={14} style={{ color: '#0A84FF', flexShrink: 0 }} />
                    )}

                    {/* 名称 */}
                    <span style={{
                        fontSize: '12px', flex: 1, overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                    }} title={clip.name}>
                        {clip.name}
                    </span>

                    {/* 元数据 */}
                    <span style={{ fontSize: '10px', color: 'var(--mac-text-secondary)', flexShrink: 0 }}>
                        {clip.track_type === 'audio' ? 'A' : 'V'}{clip.track_index}
                    </span>
                    {isPackable ? (
                        <span style={{ fontSize: '10px', color: 'var(--mac-text-secondary)', flexShrink: 0 }}>
                            {clip.path ? clip.path.split('/').pop() : ''}
                        </span>
                    ) : (
                        <span style={{ fontSize: '10px', color: 'var(--mac-text-secondary)', flexShrink: 0 }}>
                            {clip.packaging_disabled_reason || '不支持打包'}
                        </span>
                    )}
                </div>

                {/* 展开的子内容 */}
                {isExpanded && (
                    <div style={{ paddingLeft: '22px' }}>
                        {hasFusion && clip.fusion_clips.map((path, index) => (
                            <label key={`${clip.id}-fusion-${index}`} style={{
                                display: 'flex', alignItems: 'center', padding: '3px 14px 3px 0', gap: '6px',
                                fontSize: '11px', cursor: 'pointer'
                            }}>
                                <input type="checkbox"
                                    checked={selectedNodeKeys.has(getFusionKey(clip, path, index))}
                                    onChange={(e) => {
                                        const fk = getFusionKey(clip, path, index);
                                        setSelectedNodeKeys((prev) => {
                                            const next = new Set(prev);
                                            e.target.checked ? next.add(fk) : next.delete(fk);
                                            return next;
                                        });
                                    }}
                                    style={{ accentColor: 'var(--mac-accent)' }}
                                />
                                <span style={{ color: '#FF9500', fontSize: '10px' }}>Fusion</span>
                                <span style={{ color: 'var(--mac-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                    title={path}>{path.split('/').pop()}</span>
                            </label>
                        ))}
                        {hasLinked && clip.linked_items.map((linkedItem) => {
                            const linkedClip = clipLookup.get(linkedItem?.item_key);
                            if (!linkedClip) return null;
                            return (
                                <label key={`${clip.id}-linked-${linkedItem.item_key}`} style={{
                                    display: 'flex', alignItems: 'center', padding: '3px 14px 3px 0', gap: '6px',
                                    fontSize: '11px', cursor: 'pointer'
                                }}>
                                    <input type="checkbox"
                                        checked={isClipFullySelected(linkedClip, { includeLinked: false })}
                                        onChange={(e) => toggleClipSelection(linkedClip, e.target.checked, { includeLinked: false })}
                                        style={{ accentColor: 'var(--mac-accent)' }}
                                    />
                                    <span style={{ color: '#5AC8FA', fontSize: '10px' }}>链接</span>
                                    <span style={{ color: 'var(--mac-text-secondary)' }}>
                                        {linkedItem.track_type === 'audio' ? 'A' : 'V'}{linkedItem.track_index} · {linkedItem.name}
                                    </span>
                                </label>
                            );
                        })}
                        {hasSubClips && clip.sub_clips.map((child) => renderClip(child, depth + 1))}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="page-panel">
            <div className="page-content">
                <div className="page-content-inner">
                    {/* ====== Region 0: 警告横幅 ====== */}
                    {!resolveStatus?.connected && (
                        <div style={{
                            padding: '12px 16px', borderRadius: '10px', fontSize: '13px',
                            background: 'rgba(255, 59, 48, 0.1)', color: '#FF3B30',
                            display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px'
                        }}>
                            <AlertCircle size={16} />
                            未连接达芬奇，请先打开达芬奇并确保脚本服务已启动
                        </div>
                    )}

                    {resolveStatus?.connected && tracks.length === 0 && !loading && fetchAttempted && (
                        <div style={{
                            padding: '12px 16px', borderRadius: '10px', fontSize: '13px',
                            background: 'rgba(255, 149, 0, 0.1)', color: '#FF9500',
                            display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px'
                        }}>
                            <AlertCircle size={16} />
                            请先打开时间线后再进行素材打包
                        </div>
                    )}

                    {/* ====== Region 1: 基本信息 ====== */}
                    <div className="mac-settings-section">
                        <div className="mac-settings-title">基本信息</div>
                        <div className="mac-settings-group">

                            {/* 扫描状态 */}
                            <div className="mac-settings-row">
                                <div className="mac-settings-row-left">
                                    <div className="mac-settings-icon-wrapper" style={{ background: '#0A84FF', color: '#fff' }}>
                                        <RefreshCw size={16} className={loading ? 'spin' : ''} />
                                    </div>
                                    <div className="mac-settings-text-block">
                                        <div className="mac-settings-label">
                                            {loading && !fetchAttempted
                                                ? '扫描中...'
                                                : timelineName || (!fetchAttempted ? '等待扫描' : '未检测到时间线')}
                                        </div>
                                        <div className="mac-settings-desc">
                                            {summary
                                                ? `${summary.track_count} 条轨道 · ${summary.clip_count} 个片段 · ${summary.asset_count} 个素材`
                                                : '请确认达芬奇已打开时间线'}
                                        </div>
                                    </div>
                                </div>
                                <div className="mac-settings-row-right">
                                    <button className="mac-btn" onClick={() => fetchMaterials()} disabled={loading}
                                        style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '13px' }}>
                                        <RefreshCw size={14} />
                                        {loading ? '扫描中' : '重新扫描'}
                                    </button>
                                </div>
                            </div>

                            {/* 打包目标 */}
                            <div className="mac-settings-row">
                                <div className="mac-settings-row-left">
                                    <div className="mac-settings-icon-wrapper" style={{ background: '#FF9500', color: '#fff' }}>
                                        <FolderOpen size={16} />
                                    </div>
                                    <div className="mac-settings-text-block">
                                        <div className="mac-settings-label">打包目标</div>
                                        <div className="mac-settings-desc">
                                            {destDir || '未选择目标文件夹'}
                                        </div>
                                    </div>
                                </div>
                                <div className="mac-settings-row-right" style={{ gap: '6px' }}>
                                    <button className="mac-btn" onClick={handleSelectDirectory}
                                        style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px' }}>
                                        <FolderOpen size={14} />
                                        选择路径
                                    </button>
                                    <button className="mac-btn" onClick={handleRevealInFinder} disabled={!destDir.trim()}
                                        style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px' }}>
                                        <FolderSearch size={14} />
                                        打开
                                    </button>
                                </div>
                            </div>

                            {/* 执行打包 */}
                            <div className="mac-settings-row">
                                <div className="mac-settings-row-left">
                                    <div className="mac-settings-icon-wrapper" style={{ background: '#34C759', color: '#fff' }}>
                                        <Package size={16} />
                                    </div>
                                    <div className="mac-settings-text-block">
                                        <div className="mac-settings-label">执行打包</div>
                                        <div className="mac-settings-desc">
                                            {selectedCount > 0
                                                ? `已选 ${selectedCount} 个文件，将打包至目标目录`
                                                : '请先在素材列表中勾选需要打包的片段'}
                                        </div>
                                    </div>
                                </div>
                                <div className="mac-settings-row-right">
                                    <button className="mac-btn primary" onClick={handlePack} disabled={packing || loading || selectedCount === 0}
                                        style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '13px', fontWeight: 500 }}>
                                        <Package size={14} />
                                        {packing ? '正在打包' : `开始打包${selectedCount > 0 ? ` (${selectedCount})` : ''}`}
                                    </button>
                                </div>
                            </div>

                        </div>
                    </div>

                    {/* ====== Region 2: 层级配置 ====== */}
                    <div className="mac-settings-section">
                        <div className="mac-settings-title">层级配置</div>
                        <div className="mac-settings-group">

                            {/* 路径来源 */}
                            <div className="mac-settings-row">
                                <div className="mac-settings-row-left">
                                    <div className="mac-settings-icon-wrapper" style={{ background: '#AF52FA', color: '#fff' }}>
                                        <Layers size={16} />
                                    </div>
                                    <div className="mac-settings-text-block">
                                        <div className="mac-settings-label">路径来源</div>
                                        <div className="mac-settings-desc">媒体池层级或文件系统路径</div>
                                    </div>
                                </div>
                                <div className="mac-settings-row-right">
                                    <div style={{
                                        display: 'flex', background: 'var(--mac-input-bg)', padding: '3px',
                                        borderRadius: '7px', border: '1px solid var(--mac-border)'
                                    }}>
                                        <div onClick={() => handleFolderConfigChange('source', 'mediapool')}
                                            style={{
                                                padding: '5px 14px', fontSize: '13px', cursor: 'pointer', borderRadius: '5px',
                                                background: folderConfig.source === 'mediapool' ? 'var(--mac-accent)' : 'transparent',
                                                color: folderConfig.source === 'mediapool' ? '#fff' : 'var(--mac-text)',
                                                transition: 'all 0.15s', fontWeight: folderConfig.source === 'mediapool' ? 500 : 400
                                            }}>
                                            媒体池
                                        </div>
                                        <div onClick={() => handleFolderConfigChange('source', 'filesystem')}
                                            style={{
                                                padding: '5px 14px', fontSize: '13px', cursor: 'pointer', borderRadius: '5px',
                                                background: folderConfig.source === 'filesystem' ? 'var(--mac-accent)' : 'transparent',
                                                color: folderConfig.source === 'filesystem' ? '#fff' : 'var(--mac-text)',
                                                transition: 'all 0.15s', fontWeight: folderConfig.source === 'filesystem' ? 500 : 400
                                            }}>
                                            文件系统
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* 层级方向 */}
                            <div className="mac-settings-row">
                                <div className="mac-settings-row-left">
                                    <div className="mac-settings-icon-wrapper" style={{ background: '#5AC8FA', color: '#fff' }}>
                                        <ChevronDown size={16} />
                                    </div>
                                    <div className="mac-settings-text-block">
                                        <div className="mac-settings-label">层级方向</div>
                                        <div className="mac-settings-desc">
                                            {folderConfig.direction === 'forward' ? '正向：从根目录到叶目录' : '反向：从叶目录到根目录'}
                                        </div>
                                    </div>
                                </div>
                                <div className="mac-settings-row-right">
                                    <div style={{
                                        display: 'flex', background: 'var(--mac-input-bg)', padding: '3px',
                                        borderRadius: '7px', border: '1px solid var(--mac-border)'
                                    }}>
                                        <div onClick={() => handleFolderConfigChange('direction', 'forward')}
                                            style={{
                                                padding: '5px 14px', fontSize: '13px', cursor: 'pointer', borderRadius: '5px',
                                                background: folderConfig.direction === 'forward' ? 'var(--mac-accent)' : 'transparent',
                                                color: folderConfig.direction === 'forward' ? '#fff' : 'var(--mac-text)',
                                                transition: 'all 0.15s', fontWeight: folderConfig.direction === 'forward' ? 500 : 400
                                            }}>
                                            正向
                                        </div>
                                        <div onClick={() => handleFolderConfigChange('direction', 'reverse')}
                                            style={{
                                                padding: '5px 14px', fontSize: '13px', cursor: 'pointer', borderRadius: '5px',
                                                background: folderConfig.direction === 'reverse' ? 'var(--mac-accent)' : 'transparent',
                                                color: folderConfig.direction === 'reverse' ? '#fff' : 'var(--mac-text)',
                                                transition: 'all 0.15s', fontWeight: folderConfig.direction === 'reverse' ? 500 : 400
                                            }}>
                                            反向
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* 保留层数 */}
                            <div className="mac-settings-row">
                                <div className="mac-settings-row-left">
                                    <div className="mac-settings-icon-wrapper" style={{ background: '#FF375F', color: '#fff' }}>
                                        <span style={{ fontSize: '11px', fontWeight: 700 }}>{folderConfig.depth}</span>
                                    </div>
                                    <div className="mac-settings-text-block">
                                        <div className="mac-settings-label">保留层数</div>
                                        <div className="mac-settings-desc">
                                            {folderConfig.depth === 0
                                                ? '0 = 文件平铺到目标目录'
                                                : `保留 ${folderConfig.depth} 级文件夹结构`}
                                        </div>
                                    </div>
                                </div>
                                <div className="mac-settings-row-right" style={{ gap: '10px' }}>
                                    <span style={{
                                        fontSize: '18px', fontWeight: 600, color: 'var(--mac-accent)',
                                        fontVariantNumeric: 'tabular-nums', minWidth: '20px', textAlign: 'center'
                                    }}>
                                        {folderConfig.depth}
                                    </span>
                                    <input
                                        type="range"
                                        min={0}
                                        max={5}
                                        value={folderConfig.depth}
                                        onChange={(e) => {
                                            const depth = parseInt(e.target.value, 10);
                                            setFolderConfig((prev) => ({ ...prev, depth }));
                                        }}
                                        style={{
                                            width: '120px', accentColor: 'var(--mac-accent)',
                                            height: '4px', cursor: 'pointer'
                                        }}
                                    />
                                </div>
                            </div>

                        </div>
                    </div>

                    {/* ====== Region 3: 素材列表 ====== */}
                    <div className="mac-settings-section">
                        <div className="mac-settings-title">
                            素材列表
                            {!loading && tracks.length > 0 && (
                                <span style={{ fontWeight: 400, color: 'var(--mac-text-secondary)', marginLeft: '4px' }}>
                                    · {tracks.length} 条轨道
                                </span>
                            )}
                        </div>
                        <div className="mac-settings-group">

                            {/* 工具栏 */}
                            {tracks.length > 0 && (
                                <div style={{
                                    display: 'flex', alignItems: 'center', padding: '8px 16px',
                                    borderBottom: '1px solid var(--mac-border)', gap: '8px'
                                }}>
                                    {videoTracks.length > 0 && (
                                        <button type="button"
                                            onClick={() => selectAllTracksByType('video')}
                                            disabled={loading}
                                            style={{
                                                fontSize: '11px', padding: '3px 10px', borderRadius: '5px',
                                                border: `1px solid ${allVideoSelected ? 'var(--mac-accent)' : 'var(--mac-border)'}`,
                                                background: allVideoSelected ? 'var(--mac-accent-bg)' : 'transparent',
                                                color: allVideoSelected ? 'var(--mac-accent)' : 'var(--mac-text-secondary)',
                                                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px'
                                            }}>
                                            {allVideoSelected ? '取消视频轨道' : '全选视频轨道'} ({videoTracks.length})
                                        </button>
                                    )}
                                    {audioTracks.length > 0 && (
                                        <button type="button"
                                            onClick={() => selectAllTracksByType('audio')}
                                            disabled={loading}
                                            style={{
                                                fontSize: '11px', padding: '3px 10px', borderRadius: '5px',
                                                border: `1px solid ${allAudioSelected ? 'var(--mac-accent)' : 'var(--mac-border)'}`,
                                                background: allAudioSelected ? 'var(--mac-accent-bg)' : 'transparent',
                                                color: allAudioSelected ? 'var(--mac-accent)' : 'var(--mac-text-secondary)',
                                                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px'
                                            }}>
                                            {allAudioSelected ? '取消音频轨道' : '全选音频轨道'} ({audioTracks.length})
                                        </button>
                                    )}
                                    <div style={{ flex: 1 }} />
                                    <span style={{ fontSize: '10px', color: 'var(--mac-text-secondary)' }}>
                                        已选 {selectedCount} 文件
                                    </span>
                                </div>
                            )}

                            {/* 空状态 */}
                            {!loading && tracks.length === 0 && (
                                <div style={{
                                    padding: '24px 16px', textAlign: 'center', fontSize: '13px',
                                    color: 'var(--mac-text-secondary)', whiteSpace: 'pre-line'
                                }}>
                                    {fetchAttempted
                                        ? '扫描完成但未发现可识别的轨道素材。\n请确认达芬奇中已打开包含素材的时间线。'
                                        : '点击上方"重新扫描"以检测当前时间线中的素材。'}
                                </div>
                            )}

                            {/* 轨道列表 */}
                            {tracks.map((track) => {
                                const trackKey = `${track.track_type}-${track.track_index}`;
                                const isExpanded = expandedTracks.has(trackKey);
                                const trackSummary = getTrackSelectionSummary(track, selectedNodeKeys);

                                return (
                                    <div key={trackKey} style={{ borderBottom: '1px solid var(--mac-border)' }}>
                                        {/* 轨道头 */}
                                        <div
                                            onClick={() => toggleTrackExpand(trackKey)}
                                            style={{
                                                display: 'flex', alignItems: 'center', padding: '8px 16px',
                                                gap: '6px', cursor: 'pointer', minHeight: '36px'
                                            }}>
                                            <ChevronRight size={12}
                                                style={{
                                                    color: 'var(--mac-text-secondary)', flexShrink: 0,
                                                    transition: 'transform 0.15s',
                                                    transform: isExpanded ? 'rotate(90deg)' : 'none'
                                                }} />
                                            <input type="checkbox"
                                                checked={isTrackFullySelected(track)}
                                                onChange={(e) => { e.stopPropagation(); toggleTrackSelection(track, e.target.checked); }}
                                                disabled={getTrackSelectableKeys(track).length === 0}
                                                onClick={(e) => e.stopPropagation()}
                                                style={{ accentColor: 'var(--mac-accent)' }}
                                            />
                                            <span style={{
                                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                                width: '20px', height: '20px', borderRadius: '4px', flexShrink: 0,
                                                background: track.track_type === 'audio' ? '#AF52FA' : '#0A84FF',
                                                color: '#fff', fontSize: '9px', fontWeight: 700
                                            }}>
                                                {track.track_type === 'audio' ? 'A' : 'V'}{track.track_index}
                                            </span>
                                            <span style={{ fontSize: '12px', fontWeight: 500, flex: 1 }}>
                                                {track.track_type === 'audio' ? '音频轨道' : '视频轨道'} {track.track_index}
                                            </span>
                                            <span style={{ fontSize: '10px', color: 'var(--mac-text-secondary)' }}>
                                                {track.clips?.length || 0} 片段
                                            </span>
                                            {trackSummary.selectedClipCount > 0 && (
                                                <span style={{ fontSize: '10px', color: 'var(--mac-accent)' }}>
                                                    {trackSummary.selectedClipCount}/{track.clips?.length || 0} 已选
                                                </span>
                                            )}
                                        </div>

                                        {/* 展开的片段列表 */}
                                        <AnimatePresence initial={false}>
                                            {isExpanded && (
                                                <motion.div
                                                    initial={{ height: 0, opacity: 0 }}
                                                    animate={{ height: 'auto', opacity: 1 }}
                                                    exit={{ height: 0, opacity: 0 }}
                                                    transition={{ duration: 0.18 }}
                                                    style={{ overflow: 'hidden' }}
                                                >
                                                    <div style={{ paddingLeft: '34px', paddingBottom: '4px' }}>
                                                        {(track.clips || []).map((clip) => renderClip(clip))}
                                                    </div>
                                                </motion.div>
                                            )}
                                        </AnimatePresence>
                                    </div>
                                );
                            })}

                            {/* 扫描告警 */}
                            {warnings.length > 0 && (
                                <details style={{ padding: '8px 16px', fontSize: '11px', cursor: 'pointer' }}>
                                    <summary style={{ color: '#FF9500' }}>查看扫描告警详情 ({warnings.length})</summary>
                                    <div style={{ padding: '6px 0' }}>
                                        {warnings.map((w, i) => (
                                            <div key={i} style={{ color: '#FF9500', fontSize: '10px', padding: '2px 0' }}>
                                                {w}
                                            </div>
                                        ))}
                                    </div>
                                </details>
                            )}
                        </div>
                    </div>

                    {/* ====== Region 4: 输出结构预览 ====== */}
                    <div className="mac-settings-section">
                        <div className="mac-settings-title">
                            输出结构预览
                            {hierarchyTree && (
                                <span style={{ fontWeight: 400, color: 'var(--mac-text-secondary)', marginLeft: '4px' }}>
                                    · {hierarchyTree.summary.file_count} 文件 · {hierarchyTree.summary.folder_count} 文件夹
                                    {hierarchyTree.summary.conflict_count > 0 && (
                                        <span style={{ color: '#FF9500' }}> · {hierarchyTree.summary.conflict_count} 冲突</span>
                                    )}
                                </span>
                            )}
                        </div>
                        <div className="mac-settings-group">
                            <div style={{ padding: '12px 16px' }}>
                                {folderConfig.depth === 0 ? (
                                    <div style={{
                                        fontSize: '12px', color: 'var(--mac-text-secondary)',
                                        padding: '8px 12px', borderRadius: '6px',
                                        background: 'rgba(255,255,255,0.02)',
                                        display: 'flex', alignItems: 'center', gap: '6px'
                                    }}>
                                        <AlertCircle size={12} />
                                        保留层数 = 0，文件将平铺到目标文件夹。调高层数可保留文件夹结构。
                                    </div>
                                ) : hierarchyLoading ? (
                                    <div style={{ fontSize: '12px', color: 'var(--mac-text-secondary)', textAlign: 'center', padding: '16px' }}>
                                        计算预览中...
                                    </div>
                                ) : hierarchyTree ? (
                                    <div style={{
                                        fontFamily: "'SF Mono', 'Menlo', monospace",
                                        fontSize: '12px', lineHeight: '2', color: 'var(--mac-text-secondary)'
                                    }}>
                                        {hierarchyTree.tree.length === 0 ? (
                                            <div style={{ textAlign: 'center', padding: '8px', color: 'var(--mac-text-secondary)' }}>
                                                文件将平铺到目标目录
                                            </div>
                                        ) : (
                                            hierarchyTree.tree.map((node, i) => {
                                                const renderTreeNode = (n, d) => (
                                                    <div key={`${n.name}-${d}`} style={{ paddingLeft: d * 16 }}>
                                                        {n.type === 'folder' ? (
                                                            <>
                                                                <div style={{ color: '#5AC8FA' }}>
                                                                    <FolderOpen size={12} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                                                                    <span style={{ color: 'var(--mac-text)' }}>{n.name}/</span>
                                                                </div>
                                                                {(n.children || []).map((c) => renderTreeNode(c, d + 1))}
                                                            </>
                                                        ) : (
                                                            <div>
                                                                <span style={{ display: 'inline-block', width: '16px' }} />
                                                                <span>{n.name}</span>
                                                                {n.size_bytes > 0 && (
                                                                    <span style={{ color: '#666', marginLeft: '8px', fontSize: '11px' }}>
                                                                        {n.size_bytes > 1024 * 1024
                                                                            ? `${(n.size_bytes / (1024 * 1024)).toFixed(1)} MB`
                                                                            : `${(n.size_bytes / 1024).toFixed(1)} KB`}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                                return renderTreeNode(node, 0);
                                            })
                                        )}
                                    </div>
                                ) : selectedPaths.length === 0 ? (
                                    <div style={{ fontSize: '12px', color: 'var(--mac-text-secondary)', textAlign: 'center', padding: '16px' }}>
                                        请在素材列表中勾选文件后预览
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    </div>

                    {/* Notice 横幅 */}
                    <AnimatePresence mode="wait">
                        {notice && (
                            <motion.div
                                key="notice"
                                initial={{ opacity: 0, y: -8 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -8 }}
                                transition={{ duration: 0.2 }}
                                style={{
                                    padding: '10px 14px', borderRadius: '10px', fontSize: '13px',
                                    marginBottom: '12px',
                                    display: 'flex', alignItems: 'center', gap: '8px',
                                    background: notice.type === 'success' ? 'rgba(52,199,89,0.1)'
                                        : notice.type === 'error' ? 'rgba(255,59,48,0.1)'
                                        : 'rgba(255,149,0,0.1)',
                                    color: notice.type === 'success' ? '#34C759'
                                        : notice.type === 'error' ? '#FF3B30'
                                        : '#FF9500'
                                }}>
                                {notice.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                                {notice.message}
                            </motion.div>
                        )}
                    </AnimatePresence>

                    {/* ====== Region 5: 打包结果 ====== */}
                    <AnimatePresence>
                        {packResult && (packResult.packed_count > 0 || packResult.failed_count > 0) && (
                            <motion.div
                                key="result"
                                initial={{ opacity: 0, y: 12 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -8 }}
                                transition={{ type: 'spring', stiffness: 180, damping: 22 }}
                                className="mac-settings-section"
                            >
                                <div className="mac-settings-title">打包结果</div>
                                <div className="mac-settings-group">
                                    <div className="mac-settings-row">
                                        <div className="mac-settings-row-left">
                                            <div className="mac-settings-icon-wrapper"
                                                style={{
                                                    background: packResult.failed_count > 0 ? '#FF9500' : '#34C759',
                                                    color: '#fff'
                                                }}>
                                                {packResult.failed_count > 0 ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
                                            </div>
                                            <div className="mac-settings-text-block">
                                                <div className="mac-settings-label">
                                                    成功 {packResult.packed_count} 个，失败 {packResult.failed_count} 个
                                                </div>
                                                <div className="mac-settings-desc">
                                                    文件已打包至目标目录
                                                </div>
                                            </div>
                                        </div>
                                        <div className="mac-settings-row-right">
                                            <button className="mac-btn"
                                                onClick={handleRevealInFinder}
                                                disabled={!destDir.trim() || packResult.packed_count <= 0}
                                                style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px' }}>
                                                <FolderSearch size={14} />
                                                在访达中显示
                                            </button>
                                        </div>
                                    </div>
                                    {Array.isArray(packResult.failed) && packResult.failed.length > 0 && (
                                        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--mac-border)' }}>
                                            <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px', color: '#FF3B30' }}>
                                                失败详情
                                            </div>
                                            {packResult.failed.map((item, index) => (
                                                <div key={index} style={{
                                                    fontSize: '11px', padding: '6px 0',
                                                    borderBottom: '1px solid var(--mac-border)',
                                                    color: 'var(--mac-text-secondary)'
                                                }}>
                                                    <div style={{ color: 'var(--mac-text)' }} title={item.path}>
                                                        {item.path.split('/').pop()}
                                                    </div>
                                                    {item.resolved_path && item.resolved_path !== item.path && (
                                                        <div title={item.resolved_path}>
                                                            兜底路径：{item.resolved_path.split('/').pop()}
                                                        </div>
                                                    )}
                                                    <div style={{ color: '#FF3B30' }}>{item.error || '打包失败'}</div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </div>
        </div>
    );
}
