import React, { useState, useEffect } from 'react';
import axios from 'axios';

const FolderConfigView = ({ apiBaseUrl }) => {
    const [localFolders, setLocalFolders] = useState('');
    const [davinciFolders, setDavinciFolders] = useState('');
    const [mapping, setMapping] = useState([]);
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState('');

    useEffect(() => {
        loadConfig();
    }, []);

    const loadConfig = async () => {
        try {
            const res = await axios.get(`${apiBaseUrl}/api/folder_config`);
            const data = res.data;
            setLocalFolders((data.local_folders || []).join('\n'));
            setDavinciFolders((data.davinci_folders || []).join('\n'));
            
            const mapArr = [];
            for (const [local, davinci] of Object.entries(data.mapping || {})) {
                mapArr.push({ local, davinci });
            }
            setMapping(mapArr);
        } catch (error) {
            console.error("加载配置失败", error);
        }
    };

    const handleSave = async () => {
        setLoading(true);
        setMessage('');
        try {
            const mapObj = {};
            mapping.forEach(m => {
                if (m.local && m.davinci) {
                    mapObj[m.local] = m.davinci;
                }
            });

            const payload = {
                local_folders: localFolders.split('\n').map(s => s.trim()).filter(s => s),
                davinci_folders: davinciFolders.split('\n').map(s => s.trim()).filter(s => s),
                mapping: mapObj
            };

            const res = await axios.post(`${apiBaseUrl}/api/folder_config`, payload);
            setMessage(res.data.message || '保存成功');
        } catch (error) {
            setMessage('保存失败：' + (error.response?.data?.detail || error.message));
        } finally {
            setLoading(false);
        }
    };

    const handleInstallWorkflow = async () => {
        setLoading(true);
        setMessage('正在生成并安装 Mac 快捷操作...');
        try {
            const res = await axios.post(`${apiBaseUrl}/api/folder_config/install_workflow`);
            setMessage(res.data.message || '安装成功');
        } catch (error) {
            setMessage('安装失败：' + (error.response?.data?.detail || error.message));
        } finally {
            setLoading(false);
        }
    };

    const addMapping = () => {
        setMapping([...mapping, { local: '', davinci: '' }]);
    };

    const removeMapping = (index) => {
        const newMap = [...mapping];
        newMap.splice(index, 1);
        setMapping(newMap);
    };

    const updateMapping = (index, field, value) => {
        const newMap = [...mapping];
        newMap[index][field] = value;
        setMapping(newMap);
    };

    return (
        <div className="view-container">
            <h3>项目文件夹结构与映射配置</h3>
            <p style={{ color: 'var(--mac-text-secondary)', fontSize: '13px', marginBottom: '20px' }}>
                自定义本地项目文件夹结构，以及达芬奇媒体池的文件夹结构，并设置它们之间的映射关系。
                这决定了自动扫描本地目录时，素材会导入到达芬奇的哪个文件夹中。
            </p>

            <div style={{ display: 'flex', gap: '20px', marginBottom: '20px' }}>
                <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>
                        本地文件夹结构 (每行一个，使用 / 分隔层级)
                    </label>
                    <textarea 
                        className="mac-input"
                        value={localFolders}
                        onChange={e => setLocalFolders(e.target.value)}
                        style={{ width: '100%', height: '200px', resize: 'vertical' }}
                        placeholder="例如：\n00筹备\n01原始素材/摄影机素材"
                    />
                </div>
                <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>
                        达芬奇媒体池结构 (每行一个，使用 / 分隔层级)
                    </label>
                    <textarea 
                        className="mac-input"
                        value={davinciFolders}
                        onChange={e => setDavinciFolders(e.target.value)}
                        style={{ width: '100%', height: '200px', resize: 'vertical' }}
                        placeholder="例如：\n视频/摄影机素材\n音频/音效"
                    />
                    <div style={{ fontSize: '12px', color: 'var(--mac-text-secondary)', marginTop: '5px' }}>
                        注：达芬奇中会强制创建“时间线”和“时间线备份”文件夹，无需在此处声明。
                    </div>
                </div>
            </div>

            <div style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                    <label style={{ fontWeight: '500' }}>本地 -> 达芬奇 导入映射规则</label>
                    <button className="mac-btn" onClick={addMapping}>+ 添加规则</button>
                </div>
                
                <div style={{ background: 'var(--mac-bg-secondary)', padding: '15px', borderRadius: '8px' }}>
                    {mapping.length === 0 ? (
                        <div style={{ color: 'var(--mac-text-secondary)', textAlign: 'center' }}>暂无映射规则</div>
                    ) : (
                        mapping.map((m, i) => (
                            <div key={i} style={{ display: 'flex', gap: '10px', marginBottom: '10px', alignItems: 'center' }}>
                                <input 
                                    type="text" 
                                    className="mac-input" 
                                    style={{ flex: 1 }} 
                                    placeholder="本地相对路径 (例如 01原始素材/摄影机素材)"
                                    value={m.local}
                                    onChange={e => updateMapping(i, 'local', e.target.value)}
                                />
                                <span style={{ color: 'var(--mac-text-secondary)' }}>➞</span>
                                <input 
                                    type="text" 
                                    className="mac-input" 
                                    style={{ flex: 1 }} 
                                    placeholder="达芬奇路径 (例如 视频/摄影机素材)"
                                    value={m.davinci}
                                    onChange={e => updateMapping(i, 'davinci', e.target.value)}
                                />
                                <button className="mac-btn" style={{ background: '#ff3b30', color: 'white', border: 'none' }} onClick={() => removeMapping(i)}>
                                    删除
                                </button>
                            </div>
                        ))
                    )}
                </div>
            </div>

            <div style={{ display: 'flex', gap: '15px', alignItems: 'center' }}>
                <button className="mac-btn primary" onClick={handleSave} disabled={loading}>
                    {loading ? '保存中...' : '保存配置'}
                </button>
                <button className="mac-btn" onClick={handleInstallWorkflow} disabled={loading}>
                    安装 Mac 快捷操作 (创建本地文件夹)
                </button>
                {message && (
                    <span style={{ color: message.includes('失败') ? '#ff3b30' : '#34c759', fontSize: '14px' }}>
                        {message}
                    </span>
                )}
            </div>
        </div>
    );
};

export default FolderConfigView;