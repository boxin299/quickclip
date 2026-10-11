import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Folder, FolderOpen, ChevronRight, ChevronDown, Layers,
    RefreshCw, ArrowDownToLine, CheckSquare, Square,
    Film, Music, Image, File, AlertCircle, Loader2, CheckCircle2, Info, Trash2
} from 'lucide-react';

/* ── 素材类型配置 ──────────────────────────────── */
const CLIP_TYPE_CONFIG = {
    'Video': { icon: Film, color: '#0A84FF', label: '视频' },
    'Video + Audio': { icon: Film, color: '#0A84FF', label: '视频+音频' },
    'Audio': { icon: Music, color: '#34C759', label: '音频' },
    'Image': { icon: Image, color: '#FF9500', label: '图片' },
    'Still': { icon: Image, color: '#FF9500', label: '静帧' },
    '静帧': { icon: Image, color: '#FF9500', label: '图片' },
    'Other': { icon: File, color: '#8E8E93', label: '其他' },
};

function getClipTypeDisplay(clipTypes) {
    return Object.entries(clipTypes || {})
        .sort(([, a], [, b]) => b - a)
        .map(([type, count]) => {
            const cfg = CLIP_TYPE_CONFIG[type] || CLIP_TYPE_CONFIG['Other'];
            const Icon = cfg.icon;
            return { type, count, icon: Icon, color: cfg.color, label: cfg.label };
        });
}

