import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { 
    Folder, FolderOpen, Plus, Trash2, ArrowRight, 
    Save, Download, Info, Lock, ChevronRight, ChevronLeft, ChevronDown,
    HardDrive, Film, Link2, Network, Loader2, CloudOff, CheckCircle2, GripVertical,
    Sparkles, Eye, EyeOff, Copy
} from 'lucide-react';
import {
    appendSystemDavinciFolders,
    buildAutoFolderMappings,
    canReorderFolderPaths,
    getFolderDropLineY,
    getDragGhostPosition,
    getFolderDropPosition,
    getAllParentPaths,
    getPathDepth,
    mergeDavinciFolders,
    mergeLocalFolders,
    naturalCompare,
    reorderFolderPaths,
} from './folderConfigOrder';

const FOLDER_DRAG_START_THRESHOLD_PX = 6;
const SKIP_LOCAL_DELETE_CONFIRM_KEY = 'folderConfig_skipLocalDeleteConfirm';
const SKIP_DAVINCI_DELETE_CONFIRM_KEY = 'folderConfig_skipDavinciDeleteConfirm';

function hasMovedPastFolderDragThreshold(startX, startY, currentX, currentY) {
    return Math.hypot(Number(currentX || 0) - Number(startX || 0), Number(currentY || 0) - Number(startY || 0)) >= FOLDER_DRAG_START_THRESHOLD_PX;
}

