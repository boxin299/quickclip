import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { FolderOpen, Clapperboard, AlertCircle } from 'lucide-react';
import tauriAPI from '../tauriAPI';
import FolderConfigGraph from './FolderConfigGraph';

function ProjectSetup({ onProjectCreated, apiBaseUrl, projectContext, onRefreshContext, onNavigateToFolder }) {
    const [projectName, setProjectName] = useState('');
    const [localPath, setLocalPath] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [showPathTooltip, setShowPathTooltip] = useState(false);
    const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
    const pathRef = useRef(null);
    const [hasExistingProject, setHasExistingProject] = useState(false);

    useEffect(() => {
        if (projectContext?.local_path) {
            setHasExistingProject(true);
            setProjectName(projectContext.project_name || '');
            const pendingPath = sessionStorage.getItem('pendingProjectPath');
            setLocalPath(pendingPath || projectContext.local_path || '');
        } else {
            setHasExistingProject(false);
            setProjectName('');
            const pendingPath = sessionStorage.getItem('pendingProjectPath');
            setLocalPath(pendingPath || '');
        }
    }, [projectContext?.local_path, projectContext?.project_name]);

    useEffect(() => {
        return () => {
            sessionStorage.removeItem('pendingProjectPath');
        };
    }, []);

    const handleSelectDirectory = async () => {
        try {
            let dir = null;
            if (window.electronAPI && window.electronAPI.selectDirectory) {
                dir = await window.electronAPI.selectDirectory();
            } else {
                dir = await tauriAPI.selectDirectory({ title: '选择项目本地素材目录' });
            }
            if (!dir) return;
            await tauriAPI.getFileInfo(dir);
            setLocalPath(dir);
            // 暂存到 sessionStorage，防止切换页面后丢失
            sessionStorage.setItem('pendingProjectPath', dir);

            if (!hasExistingProject) {
                const folderName = dir.split(/[/\\]/).pop();
                const nameWithoutDate = folderName.replace(/^(\d{4}[-_]?\d{2}[-_]?\d{2}|\d{6,8})[-_ ]*/, '');
                if (nameWithoutDate && !projectName) {
                    setProjectName(nameWithoutDate);
                } else if (!projectName) {
                    setProjectName(folderName);
                }
            }
        } catch (e) {
            setError('选择目录失败: ' + (e?.message || String(e)));
        }
    };

    const handleCreateProject = async () => {
        if (!projectName.trim() || !localPath) {
            setError('请输入项目名称并选择素材目录');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const response = await axios.post(`${apiBaseUrl}/api/project/create`, {
                project_name: projectName.trim(),
                local_path: localPath
            });
            if (response.data.status === 'success') {
                sessionStorage.removeItem('pendingProjectPath');
                onProjectCreated(response.data);
            } else {
                setError(response.data.message || '创建项目失败');
            }
        } catch (err) {
            setError(err.response?.data?.detail || err.message || '无法连接后端服务');
        } finally {
            setLoading(false);
        }
    };

    const handleUpdatePath = async () => {
        if (!localPath) {
            setError('请先选择素材目录');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const res = await axios.post(`${apiBaseUrl}/api/project/set-local-path`, { local_path: localPath });
            if (res.data.status === 'error') {
                setError(res.data.message || '更新失败');
                setLoading(false);
                return;
            }
            sessionStorage.removeItem('pendingProjectPath');
            await onRefreshContext();
        } catch (err) {
            console.error('更新项目路径失败:', err);
            if (err.response) {
                setError(err.response.data?.message || err.response.data?.detail || `服务器错误 (${err.response.status})`);
            } else if (err.request) {
                setError('无法连接后端服务，请确认后端已启动 (端口 18000)');
            } else {
                setError(err.message || '更新项目路径失败');
            }
        } finally {
            setLoading(false);
        }
    };

    // 已存在项目且路径已变更时，显示"更改项目路径"按钮
    const isPathChanged = hasExistingProject
        && localPath
        && localPath !== projectContext?.local_path;

    return (
        <div className="page-panel">
            <div className="page-content">
                <motion.div
                    className="page-content-inner"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, ease: 'easeOut' }}
                >
                    <AnimatePresence>
                        {error && (
                            <motion.div
                                initial={{ opacity: 0, y: -10, height: 0 }}
                                animate={{ opacity: 1, y: 0, height: 'auto' }}
                                exit={{ opacity: 0, y: -10, height: 0 }}
                                transition={{ duration: 0.2 }}
                                style={{
                                    background: 'rgba(255, 59, 48, 0.1)', color: '#FF3B30',
                                    padding: '12px 16px', borderRadius: '10px', fontSize: '13px',
                                    display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '24px',
                                    border: '1px solid rgba(255, 59, 48, 0.2)'
                                }}
                            >
                                <AlertCircle size={16} /> {error}
                            </motion.div>
                        )}
                    </AnimatePresence>

                    <div className="mac-settings-section" style={{ marginBottom: 0 }}>
                        <div className="mac-settings-title">项目初始化</div>
                        <div className="mac-settings-group">
                            <div className="mac-settings-row">
                                <div className="mac-settings-row-left">
                                    <div className="mac-settings-icon-wrapper" style={{ background: '#0A84FF', color: '#fff' }}>
                                        <Clapperboard size={16} />
                                    </div>
                                    <div className="mac-settings-text-block">
                                        <div className="mac-settings-label">项目名称</div>
                                        <div className="mac-settings-desc">
                                            {hasExistingProject ? '当前达芬奇项目名称' : '为您的新剪辑项目命名'}
                                        </div>
                                    </div>
                                </div>
                                <div className="mac-settings-row-right">
                                    <input
                                        type="text"
                                        className="mac-input"
                                        value={projectName}
                                        onChange={(e) => setProjectName(e.target.value)}
                                        placeholder="例如：剪辑项目_01"
                                        disabled={hasExistingProject}
                                        style={{ width: '200px', padding: '6px 10px' }}
                                    />
                                </div>
                            </div>

                            <div className="mac-settings-row">
                                <div className="mac-settings-row-left">
                                    <div className="mac-settings-icon-wrapper" style={{ background: '#FF9500', color: '#fff' }}>
                                        <FolderOpen size={16} />
                                    </div>
                                    <div className="mac-settings-text-block">
                                        <div className="mac-settings-label">本地素材路径</div>
                                        <div
                                            ref={pathRef}
                                            className="mac-settings-desc"
                                            style={{ maxWidth: '200px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'default', position: 'relative' }}
                                            onMouseEnter={() => setShowPathTooltip(true)}
                                            onMouseLeave={() => setShowPathTooltip(false)}
                                            onMouseMove={(e) => {
                                                if (pathRef.current) {
                                                    const rect = pathRef.current.getBoundingClientRect();
                                                    setTooltipPos({ x: rect.left, y: rect.bottom + 4 });
                                                }
                                            }}
                                        >
                                            {localPath || '未选择素材目录'}
                                        </div>
                                    </div>
                                </div>
                                <div className="mac-settings-row-right">
                                    <button className="mac-btn" onClick={handleSelectDirectory} style={{ padding: '4px 12px', fontSize: '12px' }}>
                                        <FolderOpen size={14} style={{ marginRight: '6px' }} /> 选择文件夹
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div style={{ display: 'flex', width: '100%' }}>
                        {hasExistingProject ? (
                            <button
                                className="mac-btn primary"
                                onClick={handleUpdatePath}
                                disabled={loading || !isPathChanged}
                                style={{ height: '40px', fontSize: '14px', fontWeight: '500', width: '100%', justifyContent: 'center' }}
                            >
                                {loading ? '正在更新...' : '更改项目路径'}
                            </button>
                        ) : (
                            <button
                                className="mac-btn primary"
                                onClick={handleCreateProject}
                                disabled={loading || !projectName.trim() || !localPath}
                                style={{ height: '40px', fontSize: '14px', fontWeight: '500', width: '100%', justifyContent: 'center' }}
                            >
                                {loading ? '正在初始化...' : '立即创建项目'}
                            </button>
                        )}
                    </div>

                    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                        <FolderConfigGraph apiBaseUrl={apiBaseUrl} embedded setActivePage={onNavigateToFolder || undefined} />
                    </div>
                </motion.div>
            </div>

            {showPathTooltip && localPath && createPortal(
                <div style={{
                    position: 'fixed',
                    left: tooltipPos.x,
                    top: tooltipPos.y,
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
                    {localPath}
                </div>,
                document.body
            )}
        </div>
    );
}

export default ProjectSetup;
