/**
 * 视频导入与项目初始化组件
 * 负责设置达芬奇项目和导入视频文件
 */

import React, { useState } from 'react';
import axios from 'axios';
import './VideoImporter.css';

function VideoImporter({ onImport, apiBaseUrl }) {
    const [isDragging, setIsDragging] = useState(false);
    const [manualPath, setManualPath] = useState('');
    const [projectName, setProjectName] = useState('自动剪辑项目');
    const [folders, setFolders] = useState('视频, 音频, 输出');
    const [isInitializing, setIsInitializing] = useState(false);
    const [projectReady, setProjectReady] = useState(false);

    const handleInitProject = async () => {
        if (!projectName.trim()) {
            alert('项目名称不能为空');
            return;
        }
        
        setIsInitializing(true);
        try {
            const folderList = folders.split(',').map(f => f.trim()).filter(f => f);
            const response = await axios.post(`${apiBaseUrl}/api/project/init`, {
                project_name: projectName,
                folders: folderList
            });
            
            if (response.data.status === 'success') {
                setProjectReady(true);
            } else {
                alert(`初始化失败: ${response.data.message}`);
            }
        } catch (err) {
            alert(`初始化错误: ${err.response?.data?.detail || err.message}`);
        } finally {
            setIsInitializing(false);
        }
    };

    const handleSelectFile = async () => {
        if (window.electronAPI) {
            const filePath = await window.electronAPI.selectVideo();
            if (filePath) {
                onImport(filePath);
            }
        } else {
            alert('请在 Electron 环境中运行以使用文件选择器，或手动输入路径');
        }
    };

    const handleManualImport = () => {
        if (manualPath.trim()) {
            onImport(manualPath.trim());
        }
    };

    const handleDragOver = (e) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = (e) => {
        e.preventDefault();
        setIsDragging(false);
    };

    const handleDrop = (e) => {
        e.preventDefault();
        setIsDragging(false);
        
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            const file = files[0];
            if (window.electronAPI) {
                onImport(file.path);
            } else {
                alert('请在 Electron 环境中运行');
            }
        }
    };

    return (
        <div className="video-importer">
            {!projectReady ? (
                <div className="project-setup-box">
                    <h3>1. 初始化 DaVinci Resolve 项目</h3>
                    <div className="input-group">
                        <label>项目名称</label>
                        <input 
                            type="text" 
                            value={projectName} 
                            onChange={(e) => setProjectName(e.target.value)} 
                        />
                    </div>
                    <div className="input-group">
                        <label>媒体池结构 (逗号分隔)</label>
                        <input 
                            type="text" 
                            value={folders} 
                            onChange={(e) => setFolders(e.target.value)} 
                        />
                    </div>
                    <button 
                        className="primary full-width" 
                        onClick={handleInitProject}
                        disabled={isInitializing}
                    >
                        {isInitializing ? '正在初始化...' : '创建/连接项目'}
                    </button>
                    <p className="hint">点击此按钮将在达芬奇中自动创建项目与目录树</p>
                </div>
            ) : (
                <div className="import-box">
                    <div className="project-setup-box success-box">
                        <h3>✅ 项目准备就绪</h3>
                        <p>当前项目: {projectName}</p>
                    </div>
                    
                    <h3 style={{marginTop: '24px'}}>2. 导入视频并转录</h3>
                    <div 
                        className={`drop-zone ${isDragging ? 'dragging' : ''}`}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                        onClick={handleSelectFile}
                    >
                        <div className="drop-icon">📁</div>
                        <p>拖拽视频文件到这里</p>
                        <p className="sub-text">或点击选择文件</p>
                        <p className="supported-formats">支持格式: MP4, MOV, AVI, MKV, WebM</p>
                    </div>

                    <div className="divider">
                        <span>或</span>
                    </div>

                    <div className="manual-input">
                        <input
                            type="text"
                            placeholder="输入视频文件的绝对路径..."
                            value={manualPath}
                            onChange={(e) => setManualPath(e.target.value)}
                            onKeyPress={(e) => e.key === 'Enter' && handleManualImport()}
                        />
                        <button onClick={handleManualImport} disabled={!manualPath.trim()}>
                            导入
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

export default VideoImporter;
