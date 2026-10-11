/**
 * 时间线预览组件
 * 显示生成的剪辑时间线
 */

import { useState } from 'react';
import axios from 'axios';
import './TimelinePreview.css';

function TimelinePreview({ timeline, onBack, apiBaseUrl }) {
    const [copied, setCopied] = useState(false);

    const formatTime = (seconds) => {
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    const handleCopyJSON = () => {
        navigator.clipboard.writeText(JSON.stringify(timeline, null, 2));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleExportJSON = () => {
        const blob = new Blob([JSON.stringify(timeline, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'timeline.json';
        a.click();
        URL.revokeObjectURL(url);
    };

    const handleApplyToResolve = async () => {
        try {
            await axios.post(`${apiBaseUrl}/api/timeline/apply`);
            alert('时间线已成功应用到 DaVinci Resolve！');
        } catch (err) {
            alert(`应用失败: ${err.response?.data?.detail || err.message}`);
        }
    };

    return (
        <div className="timeline-preview">
            <div className="preview-header">
                <button className="secondary" onClick={onBack}>← 返回编辑</button>
                <h2>时间线预览</h2>
                <div className="actions">
                    <button className="secondary" onClick={handleCopyJSON}>
                        {copied ? '已复制!' : '复制 JSON'}
                    </button>
                    <button className="secondary" onClick={handleExportJSON}>
                        导出 JSON
                    </button>
                    <button className="primary" onClick={handleApplyToResolve}>
                        应用到 DaVinci Resolve
                    </button>
                </div>
            </div>

            <div className="preview-content">
                <div className="timeline-info">
                    <div className="info-card">
                        <h3>时间线信息</h3>
                        <div className="info-grid">
                            <div className="info-item">
                                <span className="label">帧率</span>
                                <span className="value">{timeline.frame_rate} fps</span>
                            </div>
                            <div className="info-item">
                                <span className="label">片段数</span>
                                <span className="value">{timeline.total_clips}</span>
                            </div>
                            <div className="info-item">
                                <span className="label">总时长</span>
                                <span className="value">{formatTime(timeline.total_duration_seconds)}</span>
                            </div>
                            <div className="info-item">
                                <span className="label">总帧数</span>
                                <span className="value">{timeline.total_duration_frames}</span>
                            </div>
                        </div>
                    </div>

                    <div className="info-card">
                        <h3>剪辑统计</h3>
                        <div className="info-grid">
                            <div className="info-item">
                                <span className="label">保留片段</span>
                                <span className="value">{timeline.total_clips}</span>
                            </div>
                            <div className="info-item">
                                <span className="label">删除片段</span>
                                <span className="value">{timeline.deleted_segments?.length || 0}</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="timeline-visual">
                    <h3>时间线片段</h3>
                    <div className="timeline-track">
                        {timeline.clips.map((clip, index) => (
                            <div 
                                key={clip.clip_id}
                                className={`timeline-clip ${clip.bold ? 'bold' : ''}`}
                                style={{
                                    width: `${(clip.duration_seconds / timeline.total_duration_seconds) * 100}%`
                                }}
                            >
                                <div className="clip-index">{index + 1}</div>
                                <div className="clip-text">{clip.text}</div>
                                <div className="clip-duration">{clip.duration_seconds.toFixed(2)}s</div>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="clips-detail">
                    <h3>片段详情</h3>
                    <table>
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>源入点</th>
                                <th>源出点</th>
                                <th>时间线位置</th>
                                <th>时长</th>
                                <th>文本</th>
                            </tr>
                        </thead>
                        <tbody>
                            {timeline.clips.map((clip) => (
                                <tr key={clip.clip_id} className={clip.bold ? 'bold' : ''}>
                                    <td>{clip.clip_id + 1}</td>
                                    <td>{clip.source_start_timecode}</td>
                                    <td>{clip.source_end_timecode}</td>
                                    <td>{clip.timeline_start_timecode}</td>
                                    <td>{clip.duration_seconds}s</td>
                                    <td>{clip.text}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                <div className="json-preview">
                    <h3>JSON 数据</h3>
                    <pre>{JSON.stringify(timeline, null, 2)}</pre>
                </div>
            </div>
        </div>
    );
}

export default TimelinePreview;
