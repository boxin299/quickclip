import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Settings, CheckCircle2, AlertTriangle,
    Wrench, Monitor, Download, Trash2,
    RotateCcw, Circle, Loader, Loader2, XCircle, Cloud, CloudOff, RefreshCw,
    Info, ArrowUpCircle, FolderOpen, Sun, Moon, Heart, QrCode, X,
} from 'lucide-react';
import { API_BASE_URL } from '../config';
import tauriAPI from '../tauriAPI';

const DONATE_QR_SRC = `${import.meta.env.BASE_URL}donate-qr.png`;

/* ── Runtime health check helper ────────────────────── */

let _healthCache = { data: null, time: 0, key: '' };
let _initialCheckDone = false;

function useRuntimeHealth(apiBaseUrl) {
    const [status, setStatus] = useState(_healthCache.data || { backend: null, ffmpeg: null, python: null, whisper: null, diarization: null });
    const [loading, setLoading] = useState(!_healthCache.data);

    const check = useCallback(async () => {
        setLoading(true);
        try {
            const [statusRes, healthRes, modelRes] = await Promise.all([
                axios.get(`${apiBaseUrl}/api/status`, { timeout: 5000 }).catch(() => null),
                axios.get(`${apiBaseUrl}/api/backend/health`, { timeout: 5000 }).catch(() => null),
                axios.get(`${apiBaseUrl}/api/backend/funasr/models`, { timeout: 5000 }).catch(() => null),
            ]);
            const models = (modelRes?.data?.models || []).reduce((acc, m) => { acc[m.key] = m; return acc; }, {});
            const pyInfo = healthRes?.data?.python || {};
            const newStatus = {
                backend: statusRes ? { ok: true, detail: statusRes.data?.connected ? '已连接 DaVinci' : '后端运行中' } : { ok: false, detail: '未连接' },
                python: pyInfo?.available ? { ok: true, detail: `Python ${pyInfo.version || ''} (${pyInfo.executable || ''})` } : { ok: false, detail: 'Python 3 未检测到' },
                ffmpeg: healthRes?.data?.ffmpeg?.available ? { ok: true, detail: healthRes.data.ffmpeg.path || '已就绪' } : { ok: false, detail: '未检测到' },
                whisper: models?.whisper?.installed ? { ok: true, detail: 'faster-whisper (small) 已安装' } : { ok: false, detail: 'faster-whisper 未安装' },
                diarization: models?.seg?.installed && models?.emb?.installed ? { ok: true, detail: 'sherpa-onnx 说话人分离已就绪' } : { ok: false, detail: 'sherpa-onnx 模型未安装' },
            };
            _healthCache = { data: newStatus, time: Date.now(), key: apiBaseUrl };
            setStatus(newStatus);
        } catch {
            setStatus({ backend: { ok: false, detail: '后端未启动' }, ffmpeg: null, python: null, whisper: null, diarization: null });
        } finally {
            setLoading(false);
        }
    }, [apiBaseUrl]);

    useEffect(() => {
        if (!_initialCheckDone) {
            _initialCheckDone = true;
            check();
        }
    }, [check]);

    return [status, loading, check];
}

/* ── Status icon ────────────────────────────────────── */

function StatusIcon({ ok }) {
    if (ok === true) return <CheckCircle2 size={14} style={{ color: '#34C759' }} />;
    if (ok === false) return <XCircle size={14} style={{ color: '#FF3B30' }} />;
    return <Circle size={14} style={{ color: 'var(--mac-text-secondary)' }} />;
}

/* ── Main component ─────────────────────────────────── */

function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec <= 0) return '—';
    if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
    if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
    return `${Math.round(bytesPerSec)} B/s`;
}