function MacSelect({ value, onChange, options, placeholder, width = '100%', showPlaceholderOption = true }) {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef(null);
    const [dropdownStyle, setDropdownStyle] = useState({});

    const updatePosition = React.useCallback(() => {
        if (!triggerRef.current) return;
        const rect = triggerRef.current.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const availableBelow = viewportHeight - rect.bottom - 8;
        const maxH = Math.max(120, Math.min(320, availableBelow));
        setDropdownStyle({
            position: 'fixed',
            top: rect.bottom + 4,
            left: rect.left,
            width: rect.width,
            zIndex: 10000,
            maxHeight: maxH + 'px'
        });
    }, []);

    useEffect(() => {
        if (open) {
            updatePosition();
            const onScroll = () => updatePosition();
            window.addEventListener('scroll', onScroll, true);
            window.addEventListener('resize', onScroll);
            return () => {
                window.removeEventListener('scroll', onScroll, true);
                window.removeEventListener('resize', onScroll);
            };
        }
    }, [open, updatePosition]);

    useEffect(() => {
        const handleClickOutside = (e) => {
            if (open && triggerRef.current && !triggerRef.current.contains(e.target)) {
                const dropdownEl = document.getElementById('mac-select-dropdown');
                if (dropdownEl && dropdownEl.contains(e.target)) return;
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [open]);

    const selected = options.find(o => o.value === value);

    return (
        <div ref={triggerRef} style={{ position: 'relative', width }}>
            <div
                onClick={() => setOpen(!open)}
                style={{
                    width: '100%',
                    padding: '8px 28px 8px 12px',
                    fontSize: '13px',
                    borderRadius: '6px',
                    border: '1px solid var(--mac-border)',
                    background: 'var(--mac-input-bg)',
                    color: selected ? 'var(--mac-text)' : 'var(--mac-text-secondary)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    userSelect: 'none',
                    transition: 'border-color 0.15s',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                }}
            >
                {selected ? selected.label : placeholder}
                <ChevronDown size={14} style={{
                    position: 'absolute',
                    right: '8px',
                    top: '50%',
                    transform: `translateY(-50%) rotate(${open ? 180 : 0}deg)`,
                    transition: 'transform 0.2s',
                    pointerEvents: 'none',
                    color: 'var(--mac-text-secondary)'
                }} />
            </div>
            {open && createPortal(
                <AnimatePresence>
                    <motion.div
                        id="mac-select-dropdown"
                        initial={{ opacity: 0, y: -4, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -4, scale: 0.98 }}
                        transition={{ duration: 0.12 }}
                        style={{
                            ...dropdownStyle,
                            background: 'var(--mac-bg, #1e1e1e)',
                            border: '1px solid var(--mac-border)',
                            borderRadius: '8px',
                            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                            padding: '4px',
                            overflowY: 'auto'
                        }}
                    >
                        {showPlaceholderOption && (
                            <div
                                onClick={() => { onChange(''); setOpen(false); }}
                                style={{
                                    padding: '7px 10px',
                                    fontSize: '13px',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    color: !value ? 'var(--mac-accent)' : 'var(--mac-text)',
                                    background: !value ? 'rgba(10, 132, 255, 0.1)' : 'transparent',
                                    fontWeight: !value ? '500' : '400',
                                    transition: 'background 0.1s',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis'
                                }}
                                onMouseEnter={e => { if (value) e.currentTarget.style.background = 'var(--mac-bg-secondary, rgba(255,255,255,0.05))'; }}
                                onMouseLeave={e => { if (value) e.currentTarget.style.background = 'transparent'; }}
                            >
                                {placeholder}
                            </div>
                        )}
                        {options.map(opt => (
                            <div
                                key={opt.value}
                                onClick={() => { onChange(opt.value); setOpen(false); }}
                                style={{
                                    padding: '7px 10px',
                                    fontSize: '13px',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    color: value === opt.value ? 'var(--mac-accent)' : 'var(--mac-text)',
                                    background: value === opt.value ? 'rgba(10, 132, 255, 0.1)' : 'transparent',
                                    fontWeight: value === opt.value ? '500' : '400',
                                    transition: 'background 0.1s',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis'
                                }}
                                onMouseEnter={e => { if (value !== opt.value) e.currentTarget.style.background = 'var(--mac-bg-secondary, rgba(255,255,255,0.05))'; }}
                                onMouseLeave={e => { if (value !== opt.value) e.currentTarget.style.background = 'transparent'; }}
                            >
                                {opt.label}
                            </div>
                        ))}
                    </motion.div>
                </AnimatePresence>,
                document.body
            )}
        </div>
    );
}

const TreeItem = ({ node, level, treeKind, folders, dragState, expandedPaths, setExpandedPaths, onDragStart, onDragMove, onDropPreview, onAddChild, onAddSibling, onRemove, onRename, onReorder, isSystem, editingPath, setEditingPath, selectedPath, setSelectedPath }) => {
    const [isHovered, setIsHovered] = useState(false);
    const [editValue, setEditValue] = useState(node.name);
    const hasChildren = node.children && node.children.length > 0;
    const isOpen = expandedPaths[node.path] !== false;
    const isEditing = editingPath === node.path;
    const isSelected = selectedPath === node.path;
    const canDrag = node.path !== 'ROOT' && !isSystem && !isEditing;
    const isDragActive = dragState?.isDragging === true;
    const isDropTarget = isDragActive && dragState?.targetPath === node.path && dragState?.treeKind === treeKind;
    const dragPosition = isDropTarget ? dragState.position : null;
    const isDragOver = Boolean(dragPosition);
    const isDraggingSelf = isDragActive && dragState?.sourcePath === node.path && dragState?.treeKind === treeKind;
    
    useEffect(() => {
        if (isEditing) setEditValue(node.name);
    }, [isEditing, node.name]);

    const handleRenameSubmit = () => {
        if (editValue.trim() && editValue.trim() !== node.name) {
            onRename(node.path, editValue.trim());
        } else {
            setEditingPath(null);
        }
    };

    const updateDropPreview = (e) => {
        if (!dragState || dragState.treeKind !== treeKind) {
            onDropPreview(null);
            return;
        }
        const rect = e.currentTarget.getBoundingClientRect();
        const position = getFolderDropPosition(rect, e.clientY);
        if (!canReorderFolderPaths(folders, dragState.sourcePath, node.path, position)) {
            onDropPreview(null);
            return;
        }
        onDropPreview({
            treeKind,
            targetPath: node.path,
            position,
            dropLineY: getFolderDropLineY(rect, position),
        });
    };

    const handleMouseDown = (e) => {
        if (!canDrag || e.button !== 0 || e.target.closest('button, input, [data-tree-toggle]')) return;
        e.preventDefault();
        e.stopPropagation();
        if (setSelectedPath) setSelectedPath(node.path);
        onDragStart({
            treeKind,
            sourcePath: node.path,
            sourceName: node.name,
            startX: e.clientX,
            startY: e.clientY,
            currentX: e.clientX,
            currentY: e.clientY,
            isDragging: false,
            onReorder,
        });
    };

    const handleMouseMove = (e) => {
        if (!dragState) return;
        const shouldActivateDrag = dragState.isDragging || hasMovedPastFolderDragThreshold(
            dragState.startX,
            dragState.startY,
            e.clientX,
            e.clientY,
        );
        onDragMove(e.clientX, e.clientY, shouldActivateDrag);
        if (!shouldActivateDrag) return;
        updateDropPreview(e);
    };

    const handleDragStart = (e) => {
        if (canDrag) {
            e.preventDefault();
        }
    };

    return (
        <div>
            <div 
                data-folder-tree-item={node.path}
                draggable={false}
                onDragStart={handleDragStart}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
                onClick={() => {
                    if (node.path !== 'ROOT' && setSelectedPath) {
                        setEditingPath(null);
                        setSelectedPath(node.path);
                    }
                }}
                style={{ 
                    display: 'flex', alignItems: 'center', padding: '8px 12px', 
                    paddingLeft: `${level * 20 + 12}px`, 
                    borderRadius: '8px', marginBottom: '2px',
                    opacity: isSystem ? 0.7 : (isDraggingSelf ? 0.42 : 1),
                    background: isDragOver ? 'var(--mac-border)' : (isSelected ? 'var(--mac-accent)' : (isHovered && !isSystem && !isEditing ? 'var(--mac-input-bg)' : 'transparent')),
                    color: isSelected && !isDragOver ? '#FFF' : 'inherit',
                    transition: 'background 0.1s',
                    cursor: node.path === 'ROOT' ? 'default' : (isSystem ? 'default' : (isDraggingSelf ? 'grabbing' : 'grab')),
                    userSelect: 'none',
                    WebkitUserDrag: 'none',
                    borderTop: dragPosition === 'before' ? '2px solid var(--mac-accent)' : '2px solid transparent',
                    borderBottom: dragPosition === 'after' ? '2px solid var(--mac-accent)' : '2px solid transparent'
                }}
            >
                {canDrag ? (
                    <GripVertical
                        size={14}
                        style={{
                            marginRight: '4px',
                            color: isSelected ? 'rgba(255,255,255,0.75)' : 'var(--mac-text-secondary)',
                            opacity: isHovered || isDraggingSelf ? 0.9 : 0.45,
                            flexShrink: 0,
                        }}
                    />
                ) : (
                    <span style={{ width: '18px', flexShrink: 0 }} />
                )}
                <div 
                    data-tree-toggle="true"
                    style={{ width: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', opacity: isSelected ? 0.8 : 1, flexShrink: 0 }}
                    onClick={(e) => {
                        e.stopPropagation();
                        setExpandedPaths((prev) => ({ ...prev, [node.path]: !isOpen }));
                    }}
                >
                    {hasChildren ? (
                        <span style={{ fontSize: '10px', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.1s', color: isSelected ? '#FFF' : 'inherit' }}>▶</span>
                    ) : null}
                </div>
                
                {node.path === 'ROOT' ? <HardDrive size={16} style={{ margin: '0 8px', color: isSelected ? '#FFF' : '#FF9500' }} /> :
                 (isSystem ? <Lock size={16} style={{ margin: '0 8px', color: isSelected ? 'rgba(255,255,255,0.7)' : 'var(--mac-text-secondary)' }} /> : 
                 (isOpen && hasChildren ? <FolderOpen size={16} style={{ margin: '0 8px', color: isSelected ? '#FFF' : '#0A84FF' }} /> : 
                 <Folder size={16} style={{ margin: '0 8px', color: isSelected ? '#FFF' : '#0A84FF' }} />))}
                
                {isEditing ? (
                    <input 
                        autoFocus
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        onBlur={handleRenameSubmit}
                        onKeyDown={e => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                e.stopPropagation();
                                e.target.blur();
                            }
                            if (e.key === 'Escape') {
                                e.preventDefault();
                                e.stopPropagation();
                                setEditingPath(null);
                            }
                        }}
                        onClick={e => e.stopPropagation()}
                        style={{
                            flex: 1, fontSize: '14px', fontWeight: '500', background: 'var(--mac-bg)', 
                            border: '1px solid #0A84FF', borderRadius: '4px', padding: '2px 6px',
                            margin: 0, boxSizing: 'border-box',
                            color: 'var(--mac-text)', outline: 'none', height: '26px', lineHeight: '18px'
                        }}
                    />
                ) : (
                    <span 
                        style={{ 
                            fontSize: '14px', flex: 1, fontWeight: '500', 
                            cursor: (node.path === 'ROOT' || isSystem) ? 'default' : (isDraggingSelf ? 'grabbing' : 'grab'),
                            padding: '2px 6px', borderRadius: '4px', height: '26px', lineHeight: '18px',
                            border: '1px solid transparent', boxSizing: 'border-box', margin: 0,
                            display: 'flex', alignItems: 'center'
                        }}
                        onDoubleClick={(e) => {
                            if (node.path !== 'ROOT' && !isSystem) {
                                e.stopPropagation();
                                setEditingPath(node.path);
                            }
                        }}
                    >
                        {node.name} 
                        {isSystem && <span style={{ fontSize: '12px', opacity: 0.8, fontWeight: 'normal', marginLeft: '4px' }}>(系统)</span>}
                        {node.path === 'ROOT' && <span style={{ fontSize: '12px', opacity: 0.8, fontWeight: 'normal', marginLeft: '4px' }}>(根目录示意)</span>}
                    </span>
                )}

                {node.path === 'ROOT' && (
                    <div style={{ display: 'flex', gap: '8px', opacity: isHovered || isSelected ? 1 : 0, transition: 'opacity 0.1s' }}>
                        {onAddChild && (
                            <button className="mac-btn" onClick={(e) => { e.stopPropagation(); setExpandedPaths((prev) => ({ ...prev, [node.path]: true })); onAddChild(''); }} style={{ padding: '4px 8px', fontSize: '12px', height: 'auto', minHeight: '24px', background: isSelected ? 'rgba(255,255,255,0.2)' : undefined, color: isSelected ? '#FFF' : undefined, borderColor: isSelected ? 'transparent' : undefined }}>
                                <Plus size={12} /> 新建目录
                            </button>
                        )}
                    </div>
                )}

                {node.path !== 'ROOT' && !isSystem && !isEditing && (
                    <div style={{ display: 'flex', gap: '8px', opacity: isHovered || isSelected ? 1 : 0, transition: 'opacity 0.1s' }}>
                        {onAddSibling && (
                            <button className="mac-btn" onClick={(e) => { e.stopPropagation(); onAddSibling(node.path); }} style={{ padding: '4px 8px', fontSize: '12px', height: 'auto', minHeight: '24px', background: isSelected ? 'rgba(255,255,255,0.2)' : undefined, color: isSelected ? '#FFF' : undefined, borderColor: isSelected ? 'transparent' : undefined }}>
                                <Plus size={12} /> 同级
                            </button>
                        )}
                        {onAddChild && (
                            <button className="mac-btn" onClick={(e) => { e.stopPropagation(); setExpandedPaths((prev) => ({ ...prev, [node.path]: true })); onAddChild(node.path); }} style={{ padding: '4px 8px', fontSize: '12px', height: 'auto', minHeight: '24px', background: isSelected ? 'rgba(255,255,255,0.2)' : undefined, color: isSelected ? '#FFF' : undefined, borderColor: isSelected ? 'transparent' : undefined }}>
                                <Plus size={12} /> 子级
                            </button>
                        )}
                        {onRemove && (
                            <button
                                className="mac-btn"
                                aria-label={`删除 ${node.path}`}
                                title={`删除 ${node.path}`}
                                onClick={(e) => { e.stopPropagation(); onRemove(node.path); }}
                                style={{
                                    padding: '4px 8px',
                                    fontSize: '12px',
                                    color: isSelected ? '#FFF' : '#FF3B30',
                                    background: isSelected ? '#FF3B30' : 'rgba(255,59,48,0.1)',
                                    borderColor: 'transparent',
                                    height: 'auto',
                                    minHeight: '24px',
                                }}
                            >
                                <Trash2 size={12} />
                            </button>
                        )}
                    </div>
                )}
            </div>
            
            {isOpen && hasChildren && (
                <div>
                    {node.children.map(child => (
                        <TreeItem 
                            key={child.path} node={child} level={level + 1} 
                            treeKind={treeKind} folders={folders} dragState={dragState}
                            expandedPaths={expandedPaths} setExpandedPaths={setExpandedPaths}
                            onDragStart={onDragStart} onDragMove={onDragMove} onDropPreview={onDropPreview}
                            onAddChild={onAddChild} onAddSibling={onAddSibling} onRemove={onRemove}
                            onRename={onRename} onReorder={onReorder}
                            isSystem={child.isSystem}
                            editingPath={editingPath} setEditingPath={setEditingPath}
                            selectedPath={selectedPath} setSelectedPath={setSelectedPath}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

const MenuRow = ({ icon: Icon, title, subtitle, onClick, count, iconColor = '#0A84FF' }) => {
    return (
        <div className="mac-settings-row" onClick={onClick} style={{ cursor: 'pointer' }}>
            <div className="mac-settings-row-left">
                <div className="mac-settings-icon-wrapper" style={{ background: iconColor, color: '#fff' }}>
                    <Icon size={16} />
                </div>
                <div className="mac-settings-text-block">
                    <div className="mac-settings-label">{title}</div>
                    {subtitle && <div className="mac-settings-desc">{subtitle}</div>}
                </div>
            </div>
            <div className="mac-settings-row-right">
                {count !== undefined && <span style={{ fontSize: '13px', color: 'var(--mac-text-secondary)', marginRight: '8px' }}>{count}</span>}
                <ChevronRight size={16} color="var(--mac-text-secondary)" />
            </div>
        </div>
    );
};

const FolderConfigGraph = ({ apiBaseUrl, activePage: activePageProp, setActivePage: setActivePageProp, embedded }) => {
    const [_activePage, _setActivePage] = useState('menu');
    const activePage = activePageProp !== undefined ? activePageProp : _activePage;
    const setActivePage = setActivePageProp || _setActivePage;
    const [localFolders, setLocalFolders] = useState(() => {
        try { return JSON.parse(localStorage.getItem('folderConfig_localFolders')) || []; } catch { return []; }
    });
    const [davinciFolders, setDavinciFolders] = useState(() => {
        try { return JSON.parse(localStorage.getItem('folderConfig_davinciFolders')) || []; } catch { return []; }
    });
    const [mappings, setMappings] = useState(() => {
        try { return JSON.parse(localStorage.getItem('folderConfig_mappings')) || {}; } catch { return {}; }
    });
    
    const [mappingLocalPath, setMappingLocalPath] = useState('');
    const [mappingDavinciPath, setMappingDavinciPath] = useState('');
    
    useEffect(() => {
        localStorage.setItem('folderConfig_localFolders', JSON.stringify(localFolders));
    }, [localFolders]);

    useEffect(() => {
        localStorage.setItem('folderConfig_davinciFolders', JSON.stringify(davinciFolders));
    }, [davinciFolders]);

    useEffect(() => {
        localStorage.setItem('folderConfig_mappings', JSON.stringify(mappings));
    }, [mappings]);

    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState(null);
    const [syncStatus, setSyncStatus] = useState('saved'); // 'idle', 'saving', 'saved', 'error'

    // Inline Editing state
    const [editingPath, setEditingPath] = useState(null);
    const [selectedPath, setSelectedPath] = useState(null);
    const [past, setPast] = useState([]); // For undo history
    const [dragState, setDragState] = useState(null);
    const [expandedPaths, setExpandedPaths] = useState({});
    
    // Modals state
    const [confirmModal, setConfirmModal] = useState({ show: false, title: '', message: '', onConfirm: null, skipPreferenceKey: null });
    const [skipDeleteConfirmChecked, setSkipDeleteConfirmChecked] = useState(false);
    const [resetModal, setResetModal] = useState({ show: false, title: '', message: '', onConfirm: null });
    const [depthModal, setDepthModal] = useState({ show: false, selectedPath: '' });
    const [importDepth, setImportDepth] = useState(2);
    const [davinciDepthModal, setDavinciDepthModal] = useState({ show: false });
    const [importDavinciDepth, setImportDavinciDepth] = useState(2);
    const [resolveConnected, setResolveConnected] = useState(false);
    const [showMappingChildren, setShowMappingChildren] = useState(false);
    const pollingRef = useRef(null);

    useEffect(() => {
        const checkConnection = async () => {
            try {
                const res = await axios.get(`${apiBaseUrl}/api/status`);
                setResolveConnected(res.data.connected === true);
            } catch {
                setResolveConnected(false);
            }
        };
        checkConnection();
        pollingRef.current = setInterval(checkConnection, 10000);
        return () => {
            if (pollingRef.current) clearInterval(pollingRef.current);
        };
    }, [apiBaseUrl]);

    useEffect(() => {
        if (!dragState) return undefined;
        const handleMouseMove = (e) => {
            setDragState((prev) => {
                if (!prev) return prev;
                const isDragging = prev.isDragging || hasMovedPastFolderDragThreshold(
                    prev.startX,
                    prev.startY,
                    e.clientX,
                    e.clientY,
                );
                return {
                    ...prev,
                    currentX: e.clientX,
                    currentY: e.clientY,
                    isDragging,
                };
            });
        };
        const handleMouseUp = () => {
            const { sourcePath, targetPath, position, onReorder, isDragging } = dragState;
            if (isDragging && targetPath && position && onReorder) {
                onReorder(sourcePath, targetPath, position);
                return;
            }
            setDragState(null);
        };
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') setDragState(null);
        };
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [dragState]);

    // Build Trees from flat paths
    const buildTree = (paths, systemPaths = []) => {
        const root = { name: '项目根目录', path: 'ROOT', children: [] };
        paths.forEach(p => {
            const parts = p.split('/');
            let current = root;
            let currentPath = '';
            parts.forEach((part) => {
                currentPath = currentPath ? `${currentPath}/${part}` : part;
                let child = current.children.find(c => c.name === part);
                if (!child) {
                    child = { 
                        name: part, 
                        path: currentPath, 
                        children: [],
                        isSystem: systemPaths.includes(currentPath)
                    };
                    current.children.push(child);
                }
                current = child;
            });
        });
        return [root];
    };

    const localTree = useMemo(() => buildTree(localFolders), [localFolders]);
    const localFoldersWithParents = useMemo(() => getAllParentPaths(localFolders, { sort: true }), [localFolders]);
    
    const davinciTreePaths = useMemo(() => {
        return appendSystemDavinciFolders(davinciFolders);
    }, [davinciFolders]);
    const davinciTree = useMemo(() => buildTree(davinciTreePaths, ["时间线", "时间线备份"]), [davinciTreePaths]);
    const davinciFoldersWithParents = useMemo(() => {
        const basePaths = [...davinciFolders, "时间线", "时间线备份"];
        return getAllParentPaths(basePaths, { sort: true });
    }, [davinciFolders]);

    const getVisibleFolderPaths = () => Array.from(document.querySelectorAll('[data-folder-tree-item]'))
        .map((item) => item.getAttribute('data-folder-tree-item'))
        .filter((path) => path && path !== 'ROOT');

    const hasVisibleChildren = (path, treeKind = activePage) => {
        if (!path || path === 'ROOT') return false;
        const paths = treeKind === 'davinci' ? davinciTreePaths : localFoldersWithParents;
        return paths.some((candidate) => candidate.startsWith(`${path}/`));
    };

    const isPathExpanded = (path) => expandedPaths[path] !== false;

    const getSelectionAfterRemoving = (path, fallbackPaths) => {
        const visiblePaths = getVisibleFolderPaths();
        const currentIndex = visiblePaths.findIndex((candidate) => candidate === path);
        const remainingVisible = visiblePaths.filter((candidate) => candidate !== path && !candidate.startsWith(`${path}/`));
        if (remainingVisible.length > 0) {
            const nextIndex = currentIndex < 0 ? 0 : Math.min(currentIndex, remainingVisible.length - 1);
            return remainingVisible[nextIndex];
        }
        return fallbackPaths.find((candidate) => candidate !== path && !candidate.startsWith(`${path}/`)) || null;
    };

    useEffect(() => {
        const fetchConfig = async () => {
            try {
                const res = await axios.get(`${apiBaseUrl}/api/folder_config`);
                setLocalFolders(res.data.local_folders || []);
                setDavinciFolders(res.data.davinci_folders || []);
                
                const newMappings = {};
                Object.entries(res.data.mapping || {}).forEach(([k, v]) => {
                    newMappings[k] = { target: v, include_sub: true };
                });
                setMappings(newMappings);
            } catch (e) {
                console.error("加载配置失败", e);
            }
        };
        fetchConfig();
    }, [apiBaseUrl]);

    const commitChange = (newLocal, newDavinci, newMappings) => {
        setPast(prev => [...prev, { local: localFolders, davinci: davinciFolders, mapping: mappings }]);
        setLocalFolders(newLocal);
        setDavinciFolders(newDavinci);
        if (newMappings) setMappings(newMappings);
        
        // Auto Save
        const flatMapping = {};
        Object.entries(newMappings || mappings).forEach(([k, v]) => { flatMapping[k] = v.target; });
        
        setSyncStatus('saving');
        axios.post(`${apiBaseUrl}/api/folder_config`, {
            local_folders: newLocal,
            davinci_folders: newDavinci,
            mapping: flatMapping
        }).then(() => {
            setSyncStatus('saved');
            if (message?.text?.includes('保存')) setMessage(null);
        }).catch(e => {
            setSyncStatus('error');
            // If it's a network error (offline), we don't show a big red alert since it's already saved to localStorage
            if (e.message !== 'Network Error' && e.code !== 'ERR_NETWORK') {
                const errDetail = e.response?.data?.detail || e.message;
                setMessage({ type: 'error', text: `同步到后端失败: ${errDetail}` });
            }
            console.error("同步到后端失败", e);
        });
    };

    // Keyboard Shortcuts for Undo & New
    useEffect(() => {
        const handleKeyDown = (e) => {
            const activeElement = document.activeElement;
            const isEditingInput = activeElement?.tagName === 'INPUT' || activeElement?.tagName === 'TEXTAREA';

            if (!isEditingInput && !confirmModal.show && (activePage === 'local' || activePage === 'davinci')) {
                if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && selectedPath && selectedPath !== 'ROOT') {
                    if (hasVisibleChildren(selectedPath, activePage)) {
                        e.preventDefault();
                        setEditingPath(null);
                        setExpandedPaths((prev) => ({ ...prev, [selectedPath]: e.key === 'ArrowRight' }));
                    }
                    return;
                }

                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    const visiblePaths = getVisibleFolderPaths();
                    if (visiblePaths.length > 0) {
                        e.preventDefault();
                        setEditingPath(null);
                        const currentIndex = Math.max(0, visiblePaths.indexOf(selectedPath));
                        const direction = e.key === 'ArrowDown' ? 1 : -1;
                        const nextIndex = Math.min(visiblePaths.length - 1, Math.max(0, currentIndex + direction));
                        setSelectedPath(visiblePaths[nextIndex]);
                    }
                    return;
                }

                if (e.key === 'Enter' && selectedPath && selectedPath !== 'ROOT') {
                    e.preventDefault();
                    if (activePage === 'davinci' && (selectedPath === '时间线' || selectedPath === '时间线备份')) return;
                    setEditingPath(selectedPath);
                    return;
                }

                if ((e.metaKey || e.ctrlKey) && (e.key === 'Backspace' || e.key === 'Delete') && selectedPath && selectedPath !== 'ROOT') {
                    e.preventDefault();
                    if (activePage === 'local') {
                        performRemoveLocal(selectedPath);
                    } else {
                        performRemoveDavinci(selectedPath);
                    }
                    return;
                }
            }

            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
                if (isEditingInput) return;
                e.preventDefault();
                setPast(prev => {
                    if (prev.length === 0) return prev;
                    const newPast = [...prev];
                    const lastState = newPast.pop();
                    setLocalFolders(lastState.local);
                    setDavinciFolders(lastState.davinci);
                    setMappings(lastState.mapping);
                    
                    const flatMapping = {};
                    Object.entries(lastState.mapping).forEach(([k, v]) => { flatMapping[k] = v.target; });
                    
                    setSyncStatus('saving');
                    axios.post(`${apiBaseUrl}/api/folder_config`, {
                        local_folders: lastState.local, davinci_folders: lastState.davinci, mapping: flatMapping
                    }).then(() => {
                        setSyncStatus('saved');
                        if (message?.text?.includes('撤销')) setMessage(null);
                    }).catch(e => {
                        setSyncStatus('error');
                        console.error("撤销后保存失败", e);
                    });
                    
                    return newPast;
                });
            }
            
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
                if (confirmModal.show) return;
                
                // Force blur on the active input (which triggers save/commit) BEFORE creating new folder
                if (isEditingInput) {
                    activeElement.blur();
                }
                
                e.preventDefault();
                const isShift = e.shiftKey;
                
                // Allow a tiny delay for blur event to process the rename commit
                setTimeout(() => {
                    if (activePage === 'local') {
                        if (isShift) {
                            // Cmd + Shift + N: Create Child
                            if (selectedPath && selectedPath !== 'ROOT') handleAddLocal(selectedPath);
                            else handleAddLocal('');
                        } else {
                            // Cmd + N: Create Sibling
                            if (selectedPath && selectedPath !== 'ROOT') handleAddLocalSibling(selectedPath);
                            else handleAddLocal('');
                        }
                    } else if (activePage === 'davinci') {
                        if (isShift) {
                            if (selectedPath && selectedPath !== 'ROOT') handleAddDavinci(selectedPath);
                            else handleAddDavinci('');
                        } else {
                            if (selectedPath && selectedPath !== 'ROOT') handleAddDavinciSibling(selectedPath);
                            else handleAddDavinci('');
                        }
                    }
                }, 50);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [activePage, confirmModal.show, past, localFolders, davinciFolders, mappings, apiBaseUrl, selectedPath, expandedPaths]);

    // Inline Create & Rename Actions
    const generateNewName = (basePath, list) => {
        let newName = "未命名文件夹";
        let newPath = basePath ? `${basePath}/${newName}` : newName;
        let counter = 1;
        while (list.includes(newPath)) {
            newName = `未命名文件夹 ${counter}`;
            newPath = basePath ? `${basePath}/${newName}` : newName;
            counter++;
        }
        return newPath;
    };

    const insertFolderAfterSubtree = (list, newPath, afterPath) => {
        if (!afterPath) return [...list, newPath];
        let insertIndex = list.findIndex((path) => path === afterPath || path.startsWith(`${afterPath}/`));
        if (insertIndex < 0) return [...list, newPath];
        while (
            insertIndex + 1 < list.length
            && list[insertIndex + 1].startsWith(`${afterPath}/`)
        ) {
            insertIndex += 1;
        }
        const next = [...list];
        next.splice(insertIndex + 1, 0, newPath);
        return next;
    };

    const handleFolderDragStart = (nextDragState) => {
        setDragState(nextDragState);
    };

    const handleFolderDragMove = (currentX, currentY, shouldActivateDrag = true) => {
        setDragState((prev) => prev ? {
            ...prev,
            currentX,
            currentY,
            isDragging: prev.isDragging || shouldActivateDrag,
        } : prev);
    };

    const handleDropPreview = (preview) => {
        setDragState((prev) => {
            if (!prev) return prev;
            if (!preview) return { ...prev, targetPath: null, position: null, dropLineY: null };
            return { ...prev, ...preview };
        });
    };

    const finishReorder = (callback) => {
        callback();
        setDragState(null);
    };

    const handleReorderLocal = (sourcePath, targetPath, position = 'before') => {
        const newFolders = reorderFolderPaths(localFolders, sourcePath, targetPath, position);
        finishReorder(() => commitChange(newFolders, davinciFolders, mappings));
    };

    const handleReorderDavinci = (sourcePath, targetPath, position = 'before') => {
        if (sourcePath === '时间线' || sourcePath === '时间线备份' || targetPath === '时间线' || targetPath === '时间线备份') return;
        const newFolders = reorderFolderPaths(davinciFolders, sourcePath, targetPath, position);
        finishReorder(() => commitChange(localFolders, newFolders, mappings));
    };

    const handleAddLocal = (parentPath = '', options = {}) => {
        const p = parentPath === 'ROOT' ? '' : parentPath;
        const newPath = generateNewName(p, localFolders);
        const newList = insertFolderAfterSubtree(localFolders, newPath, options.afterPath || p);
        commitChange(newList, davinciFolders);
        if (p) setExpandedPaths((prev) => ({ ...prev, [p]: true }));
        setSelectedPath(newPath);
        setEditingPath(newPath);
    };

    const handleAddLocalSibling = (path) => {
        if (path === 'ROOT') return;
        const parts = path.split('/');
        parts.pop();
        handleAddLocal(parts.join('/'), { afterPath: path });
    };

    const handleAddDavinci = (parentPath = '', options = {}) => {
        const p = parentPath === 'ROOT' ? '' : parentPath;
        const newPath = generateNewName(p, davinciFolders);
        const newList = insertFolderAfterSubtree(davinciFolders, newPath, options.afterPath || p);
        commitChange(localFolders, newList);
        if (p) setExpandedPaths((prev) => ({ ...prev, [p]: true }));
        setSelectedPath(newPath);
        setEditingPath(newPath);
    };

    const handleAddDavinciSibling = (path) => {
        if (path === 'ROOT') return;
        const parts = path.split('/');
        parts.pop();
        handleAddDavinci(parts.join('/'), { afterPath: path });
    };

    const handleRenameLocal = (oldPath, newName) => {
        const parts = oldPath.split('/');
        parts.pop();
        const parentPath = parts.join('/');
        const newPath = parentPath ? `${parentPath}/${newName}` : newName;
        
        if (oldPath === newPath) { setEditingPath(null); return; }
        if (localFolders.includes(newPath)) {
            setMessage({ type: 'error', text: `文件夹 "${newName}" 已存在。` });
            setEditingPath(null);
            return;
        }

        const newList = localFolders.map(p => {
            if (p === oldPath) return newPath;
            if (p.startsWith(oldPath + '/')) return newPath + p.substring(oldPath.length);
            return p;
        });
        
        const newMappings = { ...mappings };
        let mappingChanged = false;
        Object.keys(newMappings).forEach(k => {
            if (k === oldPath) {
                newMappings[newPath] = newMappings[k];
                delete newMappings[k];
                mappingChanged = true;
            } else if (k.startsWith(oldPath + '/')) {
                const updatedKey = newPath + k.substring(oldPath.length);
                newMappings[updatedKey] = newMappings[k];
                delete newMappings[k];
                mappingChanged = true;
            }
        });

        commitChange(newList, davinciFolders, mappingChanged ? newMappings : null);
        setSelectedPath((current) => {
            if (current === oldPath) return newPath;
            if (current?.startsWith(`${oldPath}/`)) return newPath + current.substring(oldPath.length);
            return current;
        });
        setEditingPath(null);
    };

    const handleRenameDavinci = (oldPath, newName) => {
        if (oldPath === "时间线" || oldPath === "时间线备份") {
            setEditingPath(null); return;
        }
        const parts = oldPath.split('/');
        parts.pop();
        const parentPath = parts.join('/');
        const newPath = parentPath ? `${parentPath}/${newName}` : newName;
        
        if (oldPath === newPath) { setEditingPath(null); return; }
        if (davinciFolders.includes(newPath) || newPath === "时间线" || newPath === "时间线备份") {
            setMessage({ type: 'error', text: `媒体池文件夹 "${newName}" 已存在或受保护。` });
            setEditingPath(null);
            return;
        }

        const newList = davinciFolders.map(p => {
            if (p === oldPath) return newPath;
            if (p.startsWith(oldPath + '/')) return newPath + p.substring(oldPath.length);
            return p;
        });
        
        const newMappings = { ...mappings };
        let mappingChanged = false;
        Object.entries(newMappings).forEach(([k, v]) => {
            if (v.target === oldPath) {
                newMappings[k].target = newPath;
                mappingChanged = true;
            } else if (v.target.startsWith(oldPath + '/')) {
                newMappings[k].target = newPath + v.target.substring(oldPath.length);
                mappingChanged = true;
            }
        });

        commitChange(localFolders, newList, mappingChanged ? newMappings : null);
        setSelectedPath((current) => {
            if (current === oldPath) return newPath;
            if (current?.startsWith(`${oldPath}/`)) return newPath + current.substring(oldPath.length);
            return current;
        });
        setEditingPath(null);
    };

    const closeConfirmModal = () => {
        setConfirmModal({ show: false, title: '', message: '', onConfirm: null, skipPreferenceKey: null });
        setSkipDeleteConfirmChecked(false);
    };

    const performRemoveLocal = (path) => {
        const newList = localFolders.filter(p => p !== path && !p.startsWith(path + '/'));
        const nextSelection = getSelectionAfterRemoving(path, newList);
        const newMappings = { ...mappings };
        let mappingChanged = false;
        Object.keys(newMappings).forEach(k => {
            if (k === path || k.startsWith(path + '/')) {
                delete newMappings[k];
                mappingChanged = true;
            }
        });
        commitChange(newList, davinciFolders, mappingChanged ? newMappings : null);
        setSelectedPath((current) => (current === path || current?.startsWith(path + '/') ? nextSelection : current));
        setEditingPath(null);
        setExpandedPaths((prev) => {
            const next = { ...prev };
            Object.keys(next).forEach((key) => {
                if (key === path || key.startsWith(`${path}/`)) delete next[key];
            });
            return next;
        });
    };

    const performRemoveDavinci = (path) => {
        if (path === "时间线" || path === "时间线备份") return;
        const newList = davinciFolders.filter(p => p !== path && !p.startsWith(path + '/'));
        const nextSelection = getSelectionAfterRemoving(path, newList);
        const newMappings = { ...mappings };
        let mappingChanged = false;
        Object.entries(newMappings).forEach(([k, v]) => {
            if (v.target === path || v.target.startsWith(path + '/')) {
                delete newMappings[k];
                mappingChanged = true;
            }
        });
        commitChange(localFolders, newList, mappingChanged ? newMappings : null);
        setSelectedPath((current) => (current === path || current?.startsWith(path + '/') ? nextSelection : current));
        setEditingPath(null);
        setExpandedPaths((prev) => {
            const next = { ...prev };
            Object.keys(next).forEach((key) => {
                if (key === path || key.startsWith(`${path}/`)) delete next[key];
            });
            return next;
        });
    };

    const handleImportLocal = async () => {
        if (!window.electronAPI?.selectDirectory) {
            setMessage({ type: 'error', text: '当前环境不支持选择文件夹。' });
            return;
        }
        
        const selectedPath = await window.electronAPI.selectDirectory();
        if (selectedPath) {
            setDepthModal({ show: true, selectedPath });
        }
    };

    const confirmImportLocal = async () => {
        setDepthModal({ show: false, selectedPath: '' });
        setLoading(true);
        setMessage({ type: 'info', text: `正在读取目录结构 (层级: ${importDepth})...` });
        try {
            const folders = await window.electronAPI.readLocalFolders(depthModal.selectedPath, importDepth);
            if (folders && folders.length > 0) {
                const newFolders = mergeLocalFolders([], folders);
                commitChange(newFolders, davinciFolders);
                setMessage({ type: 'success', text: `成功导入 ${folders.length} 个文件夹结构！` });
            } else {
                setMessage({ type: 'info', text: '该目录下没有找到子文件夹。' });
            }
        } catch (e) {
            setMessage({ type: 'error', text: '读取目录失败：' + e.message });
        } finally {
            setLoading(false);
        }
    };

    const handleRemoveLocal = (path) => {
        if (localStorage.getItem(SKIP_LOCAL_DELETE_CONFIRM_KEY) === 'true') {
            performRemoveLocal(path);
            return;
        }
        setSkipDeleteConfirmChecked(false);
        setConfirmModal({
            show: true,
            title: '删除本地文件夹',
            message: `确定删除本地文件夹 "${path}" 及其子文件夹吗？此操作也会移除相关的映射规则。`,
            skipPreferenceKey: SKIP_LOCAL_DELETE_CONFIRM_KEY,
            onConfirm: (shouldSkipConfirm) => {
                if (shouldSkipConfirm) localStorage.setItem(SKIP_LOCAL_DELETE_CONFIRM_KEY, 'true');
                performRemoveLocal(path);
                closeConfirmModal();
            }
        });
    };

    const handleRemoveDavinci = (path) => {
        if(path === "时间线" || path === "时间线备份") return;
        if (localStorage.getItem(SKIP_DAVINCI_DELETE_CONFIRM_KEY) === 'true') {
            performRemoveDavinci(path);
            return;
        }
        setSkipDeleteConfirmChecked(false);
        setConfirmModal({
            show: true,
            title: '删除媒体池文件夹',
            message: `确定删除达芬奇文件夹 "${path}" 及其子文件夹吗？此操作也会移除相关的映射规则。`,
            skipPreferenceKey: SKIP_DAVINCI_DELETE_CONFIRM_KEY,
            onConfirm: (shouldSkipConfirm) => {
                if (shouldSkipConfirm) localStorage.setItem(SKIP_DAVINCI_DELETE_CONFIRM_KEY, 'true');
                performRemoveDavinci(path);
                closeConfirmModal();
            }
        });
    };

    const handleClearLocal = () => {
        setConfirmModal({
            show: true,
            title: '清空本地项目结构',
            message: '确定要清空所有的本地文件夹结构吗？此操作也会移除相关的映射规则。',
            onConfirm: () => {
                const newMappings = { ...mappings };
                Object.keys(newMappings).forEach(k => delete newMappings[k]);
                commitChange([], davinciFolders, newMappings);
                setConfirmModal({ show: false, title: '', message: '', onConfirm: null });
            }
        });
    };

    const handleClearDavinci = () => {
        setConfirmModal({
            show: true,
            title: '清空媒体池箱结构',
            message: '确定要清空所有的达芬奇媒体池结构吗？此操作也会移除相关的映射规则。',
            onConfirm: () => {
                const newMappings = { ...mappings };
                Object.keys(newMappings).forEach(k => delete newMappings[k]);
                commitChange(localFolders, [], newMappings);
                setConfirmModal({ show: false, title: '', message: '', onConfirm: null });
            }
        });
    };

    const handleResetMappings = () => {
        setResetModal({
            show: true,
            title: '恢复默认映射规则',
            message: '恢复默认规则会恢复本地文件结构以及 DaVinci Resolve 媒体池结构，需要点击确定之后才能恢复导入映射规则',
            onConfirm: () => {
                const defaultLocal = [
                    "00筹备",
                    "01原始素材/摄影机素材",
                    "01原始素材/网络素材-原始",
                    "01原始素材/其他素材",
                    "02代理素材/网络素材-小样",
                    "03音频/音乐",
                    "03音频/音效",
                    "03音频/VO",
                    "04包装",
                    "05特效",
                    "06静帧",
                    "07输出",
                    "08交付",
                    "09工程文件"
                ];
                
                const defaultDavinci = [
                    "原始素材/摄影机素材",
                    "原始素材/网络素材-原始",
                    "原始素材/其他素材",
                    "代理素材/网络素材-小样",
                    "音频/音乐",
                    "音频/音效",
                    "音频/VO",
                    "包装",
                    "特效",
                    "静帧"
                ];

                const defaultMappings = {
                    "01原始素材/摄影机素材": { target: "原始素材/摄影机素材", include_sub: true },
                    "01原始素材/网络素材-原始": { target: "原始素材/网络素材-原始", include_sub: true },
                    "01原始素材/其他素材": { target: "原始素材/其他素材", include_sub: true },
                    "02代理素材/网络素材-小样": { target: "代理素材/网络素材-小样", include_sub: true },
                    "03音频/音乐": { target: "音频/音乐", include_sub: true },
                    "03音频/音效": { target: "音频/音效", include_sub: true },
                    "03音频/VO": { target: "音频/VO", include_sub: true },
                    "04包装": { target: "包装", include_sub: true },
                    "05特效": { target: "特效", include_sub: true },
                    "06静帧": { target: "静帧", include_sub: true },
                };
                
                commitChange(defaultLocal, defaultDavinci, defaultMappings);
                setResetModal({ show: false, title: '', message: '', onConfirm: null });
                setMessage({ type: 'success', text: '已恢复默认映射规则！' });
            }
        });
    };

    const handleClearMappings = () => {
        setConfirmModal({
            show: true,
            title: '清空所有映射规则',
            message: '确定要清空所有的目录映射绑定吗？',
            onConfirm: () => {
                commitChange(localFolders, davinciFolders, {});
                setConfirmModal({ show: false, title: '', message: '', onConfirm: null });
            }
        });
    };

    const handleResetLocal = () => {
        setConfirmModal({
            show: true,
            title: '重置本地项目结构',
            message: '确定要将本地项目结构恢复为默认状态吗？此操作将丢失所有自定义的本地文件夹结构和相关的映射规则。',
            onConfirm: () => {
                const defaultLocal = [
                    "00筹备",
                    "01原始素材/摄影机素材",
                    "01原始素材/网络素材-原始",
                    "01原始素材/其他素材",
                    "02代理素材/网络素材-小样",
                    "03音频/音乐",
                    "03音频/音效",
                    "03音频/VO",
                    "04包装",
                    "05特效",
                    "06静帧",
                    "07输出",
                    "08交付",
                    "09工程文件"
                ];
                
                const newMappings = { ...mappings };
                let mappingChanged = false;
                Object.keys(newMappings).forEach(k => {
                    // Check if the local path is still in the default list
                    if (!defaultLocal.some(lp => k === lp || k.startsWith(lp + '/'))) {
                        delete newMappings[k];
                        mappingChanged = true;
                    }
                });
                
                commitChange(defaultLocal, davinciFolders, mappingChanged ? newMappings : null);
                setConfirmModal({ show: false, title: '', message: '', onConfirm: null });
            }
        });
    };

    const handleResetDavinci = () => {
        setConfirmModal({
            show: true,
            title: '重置达芬奇媒体池结构',
            message: '确定要将达芬奇媒体池结构恢复为默认状态吗？此操作将丢失所有自定义的箱(Bin)结构和相关的映射规则。',
            onConfirm: () => {
                const defaultDavinci = [
                    "原始素材/摄影机素材",
                    "原始素材/网络素材-原始",
                    "原始素材/其他素材",
                    "代理素材/网络素材-小样",
                    "音频/音乐",
                    "音频/音效",
                    "音频/VO",
                    "包装",
                    "特效",
                    "静帧"
                ];
                
                const newMappings = { ...mappings };
                let mappingChanged = false;
                Object.entries(newMappings).forEach(([k, v]) => {
                    // Check if the target is still in the default list
                    if (!defaultDavinci.some(dp => v.target === dp || v.target.startsWith(dp + '/'))) {
                        delete newMappings[k];
                        mappingChanged = true;
                    }
                });
                
                commitChange(localFolders, defaultDavinci, mappingChanged ? newMappings : null);
                setConfirmModal({ show: false, title: '', message: '', onConfirm: null });
            }
        });
    };

    // Mapping Actions
    const handleCreateMapping = () => {
        if (!mappingLocalPath || !mappingDavinciPath) return;

        // 冲突检测 1: 检查是否存在已映射的父目录（包含子目录）
        for (const [existingPath, config] of Object.entries(mappings)) {
            if (config.include_sub && mappingLocalPath.startsWith(existingPath + '/')) {
                setMessage({ 
                    type: 'error', 
                    text: `无法添加映射：父目录 "${existingPath}" 已开启“包含子目录”，其所有子目录已被自动覆盖。` 
                });
                return;
            }
        }

        // 冲突检测 2: 检查是否已存在该路径的映射
        if (mappings[mappingLocalPath]) {
            setMessage({ 
                type: 'error', 
                text: `路径 "${mappingLocalPath}" 已存在映射规则，请先删除现有规则后再添加。` 
            });
            return;
        }

        const newMappings = {
            ...mappings,
            [mappingLocalPath]: { target: mappingDavinciPath, include_sub: true }
        };
        commitChange(localFolders, davinciFolders, newMappings);
        
        setMappingLocalPath('');
        setMappingDavinciPath('');
        setMessage({ type: 'success', text: '映射规则已添加并自动保存！' });
    };

    const handleRemoveMapping = (localPath) => {
        const newMappings = { ...mappings };
        delete newMappings[localPath];
        commitChange(localFolders, davinciFolders, newMappings);
    };

    const toggleIncludeSub = (localPath) => {
        const newMappings = { ...mappings };
        const newValue = !newMappings[localPath].include_sub;

        if (newValue) {
            // 如果开启包含子目录，检查是否有子目录已被单独映射
            const conflictingSubPaths = Object.keys(newMappings).filter(
                p => p !== localPath && p.startsWith(localPath + '/')
            );

            if (conflictingSubPaths.length > 0) {
                setMessage({ 
                    type: 'error', 
                    text: `无法开启“包含子目录”：以下子目录已有单独映射：${conflictingSubPaths.join(', ')}。请先删除这些子目录映射。` 
                });
                return;
            }
        }

        newMappings[localPath].include_sub = newValue;
        commitChange(localFolders, davinciFolders, newMappings);
    };

    const handleAutoMapping = () => {
        const result = buildAutoFolderMappings({
            localPaths: localFoldersWithParents,
            davinciPaths: davinciFoldersWithParents.filter(p => p !== "时间线" && p !== "时间线备份"),
            existingMappings: mappings,
            maxDepth: mappingMaxDepth,
        });

        if (result.matches.length === 0) {
            setMessage({ type: 'info', text: '没有找到可自动匹配的目录。可以切换显示子目录后再试。' });
            return;
        }

        commitChange(localFolders, davinciFolders, {
            ...mappings,
            ...result.mappings,
        });
        setMessage({
            type: 'success',
            text: `已自动添加 ${result.matches.length} 条映射规则。`,
        });
    };

    const handleSave = async () => {
        setLoading(true);
        setMessage(null);
        try {
            const flatMapping = {};
            Object.entries(mappings).forEach(([k, v]) => { flatMapping[k] = v.target; });
            
            await axios.post(`${apiBaseUrl}/api/folder_config`, {
                local_folders: localFolders,
                davinci_folders: davinciFolders,
                mapping: flatMapping
            });
            setMessage({ type: 'success', text: '映射规则与文件夹结构已保存！' });
        } catch (e) {
            setMessage({ type: 'error', text: '保存失败: ' + (e.response?.data?.detail || e.message) });
        } finally {
            setLoading(false);
        }
    };

    const handleImportDavinci = async () => {
        if (!resolveConnected) {
            setMessage({ type: 'error', text: '达芬奇未连接，请确保达芬奇已打开并进入项目后再试。' });
            return;
        }
        setDavinciDepthModal({ show: true });
    };

    const handleCopyLocalToDavinci = () => {
        const copiedFolders = mergeDavinciFolders([], localFolders);
        commitChange(localFolders, copiedFolders, mappings);
        setSelectedPath(copiedFolders[0] || null);
        setEditingPath(null);
        setMessage({ type: 'success', text: '已复制本地文件结构到达芬奇媒体池结构。' });
    };

    const confirmImportDavinci = async () => {
        setDavinciDepthModal({ show: false });
        setLoading(true);
        setMessage({ type: 'info', text: `正在从达芬奇读取媒体池结构 (层级: ${importDavinciDepth})...` });
        try {
            const res = await axios.get(`${apiBaseUrl}/api/project/media_pool_folders`);
            if (res.data.folders) {
                const allFolders = res.data.folders;
                // Filter by depth (count of '/' separators + 1)
                const filteredFolders = allFolders.filter(p => {
                    const depth = p.split('/').length;
                    return depth <= importDavinciDepth;
                });
                const timelineFolders = filteredFolders.filter(p => p === '时间线' || p === '时间线备份' || p.startsWith('时间线/') || p.startsWith('时间线备份/'));
                const otherFolders = filteredFolders.filter(p => !timelineFolders.includes(p));
                const newDavinci = mergeDavinciFolders([], [...otherFolders, ...timelineFolders]);

                commitChange(localFolders, newDavinci, null);
                const skippedCount = allFolders.length - filteredFolders.length;
                const msg = skippedCount > 0 
                    ? `成功从达芬奇导入 ${newDavinci.length} 个目录（已过滤 ${skippedCount} 个超出层级范围的目录）`
                    : `成功从达芬奇导入 ${newDavinci.length} 个目录`;
                setMessage({ type: 'success', text: msg });
            }
        } catch (e) {
            setMessage({ type: 'error', text: `从达芬奇获取结构失败: ${e.response?.data?.detail || e.message}` });
        } finally {
            setLoading(false);
        }
    };

    const handleInstallWorkflow = async () => {
        setLoading(true);
        setMessage(null);
        try {
            await axios.post(`${apiBaseUrl}/api/folder_config/install_workflow`);
            setMessage({ type: 'success', text: '快捷操作已安装' });
        } catch (error) {
            const detail = error.response?.data?.detail || error.message;
            setMessage({ type: 'error', text: '安装失败：' + detail });
        } finally { setLoading(false); }
    };

    // Calculate unmapped (use localFoldersWithParents for comprehensive check)
    const getEffectiveMappedPaths = () => {
        const parentWithSub = new Set();
        Object.entries(mappings).forEach(([mk, mv]) => {
            if (mv.include_sub) {
                parentWithSub.add(mk);
            }
        });
        return parentWithSub;
    };

    const unmappedLocals = useMemo(() => {
        const parentWithSub = getEffectiveMappedPaths();
        return localFoldersWithParents.filter(lf => {
            let isMapped = false;
            if (mappings[lf]) isMapped = true;
            else {
                for (const mk of parentWithSub) {
                    if (lf.startsWith(mk + '/')) {
                        isMapped = true; break;
                    }
                }
            }
            return !isMapped;
        });
    }, [localFoldersWithParents, mappings]);

    const mappingMaxDepth = showMappingChildren ? 2 : 1;
    const selectableLocalFolders = useMemo(() => (
        unmappedLocals.filter(path => getPathDepth(path) <= mappingMaxDepth)
    ), [mappingMaxDepth, unmappedLocals]);
    const selectableDavinciFolders = useMemo(() => (
        davinciFoldersWithParents
            .filter(p => p !== "时间线" && p !== "时间线备份")
            .filter(path => getPathDepth(path) <= mappingMaxDepth)
    ), [davinciFoldersWithParents, mappingMaxDepth]);

    useEffect(() => {
        if (mappingLocalPath && !selectableLocalFolders.includes(mappingLocalPath)) {
            setMappingLocalPath('');
        }
        if (mappingDavinciPath && !selectableDavinciFolders.includes(mappingDavinciPath)) {
            setMappingDavinciPath('');
        }
    }, [mappingLocalPath, mappingDavinciPath, selectableLocalFolders, selectableDavinciFolders]);

    const filteredMappingList = useMemo(() => {
        const parentWithSub = getEffectiveMappedPaths();
        return Object.entries(mappings)
            .filter(([localPath]) => {
                for (const mk of parentWithSub) {
                    if (mk !== localPath && localPath.startsWith(mk + '/')) {
                        return false;
                    }
                }
                return true;
            });
    }, [mappings]);

    const filteredUnmappedWarning = useMemo(() => {
        const parentWithSub = getEffectiveMappedPaths();
        return localFoldersWithParents.filter(lf => {
            let isMapped = false;
            if (mappings[lf]) isMapped = true;
            else {
                for (const mk of parentWithSub) {
                    if (lf.startsWith(mk + '/')) {
                        isMapped = true; break;
                    }
                }
            }
            if (isMapped) return false;
            for (const mk of parentWithSub) {
                if (lf.startsWith(mk + '/')) return false;
            }
            return true;
        });
    }, [localFoldersWithParents, mappings]);

    const dragGhostPosition = dragState?.isDragging ? getDragGhostPosition(dragState.currentX, dragState.currentY, dragState.dropLineY) : null;

    return (
        <>
            {dragState?.isDragging && dragGhostPosition && typeof document !== 'undefined' && createPortal(
                <div
                    data-testid="folder-drag-preview"
                    style={{
                        position: 'fixed',
                        left: `${dragGhostPosition.x}px`,
                        top: `${dragGhostPosition.y}px`,
                        zIndex: 10020,
                        pointerEvents: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        minWidth: '180px',
                        maxWidth: '300px',
                        padding: '8px 12px',
                        borderRadius: '8px',
                        border: '1px solid rgba(10, 132, 255, 0.35)',
                        background: 'var(--mac-bg)',
                        color: 'var(--mac-text)',
                        boxShadow: '0 14px 36px rgba(0,0,0,0.28)',
                        fontSize: '13px',
                        fontWeight: 500,
                        opacity: 0.92,
                        willChange: 'left, top',
                    }}
                >
                    <GripVertical size={14} style={{ color: 'var(--mac-text-secondary)', flexShrink: 0 }} />
                    <Folder size={16} style={{ color: '#0A84FF', flexShrink: 0 }} />
                    <span style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}>
                        {dragState.sourceName || dragState.sourcePath}
                    </span>
                </div>,
                document.body
            )}

            {/* Header extension: Moved status indicator to header */}
            {typeof window !== 'undefined' && document.getElementById('page-header-actions') && 
             createPortal(
                <div style={{ fontSize: '12px', color: 'var(--mac-text-secondary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {syncStatus === 'saving' ? (
                        <><Loader2 size={14} className="spin" /> 正在保存...</>
                    ) : syncStatus === 'error' ? (
                        <span style={{ color: 'var(--mac-text-secondary)', display: 'flex', alignItems: 'center', gap: '4px' }} title="达芬奇助手未连接，当前更改已保存在本地缓存中"><CloudOff size={14} /> 离线 (已本地保存)</span>
                    ) : syncStatus === 'saved' ? (
                        <><CheckCircle2 size={14} /> 已保存</>
                    ) : (
                        <><CheckCircle2 size={14} /> 已同步</>
                    )}
                </div>,
                document.getElementById('page-header-actions')
             )
            }

            <div style={{ flex: 1, padding: '0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <AnimatePresence mode="popLayout">
                    {activePage === 'menu' && (
                        <motion.div 
                            key="menu"
                            initial={{ opacity: 0, x: -10, scale: 0.98 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ type: 'spring', stiffness: 900, damping: 35, mass: 0.8 }}
                            style={{ display: 'flex', flexDirection: 'column', padding: embedded ? '24px 0' : '32px 20px', overflowY: 'auto', flex: 1, alignItems: 'center' }}
                        >
                            <div className="mac-settings-section" style={{ width: '100%' }}>
                                <div className="mac-settings-title">项目结构与映射</div>
                                <div className="mac-settings-group">
                                    <MenuRow 
                                        icon={HardDrive} title="本地文件结构" subtitle="项目在硬盘上的实际文件夹目录" 
                                        count={`${localFolders.length} 个目录`} onClick={() => setActivePage('local')} 
                                        iconColor="#0A84FF"
                                    />
                                    <MenuRow 
                                        icon={Film} title="达芬奇媒体池结构" subtitle="导入到达芬奇内部的箱(Bin)结构" 
                                        count={`${davinciFolders.length + 2} 个箱`} onClick={() => setActivePage('davinci')} 
                                        iconColor="#FF9500"
                                    />
                                    <MenuRow 
                                        icon={Link2} title="导入映射规则" subtitle="配置本地目录到媒体池的对应关系" 
                                        count={`${Object.keys(mappings).length} 条规则`} onClick={() => setActivePage('mapping')} 
                                        iconColor="#34C759"
                                    />
                                </div>
                            </div>
                        </motion.div>
                    )}

                    {activePage === 'local' && (
                        <motion.div 
                            key="local"
                            initial={{ opacity: 0, x: 10, scale: 0.98 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ type: "spring", stiffness: 900, damping: 35, mass: 0.8 }}
                            style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '32px 20px', overflowY: 'auto', alignItems: 'center' }}
                        >
                            <div className="mac-settings-section" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, marginBottom: '16px', width: '100%' }}>
                                <div className="mac-settings-title">本地项目结构</div>
                                <div className="mac-settings-group" style={{ padding: '12px', flex: 1, overflowY: 'auto', marginBottom: 0 }}>
                                    {localTree.map(node => (
                                        <TreeItem key={node.path} node={node} level={0} treeKind="local" folders={localFolders} dragState={dragState} expandedPaths={expandedPaths} setExpandedPaths={setExpandedPaths} onDragStart={handleFolderDragStart} onDragMove={handleFolderDragMove} onDropPreview={handleDropPreview} onAddChild={handleAddLocal} onAddSibling={handleAddLocalSibling} onRemove={handleRemoveLocal} onRename={handleRenameLocal} onReorder={handleReorderLocal} editingPath={editingPath} setEditingPath={setEditingPath} selectedPath={selectedPath} setSelectedPath={setSelectedPath} />
                                    ))}
                                    {localTree.length === 0 && (
                                        <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--mac-text-secondary)', fontSize: '13px' }}>
                                            <button className="mac-btn" onClick={() => handleAddLocal('')} style={{ marginBottom: '16px' }}>
                                                <Plus size={14} /> 添加根目录
                                            </button>
                                            <div>暂无本地目录，请点击上方按钮添加。</div>
                                        </div>
                                    )}
                                </div>
                            </div>
                            
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, width: '100%', gap: '12px' }}>
                                <button className="mac-btn" onClick={handleImportLocal} disabled={loading} style={{ height: '40px', flex: 1, justifyContent: 'center' }}>
                                    <FolderOpen size={16} /> 导入本地结构
                                </button>
                                <button className="mac-btn" onClick={handleResetLocal} disabled={loading} style={{ height: '40px', flex: 1, justifyContent: 'center' }}>
                                    恢复默认结构
                                </button>
                                <button className="mac-btn" onClick={handleClearLocal} disabled={loading} style={{ height: '40px', color: '#FF3B30', flex: 1, justifyContent: 'center' }}>
                                    清空全部
                                </button>
                                <button className="mac-btn" onClick={handleInstallWorkflow} disabled={loading} style={{ height: '40px', flex: 1, justifyContent: 'center' }}>
                                    <Download size={16} /> 安装快捷操作
                                </button>
                            </div>
                        </motion.div>
                    )}

                    {activePage === 'davinci' && (
                        <motion.div 
                            key="davinci"
                            initial={{ opacity: 0, x: 10, scale: 0.98 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ type: "spring", stiffness: 900, damping: 35, mass: 0.8 }}
                            style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '32px 20px', overflowY: 'auto', alignItems: 'center' }}
                        >
                            <div className="mac-settings-section" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, width: '100%' }}>
                                <div className="mac-settings-title">媒体池箱结构</div>
                                <div className="mac-settings-group" style={{ padding: '12px', flex: 1, overflowY: 'auto', marginBottom: 0 }}>
                                    {davinciTree.map(node => (
                                        <TreeItem key={node.path} node={node} level={0} treeKind="davinci" folders={davinciFolders} dragState={dragState} expandedPaths={expandedPaths} setExpandedPaths={setExpandedPaths} onDragStart={handleFolderDragStart} onDragMove={handleFolderDragMove} onDropPreview={handleDropPreview} onAddChild={handleAddDavinci} onAddSibling={handleAddDavinciSibling} onRemove={handleRemoveDavinci} onRename={handleRenameDavinci} onReorder={handleReorderDavinci} isSystem={node.isSystem} editingPath={editingPath} setEditingPath={setEditingPath} selectedPath={selectedPath} setSelectedPath={setSelectedPath} />
                                    ))}
                                    {davinciTree.length === 0 && (
                                        <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--mac-text-secondary)', fontSize: '13px' }}>
                                            <button className="mac-btn" onClick={() => handleAddDavinci('')} style={{ marginBottom: '16px' }}>
                                                <Plus size={14} /> 添加根目录
                                            </button>
                                            <div>暂无达芬奇目录，请点击上方按钮添加。</div>
                                        </div>
                                    )}
                                </div>
                            </div>
                            
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, width: '100%', marginTop: '16px', gap: '12px' }}>
                                <button className="mac-btn" onClick={handleImportDavinci} disabled={loading} style={{ height: '40px', flex: 1, justifyContent: 'center' }}>
                                    <FolderOpen size={16} /> 从当前项目导入
                                </button>
                                <button className="mac-btn" onClick={handleCopyLocalToDavinci} disabled={loading} style={{ height: '40px', flex: 1, justifyContent: 'center' }}>
                                    <Copy size={16} /> 复制本地结构
                                </button>
                                <button className="mac-btn" onClick={handleResetDavinci} disabled={loading} style={{ height: '40px', flex: 1, justifyContent: 'center' }}>
                                    恢复默认结构
                                </button>
                                <button className="mac-btn" onClick={handleClearDavinci} disabled={loading} style={{ height: '40px', color: '#FF3B30', flex: 1, justifyContent: 'center' }}>
                                    清空全部
                                </button>
                            </div>
                        </motion.div>
                    )}

                    {activePage === 'mapping' && (
                        <motion.div 
                            key="mapping"
                            initial={{ opacity: 0, x: 10, scale: 0.98 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ type: "spring", stiffness: 900, damping: 35, mass: 0.8 }}
                            style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '32px 20px', overflowY: 'auto', alignItems: 'center' }}
                        >
                            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', flex: 1 }}>
                            {/* Add Mapping Header */}
                            {unmappedLocals.length > 0 && (
                            <div className="mac-settings-section" style={{ width: '100%' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                                    <div className="mac-settings-title" style={{ marginBottom: 0 }}>添加新映射规则</div>
                                    <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                                        <button
                                            className="mac-btn"
                                            onClick={() => setShowMappingChildren(prev => !prev)}
                                            style={{ height: '24px', fontSize: '12px', padding: '0 8px', marginBottom: 0 }}
                                            title={showMappingChildren ? '仅显示一级目录' : '显示到二级子目录'}
                                        >
                                            {showMappingChildren ? <EyeOff size={13} /> : <Eye size={13} />}
                                            {showMappingChildren ? '仅一级' : '显示子目录'}
                                        </button>
                                        <button
                                            className="mac-btn"
                                            onClick={handleAutoMapping}
                                            disabled={loading || selectableLocalFolders.length === 0 || selectableDavinciFolders.length === 0}
                                            style={{ height: '24px', fontSize: '12px', padding: '0 8px', marginBottom: 0 }}
                                            title="按名称相似度自动添加映射规则"
                                        >
                                            <Sparkles size={13} /> 自动映射
                                        </button>
                                    </div>
                                </div>
                                <div className="mac-settings-group" style={{ padding: '12px' }}>
                                    <div className="mapping-form-row" style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                                        <div style={{ flex: '1 1 200px', minWidth: '180px' }}>
                                            <MacSelect
                                                value={mappingLocalPath}
                                                onChange={setMappingLocalPath}
                                                options={selectableLocalFolders.map(p => ({ value: p, label: p }))}
                                                placeholder="-- 选择未映射的本地目录 --"
                                                showPlaceholderOption={true}
                                            />
                                        </div>
                                        <ArrowRight size={18} color="var(--mac-text-secondary)" className="mapping-arrow" style={{ flexShrink: 0 }} />
                                        <div style={{ flex: '1 1 200px', minWidth: '180px' }}>
                                            <MacSelect
                                                value={mappingDavinciPath}
                                                onChange={setMappingDavinciPath}
                                                options={selectableDavinciFolders.map(p => ({ value: p, label: p }))}
                                                placeholder="-- 选择达芬奇媒体池目录 --"
                                                showPlaceholderOption={true}
                                            />
                                        </div>
                                        <button className="mac-btn primary mapping-btn" onClick={handleCreateMapping} disabled={!mappingLocalPath || !mappingDavinciPath} style={{ flexShrink: 0, padding: '0 16px', height: '38px' }}>
                                            添加绑定
                                        </button>
                                    </div>
                                </div>
                            </div>
                            )}

                            {/* Mapping List */}
                            <div className="mac-settings-section" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, marginBottom: 0 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <div className="mac-settings-title">已有规则</div>
                                    <div style={{ display: 'flex', gap: '8px' }}>
                                        <button className="mac-btn" onClick={handleResetMappings} disabled={loading} style={{ height: '24px', fontSize: '12px', padding: '0 8px', marginBottom: '8px' }}>
                                            恢复默认规则
                                        </button>
                                        {Object.keys(mappings).length > 0 && (
                                            <button className="mac-btn" onClick={handleClearMappings} disabled={loading} style={{ height: '24px', fontSize: '12px', color: '#FF3B30', padding: '0 8px', marginBottom: '8px' }}>
                                                清空全部
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <div className="mac-settings-group" style={{ display: 'flex', flexDirection: 'column', flex: 1, overflowY: 'auto', padding: '0', background: 'transparent', border: 'none' }}>
                                    {filteredMappingList.length === 0 ? (
                                        <div style={{ margin: '40px auto', textAlign: 'center', color: 'var(--mac-text-secondary)', fontSize: '13px' }}>
                                            <ArrowRight size={32} style={{ opacity: 0.2, marginBottom: '8px' }} /><br/>
                                            暂无映射规则，请在上方添加。
                                        </div>
                                    ) : (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                            {filteredMappingList
                                                .sort(([a], [b]) => naturalCompare(a, b))
                                                .map(([localPath, config]) => (
                                                <div key={localPath} className="mac-settings-group" style={{ 
                                                    display: 'flex', alignItems: 'center', padding: '12px', 
                                                    marginBottom: 0
                                                }}>
                                                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
                                                        <Folder size={16} color="#FF9500" style={{ flexShrink: 0 }} />
                                                        <span style={{ fontSize: '13px', fontWeight: '500', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--mac-text)' }}>{localPath}</span>
                                                    </div>
                                                    
                                                    <ArrowRight size={14} color="var(--mac-text-secondary)" style={{ flexShrink: 0, margin: '0 8px' }} />
                                                    
                                                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
                                                        <Folder size={16} color="#0A84FF" style={{ flexShrink: 0 }} />
                                                        <span style={{ fontSize: '13px', fontWeight: '500', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--mac-text)' }}>{config.target}</span>
                                                    </div>

                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0, paddingLeft: '10px', borderLeft: '1px solid var(--mac-border)' }}>
                                                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--mac-text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                                            <input 
                                                                type="checkbox" 
                                                                checked={config.include_sub} 
                                                                onChange={() => toggleIncludeSub(localPath)}
                                                                style={{ cursor: 'pointer' }}
                                                            />
                                                            包含子目录
                                                        </label>
                                                        <button className="mac-btn" style={{ padding: '4px', border: 'none', background: 'transparent', color: '#FF3B30', boxShadow: 'none' }} onClick={() => handleRemoveMapping(localPath)}>
                                                            <Trash2 size={14} />
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Unmapped Warning */}
                            {filteredUnmappedWarning.length > 0 && (
                                <div style={{ marginTop: '16px', padding: '12px', background: 'rgba(255,149,0,0.1)', borderRadius: '8px', display: 'flex', alignItems: 'flex-start', gap: '8px', width: '100%' }}>
                                    <Info size={16} color="#FF9500" style={{ marginTop: '2px', flexShrink: 0 }} />
                                    <div>
                                        <div style={{ fontSize: '12px', fontWeight: '600', color: '#FF9500', marginBottom: '4px' }}>提示：有 {filteredUnmappedWarning.length} 个未映射的本地文件夹</div>
                                        <div style={{ fontSize: '11px', color: 'var(--mac-text-secondary)' }}>未映射的本地文件夹在导入到达芬奇时将被忽略。如果您希望导入，请为它们配置映射或开启父目录的"包含子目录"选项。</div>
                                    </div>
                                </div>
                            )}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            {/* Custom Confirm Modal */}
            {confirmModal.show && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ width: '320px', padding: '24px', margin: 0, background: 'var(--mac-bg)', border: '1px solid var(--mac-border)', borderRadius: '12px', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}>
                        <h3 style={{ margin: '0 0 16px', fontSize: '16px', color: 'var(--mac-text)' }}>{confirmModal.title}</h3>
                        <p style={{ fontSize: '13px', color: 'var(--mac-text-secondary)', marginBottom: '20px', lineHeight: 1.5 }}>
                            {confirmModal.message}
                        </p>
                        {confirmModal.skipPreferenceKey && (
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--mac-text)', marginBottom: '20px', cursor: 'pointer', userSelect: 'none' }}>
                                <input
                                    type="checkbox"
                                    aria-label="不再显示删除确认"
                                    checked={skipDeleteConfirmChecked}
                                    onChange={(e) => setSkipDeleteConfirmChecked(e.target.checked)}
                                    style={{ cursor: 'pointer' }}
                                />
                                不再显示删除确认
                            </label>
                        )}
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                            <button className="mac-btn" onClick={closeConfirmModal} style={{ background: 'var(--mac-modal-btn-bg)', border: '1px solid var(--mac-modal-btn-border)', color: 'var(--mac-text)', padding: '8px 20px', borderRadius: '8px', fontWeight: '500' }}>取消</button>
                            <button className="mac-btn primary" style={{ background: '#FF3B30', borderColor: 'transparent' }} onClick={() => confirmModal.onConfirm?.(skipDeleteConfirmChecked)}>删除</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Depth Selection Modal */}
            {depthModal.show && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ width: '340px', padding: '24px', margin: 0, background: 'var(--mac-bg)', border: '1px solid var(--mac-border)', borderRadius: '12px', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}>
                        <h3 style={{ margin: '0 0 16px', fontSize: '16px', color: 'var(--mac-text)' }}>选择导入层级</h3>
                        <p style={{ fontSize: '13px', color: 'var(--mac-text-secondary)', marginBottom: '16px', lineHeight: 1.5 }}>
                            请选择您要读取的文件夹深度。层级越深，读取的子文件夹越多。
                        </p>
                        
                        <div style={{ marginBottom: '24px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '13px', color: 'var(--mac-text)' }}>
                                <span>仅当前目录 (1层)</span>
                                <span>更深层级 ({importDepth}层)</span>
                            </div>
                            <input 
                                type="range" 
                                min="1" 
                                max="5" 
                                value={importDepth} 
                                onChange={(e) => setImportDepth(parseInt(e.target.value))}
                                style={{ width: '100%', accentColor: 'var(--mac-accent)' }}
                            />
                            <div style={{ textAlign: 'center', marginTop: '12px', fontSize: '14px', fontWeight: '500', color: 'var(--mac-accent)' }}>
                                读取 {importDepth} 层文件夹
                            </div>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                            <button className="mac-btn" onClick={() => setDepthModal({ show: false, selectedPath: '' })} style={{ background: 'var(--mac-modal-btn-bg)', border: '1px solid var(--mac-modal-btn-border)', color: 'var(--mac-text)', padding: '8px 20px', borderRadius: '8px', fontWeight: '500' }}>取消</button>
                            <button className="mac-btn primary" onClick={confirmImportLocal}>确认导入</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Da Vinci Depth Selection Modal */}
            {davinciDepthModal.show && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ width: '340px', padding: '24px', margin: 0, background: 'var(--mac-bg)', border: '1px solid var(--mac-border)', borderRadius: '12px', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}>
                        <h3 style={{ margin: '0 0 16px', fontSize: '16px', color: 'var(--mac-text)' }}>选择导入层级 — 达芬奇</h3>
                        <p style={{ fontSize: '13px', color: 'var(--mac-text-secondary)', marginBottom: '16px', lineHeight: 1.5 }}>
                            请选择您要从达芬奇媒体池读取的文件夹深度。层级越深，读取的子文件夹越多。
                        </p>
                        
                        <div style={{ marginBottom: '24px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '13px', color: 'var(--mac-text)' }}>
                                <span>仅顶层目录 (1层)</span>
                                <span>更深层级 ({importDavinciDepth}层)</span>
                            </div>
                            <input 
                                type="range" 
                                min="1" 
                                max="5" 
                                value={importDavinciDepth} 
                                onChange={(e) => setImportDavinciDepth(parseInt(e.target.value))}
                                style={{ width: '100%', accentColor: 'var(--mac-accent)' }}
                            />
                            <div style={{ textAlign: 'center', marginTop: '12px', fontSize: '14px', fontWeight: '500', color: 'var(--mac-accent)' }}>
                                读取 {importDavinciDepth} 层媒体池目录
                            </div>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                            <button className="mac-btn" onClick={() => setDavinciDepthModal({ show: false })} style={{ background: 'var(--mac-modal-btn-bg)', border: '1px solid var(--mac-modal-btn-border)', color: 'var(--mac-text)', padding: '8px 20px', borderRadius: '8px', fontWeight: '500' }}>取消</button>
                            <button className="mac-btn primary" onClick={confirmImportDavinci}>确认导入</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Reset Mappings Modal */}
            {resetModal.show && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ width: '400px', padding: '24px', margin: 0, background: 'var(--mac-bg)', border: '1px solid var(--mac-border)', borderRadius: '12px', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}>
                        <h3 style={{ margin: '0 0 16px', fontSize: '16px', color: 'var(--mac-text)' }}>{resetModal.title}</h3>
                        <p style={{ fontSize: '13px', color: 'var(--mac-text-secondary)', marginBottom: '20px', lineHeight: 1.5 }}>
                            {resetModal.message}
                        </p>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                            <button className="mac-btn" onClick={() => setResetModal({ show: false, title: '', message: '', onConfirm: null })} style={{ background: 'var(--mac-modal-btn-bg)', border: '1px solid var(--mac-modal-btn-border)', color: 'var(--mac-text)', padding: '8px 20px', borderRadius: '8px', fontWeight: '500' }}>取消</button>
                            <button className="mac-btn primary" onClick={resetModal.onConfirm}>确定</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

export default FolderConfigGraph;