/* ── 文件夹树节点 ──────────────────────────────── */
function HierarchyNode({ node, level, selectedPaths, onToggle, keepLevels }) {
    const [isOpen, setIsOpen] = useState(level < 2); // 默认展开前两层
    const hasChildren = node.children && node.children.length > 0;
    const isSelected = selectedPaths.has(node.path);
    const isIndeterminate = !isSelected && node.children && node.children.length > 0 &&
        node.children.some(c => c.path && (selectedPaths.has(c.path) || c.children?.some(gc => gc.path && selectedPaths.has(gc.path))));

    // 预览：当前节点深度是否在展平范围内
    const relDepth = node.depth;
    const showFlattenHint = isSelected && keepLevels > 0 && relDepth > keepLevels;

    const clipTypes = getClipTypeDisplay(node.clip_types);

    return (
        <div style={{ marginLeft: level > 0 ? '0' : '0' }}>
            <div
                onClick={(e) => {
                    if (e.target.type === 'checkbox') return;
                    if (hasChildren) setIsOpen(!isOpen);
                }}
                style={{
                    display: 'flex', alignItems: 'center', gap: '6px',
                    padding: '6px 8px', paddingLeft: `${level * 16 + 8}px`,
                    borderRadius: '6px', cursor: 'pointer',
                    background: showFlattenHint ? 'rgba(255, 149, 0, 0.08)' : 'transparent',
                    border: showFlattenHint ? '1px solid rgba(255, 149, 0, 0.2)' : '1px solid transparent',
                    transition: 'all 0.15s',
                }}
                onMouseEnter={e => { if (!showFlattenHint) e.currentTarget.style.background = 'var(--mac-bg-secondary)'; }}
                onMouseLeave={e => { if (!showFlattenHint) e.currentTarget.style.background = 'transparent'; }}
            >
                {/* 复选框 */}
                {node.path && (
                    <input
                        type="checkbox"
                        checked={isSelected}
                        ref={el => {
                            if (el) el.indeterminate = isIndeterminate;
                        }}
                        onChange={(e) => {
                            e.stopPropagation();
                            onToggle(node.path);
                        }}
                        style={{
                            width: '14px', height: '14px', cursor: 'pointer',
                            accentColor: 'var(--mac-accent)', flexShrink: 0,
                        }}
                    />
                )}

                {/* 展开/折叠箭头 */}
                <div style={{ width: '16px', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
                    {hasChildren ? (
                        <span style={{
                            fontSize: '10px', transform: isOpen ? 'rotate(90deg)' : 'none',
                            transition: 'transform 0.15s', color: 'var(--mac-text-secondary)',
                        }}>▶</span>
                    ) : <span style={{ width: '10px' }} />}
                </div>

                {/* 文件夹图标 */}
                {isOpen && hasChildren ? (
                    <FolderOpen size={16} style={{ color: '#0A84FF', flexShrink: 0 }} />
                ) : (
                    <Folder size={16} style={{ color: node.path ? '#0A84FF' : '#FF9500', flexShrink: 0 }} />
                )}

                {/* 名称 */}
                <span style={{
                    fontSize: '13px', fontWeight: node.path ? '500' : '600',
                    color: 'var(--mac-text)', flex: 1, whiteSpace: 'nowrap',
                    overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                    {node.name}
                    {!node.path && <span style={{ fontSize: '11px', fontWeight: '400', opacity: 0.6, marginLeft: '6px' }}>(根)</span>}
                </span>

                {/* 素材统计 */}
                {node.clip_count > 0 && (
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexShrink: 0 }}>
                        {clipTypes.slice(0, 3).map(ct => (
                            <span key={ct.type} title={`${ct.label}: ${ct.count}`}
                                style={{
                                    fontSize: '10px', padding: '1px 5px', borderRadius: '3px',
                                    background: `${ct.color}18`, color: ct.color,
                                    fontWeight: '500', display: 'flex', alignItems: 'center', gap: '2px',
                                }}>
                                <ct.icon size={10} />
                                {ct.count}
                            </span>
                        ))}
                        {clipTypes.length > 3 && (
                            <span style={{ fontSize: '10px', color: 'var(--mac-text-secondary)' }}>
                                +{clipTypes.length - 3}
                            </span>
                        )}
                    </div>
                )}

                {/* 展平提示 */}
                {showFlattenHint && (
                    <span style={{
                        fontSize: '10px', color: '#FF9500', fontWeight: '500',
                        background: 'rgba(255, 149, 0, 0.1)', padding: '1px 6px',
                        borderRadius: '3px', flexShrink: 0,
                    }}>
                        将被展平
                    </span>
                )}
            </div>

            {/* 子节点 */}
            {isOpen && hasChildren && (
                <div>
                    {node.children.map(child => (
                        <HierarchyNode
                            key={child.path}
                            node={child}
                            level={level + 1}
                            selectedPaths={selectedPaths}
                            onToggle={onToggle}
                            keepLevels={keepLevels}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

/* ── 主组件 ────────────────────────────────────── */
const FileHierarchyManager = ({ apiBaseUrl, resolveStatus }) => {
    const [tree, setTree] = useState(null);
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState(null);
    const [selectedPaths, setSelectedPaths] = useState(new Set());
    const [keepLevels, setKeepLevels] = useState(3);
    const [applying, setApplying] = useState(false);
    const [flattenedPaths, setFlattenedPaths] = useState(new Set());
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const hasInitialLoaded = useRef(false);

    // 去重：移除被其他选中路径包含的子路径（避免嵌套勾选时重复计数）
    const topLevelPaths = useMemo(() => {
        if (selectedPaths.size === 0) return [];
        const paths = Array.from(selectedPaths);
        return paths.filter(p => {
            const parts = p.split('/');
            for (let i = parts.length - 1; i > 0; i--) {
                const ancestor = parts.slice(0, i).join('/');
                if (selectedPaths.has(ancestor)) return false;
            }
            return true;
        });
    }, [selectedPaths]);

    // 计算选中文件夹范围内的 Image 素材总数
    const selectedImageCount = useMemo(() => {
        if (!tree || topLevelPaths.length === 0) return 0;
        let count = 0;
        const countImages = (node) => {
            if (node.clip_types?.Image) count += node.clip_types.Image;
            if (node.clip_types?.Still) count += node.clip_types.Still;
            if (node.clip_types?.['静帧']) count += node.clip_types['静帧'];
            if (node.children) node.children.forEach(countImages);
        };
        const findAndCount = (node, path) => {
            if (node.path === path) { countImages(node); return; }
            if (node.children) node.children.forEach(c => findAndCount(c, path));
        };
        topLevelPaths.forEach(p => findAndCount(tree, p));
        return count;
    }, [tree, topLevelPaths]);

    // 删除预览数据：选中文件夹 + 每文件夹 Image 数量
    const deletePreview = useMemo(() => {
        if (!tree || topLevelPaths.length === 0 || selectedImageCount === 0) return [];
        const findNode = (node, path) => {
            if (node.path === path) return node;
            if (node.children) {
                for (const c of node.children) {
                    const found = findNode(c, path);
                    if (found) return found;
                }
            }
            return null;
        };
        const collectImages = (node) => {
            let count = 0;
            if (node.clip_types?.Image) count += node.clip_types.Image;
            if (node.clip_types?.Still) count += node.clip_types.Still;
            if (node.clip_types?.['静帧']) count += node.clip_types['静帧'];
            if (node.children) node.children.forEach(c => { count += collectImages(c); });
            return count;
        };
        return topLevelPaths.map(p => {
            const node = findNode(tree, p);
            return {
                path: p,
                name: p.split('/').pop() || p,
                imageCount: node ? collectImages(node) : 0,
            };
        }).filter(d => d.imageCount > 0);
    }, [tree, topLevelPaths, selectedImageCount]);

    // 获取层级树
    const fetchHierarchy = useCallback(async () => {
        setLoading(true);
        setMessage(null);
        try {
            const res = await axios.get(`${apiBaseUrl}/api/project/folder_hierarchy`);
            setTree(res.data.tree);
        } catch (e) {
            setMessage({ type: 'error', text: `获取层级树失败: ${e.response?.data?.detail || e.message}` });
        } finally {
            setLoading(false);
        }
    }, [apiBaseUrl]);

    // 仅在首次挂载且已连接时自动获取一次层级树
    useEffect(() => {
        if (resolveStatus.connected && resolveStatus.project && !hasInitialLoaded.current) {
            hasInitialLoaded.current = true;
            setMessage(null);
            fetchHierarchy();
        }
        if (!resolveStatus.connected || !resolveStatus.project) {
            hasInitialLoaded.current = false;
            setTree(null);
        }
    }, [resolveStatus.connected, resolveStatus.project, fetchHierarchy]);

    // 收集所有叶子路径
    const getAllLeafPaths = useCallback((node) => {
        if (!node) return [];
        if (!node.children || node.children.length === 0) {
            return node.path ? [node.path] : [];
        }
        let paths = [];
        for (const child of node.children) {
            paths = paths.concat(getAllLeafPaths(child));
        }
        return paths;
    }, []);

    // 收集所有节点路径（不仅是叶子）
    const getAllPaths = useCallback((node) => {
        if (!node) return [];
        let paths = [];
        if (node.path) paths.push(node.path);
        if (node.children) {
            for (const child of node.children) {
                paths = paths.concat(getAllPaths(child));
            }
        }
        return paths;
    }, []);

    // 切换选中
    const handleToggle = useCallback((path) => {
        setSelectedPaths(prev => {
            const next = new Set(prev);
            if (next.has(path)) {
                // 取消选中：同时取消该文件夹下所有子孙节点的选中
                next.delete(path);
                if (tree) {
                    const findNode = (node, targetPath) => {
                        if (node.path === targetPath) return node;
                        if (node.children) {
                            for (const c of node.children) {
                                const found = findNode(c, targetPath);
                                if (found) return found;
                            }
                        }
                        return null;
                    };
                    const node = findNode(tree, path);
                    if (node) {
                        const descendants = getAllPaths(node);
                        descendants.forEach(d => next.delete(d));
                    }
                }
            } else {
                next.add(path);
            }
            return next;
        });
    }, [tree, getAllPaths]);

    // 全选/取消全选
    const handleSelectAll = useCallback(() => {
        if (!tree) return;
        const allPaths = getAllPaths(tree);
        if (allPaths.length === 0) return;
        if (selectedPaths.size >= allPaths.length) {
            setSelectedPaths(new Set());
        } else {
            setSelectedPaths(new Set(allPaths));
        }
    }, [tree, selectedPaths, getAllPaths]);

    // ── 实时预览：根据 selectedPaths + keepLevels 自动计算 ──
    const previewData = useMemo(() => {
        if (!tree || selectedPaths.size === 0) return null;

        const preview = [];
        let totalClips = 0;
        const seenSources = new Set(); // 防止重复来源

        // 在树中查找节点
        const findNode = (node, targetPath) => {
            if (node.path === targetPath) return node;
            if (node.children) {
                for (const child of node.children) {
                    const found = findNode(child, targetPath);
                    if (found) return found;
                }
            }
            return null;
        };

        for (const selPath of selectedPaths) {
            const depth = selPath.split('/').length;

            // 递归收集超出保留层级的文件夹
            const findDeepFolders = (node) => {
                const results = [];
                if (!node || !node.children) return results;

                for (const child of node.children) {
                    const childDepth = child.path.split('/').length;
                    const relDepth = childDepth - depth + 1; // 选中文件夹视为第1层

                    if (relDepth > keepLevels) {
                        // 超出保留层级 — 收集该文件夹的素材，并继续递归
                        const sourcePath = child.path;
                        if (!seenSources.has(sourcePath)) {
                            seenSources.add(sourcePath);
                            if (child.clip_count > 0) {
                                results.push({
                                    source: sourcePath,
                                    clip_count: child.clip_count,
                                    clip_types: { ...child.clip_types },
                                });
                                totalClips += child.clip_count;
                            }
                        }
                        const subResults = findDeepFolders(child);
                        results.push(...subResults);
                    } else {
                        // 仍在保留层级内，递归检查子级
                        const subResults = findDeepFolders(child);
                        results.push(...subResults);
                    }
                }
                return results;
            };

            const selNode = findNode(tree, selPath);
            if (!selNode) continue;

            const deepFolders = findDeepFolders(selNode);

            if (deepFolders.length > 0) {
                // 为每个深层文件夹独立计算目标路径
                const sourcesWithTarget = deepFolders.map(d => {
                    const srcParts = d.source.split('/');
                    const tgtParts = srcParts.slice(0, depth + keepLevels - 1); // 选中文件夹为第1层
                    return {
                        ...d,
                        target: tgtParts.join('/') || selPath,
                    };
                });
                preview.push({
                    folder: selPath,
                    sources: sourcesWithTarget,
                    total_clips: deepFolders.reduce((sum, d) => sum + d.clip_count, 0),
                });
            }
        }

        if (preview.length === 0) return null;
        return { folders: preview, total_clips: totalClips, keep_levels: keepLevels };
    }, [tree, selectedPaths, keepLevels]);

    // 执行展平
    const handleApply = async () => {
        const folderPaths = Array.from(selectedPaths);
        if (folderPaths.length === 0) {
            setMessage({ type: 'error', text: '请先勾选需要处理的文件夹' });
            return;
        }
        setApplying(true);
        setMessage(null);
        try {
            const res = await axios.post(`${apiBaseUrl}/api/project/folder_hierarchy/flatten`, {
                folder_paths: folderPaths,
                keep_levels: keepLevels,
            });
            const data = res.data;
            setMessage({ type: 'success', text: data.message || `展平完成，共移动 ${data.total_moved} 个素材` });

            const newFlattened = new Set(flattenedPaths);
            if (data.details) {
                for (const d of data.details) {
                    if (d.status === 'moved') {
                        newFlattened.add(d.folder);
                    }
                }
            }
            setFlattenedPaths(newFlattened);
            setSelectedPaths(new Set());
            // 不自动刷新——展平结果已直接反映在媒体池中
        } catch (e) {
            setMessage({ type: 'error', text: `展平失败: ${e.response?.data?.detail || e.message}` });
        } finally {
            setApplying(false);
        }
    };

    // 执行图片删除
    const handleDeleteImages = async () => {
        setDeleting(true);
        setMessage(null);
        try {
            const res = await axios.post(`${apiBaseUrl}/api/project/folder_hierarchy/delete-images`, {
                folder_paths: Array.from(selectedPaths),
                keep_levels: keepLevels,
            });
            const data = res.data;
            setMessage({
                type: 'success',
                text: `已删除 ${data.deleted_count ?? 0} 张图片` +
                    (data.deleted_folder_count > 0 ? `，清理 ${data.deleted_folder_count} 个空文件夹` : ''),
            });
            setShowDeleteModal(false);
            setSelectedPaths(new Set());
            fetchHierarchy();
        } catch (e) {
            setMessage({ type: 'error', text: `删除失败: ${e.response?.data?.detail || e.message}` });
        } finally {
            setDeleting(false);
        }
    };

    const isConnected = resolveStatus.connected && resolveStatus.project;

    const renderPreviewContent = () => {
        if (!previewData) {
            return (
                <div style={{
                    padding: '40px 16px', textAlign: 'center',
                    color: 'var(--mac-text-secondary)', fontSize: '13px',
                }}>
                    <Layers size={32} style={{ opacity: 0.2, marginBottom: '12px' }} />
                    <div>勾选文件夹即可实时预览<br />展平效果</div>
                </div>
            );
        }
        return (
            <div>
                <div style={{
                    padding: '8px 12px', borderRadius: '6px',
                    background: 'rgba(10, 132, 255, 0.06)',
                    marginBottom: '12px', fontSize: '13px',
                }}>
                    <span style={{ fontWeight: '600', color: 'var(--mac-accent)' }}>
                        保留 {previewData.keep_levels} 层
                    </span>
                    <span style={{ margin: '0 4px', color: 'var(--mac-text-secondary)' }}>·</span>
                    <span style={{ color: 'var(--mac-text-secondary)' }}>
                        共移动 <strong style={{ color: '#FF9500' }}>{previewData.total_clips}</strong> 个素材
                    </span>
                </div>

                {/* 素材类型细分 */}
                {(() => {
                    const typeTotals = {};
                    for (const f of previewData.folders) {
                        for (const s of f.sources) {
                            for (const [t, c] of Object.entries(s.clip_types || {})) {
                                typeTotals[t] = (typeTotals[t] || 0) + c;
                            }
                        }
                    }
                    if (typeTotals.Image || typeTotals.Still || typeTotals['静帧']) {
                        typeTotals['图片'] = (typeTotals.Image || 0) + (typeTotals.Still || 0) + (typeTotals['静帧'] || 0);
                        delete typeTotals.Image;
                        delete typeTotals.Still;
                        delete typeTotals['静帧'];
                    }
                    const entries = Object.entries(typeTotals);
                    if (entries.length === 0) return null;
                    const typeConfig = {
                        'Video': { color: '#0A84FF', label: '视频' },
                        'Video + Audio': { color: '#0A84FF', label: '视频+音频' },
                        'Audio': { color: '#34C759', label: '音频' },
                        '图片': { color: '#FF9500', label: '图片' },
                    };
                    return (
                        <div style={{
                            padding: '8px 12px', borderRadius: '6px',
                            background: 'rgba(10, 132, 255, 0.04)',
                            marginBottom: '12px', fontSize: '12px',
                            display: 'flex', flexWrap: 'wrap', gap: '6px',
                            alignItems: 'center',
                        }}>
                            {entries.map(([t, c]) => {
                                const cfg = typeConfig[t] || { color: '#8E8E93', label: t };
                                return (
                                    <span key={t} style={{ color: cfg.color, fontWeight: '500' }}>
                                        {cfg.label} {c} 个
                                    </span>
                                );
                            }).reduce((prev, curr) => [prev, <span key="sep" style={{ color: 'var(--mac-text-secondary)', opacity: 0.4 }}>·</span>, curr])}
                        </div>
                    );
                })()}

                {previewData.folders.map((f, idx) => (
                    <div key={idx} style={{
                        marginBottom: '12px', padding: '10px',
                        border: '1px solid var(--mac-border)',
                        borderRadius: '8px', fontSize: '12px',
                    }}>
                        <div style={{
                            fontWeight: '600', color: 'var(--mac-text)',
                            marginBottom: '6px', whiteSpace: 'nowrap',
                            overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>
                            <Folder size={12} style={{ marginRight: '4px', verticalAlign: 'middle', color: '#0A84FF' }} />
                            {f.folder}
                        </div>
                        <div style={{
                            fontSize: '11px', color: 'var(--mac-text-secondary)',
                            marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '4px',
                        }}>
                            <ArrowDownToLine size={10} color="#34C759" />
                            共 {f.sources.length} 个文件夹待展平
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            {f.sources.map((s, si) => (
                                <div key={`${s.source}-${si}`}>
                                    <div style={{
                                        display: 'flex', alignItems: 'center', gap: '6px',
                                        padding: '3px 8px', borderRadius: '4px 4px 0 0',
                                        background: 'var(--mac-bg-secondary)',
                                    }}>
                                        <span style={{
                                            fontSize: '10px', color: 'var(--mac-text-secondary)',
                                            flex: 1, whiteSpace: 'nowrap',
                                            overflow: 'hidden', textOverflow: 'ellipsis',
                                        }}>
                                            {s.source.split('/').pop()}
                                        </span>
                                        <span style={{
                                            fontSize: '10px', fontWeight: '500',
                                            color: '#FF9500', whiteSpace: 'nowrap',
                                        }}>
                                            {s.clip_count} 个素材
                                        </span>
                                        {Object.entries(s.clip_types || {}).slice(0, 3).map(([t, c]) => {
                                            const cfg = CLIP_TYPE_CONFIG[t] || CLIP_TYPE_CONFIG['Other'];
                                            const Icon = cfg.icon;
                                            return (
                                                <span key={t} title={`${cfg.label}: ${c}`} style={{
                                                    fontSize: '9px', color: cfg.color,
                                                    display: 'flex', alignItems: 'center', gap: '2px',
                                                }}>
                                                    <Icon size={9} />{c}
                                                </span>
                                            );
                                        })}
                                    </div>
                                    {s.target !== s.source && (
                                        <div style={{
                                            fontSize: '10px', color: '#34C759',
                                            padding: '2px 8px', borderRadius: '0 0 4px 4px',
                                            background: 'rgba(52, 199, 89, 0.06)',
                                            display: 'flex', alignItems: 'center', gap: '4px',
                                            whiteSpace: 'nowrap',
                                            overflow: 'hidden', textOverflow: 'ellipsis',
                                        }}>
                                            <ArrowDownToLine size={9} />
                                            {s.target.split('/').pop() || s.target}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        );
    };

    return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* 顶部操作栏 — z-index 11 覆盖全局 .content-body::before 渐变涂层 */}
            <div style={{
                display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
                padding: '12px 20px', borderBottom: '1px solid var(--mac-border)',
                flexShrink: 0,
                position: 'relative', zIndex: 11,
                background: 'var(--mac-bg)',
            }}>
                {/* 保留层级设置 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Layers size={16} style={{ color: 'var(--mac-text-secondary)' }} />
                    <span style={{ fontSize: '13px', color: 'var(--mac-text-secondary)', whiteSpace: 'nowrap' }}>
                        保留层级:
                    </span>
                    <input
                        type="range"
                        min="1"
                        max="10"
                        value={keepLevels}
                        onChange={(e) => setKeepLevels(parseInt(e.target.value))}
                        style={{ flex: 1, minWidth: '60px', maxWidth: '200px', accentColor: 'var(--mac-accent)' }}
                    />
                    <span style={{
                        fontSize: '13px', fontWeight: '600', color: 'var(--mac-accent)',
                        minWidth: '28px', textAlign: 'center',
                    }}>
                        {keepLevels}
                    </span>
                </div>

                <div style={{
                    width: '1px', height: '20px',
                    background: 'var(--mac-border)', margin: '0 4px',
                }} />

                <div style={{ flex: 1 }} />

                <button
                    className="mac-btn"
                    onClick={() => setShowDeleteModal(true)}
                    disabled={!tree || loading || selectedPaths.size === 0 || selectedImageCount === 0}
                    style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                    title={
                        selectedPaths.size === 0 ? '请先勾选文件夹' :
                        selectedImageCount === 0 ? '所选文件夹中无图片' : ''
                    }
                >
                    <Trash2 size={14} />
                    删除图片 ({selectedImageCount})
                </button>

                <button
                    className="mac-btn primary"
                    onClick={handleApply}
                    disabled={!tree || loading || applying || selectedPaths.size === 0}
                    style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                    {applying ? (
                        <><Loader2 size={14} className="spin" /> 执行中...</>
                    ) : (
                        <><ArrowDownToLine size={14} /> 执行展平</>
                    )}
                </button>
            </div>

            {/* 消息提示 */}
            <AnimatePresence>
                {message && (
                    <motion.div
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        style={{
                            margin: '8px 20px 0', padding: '8px 14px', borderRadius: '8px',
                            fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px',
                            background: message.type === 'error' ? 'rgba(255, 59, 48, 0.1)' :
                                message.type === 'success' ? 'rgba(52, 199, 89, 0.1)' :
                                    'rgba(10, 132, 255, 0.1)',
                            border: `1px solid ${message.type === 'error' ? 'rgba(255, 59, 48, 0.3)' :
                                message.type === 'success' ? 'rgba(52, 199, 89, 0.3)' :
                                    'rgba(10, 132, 255, 0.3)'}`,
                        }}
                    >
                        {message.type === 'error' ? <AlertCircle size={14} color="#FF3B30" /> :
                            message.type === 'success' ? <CheckCircle2 size={14} color="#34C759" /> :
                                <Info size={14} color="#0A84FF" />}
                        <span style={{ flex: 1 }}>{message.text}</span>
                        <button
                            onClick={() => setMessage(null)}
                            style={{
                                background: 'none', border: 'none', cursor: 'pointer',
                                color: 'var(--mac-text-secondary)', fontSize: '14px',
                                padding: '0 2px',
                            }}
                        >×</button>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* 删除确认弹窗 */}
            <AnimatePresence>
                {showDeleteModal && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        style={{
                            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                            background: 'rgba(0,0,0,0.4)', zIndex: 300,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                        onClick={() => setShowDeleteModal(false)}
                    >
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            onClick={e => e.stopPropagation()}
                            style={{
                                background: 'var(--mac-bg)', borderRadius: '12px',
                                border: '1px solid var(--mac-border)',
                                width: '400px', maxHeight: '60vh',
                                display: 'flex', flexDirection: 'column',
                                boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
                            }}
                        >
                            {/* 标题 */}
                            <div style={{
                                padding: '16px 20px', borderBottom: '1px solid var(--mac-border)',
                                display: 'flex', alignItems: 'center', gap: '10px',
                                fontSize: '15px', fontWeight: '600',
                            }}>
                                <Trash2 size={18} color="#FF3B30" />
                                确认删除图片
                            </div>

                            {/* 内容 */}
                            <div style={{
                                padding: '16px 20px', flex: 1, overflowY: 'auto',
                                fontSize: '13px', color: 'var(--mac-text-secondary)',
                            }}>
                                <div style={{
                                    padding: '10px 14px', borderRadius: '8px',
                                    background: 'rgba(255, 59, 48, 0.06)',
                                    border: '1px solid rgba(255, 59, 48, 0.15)',
                                    marginBottom: '14px',
                                    fontSize: '13px', color: 'var(--mac-text)',
                                }}>
                                    将在 <strong style={{ color: '#FF3B30' }}>{deletePreview.length} 个文件夹</strong>中
                                    删除 <strong style={{ color: '#FF3B30' }}>{selectedImageCount} 张图片</strong>
                                </div>

                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                    {deletePreview.slice(0, 5).map(d => (
                                        <div key={d.path} style={{
                                            display: 'flex', alignItems: 'center', gap: '8px',
                                            padding: '6px 10px', borderRadius: '6px',
                                            background: 'var(--mac-bg-secondary)',
                                        }}>
                                            <Folder size={14} style={{ color: '#0A84FF', flexShrink: 0 }} />
                                            <span style={{
                                                flex: 1, whiteSpace: 'nowrap',
                                                overflow: 'hidden', textOverflow: 'ellipsis',
                                                color: 'var(--mac-text)',
                                            }}>{d.name}</span>
                                            <span style={{
                                                fontSize: '12px', fontWeight: '600',
                                                color: '#FF9500', flexShrink: 0,
                                            }}>{d.imageCount} 张</span>
                                        </div>
                                    ))}
                                    {deletePreview.length > 5 && (
                                        <div style={{
                                            fontSize: '12px', color: 'var(--mac-text-secondary)',
                                            textAlign: 'center', paddingTop: '4px',
                                        }}>
                                            ...及其他 {deletePreview.length - 5} 个文件夹
                                        </div>
                                    )}
                                </div>

                                <div style={{
                                    marginTop: '14px', padding: '8px 12px', borderRadius: '6px',
                                    background: 'rgba(255, 149, 0, 0.06)',
                                    fontSize: '12px', color: '#FF9500',
                                    display: 'flex', alignItems: 'center', gap: '6px',
                                }}>
                                    <Info size={13} />
                                    仅从媒体池移除，不删除磁盘文件
                                </div>
                            </div>

                            {/* 按钮 */}
                            <div style={{
                                padding: '12px 20px', borderTop: '1px solid var(--mac-border)',
                                display: 'flex', justifyContent: 'flex-end', gap: '8px',
                            }}>
                                <button
                                    className="mac-btn"
                                    onClick={() => setShowDeleteModal(false)}
                                    disabled={deleting}
                                >
                                    取消
                                </button>
                                <button
                                    className="mac-btn primary"
                                    onClick={handleDeleteImages}
                                    disabled={deleting}
                                    style={{
                                        background: '#FF3B30',
                                        display: 'flex', alignItems: 'center', gap: '6px',
                                    }}
                                >
                                    {deleting ? (
                                        <><Loader2 size={14} className="spin" /> 删除中...</>
                                    ) : (
                                        <><Trash2 size={14} /> 确认删除</>
                                    )}
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* 主内容区 */}
            <div style={{
                flex: 1, display: 'flex', overflow: 'hidden',
                padding: '12px 20px 20px', gap: '16px',
            }}>
                {/* 左侧：文件夹树 */}
                <div style={{
                    flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
                    border: '1px solid var(--mac-border)', borderRadius: '10px',
                    background: 'var(--mac-bg)',
                }}>
                    <div style={{
                        padding: '10px 14px', borderBottom: '1px solid var(--mac-border)',
                        fontSize: '12px', fontWeight: '600', color: 'var(--mac-text-secondary)',
                        display: 'flex', alignItems: 'center', gap: '6px',
                    }}>
                        <Folder size={14} /> 媒体池文件夹层级
                        <button
                            onClick={fetchHierarchy}
                            disabled={loading || !isConnected}
                            title="刷新层级"
                            style={{
                                background: 'none', border: 'none', cursor: loading ? 'wait' : 'pointer',
                                padding: '2px', borderRadius: '4px', display: 'flex',
                                alignItems: 'center', justifyContent: 'center',
                                color: 'var(--mac-text-secondary)',
                                opacity: loading ? 0.5 : 1,
                                marginLeft: 'auto',
                            }}
                        >
                            <RefreshCw size={14} className={loading ? 'spin' : ''} />
                        </button>
                        {tree && (
                            <span style={{ fontSize: '11px', fontWeight: '400', marginLeft: '6px' }}>
                                已选 {selectedPaths.size} 个
                            </span>
                        )}
                    </div>
                    <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
                        {!tree && !loading && (
                            <div style={{
                                padding: '40px 20px', textAlign: 'center',
                                color: 'var(--mac-text-secondary)', fontSize: '13px',
                            }}>
                                {isConnected ? '点击刷新图标读取媒体池结构' : '请先连接到 DaVinci Resolve 项目'}
                            </div>
                        )}
                        {loading && (
                            <div style={{
                                padding: '40px 20px', textAlign: 'center',
                                color: 'var(--mac-text-secondary)', fontSize: '13px',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                            }}>
                                <Loader2 size={16} className="spin" /> 正在读取媒体池结构...
                            </div>
                        )}
                        {tree && !loading && (
                            <HierarchyNode
                                node={tree}
                                level={0}
                                selectedPaths={selectedPaths}
                                onToggle={handleToggle}
                                keepLevels={keepLevels}
                            />
                        )}
                    </div>
                </div>

                {/* 右侧：实时预览面板 */}
                <div style={{
                    width: '340px', flexShrink: 0, display: 'flex', flexDirection: 'column',
                    overflow: 'hidden', border: '1px solid var(--mac-border)',
                    borderRadius: '10px', background: 'var(--mac-bg)',
                }}>
                    <div style={{
                        padding: '10px 14px', borderBottom: '1px solid var(--mac-border)',
                        fontSize: '12px', fontWeight: '600', color: 'var(--mac-text-secondary)',
                        display: 'flex', alignItems: 'center', gap: '6px',
                    }}>
                        <Info size={14} /> 展平预览
                    </div>
                    <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
                        {renderPreviewContent()}
                    </div>
                </div>
            </div>

            {/* spinner animation */}
            <style>{`
                @keyframes spin {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }
                .spin { animation: spin 1s linear infinite; }
            `}</style>
        </div>
    );
};

export default FileHierarchyManager;
