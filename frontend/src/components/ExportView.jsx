import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { Settings, FileVideo, Calendar, Clock, Hash, Type, FolderOpen, AlertCircle, Trash2, Save, ChevronDown, Pencil } from 'lucide-react';

const AVAILABLE_TAGS = [
    { id: 'tag-project', label: '项目名', value: '%ProjectName%', icon: <FileVideo size={14} /> },
    { id: 'tag-timeline', label: '时间线', value: '%TimelineName%', icon: <Settings size={14} /> },
    { id: 'tag-datetime', label: '日期时间', value: '%DateTime%', icon: <Calendar size={14} /> },
    { id: 'tag-version', label: '版本号', value: 'V01', icon: <Hash size={14} />, isEditable: true, versionNumber: '01' },
    { id: 'tag-custom', label: '文本', value: '', icon: <Type size={14} />, isEditable: true }
];

const KEEP_PRESET_KEYWORDS = ['H.264 Master', 'H.265 Master', 'HyperDeck', 'ProRes 422 HQ'];
const NATIVE_PRESET_PATTERNS = [
    'H.264', 'H.265', 'HyperDeck', 'ProRes',
    'YouTube', 'Vimeo', 'Twitter', 'TikTok',
    'Presentations', 'Dropbox', 'Replay', 'IMF',
    'Final Cut', 'Premiere', 'Audio Only', 'Avid', 'AAF',
    'Custom Export', 'ProTools', 'Tencent'
];