function formatElapsed(seconds) {
    if (seconds <= 0) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function SettingsView({ apiBaseUrl, theme = 'auto', onThemeChange }) {
    const [appId, setAppId] = useState('');
    const [appSecret, setAppSecret] = useState('');
    const [feishuUid, setFeishuUid] = useState('');
    const [saveLoading, setSaveLoading] = useState(false);
    const [captureLoading, setCaptureLoading] = useState(false);
    const [oauthLoading, setOauthLoading] = useState(false);
    const [message, setMessage] = useState(null);
    const [error, setError] = useState(null);
    const [envExpanded, setEnvExpanded] = useState(false);
    const [donateOpen, setDonateOpen] = useState(false);

    // ── 模型安装 ──────────────────────
    const [deletingModels, setDeletingModels] = useState(false);

    // ── 技能安装 ──────────────────────
    const [skills, setSkills] = useState([]);
    const [skillsLoading, setSkillsLoading] = useState(true);
    const [installing, setInstalling] = useState(null);
    const [hoveredDot, setHoveredDot] = useState(null);
    const [popoverPos, setPopoverPos] = useState({ x: 0, y: 0 });
    const hoverTimerRef = React.useRef(null);

    const [runtimeStatus, runtimeLoading, refreshRuntime] = useRuntimeHealth(apiBaseUrl);

    // ── 模型安装管理（模块级持久化 + 轮询）──────────────────
    const modelInstalled = runtimeStatus.whisper?.ok === true || runtimeStatus.diarization?.ok === true;
    const modelMissing = runtimeStatus.whisper?.ok === false || runtimeStatus.diarization?.ok === false;

    // 模块级变量：组件卸载/重载时状态不丢失
    if (!window.__quickclip_installProgress) window.__quickclip_installProgress = null;
    if (!window.__quickclip_installTimer) window.__quickclip_installTimer = null;

    const [installProgress, setInstallProgress] = useState(window.__quickclip_installProgress);

    const syncProgress = (data) => {
        window.__quickclip_installProgress = data;
        setInstallProgress(data);
    };

    // 页面挂载时检查是否有进行中的安装
    useEffect(() => {
        let cancelled = false;
        // 如果已有模块级状态且正在运行，直接恢复（无需等网络请求）
        if (window.__quickclip_installProgress?.running) {
            setInstallProgress({...window.__quickclip_installProgress});
        }
        const check = async (retry = true) => {
            try {
                const res = await axios.get(`${apiBaseUrl}/api/backend/funasr/models/install/progress`);
                if (cancelled) return;
                const d = res.data || {};
                if (d.running) {
                    syncProgress(d);
                } else if (d.finished && d.error) {
                    window.__quickclip_installProgress = null;
                    setError(d.error);
                } else if (d.finished && d.stage === 'done') {
                    window.__quickclip_installProgress = null;
                    refreshRuntime();
                }
            } catch {
                if (retry && !cancelled) {
                    await new Promise(r => setTimeout(r, 1000));
                    await check(false);
                }
            }
        };
        check();
        return () => { cancelled = true; };
    }, [apiBaseUrl]);

    // 轮询安装进度（永不主动停止，直到后端返回 running=false）
    useEffect(() => {
        if (installProgress?.running && !window.__quickclip_installTimer) {
            let failCount = 0;
            const poll = async () => {
                try {
                    const res = await axios.get(`${apiBaseUrl}/api/backend/funasr/models/install/progress`, { timeout: 8000 });
                    failCount = 0;
                    syncProgress(res.data);
                    if (!res.data.running) {
                        clearInterval(window.__quickclip_installTimer);
                        window.__quickclip_installTimer = null;
                        window.__quickclip_installProgress = null;
                        refreshRuntime();
                        if (res.data.error) {
                            setError(res.data.error);
                        } else {
                            setMessage('模型安装完成');
                        }
                    }
                } catch {
                    failCount++;
                    // 连续失败超过 30 次（约 45s）才降速，但永不停止
                    if (failCount > 30) {
                        clearInterval(window.__quickclip_installTimer);
                        window.__quickclip_installTimer = setInterval(poll, 5000);
                    }
                }
            };
            poll();
            window.__quickclip_installTimer = setInterval(poll, 1500);
        }
        return () => {};
    }, [installProgress?.running]);

    const installingModels = installProgress?.running === true;

    // 安装进行中时自动展开面板
    useEffect(() => {
        if (installingModels) setEnvExpanded(true);
    }, [installingModels]);

    // 安装耗时计时器
    const [installElapsed, setInstallElapsed] = useState(0);
    useEffect(() => {
        if (!installingModels) {
            setInstallElapsed(0);
            return;
        }
        const t0 = Date.now();
        const timer = setInterval(() => {
            setInstallElapsed(Math.round((Date.now() - t0) / 1000));
        }, 1000);
        return () => clearInterval(timer);
    }, [installingModels]);

    const handleInstallModels = async () => {
        setError(null);
        setMessage(null);
        try {
            await axios.post(`${apiBaseUrl}/api/backend/funasr/models/install`, { force: false });
            syncProgress({ running: true, stage: 'start', detail: '准备安装…', error: null, finished: false, total_bytes: 0, downloaded_bytes: 0, speed: 0 });
        } catch (e) {
            if (e.response?.status === 409) {
                setError('安装正在进行中，请等待完成');
            } else {
                setError(e.response?.data?.detail || '模型安装失败');
            }
        }
    };

    const handleDeleteModels = async () => {
        setDeletingModels(true);
        setError(null);
        setMessage(null);
        try {
            const res = await axios.post(`${apiBaseUrl}/api/backend/funasr/models/delete`, {});
            setMessage(res.data.message || '模型已删除');
            refreshRuntime();
        } catch (e) {
            setError(e.response?.data?.detail || '模型删除失败');
        } finally {
            setDeletingModels(false);
        }
    };

    // ── 更新检测 ──────────────────────
    const [updateCheckLoading, setUpdateCheckLoading] = useState(false);
    const [updateInfo, setUpdateInfo] = useState(null);
    const isTauri = !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
    // 运行时从 Tauri 读取版本号（单一真相源：tauri.conf.json），非 Tauri 环境回退到构建常量
    const [appVersion, setAppVersion] = useState('1.0.0');
    useEffect(() => {
        if (isTauri) {
            import('@tauri-apps/api/app').then(m => m.getVersion()).then(v => setAppVersion(v)).catch(() => {});
        }
    }, [isTauri]);

    const checkForUpdates = useCallback(async () => {
        setUpdateCheckLoading(true);
        setUpdateInfo(null);
        try {
            let platform = 'macos';
            let arch = 'aarch64';
            if (isTauri) {
                try {
                    const ua = navigator.userAgent || '';
                    if (ua.includes('Windows')) platform = 'windows';
                    else if (ua.includes('Linux')) platform = 'linux';
                } catch {}
            }
            const res = await axios.get(
                `${API_BASE_URL}/api/update/check?platform=${platform}&arch=${arch}&current_version=${appVersion}`
            );
            setUpdateInfo(res.data);
        } catch (e) {
            setUpdateInfo({
                has_update: false,
                error: true,
                message: e.response?.data?.message || e.response?.data?.detail || e.message || '无法连接到更新服务器',
            });
        } finally {
            setUpdateCheckLoading(false);
        }
    }, [isTauri, appVersion]);

    // 启动时自动检测更新（仅 Tauri 环境）
    useEffect(() => {
        if (isTauri) {
            checkForUpdates();
        }
    }, [isTauri, checkForUpdates]);

    useEffect(() => {
        const fetchConfig = async () => {
            try {
                const endpoint = `${apiBaseUrl}/api/config`;
                const res = await axios.get(endpoint);
                setAppId(res.data.feishu_app_id || '');
                setAppSecret(res.data.feishu_app_secret || '');
                setFeishuUid(res.data.feishu_uid || '');
            } catch (e) {
                console.error('无法读取配置', e);
            }
        };
        fetchConfig();
    }, [apiBaseUrl]);

    // 模型依赖有异常时自动展开
    useEffect(() => {
        if (!runtimeLoading) {
            const hasError = Object.values(runtimeStatus).some(
                (s) => s && s.ok === false
            );
            if (hasError) setEnvExpanded(true);
        }
    }, [runtimeStatus, runtimeLoading]);

    // 加载关联技能清单
    const fetchSkills = useCallback(async () => {
        setSkillsLoading(true);
        try {
            const res = await axios.get(`${apiBaseUrl}/api/skills/bundled`);
            setSkills(res.data.skills || []);
        } catch (e) {
            console.error('无法加载技能清单', e);
            setSkills([]);
        } finally {
            setSkillsLoading(false);
        }
    }, [apiBaseUrl]);

    useEffect(() => {
        fetchSkills();
    }, [fetchSkills]);

    useEffect(() => {
        if (!donateOpen) return;
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') setDonateOpen(false);
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [donateOpen]);

    const handleInstall = async (skillKey, platformId) => {
        const tag = `${skillKey}:${platformId}`;
        setInstalling(tag);
        try {
            const res = await axios.post(`${apiBaseUrl}/api/skills/install`, { key: skillKey, target: platformId });
            if (res.data.ok) fetchSkills();
        } catch (e) {
            console.error('安装技能失败', e);
        } finally {
            setInstalling(null);
        }
    };

    const handleUninstall = async (skillKey, platformId) => {
        const tag = `${skillKey}:${platformId}`;
        setInstalling(tag);
        try {
            const res = await axios.post(`${apiBaseUrl}/api/skills/uninstall`, { key: skillKey, target: platformId });
            if (res.data.ok) fetchSkills();
        } catch (e) {
            console.error('卸载技能失败', e);
        } finally {
            setInstalling(null);
        }
    };

    const handleReveal = (dir) => {
        tauriAPI.revealInFinder(dir);
    };

    const handleSave = async () => {
        setSaveLoading(true);
        setMessage(null);
        setError(null);
        try {
            const endpoint = `${apiBaseUrl}/api/config`;
            const res = await axios.post(endpoint, {
                feishu_app_id: appId,
                feishu_app_secret: appSecret,
                feishu_uid: feishuUid,
            });
            if (res.data.status === 'success') {
                setMessage('全局配置已成功保存！');
            } else {
                setError(res.data.message);
            }
        } catch (e) {
            setError(e.response?.data?.detail || e.message);
        } finally {
            setSaveLoading(false);
        }
    };

    const handleAutoCreate = async () => {
        if (!window.electronAPI || !window.electronAPI.openFeishuBotCreator) {
            setError('自动抓取需要桌面客户端环境。你可以手动输入 App ID 和 App Secret，或点击下方「飞书开发者后台」前往飞书开放平台查看凭证。');
            return;
        }
        setCaptureLoading(true);
        setError(null);
        setMessage('正在打开飞书授权页面，请在弹出的窗口中登录飞书并进入应用的「凭证与基础信息」页面...');
        try {
            const res = await window.electronAPI.openFeishuBotCreator('https://open.feishu.cn/app');
            if (res && res.appId && res.appSecret) {
                setAppId(res.appId);
                setAppSecret(res.appSecret);
                setMessage('密钥抓取成功！请点击下方"保存配置"。');
            } else {
                setMessage('');
                setError('未能自动获取凭证。请在弹出的飞书页面中点击进入你的应用，查看「凭证与基础信息」页面；如仍未获取，可手动复制 App ID 和 App Secret 粘贴到上方输入框。');
            }
        } catch (e) {
            setMessage('');
            setError(e.message || '抓取失败，请手动输入 App ID 和 App Secret');
        } finally {
            setCaptureLoading(false);
        }
    };

    const handleFeishuOAuth = async () => {
        setOauthLoading(true);
        setError(null);
        setMessage(null);
        try {
            const res = await axios.get(`${apiBaseUrl}/api/feishu/auth_url`);
            const authUrl = res.data.auth_url;
            if (!authUrl) {
                setError('无法获取授权 URL');
                return;
            }
            setMessage('正在打开飞书授权页面，请在浏览器中完成登录...');
            await tauriAPI.openUrl(authUrl);
            setMessage('请在浏览器中授权后返回本页面，系统将自动完成登录。');
        } catch (e) {
            setError(e.response?.data?.detail || e.message || '授权失败');
        } finally {
            setOauthLoading(false);
        }
    };

    // 模型依赖状态摘要
    const envItems = [
        { key: 'whisper', label: 'faster-whisper', iconBg: '#34C759' },
        { key: 'diarization', label: 'sherpa-onnx', iconBg: '#AF52DE' },
    ];
    const okCount = envItems.filter((e) => runtimeStatus[e.key]?.ok === true).length;
    const totalCount = envItems.length;
    const allOk = okCount === totalCount;
    const envSummary = allOk
        ? '所有组件运行正常'
        : `${totalCount - okCount} 个组件异常`;

    return (
        <div className="page-panel">
            <div className="page-content">
                <motion.div
                    className="page-content-inner"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, ease: 'easeOut' }}
                >
                    {/* global messages */}
                    <AnimatePresence>
                        {error && (
                            <motion.div
                                initial={{ opacity: 0, y: -10, height: 0 }}
                                animate={{ opacity: 1, y: 0, height: 'auto' }}
                                exit={{ opacity: 0, y: -10, height: 0 }}
                                transition={{ duration: 0.2 }}
                                style={{ background: 'rgba(255, 59, 48, 0.1)', color: '#FF3B30', padding: '12px 16px', borderRadius: '10px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', border: '1px solid rgba(255, 59, 48, 0.2)' }}
                            >
                                <AlertTriangle size={16} /> {error}
                            </motion.div>
                        )}

                        {message && (
                            <motion.div
                                initial={{ opacity: 0, y: -10, height: 0 }}
                                animate={{ opacity: 1, y: 0, height: 'auto' }}
                                exit={{ opacity: 0, y: -10, height: 0 }}
                                transition={{ duration: 0.2 }}
                                style={{ background: 'rgba(52, 199, 89, 0.1)', color: '#34C759', padding: '12px 16px', borderRadius: '10px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', border: '1px solid rgba(52, 199, 89, 0.2)' }}
                            >
                                <CheckCircle2 size={16} /> {message}
                            </motion.div>
                        )}
                    </AnimatePresence>

                    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                        {/* ── 外观 ──────────────────────── */}
                        <div className="mac-settings-section">
                            <div className="mac-settings-title">外观</div>
                            <div className="mac-settings-group">
                                <div className="mac-settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, padding: '14px 16px' }}>
                                    <div style={{ display: 'flex', gap: 10 }}>

                                        {/* ── 跟随系统 ── */}
                                        <button
                                            onClick={() => onThemeChange?.('auto')}
                                            style={{
                                                flex: 1,
                                                display: 'flex', flexDirection: 'column', alignItems: 'center',
                                                gap: 10, padding: '14px 10px 12px',
                                                borderRadius: 14,
                                                background: theme === 'auto' ? 'var(--mac-accent-bg)' : 'var(--mac-input-bg)',
                                                border: theme === 'auto'
                                                    ? '1.5px solid var(--mac-accent)'
                                                    : '1.5px solid transparent',
                                                boxShadow: theme === 'auto'
                                                    ? '0 0 0 3px rgba(10,132,255,0.08), inset 0 1px 0 rgba(255,255,255,0.06)'
                                                    : 'inset 0 1px 0 rgba(255,255,255,0.04)',
                                                cursor: 'pointer',
                                                transition: 'all 0.22s cubic-bezier(0.4, 0, 0.2, 1)',
                                                transform: theme === 'auto' ? 'scale(1.02)' : 'scale(1)',
                                            }}
                                            onMouseEnter={(e) => { if (theme !== 'auto') e.currentTarget.style.background = 'var(--mac-panel-bg)'; }}
                                            onMouseLeave={(e) => { if (theme !== 'auto') e.currentTarget.style.background = 'var(--mac-input-bg)'; }}
                                        >
                                            <div style={{
                                                width: 40, height: 40, borderRadius: 13,
                                                background: 'linear-gradient(135deg, rgba(249,249,249,0.95) 0%, rgba(249,249,249,0.95) 48%, rgba(28,28,30,0.95) 48%, rgba(28,28,30,0.95) 100%)',
                                                boxShadow: '0 2px 8px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.5), 0 0 0 1px rgba(0,0,0,0.04)',
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                position: 'relative', overflow: 'hidden',
                                            }}>
                                                <div style={{
                                                    position: 'absolute', inset: 0, borderRadius: 13,
                                                    background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.3) 0%, transparent 60%)',
                                                    pointerEvents: 'none',
                                                }} />
                                                <Monitor size={19} strokeWidth={1.8} color="#0A84FF" style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.1))', position: 'relative', zIndex: 1 }} />
                                            </div>
                                            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--mac-text)', letterSpacing: '-0.01em' }}>跟随系统</span>
                                        </button>

                                        {/* ── 浅色模式 ── */}
                                        <button
                                            onClick={() => onThemeChange?.('light')}
                                            style={{
                                                flex: 1,
                                                display: 'flex', flexDirection: 'column', alignItems: 'center',
                                                gap: 10, padding: '14px 10px 12px',
                                                borderRadius: 14,
                                                background: theme === 'light' ? 'var(--mac-accent-bg)' : 'var(--mac-input-bg)',
                                                border: theme === 'light'
                                                    ? '1.5px solid var(--mac-accent)'
                                                    : '1.5px solid transparent',
                                                boxShadow: theme === 'light'
                                                    ? '0 0 0 3px rgba(10,132,255,0.08), inset 0 1px 0 rgba(255,255,255,0.06)'
                                                    : 'inset 0 1px 0 rgba(255,255,255,0.04)',
                                                cursor: 'pointer',
                                                transition: 'all 0.22s cubic-bezier(0.4, 0, 0.2, 1)',
                                                transform: theme === 'light' ? 'scale(1.02)' : 'scale(1)',
                                            }}
                                            onMouseEnter={(e) => { if (theme !== 'light') e.currentTarget.style.background = 'var(--mac-panel-bg)'; }}
                                            onMouseLeave={(e) => { if (theme !== 'light') e.currentTarget.style.background = 'var(--mac-input-bg)'; }}
                                        >
                                            <div style={{
                                                width: 40, height: 40, borderRadius: 13,
                                                background: 'linear-gradient(180deg, #FFFFFF 0%, #F2F2F7 100%)',
                                                boxShadow: '0 2px 10px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.8), 0 0 0 1px rgba(0,0,0,0.03)',
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                position: 'relative', overflow: 'hidden',
                                            }}>
                                                <div style={{
                                                    position: 'absolute', top: '-4px', left: '50%', transform: 'translateX(-50%)',
                                                    width: 28, height: 28, borderRadius: '50%',
                                                    background: 'radial-gradient(circle, rgba(255,200,50,0.45) 0%, rgba(255,149,0,0.12) 50%, transparent 70%)',
                                                    pointerEvents: 'none',
                                                }} />
                                                <Sun size={19} strokeWidth={1.8} color="#FF9500" style={{ filter: 'drop-shadow(0 1px 3px rgba(255,149,0,0.25))', position: 'relative', zIndex: 1 }} />
                                            </div>
                                            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--mac-text)', letterSpacing: '-0.01em' }}>浅色模式</span>
                                        </button>

                                        {/* ── 深色模式 ── */}
                                        <button
                                            onClick={() => onThemeChange?.('dark')}
                                            style={{
                                                flex: 1,
                                                display: 'flex', flexDirection: 'column', alignItems: 'center',
                                                gap: 10, padding: '14px 10px 12px',
                                                borderRadius: 14,
                                                background: theme === 'dark' ? 'var(--mac-accent-bg)' : 'var(--mac-input-bg)',
                                                border: theme === 'dark'
                                                    ? '1.5px solid var(--mac-accent)'
                                                    : '1.5px solid transparent',
                                                boxShadow: theme === 'dark'
                                                    ? '0 0 0 3px rgba(10,132,255,0.08), inset 0 1px 0 rgba(255,255,255,0.06)'
                                                    : 'inset 0 1px 0 rgba(255,255,255,0.04)',
                                                cursor: 'pointer',
                                                transition: 'all 0.22s cubic-bezier(0.4, 0, 0.2, 1)',
                                                transform: theme === 'dark' ? 'scale(1.02)' : 'scale(1)',
                                            }}
                                            onMouseEnter={(e) => { if (theme !== 'dark') e.currentTarget.style.background = 'var(--mac-panel-bg)'; }}
                                            onMouseLeave={(e) => { if (theme !== 'dark') e.currentTarget.style.background = 'var(--mac-input-bg)'; }}
                                        >
                                            <div style={{
                                                width: 40, height: 40, borderRadius: 13,
                                                background: 'linear-gradient(180deg, #2C2C2E 0%, #1C1C1E 100%)',
                                                boxShadow: '0 2px 10px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.06), 0 0 0 1px rgba(255,255,255,0.04)',
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                position: 'relative', overflow: 'hidden',
                                            }}>
                                                <div style={{
                                                    position: 'absolute', top: '-6px', right: '-3px',
                                                    width: 14, height: 14, borderRadius: '50%',
                                                    background: 'radial-gradient(circle, rgba(180,180,220,0.45) 0%, rgba(120,120,200,0.15) 50%, transparent 70%)',
                                                    pointerEvents: 'none',
                                                }} />
                                                <div style={{
                                                    position: 'absolute', bottom: '5px', left: '7px',
                                                    width: 3, height: 3, borderRadius: '50%',
                                                    background: 'rgba(255,255,255,0.45)',
                                                    pointerEvents: 'none',
                                                }} />
                                                <div style={{
                                                    position: 'absolute', bottom: '11px', right: '11px',
                                                    width: 2, height: 2, borderRadius: '50%',
                                                    background: 'rgba(255,255,255,0.25)',
                                                    pointerEvents: 'none',
                                                }} />
                                                <Moon size={19} strokeWidth={1.8} color="#A78BFA" style={{ filter: 'drop-shadow(0 1px 3px rgba(167,139,250,0.3))', position: 'relative', zIndex: 1 }} />
                                            </div>
                                            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--mac-text)', letterSpacing: '-0.01em' }}>深色模式</span>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* ── 支持 ──────────────────────── */}
                        <div className="mac-settings-section">
                            <div className="mac-settings-title">支持</div>
                            <div className="mac-settings-group">
                                <div className="mac-settings-row">
                                    <div className="mac-settings-row-left">
                                        <div className="mac-settings-icon-wrapper" style={{ background: '#FF2D55', color: '#fff' }}>
                                            <Heart size={16} />
                                        </div>
                                        <div className="mac-settings-text-block">
                                            <div className="mac-settings-label">赞赏支持</div>
                                            <div className="mac-settings-desc">如果这个工具帮到了你，可以扫码赞赏支持继续维护。</div>
                                        </div>
                                    </div>
                                    <div className="mac-settings-row-right">
                                        <button
                                            type="button"
                                            className="mac-btn secondary"
                                            aria-label="打开赞赏码"
                                            onClick={() => setDonateOpen(true)}
                                            style={{ height: '32px', padding: '0 16px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: 6 }}
                                        >
                                            <QrCode size={14} />
                                            赞赏
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* ── 模型依赖 ──────────────────────── */}
                        <div className="mac-settings-section">
                            <div className="mac-settings-title">模型依赖</div>
                            <div
                                className="mac-settings-group"
                                style={{
                                    cursor: 'pointer',
                                    ...(allOk ? {} : {
                                        borderColor: 'rgba(255, 59, 48, 0.3)',
                                        background: 'rgba(255, 59, 48, 0.04)',
                                    }),
                                }}
                                onClick={() => setEnvExpanded(!envExpanded)}
                            >
                                {/* 摘要行（折叠态和展开态共用） */}
                                <div
                                    className="mac-settings-row"
                                    style={{
                                        minHeight: 'auto',
                                        padding: '12px 16px',
                                        borderBottom: envExpanded ? '1px solid var(--mac-border)' : 'none',
                                    }}
                                >
                                    <div className="mac-settings-row-left" style={{ gap: 10 }}>
                                        {runtimeLoading ? (
                                            <>
                                                <Loader size={14} className="spin-icon" style={{ color: 'var(--mac-text-secondary)' }} />
                                                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--mac-text)' }}>
                                                    检测中…
                                                </span>
                                            </>
                                        ) : (
                                            <>
                                                <span
                                                    style={{
                                                        display: 'inline-block',
                                                        width: 8,
                                                        height: 8,
                                                        borderRadius: '50%',
                                                        background: allOk ? '#34C759' : '#FF3B30',
                                                        flexShrink: 0,
                                                    }}
                                                />
                                                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--mac-text)' }}>
                                                    {envSummary}
                                                </span>
                                                <span style={{ fontSize: 11, color: 'var(--mac-text-secondary)' }}>
                                                    {okCount}/{totalCount} 正常
                                                </span>
                                            </>
                                        )}
                                    </div>
                                    <div className="mac-settings-row-right" style={{ gap: 8 }}>
                                        <button
                                            className="mac-btn secondary"
                                            onClick={(e) => { e.stopPropagation(); refreshRuntime(); }}
                                            disabled={runtimeLoading}
                                            style={{ height: 28, padding: '0 10px', fontSize: 12 }}
                                        >
                                            <RotateCcw size={13} />
                                        </button>
                                        <span style={{ fontSize: 12, color: 'var(--mac-text-secondary)', transition: 'transform 0.2s', transform: envExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
                                            ▸
                                        </span>
                                    </div>
                                </div>

                                {/* 展开后的紧凑列表 */}
                                <AnimatePresence>
                                    {envExpanded && (
                                        <motion.div
                                            initial={{ height: 0, opacity: 0 }}
                                            animate={{ height: 'auto', opacity: 1 }}
                                            exit={{ height: 0, opacity: 0 }}
                                            transition={{ duration: 0.2, ease: 'easeOut' }}
                                            style={{ overflow: 'hidden' }}
                                        >
                                            {envItems.map((item) => {
                                                const s = runtimeStatus[item.key];
                                                return (
                                                    <div
                                                        key={item.key}
                                                        className="env-compact-row"
                                                    >
                                                        <span
                                                            className="env-compact-dot"
                                                            style={{ background: item.iconBg }}
                                                        />
                                                        <span className="env-compact-label">{item.label}</span>
                                                        <span className="env-compact-desc">
                                                            {runtimeLoading ? '…' : s?.detail || '—'}
                                                        </span>
                                                        <StatusIcon ok={s?.ok} />
                                                    </div>
                                                );
                                            })}

                                            {/* 安装进度（真实阶段 + 速度 + 耗时） */}
                                            {installingModels && (
                                                <div style={{ padding: '10px 16px', borderTop: '1px solid var(--mac-border)' }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                                                        <Loader2 size={14} className="spin" style={{ color: 'var(--mac-accent)' }} />
                                                        <span style={{ fontSize: '12px', fontWeight: '500', color: 'var(--mac-text)', flex: 1 }}>
                                                            {installProgress?.detail || '准备安装…'}
                                                        </span>
                                                        <span style={{ fontSize: '10px', color: 'var(--mac-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                                                            {formatElapsed(installElapsed)}
                                                        </span>
                                                    </div>
                                                    {/* 真实进度条 + 百分比 + 速度 */}
                                                    {installProgress?.total_bytes > 0 && (
                                                        <div style={{ marginBottom: '6px' }}>
                                                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                                                                <span style={{ fontSize: '10px', color: 'var(--mac-text-secondary)' }}>
                                                                    {formatBytes(installProgress.downloaded_bytes)} / {formatBytes(installProgress.total_bytes)}
                                                                </span>
                                                                <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--mac-accent)' }}>
                                                                    {formatSpeed(installProgress.speed)}
                                                                </span>
                                                            </div>
                                                            <div style={{
                                                                width: '100%', height: '4px', borderRadius: '2px',
                                                                background: 'var(--mac-input-bg)', overflow: 'hidden',
                                                            }}>
                                                                <motion.div
                                                                    animate={{
                                                                        width: `${Math.min(100, (installProgress.downloaded_bytes / installProgress.total_bytes) * 100)}%`,
                                                                    }}
                                                                    transition={{ duration: 0.3, ease: 'easeOut' }}
                                                                    style={{
                                                                        height: '100%', borderRadius: '2px',
                                                                        background: 'linear-gradient(90deg, #0A84FF, #AF52DE)',
                                                                    }}
                                                                />
                                                            </div>
                                                        </div>
                                                    )}
                                                    {/* 阶段指示器 */}
                                                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                                                        {['pip', 'whisper', 'diarization'].map((stage) => {
                                                            const stageLabels = {
                                                                pip: 'Python 包',
                                                                whisper: 'Whisper 模型',
                                                                diarization: '分离模型',
                                                            };
                                                            const seq = ['start', 'pip', 'whisper', 'diarization'];
                                                            const currentIdx = seq.indexOf(installProgress?.stage || 'start');
                                                            const stageIdx = seq.indexOf(stage);
                                                            const done = currentIdx > stageIdx;
                                                            const active = currentIdx >= stageIdx;
                                                            return (
                                                                <React.Fragment key={stage}>
                                                                    {stageIdx > 0 && (
                                                                        <div style={{
                                                                            flex: 1, height: '2px', borderRadius: '1px',
                                                                            background: done ? '#34C759' : 'var(--mac-input-bg)',
                                                                            maxWidth: '20px',
                                                                        }} />
                                                                    )}
                                                                    <div style={{
                                                                        display: 'flex', alignItems: 'center', gap: '4px',
                                                                        opacity: active ? 1 : 0.4,
                                                                        transition: 'opacity 0.3s',
                                                                    }}>
                                                                        <span style={{
                                                                            display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%',
                                                                            background: done ? '#34C759' : active ? 'var(--mac-accent)' : 'var(--mac-text-secondary)',
                                                                        }} />
                                                                        <span style={{ fontSize: '10px', color: 'var(--mac-text-secondary)', whiteSpace: 'nowrap' }}>
                                                                            {stageLabels[stage]}
                                                                        </span>
                                                                    </div>
                                                                </React.Fragment>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            )}

                                            {/* 操作按钮 */}
                                            {!runtimeLoading && (
                                                <div style={{
                                                    display: 'flex', gap: '8px', padding: '10px 16px',
                                                    borderTop: '1px solid var(--mac-border)',
                                                }}>
                                                    <button
                                                        className="mac-btn primary"
                                                        onClick={(e) => { e.stopPropagation(); handleInstallModels(); }}
                                                        disabled={installingModels || deletingModels || !modelMissing}
                                                        style={{ flex: 1, height: '30px', padding: '0 12px', fontSize: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                                                    >
                                                        {installingModels ? (
                                                            <><Loader2 size={13} className="spin" /> 安装中</>
                                                        ) : (
                                                            <><Download size={13} /> 安装缺失模型</>
                                                        )}
                                                    </button>
                                                    <button
                                                        className="mac-btn secondary"
                                                        onClick={(e) => { e.stopPropagation(); handleDeleteModels(); }}
                                                        disabled={installingModels || deletingModels || !modelInstalled}
                                                        style={{ flex: 1, height: '30px', padding: '0 12px', fontSize: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                                                    >
                                                        {deletingModels ? (
                                                            <><Loader2 size={13} className="spin" /> 删除中</>
                                                        ) : (
                                                            <><Trash2 size={13} /> 删除模型</>
                                                        )}
                                                    </button>
                                                </div>
                                            )}
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        </div>

                        {/* ── 软件更新 ──────────────────────── */}
                        {isTauri && <div className="mac-settings-section">
                                <div className="mac-settings-title">软件更新</div>
                                <div className="mac-settings-group">
                                    <div className="mac-settings-row">
                                        <div className="mac-settings-row-left">
                                            <div className="mac-settings-icon-wrapper" style={{ background: '#0A84FF', color: '#fff' }}>
                                                <Info size={16} />
                                            </div>
                                            <div className="mac-settings-text-block">
                                                <div className="mac-settings-label">当前版本</div>
                                                <div className="mac-settings-desc">v{appVersion}{updateInfo?.has_update ? ' — 有新版本可用！' : ' — 已是最新'}</div>
                                            </div>
                                        </div>
                                        <div className="mac-settings-row-right">
                                            <button
                                                className="mac-btn secondary"
                                                onClick={checkForUpdates}
                                                disabled={updateCheckLoading}
                                                style={{ height: '32px', padding: '0 16px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: 6 }}
                                            >
                                                {updateCheckLoading ? <Loader size={14} className="spin-icon" /> : <RefreshCw size={14} />}
                                                {updateCheckLoading ? '检测中…' : '检查更新'}
                                            </button>
                                        </div>
                                    </div>

                                    {/* 更新可用提示 */}
                                    {updateInfo?.has_update && (
                                        <div className="mac-settings-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#0A84FF', fontWeight: 600, fontSize: '13px' }}>
                                                <ArrowUpCircle size={16} />
                                                新版本 v{updateInfo.latest_version}
                                                {updateInfo.release_date && (
                                                    <span style={{ fontWeight: 400, opacity: 0.6, fontSize: '12px' }}>— {updateInfo.release_date}</span>
                                                )}
                                            </div>
                                            {updateInfo.changelog && (
                                                <div style={{ fontSize: '12px', color: 'var(--mac-text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                                                    {updateInfo.changelog}
                                                </div>
                                            )}
                                            {updateInfo.download_url ? (
                                                <button
                                                    className="mac-btn primary"
                                                    onClick={async () => {
                                                        const isTauri = typeof window !== 'undefined' && window.__TAURI_INTERNALS__;
                                                        if (isTauri) {
                                                            const { invoke } = await import('@tauri-apps/api/core');
                                                            await invoke('open_url', { url: updateInfo.download_url });
                                                        } else {
                                                            window.open(updateInfo.download_url, '_blank');
                                                        }
                                                    }}
                                                    style={{ height: '32px', padding: '0 16px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: 6 }}
                                                >
                                                    <Download size={14} />
                                                    下载更新
                                                </button>
                                            ) : (
                                                <div style={{ fontSize: '12px', color: '#FF9500' }}>
                                                    下载链接尚未配置，请联系管理员或前往官网下载。
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {updateInfo?.error && (
                                        <div className="mac-settings-row">
                                            <div className="mac-settings-row-left">
                                                <div className="mac-settings-text-block">
                                                    <div className="mac-settings-desc" style={{ color: '#FF9500' }}>{updateInfo.message}</div>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        }

                        {/* ── 技能安装（暂时隐藏，待优化测试后再启用） ──────────────────────── */}
                        {false && <div className="mac-settings-section">
                            <div className="mac-settings-title">技能安装</div>
                            <div className="mac-settings-group">
                                {skillsLoading ? (
                                    <div className="mac-settings-row">
                                        <div className="mac-settings-row-left">
                                            <div className="mac-settings-text-block">
                                                <div className="mac-settings-desc">加载中…</div>
                                            </div>
                                        </div>
                                    </div>
                                ) : skills.length === 0 ? (
                                    <div className="mac-settings-row">
                                        <div className="mac-settings-row-left">
                                            <div className="mac-settings-text-block">
                                                <div className="mac-settings-desc">暂无关联技能</div>
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    skills.map((skill) => (
                                        <div key={skill.key}>
                                            <div className="mac-settings-row">
                                                <div className="mac-settings-row-left">
                                                    <div className="mac-settings-icon-wrapper" style={{ background: '#AF52DE', color: '#fff' }}>
                                                        <Wrench size={16} />
                                                    </div>
                                                    <div className="mac-settings-text-block">
                                                        <div className="mac-settings-label">{skill.name}</div>
                                                        <div className="mac-settings-desc">{skill.description}</div>
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="mac-settings-row" style={{ paddingTop: 0 }}>
                                                <div className="mac-settings-row-left" style={{ flexWrap: 'wrap', gap: '4px 12px' }}>
                                                    {skill.platforms.map((p) => {
                                                        const tag = `${skill.key}:${p.id}`;
                                                        const isBusy = installing === tag;
                                                        const isHovered = hoveredDot === tag;
                                                        const showPopover = (e) => {
                                                            if (!p.installed || isBusy) return;
                                                            clearTimeout(hoverTimerRef.current);
                                                            if (hoveredDot !== tag) {
                                                                const rect = e.currentTarget.getBoundingClientRect();
                                                                setPopoverPos({ x: rect.left + rect.width / 2, y: rect.top });
                                                            }
                                                            setHoveredDot(tag);
                                                        };
                                                        const hidePopover = () => {
                                                            hoverTimerRef.current = setTimeout(() => setHoveredDot(null), 150);
                                                        };
                                                        return (
                                                            <div
                                                                key={p.id}
                                                                className="skill-platform-dot"
                                                                onMouseEnter={showPopover}
                                                                onMouseLeave={hidePopover}
                                                                onClick={() => { if (!p.installed && !isBusy) handleInstall(skill.key, p.id); }}
                                                                style={{
                                                                    display: 'inline-flex', alignItems: 'center', gap: 5,
                                                                    cursor: p.installed ? 'default' : 'pointer',
                                                                    padding: '6px 0',
                                                                    opacity: isBusy ? 0.5 : 1,
                                                                }}
                                                            >
                                                                {isBusy ? (
                                                                    <Loader size={11} className="spin-icon" style={{ color: 'var(--mac-text-secondary)' }} />
                                                                ) : (
                                                                    <span style={{
                                                                        display: 'inline-block', width: 9, height: 9, borderRadius: '50%',
                                                                        background: p.installed ? '#AF52DE' : 'transparent',
                                                                        border: p.installed ? '2px solid #AF52DE' : '2px solid var(--mac-border)',
                                                                        flexShrink: 0,
                                                                    }} />
                                                                )}
                                                                <span style={{ fontSize: '12px', color: 'var(--mac-text-secondary)' }}>
                                                                    {p.label}
                                                                </span>
                                                                {isHovered && createPortal(
                                                                    <div
                                                                        className="skill-dot-popover"
                                                                        onMouseEnter={showPopover}
                                                                        onMouseLeave={hidePopover}
                                                                        style={{
                                                                            position: 'fixed', left: popoverPos.x, top: popoverPos.y,
                                                                            transform: 'translate(-50%, -100%)',
                                                                            background: 'var(--mac-surface-solid)', border: '1px solid var(--mac-border)',
                                                                            borderRadius: 8, padding: '4px 0', zIndex: 9999,
                                                                            boxShadow: '0 4px 16px rgba(0,0,0,0.2)', minWidth: 120,
                                                                            color: 'var(--mac-text)',
                                                                            whiteSpace: 'nowrap',
                                                                        }}
                                                                    >
                                                                        <button
                                                                            className="skill-popover-btn"
                                                                            onClick={(e) => { e.stopPropagation(); handleReveal(p.dir); setHoveredDot(null); }}
                                                                        >
                                                                            <FolderOpen size={12} /> 在访达中显示
                                                                        </button>
                                                                        <button
                                                                            className="skill-popover-btn"
                                                                            onClick={(e) => { e.stopPropagation(); handleUninstall(skill.key, p.id); setHoveredDot(null); }}
                                                                        >
                                                                            <XCircle size={12} /> 卸载
                                                                        </button>
                                                                    </div>,
                                                                    document.body
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    }
                    </div>
                </motion.div>
            </div>
            {createPortal(
                <AnimatePresence>
                    {donateOpen && (
                        <motion.div
                            className="donate-modal-backdrop"
                            role="presentation"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.18 }}
                            onClick={() => setDonateOpen(false)}
                        >
                            <motion.div
                                className="donate-modal"
                                role="dialog"
                                aria-label="赞赏支持"
                                aria-modal="true"
                                initial={{ opacity: 0, y: 12, scale: 0.98 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, y: 8, scale: 0.98 }}
                                transition={{ duration: 0.2, ease: 'easeOut' }}
                                onClick={(event) => event.stopPropagation()}
                            >
                                <div className="donate-modal-header">
                                    <div>
                                        <div className="donate-modal-title">赞赏支持</div>
                                        <div className="donate-modal-desc">扫码即可赞赏，谢谢你的支持。</div>
                                    </div>
                                    <button
                                        type="button"
                                        className="donate-modal-close"
                                        aria-label="关闭赞赏码"
                                        onClick={() => setDonateOpen(false)}
                                    >
                                        <X size={16} />
                                    </button>
                                </div>
                                <div className="donate-qr-frame">
                                    <img src={DONATE_QR_SRC} alt="赞赏二维码" className="donate-qr-image" />
                                </div>
                            </motion.div>
                        </motion.div>
                    )}
                </AnimatePresence>,
                document.body
            )}
        </div>
    );
}

export default SettingsView;
