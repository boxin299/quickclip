/**
 * 状态栏组件
 * 显示应用状态信息
 */

import React from 'react';
import './StatusBar.css';

function StatusBar({ videoPath, loading, transcript }) {
    const getFileName = (path) => {
        if (!path) return '';
        return path.split('/').pop() || path.split('\\').pop() || path;
    };

    return (
        <footer className="status-bar">
            <div className="status-left">
                {videoPath && (
                    <span className="status-item">
                        📹 {getFileName(videoPath)}
                    </span>
                )}
                {transcript && (
                    <span className="status-item">
                        📝 {transcript.segments?.length || 0} 片段
                    </span>
                )}
            </div>
            <div className="status-right">
                {loading && (
                    <span className="status-item loading">
                        ⏳ 处理中...
                    </span>
                )}
                <span className="status-item">
                    后端: http://localhost:8000
                </span>
            </div>
        </footer>
    );
}

export default StatusBar;