function ToggleSwitch({ checked, onChange, color = '#0A84FF' }) {
    return (
        <div
            onClick={() => onChange(!checked)}
            style={{
                width: 44, height: 24, borderRadius: 12, cursor: 'pointer',
                background: checked ? color : 'rgba(120, 120, 128, 0.32)',
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

const normalizePath = (p) => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');

const springTransition = { type: 'spring', stiffness: 900, damping: 35, mass: 0.8 };
const SUBFOLDER_OPTIONS_MAX_HEIGHT = {
    timeline: 58,
    custom: 112,
};
const CUSTOM_SUBFOLDER_INPUT_MAX_HEIGHT = 46;

const TagBlock = ({ block, index, isDragSource, updateBlockValue, removeBlock, onEditStart, onEditEnd, onPointerDown }) => {
    return (
        <motion.div
            layout="position"
            transition={{ duration: 0.15 }}
            data-instance-id={block.instanceId}
            onPointerDown={(e) => {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
                onPointerDown(index, e);
            }}
            style={{
                padding: '5px 8px',
                background: block.isEditable ? 'var(--mac-input-bg)' : 'var(--mac-accent)',
                color: block.isEditable ? 'var(--mac-text)' : '#FFF',
                borderRadius: '10px',
                fontSize: '13px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                opacity: isDragSource ? 0.15 : 1,
                cursor: 'grab',
                border: block.isEditable ? '1px solid var(--mac-accent)' : 'none',
                userSelect: 'none',
                touchAction: 'none'
            }}
        >
            {block.icon}
            {block.isEditable ? (
                <input
                    type="text"
                    value={block.value}
                    onChange={e => updateBlockValue(index, e.target.value)}
                    onClick={e => e.target.select()}
                    onPointerDown={e => e.stopPropagation()}
                    onFocus={onEditStart}
                    onBlur={onEditEnd}
                    style={{
                        background: 'transparent',
                        border: 'none',
                        borderBottom: '1.5px solid var(--mac-accent)',
                        color: 'var(--mac-text)',
                        width: Math.max(30, (block.value?.length || 1) * 8) + 'px',
                        fontSize: '13px',
                        outline: 'none',
                        textAlign: 'center',
                        paddingBottom: '1px'
                    }}
                />
            ) : (
                block.label
            )}
            <button
                onClick={() => removeBlock(index)}
                onPointerDown={e => e.stopPropagation()}
                style={{ background: 'transparent', border: 'none', color: 'inherit', opacity: 0.5, cursor: 'pointer', padding: '0 2px' }}
            >×</button>
        </motion.div>
    );
};

function MacSelect({ value, onChange, options, placeholder, width = '160px', showPlaceholderOption = true }) {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef(null);
    const [dropdownStyle, setDropdownStyle] = useState({});

    const updatePosition = useCallback(() => {
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
                    padding: '6px 28px 6px 10px',
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

const ExportView = ({ apiBaseUrl, projectId, projectContext, resolveStatus, hasTimeline, onRefreshContext }) => {
    const [targetDir, setTargetDir] = useState(() => localStorage.getItem(`export_targetDir_${projectId}`) || '');
    const [presetName, setPresetName] = useState(() => localStorage.getItem('export_presetName') || '');
    const [presetList, setPresetList] = useState([]);
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState('');
    const [useSubfolder, setUseSubfolder] = useState(() => localStorage.getItem('export_useSubfolder') === 'true');
    const [subfolderType, setSubfolderType] = useState(() => localStorage.getItem('export_subfolderType') || 'timeline');
    const [customSubfolder, setCustomSubfolder] = useState(() => localStorage.getItem('export_customSubfolder') || '');
    const [autoSeparator, setAutoSeparator] = useState(() => localStorage.getItem('export_autoSeparator') !== 'false');
    const [separator, setSeparator] = useState(() => localStorage.getItem('export_separator') || '_');
    const [versionPrefix, setVersionPrefix] = useState(() => localStorage.getItem('export_versionPrefix') || 'V');
    const [datetimeParts, setDatetimeParts] = useState(() => {
        try {
            const saved = JSON.parse(localStorage.getItem('export_datetimeParts') || 'null');
            return saved || { year: true, month: true, day: true, hour: false, minute: false, second: false };
        } catch {
            return { year: true, month: true, day: true, hour: false, minute: false, second: false };
        }
    });

    const [versionMap, setVersionMap] = useState(() => {
        try {
            return JSON.parse(localStorage.getItem('export_versionMap') || '{}');
        } catch {
            return {};
        }
    });

    const [liveTimeline, setLiveTimeline] = useState('');
    const [subdirs, setSubdirs] = useState([]);
    const [localPath, setLocalPath] = useState('');
    const [pathSource, setPathSource] = useState('');

    useEffect(() => {
        const fetchPresets = async () => {
            try {
                const res = await axios.get(`${apiBaseUrl}/api/export/presets`);
                if (res.data.presets) {
                    // 1. 清理名称中的 "Pro Tools" 文本（大小写不敏感）
                    const map = {};
                    const cleanedNames = [];
                    const seen = new Set();
                    for (const name of res.data.presets) {
                        const cleaned = name.replace(/pro\s*tools/gi, '').trim().replace(/\s+/g, ' ');
                        if (!cleaned || seen.has(cleaned)) continue;
                        seen.add(cleaned);
                        map[cleaned] = name;  // cleaned -> original
                        cleanedNames.push(cleaned);
                    }
                    presetNameMapRef.current = map;

                    // 2. 过滤：保留重要原生预设和用户自定义预设
                    const filtered = cleanedNames.filter(name => {
                        if (KEEP_PRESET_KEYWORDS.some(kw => name.includes(kw))) return true;
                        if (NATIVE_PRESET_PATTERNS.some(kw => name.toLowerCase().includes(kw.toLowerCase()))) return false;
                        return true;
                    });

                    // 3. 排序：用户自定义预设在前，原生重要预设在后
                    const isNative = (name) => KEEP_PRESET_KEYWORDS.some(kw => name.includes(kw));
                    const userDefined = filtered.filter(name => !isNative(name));
                    const nativeImportant = filtered.filter(name => isNative(name));
                    setPresetList([...userDefined, ...nativeImportant]);
                }
            } catch (err) {
                console.error("无法获取渲染预设列表", err);
            }
        };
        fetchPresets();
    }, [apiBaseUrl]);

    useEffect(() => {
        const fetchDefaults = async () => {
            try {
                const pathRes = await axios.get(`${apiBaseUrl}/api/project/path`);
                const projPath = pathRes.data.project_path || '';
                const defaultExportDir = pathRes.data.default_export_dir || '';
                setLocalPath(projPath);
                setPathSource(pathRes.data.path_source || '');
                if (pathRes.data.subdirs) {
                    setSubdirs(pathRes.data.subdirs);
                }
                if (pathRes.data.path_error) {
                    setMessage(pathRes.data.path_error);
                }
                // 项目路径可能已变更，清理相对于旧路径的过期 targetDir
                const newResolvedPath = projPath || projectContext?.local_path || '';
                setTargetDir(prev => {
                    if (!prev) {
                        return defaultExportDir || projPath || '';
                    }
                    // 如果 prev 是绝对路径但与当前项目路径不匹配，说明项目路径已变更，清除旧值
                    if ((prev.startsWith('/') || prev.includes(':')) && newResolvedPath) {
                        const normalizedPrev = normalizePath(prev);
                        const normalizedBase = normalizePath(newResolvedPath);
                        if (normalizedPrev !== normalizedBase && !normalizedPrev.startsWith(normalizedBase + '/')) {
                            return defaultExportDir || projPath || '';
                        }
                    }
                    return prev;
                });
            } catch (err) {
                console.error("无法获取默认导出路径", err);
            }
        };
        fetchDefaults();
    }, [apiBaseUrl, projectContext?.default_export_dir]);

    // 当项目基础路径变更时，清理过期的绝对路径 targetDir
    useEffect(() => {
        const newResolvedPath = localPath || projectContext?.local_path || '';
        if (!newResolvedPath) return;
        setTargetDir(prev => {
            if (!prev) return prev;
            if ((prev.startsWith('/') || prev.includes(':'))) {
                const normalizedPrev = normalizePath(prev);
                const normalizedBase = normalizePath(newResolvedPath);
                if (normalizedPrev !== normalizedBase && !normalizedPrev.startsWith(normalizedBase + '/')) {
                    return '';
                }
            }
            return prev;
        });
    }, [projectContext?.local_path, localPath]);

    useEffect(() => {
        const pollTimeline = async () => {
            try {
                const res = await axios.get(`${apiBaseUrl}/api/project/current-timeline`);
                if (res.data.timeline) {
                    setLiveTimeline(res.data.timeline);
                }
            } catch (err) {}
        };
        pollTimeline();
        const timer = setInterval(pollTimeline, 10000);
        return () => clearInterval(timer);
    }, [apiBaseUrl]);

    const currentTimeline = liveTimeline || projectContext?.current_timeline || '';

    const [templateBlocks, setTemplateBlocks] = useState(() => {
        const prefix = localStorage.getItem('export_versionPrefix') || 'V';
        const saved = localStorage.getItem('export_templateBlocks');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                return parsed.map(p => {
                    const originalTag = AVAILABLE_TAGS.find(t => t.id === p.id);
                    const block = { ...p, icon: originalTag ? originalTag.icon : null };
                    if (block.id === 'tag-version') {
                        if (!block.versionNumber) {
                            const match = block.value.match(/(\d+)$/);
                            block.versionNumber = match ? match[1] : '01';
                        }
                        block.value = prefix + block.versionNumber;
                    }
                    return block;
                });
            } catch (e) {
                console.error('Failed to parse saved blocks', e);
            }
        }
        return [
            { ...AVAILABLE_TAGS[0], instanceId: 'init-1' },
            { ...AVAILABLE_TAGS[1], instanceId: 'init-2' },
            { ...AVAILABLE_TAGS[2], instanceId: 'init-3' },
            { ...AVAILABLE_TAGS[3], instanceId: 'init-4', value: prefix + '01', versionNumber: '01' }
        ];
    });

    useEffect(() => {
        localStorage.setItem(`export_targetDir_${projectId}`, targetDir);
        localStorage.setItem('export_presetName', presetName);
        localStorage.setItem('export_useSubfolder', useSubfolder);
        localStorage.setItem('export_subfolderType', subfolderType);
        localStorage.setItem('export_customSubfolder', customSubfolder);
        localStorage.setItem('export_autoSeparator', autoSeparator);
        localStorage.setItem('export_separator', separator);
        localStorage.setItem('export_versionPrefix', versionPrefix);
        localStorage.setItem('export_datetimeParts', JSON.stringify(datetimeParts));
        localStorage.setItem('export_versionMap', JSON.stringify(versionMap));
        const blocksToSave = templateBlocks.map(({ icon, ...rest }) => rest);
        localStorage.setItem('export_templateBlocks', JSON.stringify(blocksToSave));
    }, [targetDir, presetName, useSubfolder, subfolderType, customSubfolder, templateBlocks, projectId, autoSeparator, separator, versionPrefix, datetimeParts, versionMap]);

    useEffect(() => {
        setTemplateBlocks(prev => {
            let changed = false;
            const newBlocks = prev.map(block => {
                if (block.id === 'tag-version') {
                    const num = block.versionNumber || '01';
                    const newValue = versionPrefix + num;
                    if (newValue !== block.value) {
                        changed = true;
                        return { ...block, value: newValue };
                    }
                }
                return block;
            });
            return changed ? newBlocks : prev;
        });
    }, [versionPrefix]);

    useEffect(() => {
        if (!currentTimeline) return;
        setTemplateBlocks(prev => {
            let changed = false;
            const newBlocks = prev.map(block => {
                if (block.id === 'tag-version') {
                    const savedNum = versionMap[currentTimeline];
                    if (savedNum !== undefined) {
                        const newValue = versionPrefix + savedNum;
                        if (newValue !== block.value || savedNum !== block.versionNumber) {
                            changed = true;
                            return { ...block, value: newValue, versionNumber: savedNum };
                        }
                    } else {
                        const defaultNum = '01';
                        const newValue = versionPrefix + defaultNum;
                        if (newValue !== block.value || defaultNum !== block.versionNumber) {
                            changed = true;
                            return { ...block, value: newValue, versionNumber: defaultNum };
                        }
                    }
                }
                return block;
            });
            return changed ? newBlocks : prev;
        });
    }, [currentTimeline, versionPrefix, versionMap]);

    const [dragInstanceId, setDragInstanceId] = useState(null);
    const [dragOverlay, setDragOverlay] = useState(null);
    const [past, setPast] = useState([]);
    const [editingBlocks, setEditingBlocks] = useState(null);
    const containerRef = useRef(null);
    const presetNameMapRef = useRef({});

    useEffect(() => {
        const handleKeyDown = (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
                if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') {
                    return;
                }
                e.preventDefault();
                setPast(prev => {
                    if (prev.length === 0) return prev;
                    const newPast = [...prev];
                    const previousState = newPast.pop();
                    setTemplateBlocks(previousState);
                    return newPast;
                });
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    const calcInsertIndex = useCallback((px, py, currentDragInstanceId) => {
        const container = containerRef.current;
        if (!container) return -1;
        const containerRect = container.getBoundingClientRect();
        if (px < containerRect.left - 20 || px > containerRect.right + 20 || py < containerRect.top - 20 || py > containerRect.bottom + 20) {
            return -1;
        }
        const allTags = Array.from(container.querySelectorAll('[data-instance-id]'))
            .filter(el => el.getAttribute('data-instance-id') !== currentDragInstanceId);
        if (allTags.length === 0) return 0;
        const sortedTags = allTags.map(el => ({
            el,
            rect: el.getBoundingClientRect(),
            logicalTop: containerRect.top + (el.offsetTop - container.offsetTop),
            logicalLeft: containerRect.left + (el.offsetLeft - container.offsetLeft)
        })).sort((a, b) => {
            if (Math.abs(a.logicalTop - b.logicalTop) > 10) return a.logicalTop - b.logicalTop;
            return a.logicalLeft - b.logicalLeft;
        });
        for (let i = 0; i < sortedTags.length; i++) {
            const { el } = sortedTags[i];
            const logicalLeft = containerRect.left + (el.offsetLeft - container.offsetLeft);
            const logicalTop = containerRect.top + (el.offsetTop - container.offsetTop);
            const logicalBottom = logicalTop + el.offsetHeight;
            const midX = logicalLeft + el.offsetWidth / 2;
            if (py < logicalTop) {
                return i;
            } else if (py >= logicalTop && py <= logicalBottom) {
                const deadzone = el.offsetWidth * 0.3;
                if (px < midX - deadzone) {
                    return i;
                } else if (px >= midX - deadzone && px <= midX + deadzone) {
                    return -1;
                }
            }
        }
        return sortedTags.length;
    }, []);

    const handleTagPointerDown = useCallback((index, e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
        e.preventDefault();
        const block = templateBlocks[index];
        const instanceId = block.instanceId;
        const el = e.currentTarget;
        const rect = el.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const offsetY = e.clientY - rect.top;
        const startX = e.clientX;
        const startY = e.clientY;
        let isDragging = false;
        let lastInsertIndex = -1;
        let savedOriginal = null;
        const onPointerMove = (moveEvent) => {
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;
            if (!isDragging && Math.sqrt(dx * dx + dy * dy) > 5) {
                isDragging = true;
                savedOriginal = [...templateBlocks];
                setDragInstanceId(instanceId);
                setDragOverlay({
                    block,
                    x: moveEvent.clientX - offsetX,
                    y: moveEvent.clientY - offsetY,
                    width: rect.width,
                    height: rect.height
                });
            }
            if (isDragging) {
                setDragOverlay(prev => prev ? { ...prev, x: moveEvent.clientX - offsetX, y: moveEvent.clientY - offsetY } : null);
                const insertIndex = calcInsertIndex(moveEvent.clientX, moveEvent.clientY, instanceId);
                if (insertIndex !== -1 && insertIndex !== lastInsertIndex) {
                    lastInsertIndex = insertIndex;
                    setTemplateBlocks(prev => {
                        const dragItem = prev.find(item => item.instanceId === instanceId);
                        if (!dragItem) return prev;
                        const others = prev.filter(item => item.instanceId !== instanceId);
                        const clampedIndex = Math.max(0, Math.min(insertIndex, others.length));
                        others.splice(clampedIndex, 0, dragItem);
                        const isSame = prev.every((item, i) => item.instanceId === others[i]?.instanceId);
                        if (isSame) return prev;
                        return others;
                    });
                }
            }
        };
        const cleanup = () => {
            if (isDragging && savedOriginal) {
                setPast(p => [...p, savedOriginal]);
            }
            setDragInstanceId(null);
            setDragOverlay(null);
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('keydown', onEscape);
        };
        const onPointerUp = () => { cleanup(); };
        const onEscape = (e) => {
            if (e.key === 'Escape' && isDragging && savedOriginal) {
                setTemplateBlocks(savedOriginal);
                cleanup();
            }
        };
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('keydown', onEscape);
    }, [templateBlocks, calcInsertIndex]);

    const handleSelectDirectory = async () => {
        try {
            const path = await window.electronAPI.selectDirectory({ promptToCreate: true });
            if (path) {
                if (!localPath && resolvedLocalPath) {
                    const parentDir = path.substring(0, path.lastIndexOf('/'));
                    if (parentDir === resolvedLocalPath || normalizePath(parentDir) === normalizePath(resolvedLocalPath)) {
                        const subfolder = path.split('/').pop();
                        setTargetDir(subfolder);
                        await handleSetLocalPath(resolvedLocalPath);
                    } else {
                        await handleSetLocalPath(path);
                        setTargetDir('');
                    }
                } else {
                    const parentDir = path.substring(0, path.lastIndexOf('/'));
                    if (parentDir === resolvedLocalPath || normalizePath(parentDir) === normalizePath(resolvedLocalPath)) {
                        const subfolder = path.split('/').pop();
                        setTargetDir(subfolder);
                    } else {
                        await handleSetLocalPath(path);
                        setTargetDir('');
                    }
                }
            }
        } catch (error) {
            console.error('Failed to select directory:', error);
        }
    };

    const handleSetLocalPath = async (path) => {
        try {
            const res = await axios.post(`${apiBaseUrl}/api/project/set-local-path`, { local_path: path });
            if (res.data.status === 'success') {
                setLocalPath(res.data.local_path);
                if (res.data.subdirs) {
                    setSubdirs(res.data.subdirs);
                }
                if (onRefreshContext) {
                    await onRefreshContext();
                }
            }
        } catch (err) {
            console.error('设置项目路径失败:', err);
        }
    };

    const getDatetimeFormat = () => {
        const parts = [];
        if (datetimeParts.year) parts.push('%Y');
        if (datetimeParts.month) parts.push('%m');
        if (datetimeParts.day) parts.push('%d');
        if (datetimeParts.hour) parts.push('%H');
        if (datetimeParts.minute) parts.push('%M');
        if (datetimeParts.second) parts.push('%S');
        return parts.join('');
    };

    const getDatetimePreview = () => {
        const now = new Date();
        const parts = [];
        if (datetimeParts.year) parts.push(String(now.getFullYear()));
        if (datetimeParts.month) parts.push(String(now.getMonth() + 1).padStart(2, '0'));
        if (datetimeParts.day) parts.push(String(now.getDate()).padStart(2, '0'));
        if (datetimeParts.hour) parts.push(String(now.getHours()).padStart(2, '0'));
        if (datetimeParts.minute) parts.push(String(now.getMinutes()).padStart(2, '0'));
        if (datetimeParts.second) parts.push(String(now.getSeconds()).padStart(2, '0'));
        return parts.join('');
    };

    const getPreviewString = () => {
        const projectName = projectContext?.project_name || '项目名';
        const timelineName = currentTimeline || '时间线';
        const datetimePreview = getDatetimePreview();
        const values = templateBlocks.map(b => {
            if (b.id === 'tag-project') return projectName;
            if (b.id === 'tag-timeline') return timelineName;
            if (b.id === 'tag-datetime') return datetimePreview;
            return b.value;
        });
        if (autoSeparator) {
            return values.join(separator);
        }
        return values.join('');
    };

    const getTemplateString = () => {
        const values = templateBlocks.map(b => {
            if (b.id === 'tag-datetime') {
                return `%DateTime:${getDatetimeFormat()}%`;
            }
            return b.value;
        });
        if (autoSeparator) {
            return values.join(separator);
        }
        return values.join('');
    };

    const [, setPreviewTick] = useState(0);
    useEffect(() => {
        const timer = setInterval(() => setPreviewTick(t => t + 1), 1000);
        return () => clearInterval(timer);
    }, []);

    const handleExport = async () => {
        const fileNameTemplate = getTemplateString();
        const finalDir = resolveTargetDir();
        if (!finalDir || !fileNameTemplate) {
            setMessage('请选择导出目录并组合文件名模板');
            return;
        }
        let finalTargetDir = finalDir;
        let subName = '';
        if (useSubfolder) {
            subName = subfolderType === 'timeline' ? '%TimelineName%' : customSubfolder;
            if (subName) {
                finalTargetDir = `${finalDir}/${subName}`;
            }
        }
        setLoading(true);
        setMessage('');
        try {
            const res = await axios.post(`${apiBaseUrl}/api/export/render`, {
                target_dir: finalTargetDir,
                file_name_template: fileNameTemplate,
                preset_name: (presetName ? (presetNameMapRef.current[presetName] || presetName) : undefined),
                use_subfolder: useSubfolder,
                subfolder_name: subName || undefined
            });
            setMessage(res.data.message || '导出已启动');
            const newBlocks = [...templateBlocks];
            let updated = false;
            let newVersionNum = '01';
            for (let i = 0; i < newBlocks.length; i++) {
                if (newBlocks[i].id === 'tag-version') {
                    const currentNum = newBlocks[i].versionNumber || '01';
                    const num = parseInt(currentNum, 10) + 1;
                    newVersionNum = String(num).padStart(currentNum.length, '0');
                    newBlocks[i].versionNumber = newVersionNum;
                    newBlocks[i].value = versionPrefix + newVersionNum;
                    updated = true;
                }
            }
            if (updated && currentTimeline) {
                setVersionMap(prev => ({ ...prev, [currentTimeline]: newVersionNum }));
            }
            if (updated) {
                setTemplateBlocks(newBlocks);
            }
        } catch (error) {
            const detail = error.response?.data?.detail || error.message;
            setMessage(detail);
        } finally {
            setLoading(false);
        }
    };

    const handleBackupOnly = async () => {
        const fileNameTemplate = getTemplateString();
        if (!fileNameTemplate) {
            setMessage('请组合文件名模板');
            return;
        }
        let subName = '';
        if (useSubfolder) {
            subName = subfolderType === 'timeline' ? '%TimelineName%' : customSubfolder;
        }
        setLoading(true);
        setMessage('');
        try {
            const res = await axios.post(`${apiBaseUrl}/api/export/backup-only`, {
                target_dir: '',
                file_name_template: fileNameTemplate,
                use_subfolder: useSubfolder,
                subfolder_name: subName || undefined
            });
            setMessage(res.data.message || '备份完成');
        } catch (error) {
            const detail = error.response?.data?.detail || error.message;
            setMessage(detail);
        } finally {
            setLoading(false);
        }
    };

    const addTagClick = (tag) => {
        setPast(prev => [...prev, templateBlocks]);
        const newBlock = { ...tag, instanceId: `block-${Date.now()}` };
        if (tag.id === 'tag-version') {
            const num = (currentTimeline && versionMap[currentTimeline]) || '01';
            newBlock.value = versionPrefix + num;
            newBlock.versionNumber = num;
        }
        setTemplateBlocks([...templateBlocks, newBlock]);
    };

    const removeBlock = (index) => {
        setPast(prev => [...prev, templateBlocks]);
        const newBlocks = Array.from(templateBlocks);
        newBlocks.splice(index, 1);
        setTemplateBlocks(newBlocks);
    };

    const updateBlockValue = (index, newValue) => {
        const newBlocks = Array.from(templateBlocks);
        newBlocks[index].value = newValue;
        if (newBlocks[index].id === 'tag-version') {
            const match = newValue.match(/(\d+)$/);
            newBlocks[index].versionNumber = match ? match[1] : '01';
            if (currentTimeline) {
                setVersionMap(prev => ({ ...prev, [currentTimeline]: newBlocks[index].versionNumber }));
            }
        }
        setTemplateBlocks(newBlocks);
    };

    const datetimePillStyle = (active) => ({
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '12px',
        cursor: 'pointer',
        padding: '3px 8px',
        borderRadius: '5px',
        userSelect: 'none',
        transition: 'all 0.15s',
        ...(active ? {
            border: '1px solid var(--mac-accent)',
            background: 'rgba(10, 132, 255, 0.1)',
            color: 'var(--mac-accent)',
            fontWeight: '500'
        } : {
            border: '1px solid var(--mac-border)',
            background: 'var(--mac-input-bg)',
            color: 'var(--mac-text-secondary)'
        })
    });

    const folderOptions = subdirs.map(f => {
        return { value: f, label: f };
    });

    const hasLocalPath = !!(localPath || projectContext?.local_path);
    const resolvedLocalPath = localPath || projectContext?.local_path || '';

    const resolveTargetDir = () => {
        if (!targetDir) return '';
        if (targetDir.startsWith('/') || targetDir.includes(':')) {
            return targetDir;
        }
        if (resolvedLocalPath) {
            return `${resolvedLocalPath}/${targetDir}`;
        }
        return targetDir;
    };

    const [showExportPathTooltip, setShowExportPathTooltip] = useState(false);
    const [exportTooltipPos, setExportTooltipPos] = useState({ x: 0, y: 0 });
    const exportPathRef = useRef(null);

    const getShortPath = () => {
        const full = resolveTargetDir();
        if (!full) return hasLocalPath ? '未选择' : '未设置项目路径';
        if (!resolvedLocalPath) return full.split('/').pop() || full;
        const projFolder = resolvedLocalPath.split('/').pop() || '';
        const afterProj = full.slice(resolvedLocalPath.length);
        return projFolder + (afterProj || '');
    };

    const handleSubfolderChange = (subfolder) => {
        setTargetDir(subfolder);
    };

    return (
        <div className="page-panel">
            <div className="page-content">
                <div className="page-content-inner">
                    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                        
                        {!resolveStatus?.connected && (
                            <div style={{
                                padding: '12px 16px', borderRadius: '10px', fontSize: '13px',
                                background: 'rgba(255, 59, 48, 0.1)',
                                color: '#FF3B30',
                                display: 'flex', alignItems: 'center', gap: '8px',
                                marginBottom: '8px'
                            }}>
                                <AlertCircle size={16} /> 
                                未连接达芬奇，请先打开达芬奇并确保脚本服务已启动
                            </div>
                        )}

                        {resolveStatus?.connected && !hasTimeline && (
                            <div style={{
                                padding: '12px 16px', borderRadius: '10px', fontSize: '13px',
                                background: 'rgba(255, 149, 0, 0.1)',
                                color: '#FF9500',
                                display: 'flex', alignItems: 'center', gap: '8px',
                                marginBottom: '8px'
                            }}>
                                <AlertCircle size={16} /> 
                                请先打开时间线后再进行导出与备份
                            </div>
                        )}

                        {resolveStatus?.connected && hasTimeline && !hasLocalPath && (
                            <div style={{
                                padding: '12px 16px', borderRadius: '10px', fontSize: '13px',
                                background: 'rgba(255, 149, 0, 0.1)',
                                color: '#FF9500',
                                display: 'flex', alignItems: 'center', gap: '8px',
                                marginBottom: '8px'
                            }}>
                                <AlertCircle size={16} /> 
                                未检测到项目本地路径，请先设置项目路径后再进行导出
                                <button
                                    className="mac-btn"
                                    onClick={async () => {
                                        try {
                                            const path = await window.electronAPI.selectDirectory({ promptToCreate: true });
                                            if (path) await handleSetLocalPath(path);
                                        } catch (e) {}
                                    }}
                                    style={{
                                        marginLeft: 'auto',
                                        padding: '4px 12px',
                                        fontSize: '12px',
                                        border: '1px solid #FF9500',
                                        color: '#FF9500',
                                        background: 'transparent',
                                        borderRadius: '6px',
                                        cursor: 'pointer',
                                        whiteSpace: 'nowrap'
                                    }}
                                >
                                    设置项目路径
                                </button>
                            </div>
                        )}

                        <div className="mac-settings-section">
                            <div className="mac-settings-title">位置与文件夹</div>
                            <div className="mac-settings-group">
                                <div className="mac-settings-row">
                                    <div className="mac-settings-row-left">
                                        <div className="mac-settings-icon-wrapper" style={{ background: '#0A84FF', color: '#fff' }}>
                                            <FolderOpen size={16} />
                                        </div>
                                        <div className="mac-settings-text-block">
                                            <div className="mac-settings-label">导出位置</div>
                                            <div
                                                ref={exportPathRef}
                                                className="mac-settings-desc"
                                                style={{ cursor: 'default', position: 'relative' }}
                                                onMouseEnter={() => {
                                                    const full = resolveTargetDir();
                                                    if (full && full !== getShortPath()) setShowExportPathTooltip(true);
                                                }}
                                                onMouseLeave={() => setShowExportPathTooltip(false)}
                                                onMouseMove={() => {
                                                    if (exportPathRef.current) {
                                                        const rect = exportPathRef.current.getBoundingClientRect();
                                                        setExportTooltipPos({ x: rect.left, y: rect.bottom + 4 });
                                                    }
                                                }}
                                            >
                                                {getShortPath()}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="mac-settings-row-right" style={{ gap: '6px' }}>
                                        <MacSelect
                                            value={targetDir}
                                            onChange={handleSubfolderChange}
                                            options={folderOptions}
                                            placeholder={hasLocalPath ? '选择文件夹' : '请先设置项目路径'}
                                            width="140px"
                                            showPlaceholderOption={false}
                                        />
                                        <button 
                                            className="mac-btn" 
                                            onClick={handleSelectDirectory} 
                                            style={{ 
                                                padding: '6px 12px', 
                                                fontSize: '13px', 
                                                display: 'flex', 
                                                alignItems: 'center', 
                                                justifyContent: 'center',
                                                gap: '4px', 
                                                flexShrink: 0,
                                                height: '32px',
                                                borderRadius: '6px'
                                            }}
                                            title="自定义路径"
                                        >
                                            <Pencil size={14} />
                                        </button>
                                    </div>
                                </div>

                                <div className="mac-settings-row">
                                    <div className="mac-settings-row-left">
                                        <div className="mac-settings-icon-wrapper" style={{ background: '#FF9500', color: '#fff' }}>
                                            <FolderOpen size={16} />
                                        </div>
                                        <div className="mac-settings-text-block">
                                            <div className="mac-settings-label">导出到子文件夹</div>
                                            <div className="mac-settings-desc">为每次导出创建一个独立的子文件夹，适合多时间线项目</div>
                                        </div>
                                    </div>
                                    <div className="mac-settings-row-right">
                                        <ToggleSwitch checked={useSubfolder} onChange={setUseSubfolder} color="#0A84FF" />
                                    </div>
                                </div>

                                <AnimatePresence initial={false}>
                                    {useSubfolder && (
                                        <motion.div
                                            key="subfolder-options"
                                            initial={{ maxHeight: 0, opacity: 0 }}
                                            animate={{
                                                maxHeight: SUBFOLDER_OPTIONS_MAX_HEIGHT[subfolderType] || SUBFOLDER_OPTIONS_MAX_HEIGHT.timeline,
                                                opacity: 1
                                            }}
                                            exit={{ maxHeight: 0, opacity: 0 }}
                                            transition={{
                                                maxHeight: { duration: 0.18, ease: [0.32, 0.72, 0, 1] },
                                                opacity: { duration: 0.12, ease: 'easeOut' }
                                            }}
                                            style={{
                                                overflow: 'hidden',
                                                background: 'var(--mac-bg-secondary)'
                                            }}
                                        >
                                            <motion.div
                                                initial={{ y: -4, opacity: 0 }}
                                                animate={{ y: 0, opacity: 1 }}
                                                exit={{ y: -3, opacity: 0 }}
                                                transition={{
                                                    y: { duration: 0.14, ease: [0.32, 0.72, 0, 1] },
                                                    opacity: { duration: 0.12 }
                                                }}
                                                style={{
                                                    display: 'flex',
                                                    flexDirection: 'column',
                                                    padding: '12px 16px',
                                                    borderTop: '1px solid var(--mac-border)',
                                                    willChange: 'transform, opacity'
                                                }}
                                            >
                                                <div style={{
                                                    display: 'flex', background: 'var(--mac-panel-bg)', padding: '4px',
                                                    borderRadius: '8px', border: '1px solid var(--mac-border)', width: '100%',
                                                    boxSizing: 'border-box',
                                                    margin: '0 auto'
                                                }}>
                                                    <div
                                                        onClick={() => setSubfolderType('timeline')}
                                                        style={{
                                                            flex: 1, textAlign: 'center',
                                                            padding: '6px 14px', fontSize: '13px', cursor: 'pointer', borderRadius: '6px',
                                                            background: subfolderType === 'timeline' ? 'var(--mac-accent)' : 'transparent',
                                                            color: subfolderType === 'timeline' ? '#fff' : 'var(--mac-text)',
                                                            transition: 'all 0.2s', fontWeight: subfolderType === 'timeline' ? '500' : 'normal'
                                                        }}
                                                    >
                                                        以时间线命名
                                                    </div>
                                                    <div
                                                        onClick={() => setSubfolderType('custom')}
                                                        style={{
                                                            flex: 1, textAlign: 'center',
                                                            padding: '6px 14px', fontSize: '13px', cursor: 'pointer', borderRadius: '6px',
                                                            background: subfolderType === 'custom' ? 'var(--mac-accent)' : 'transparent',
                                                            color: subfolderType === 'custom' ? '#fff' : 'var(--mac-text)',
                                                            transition: 'all 0.2s', fontWeight: subfolderType === 'custom' ? '500' : 'normal'
                                                        }}
                                                    >
                                                        自定义命名
                                                    </div>
                                                </div>

                                                <AnimatePresence mode="wait">
                                                    {subfolderType === 'custom' && (
                                                        <motion.div
                                                            key="custom-subfolder-input"
                                                            initial={{ maxHeight: 0, y: -3, opacity: 0 }}
                                                            animate={{ maxHeight: CUSTOM_SUBFOLDER_INPUT_MAX_HEIGHT, y: 0, opacity: 1 }}
                                                            exit={{ maxHeight: 0, y: -2, opacity: 0 }}
                                                            transition={{
                                                                maxHeight: { duration: 0.16, ease: [0.32, 0.72, 0, 1] },
                                                                y: { duration: 0.12, ease: 'easeOut' },
                                                                opacity: { duration: 0.1, ease: 'easeOut' }
                                                            }}
                                                            style={{ overflow: 'hidden', display: 'flex', justifyContent: 'center', marginTop: 12, willChange: 'max-height, transform, opacity' }}
                                                        >
                                                            <input
                                                                type="text"
                                                                className="mac-input"
                                                                value={customSubfolder}
                                                                onChange={(e) => setCustomSubfolder(e.target.value)}
                                                                placeholder="输入子文件夹名称..."
                                                                style={{ width: '100%', padding: '8px 12px', boxSizing: 'border-box' }}
                                                            />
                                                        </motion.div>
                                                    )}
                                                </AnimatePresence>
                                            </motion.div>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        </div>

                        <div className="mac-settings-section">
                            <div className="mac-settings-title">文件命名规则</div>
                            <div className="mac-settings-group" style={{ padding: '16px' }}>
                                <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                        <div style={{ fontSize: '13px', color: 'var(--mac-text-secondary)', marginBottom: '8px', display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                                            <span>组合文件名 (拖拽调整顺序)：</span>
                                            <span style={{ fontSize: '12px', color: 'var(--mac-accent)', fontWeight: '500', wordBreak: 'break-all' }}>{getPreviewString()}</span>
                                        </div>
                                        <div 
                                            ref={containerRef}
                                            style={{ 
                                                display: 'flex', gap: '4px', flexWrap: 'wrap', minHeight: '44px',
                                                padding: '12px', background: 'var(--mac-bg)', 
                                                borderRadius: '10px', border: '1px dashed var(--mac-border)' 
                                            }}
                                        >
                                            {templateBlocks.map((block, index) => (
                                                <TagBlock 
                                                    key={block.instanceId} 
                                                    block={block}
                                                    index={index}
                                                    isDragSource={dragInstanceId === block.instanceId}
                                                    updateBlockValue={updateBlockValue}
                                                    removeBlock={removeBlock}
                                                    onEditStart={() => setEditingBlocks([...templateBlocks])}
                                                    onEditEnd={() => {
                                                        if (editingBlocks && JSON.stringify(editingBlocks) !== JSON.stringify(templateBlocks)) {
                                                            setPast(prev => [...prev, editingBlocks]);
                                                        }
                                                        setEditingBlocks(null);
                                                    }}
                                                    onPointerDown={handleTagPointerDown}
                                                />
                                            ))}
                                            {templateBlocks.length === 0 && (
                                                <div style={{ color: 'var(--mac-text-secondary)', fontSize: '13px', padding: '6px' }}>
                                                    请点击下方标签添加
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                <div style={{ display: 'flex', gap: '8px', marginTop: '16px', flexWrap: 'wrap' }}>
                                    {AVAILABLE_TAGS.map((tag) => (
                                        <button key={tag.id} className="mac-btn" onClick={() => addTagClick(tag)} style={{ fontSize: '12px', padding: '4px 10px' }}>
                                            <span style={{ color: 'var(--mac-accent)', marginRight: '4px' }}>{tag.icon}</span> {tag.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="mac-settings-group" style={{ marginTop: '8px' }}>
                                <div className="mac-settings-row">
                                    <div className="mac-settings-row-left">
                                        <div className="mac-settings-icon-wrapper" style={{ background: '#5856D6', color: '#fff' }}>
                                            <Settings size={16} />
                                        </div>
                                        <div className="mac-settings-text-block">
                                            <div className="mac-settings-label">自动添加分隔符</div>
                                            <div className="mac-settings-desc">在文件名各部分之间自动插入分隔符</div>
                                        </div>
                                    </div>
                                    <div className="mac-settings-row-right">
                                        {autoSeparator && (
                                            <input
                                                type="text"
                                                className="mac-input"
                                                value={separator}
                                                onChange={e => {
                                                    const val = e.target.value;
                                                    if (!val.includes('/') && !val.includes('\\')) {
                                                        setSeparator(val);
                                                    }
                                                }}
                                                style={{ width: '36px', textAlign: 'center', padding: '4px 6px' }}
                                            />
                                        )}
                                        <ToggleSwitch checked={autoSeparator} onChange={setAutoSeparator} color="#0A84FF" />
                                    </div>
                                </div>

                                <div className="mac-settings-row">
                                    <div className="mac-settings-row-left">
                                        <div className="mac-settings-icon-wrapper" style={{ background: '#FF9500', color: '#fff' }}>
                                            <Hash size={16} />
                                        </div>
                                        <div className="mac-settings-text-block">
                                            <div className="mac-settings-label">版本号前缀</div>
                                            <div className="mac-settings-desc">自定义版本号的格式前缀</div>
                                        </div>
                                    </div>
                                    <div className="mac-settings-row-right">
                                        <input
                                            type="text"
                                            className="mac-input"
                                            value={versionPrefix}
                                            onChange={e => setVersionPrefix(e.target.value)}
                                            placeholder="V"
                                            style={{ width: '80px', padding: '6px 10px', textAlign: 'center' }}
                                        />
                                    </div>
                                </div>

                                <div className="mac-settings-row">
                                    <div className="mac-settings-row-left">
                                        <div className="mac-settings-icon-wrapper" style={{ background: '#0A84FF', color: '#fff' }}>
                                            <FileVideo size={16} />
                                        </div>
                                        <div className="mac-settings-text-block">
                                            <div className="mac-settings-label">渲染预设名称</div>
                                            <div className="mac-settings-desc">留空将使用当前达芬奇渲染页面的默认设置</div>
                                        </div>
                                    </div>
                                    <div className="mac-settings-row-right">
                                        <MacSelect
                                            value={presetName}
                                            onChange={setPresetName}
                                            options={presetList.map(name => ({ value: name, label: name }))}
                                            placeholder="默认设置"
                                            width="160px"
                                            showPlaceholderOption={true}
                                        />
                                    </div>
                                </div>

                                <div className="mac-settings-row">
                                    <div className="mac-settings-row-left">
                                        <div className="mac-settings-icon-wrapper" style={{ background: '#34C759', color: '#fff' }}>
                                            <Calendar size={16} />
                                        </div>
                                        <div className="mac-settings-text-block">
                                            <div className="mac-settings-label">日期时间格式</div>
                                            <div className="mac-settings-desc">选择日期时间中包含的部分</div>
                                        </div>
                                    </div>
                                    <div className="mac-settings-row-right">
                                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                            {[
                                                { key: 'year', label: '年' },
                                                { key: 'month', label: '月' },
                                                { key: 'day', label: '日' },
                                                { key: 'hour', label: '时' },
                                                { key: 'minute', label: '分' },
                                                { key: 'second', label: '秒' },
                                            ].map(item => (
                                                <div
                                                    key={item.key}
                                                    onClick={() => setDatetimeParts(prev => ({ ...prev, [item.key]: !prev[item.key] }))}
                                                    style={datetimePillStyle(datetimeParts[item.key])}
                                                >
                                                    {item.label}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                    </div>

                    <div style={{ marginTop: '-12px', display: 'flex', gap: '10px', width: '100%' }}>
                        <button 
                            className="mac-btn primary" 
                            onClick={handleExport}
                            disabled={loading || !targetDir || !hasTimeline}
                            style={{ height: '40px', fontSize: '14px', fontWeight: '500', flex: 1, justifyContent: 'center', gap: '6px' }}
                        >
                            {loading ? '正在处理...' : <><FileVideo size={16} /> 渲染与备份</>}
                        </button>
                        <button 
                            className="mac-btn"
                            onClick={handleBackupOnly}
                            disabled={loading || !hasTimeline}
                            style={{
                                height: '40px',
                                fontSize: '14px',
                                fontWeight: '500',
                                justifyContent: 'center',
                                gap: '6px',
                                border: '1px solid var(--mac-accent)',
                                color: 'var(--mac-accent)',
                                background: 'transparent',
                                padding: '0 20px',
                                display: 'flex',
                                alignItems: 'center',
                                whiteSpace: 'nowrap'
                            }}
                        >
                            <Save size={16} /> 仅备份
                        </button>
                    </div>

                    {message && (
                        <div style={{
                            padding: '12px 16px', borderRadius: '10px', fontSize: '13px',
                            background: message.includes('失败') || message.includes('请') || message.includes('权限') || message.includes('不存在') ? 'rgba(255, 59, 48, 0.1)' : 'rgba(52, 199, 89, 0.1)',
                            color: message.includes('失败') || message.includes('请') || message.includes('权限') || message.includes('不存在') ? '#FF3B30' : '#34C759',
                            display: 'flex', alignItems: 'center', gap: '8px',
                            marginTop: '-3px'
                        }}>
                            <AlertCircle size={16} /> {message}
                        </div>
                    )}
                </div>
            </div>
            
            <AnimatePresence>
                {dragOverlay && (
                    <motion.div
                        initial={{ opacity: 0.9, scale: 1.05 }}
                        animate={{ opacity: 0.9, scale: 1.05 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        transition={springTransition}
                        style={{
                            position: 'fixed',
                            left: dragOverlay.x,
                            top: dragOverlay.y,
                            width: dragOverlay.width,
                            height: dragOverlay.height,
                            padding: '5px 8px',
                            background: dragOverlay.block.isEditable ? 'rgba(255,255,255,0.2)' : 'var(--mac-accent)',
                            color: '#FFF',
                            borderRadius: '10px',
                            fontSize: '13px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            boxShadow: '0 10px 30px rgba(0,0,0,0.4)',
                            cursor: 'grabbing',
                            border: dragOverlay.block.isEditable ? '1px solid var(--mac-accent)' : 'none',
                            pointerEvents: 'none',
                            zIndex: 10000
                        }}
                    >
                        {dragOverlay.block.icon}
                        {dragOverlay.block.isEditable ? (
                            <span>{dragOverlay.block.value}</span>
                        ) : (
                            dragOverlay.block.label
                        )}
                    </motion.div>
                )}
            </AnimatePresence>

            {showExportPathTooltip && createPortal(
                <div style={{
                    position: 'fixed',
                    left: exportTooltipPos.x,
                    top: exportTooltipPos.y,
                    padding: '4px 10px',
                    background: 'var(--mac-bg, #1e1e1e)',
                    border: '1px solid var(--mac-border)',
                    borderRadius: '6px',
                    fontSize: '11px',
                    color: 'var(--mac-text)',
                    whiteSpace: 'nowrap',
                    zIndex: 10000,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                    pointerEvents: 'none'
                }}>
                    {resolveTargetDir()}
                </div>,
                document.body
            )}
        </div>
    );
};

export default ExportView;
