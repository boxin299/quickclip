import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import { Trash2, Check, AlertTriangle, X, Clipboard, Folder, Monitor } from 'lucide-react';
import MacSelect from './MacSelect';
import { findApiBaseUrlForEndpoint } from '../config';
import './ClipImportView.css';

export default function ClipImportView({ apiBaseUrl }) {
  const [resolvedApiBaseUrl, setResolvedApiBaseUrl] = useState(apiBaseUrl);
  const [enabled, setEnabled] = useState(false);
  const [running, setRunning] = useState(false);
  const [available, setAvailable] = useState(true);
  const [lastError, setLastError] = useState('');
  const [config, setConfig] = useState({});
  const [recentImports, setRecentImports] = useState([]);
  const [localFolderOptions, setLocalFolderOptions] = useState([]);
  const [davinciFolderOptions, setDavinciFolderOptions] = useState([]);
  const [newItemIds, setNewItemIds] = useState(new Set());
  const pollRef = useRef(null);
  const recentImportsRef = useRef([]);
  const resolvingApiRef = useRef(false);

  useEffect(() => {
    setResolvedApiBaseUrl(apiBaseUrl);
  }, [apiBaseUrl]);

  const recoverApiBaseUrl = useCallback(async () => {
    if (resolvingApiRef.current) return resolvedApiBaseUrl;
    resolvingApiRef.current = true;
    try {
      const nextBaseUrl = await findApiBaseUrlForEndpoint('/api/clip-import/status', resolvedApiBaseUrl);
      if (nextBaseUrl && nextBaseUrl !== resolvedApiBaseUrl) {
        setResolvedApiBaseUrl(nextBaseUrl);
      }
      return nextBaseUrl || resolvedApiBaseUrl;
    } finally {
      resolvingApiRef.current = false;
    }
  }, [resolvedApiBaseUrl]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await axios.get(`${resolvedApiBaseUrl}/api/clip-import/status`);
      const data = res.data;
      setEnabled(data.enabled);
      setRunning(data.running);
      setAvailable(data.available !== false);
      setLastError(data.last_error || '');
      setConfig(data.config || {});
      const imports = data.recent_imports || [];
      const prev = recentImportsRef.current;
      if (imports.length > 0 && prev.length > 0) {
        const newest = imports[0];
        const prevNewest = prev[0];
        if (newest.timestamp !== prevNewest.timestamp) {
          setNewItemIds((prevIds) => new Set([...prevIds, newest.timestamp]));
        }
      }
      recentImportsRef.current = imports;
      setRecentImports(imports);
    } catch (error) {
      const recoveredBaseUrl = await recoverApiBaseUrl();
      if (recoveredBaseUrl && recoveredBaseUrl !== resolvedApiBaseUrl) {
        try {
          const retryRes = await axios.get(`${recoveredBaseUrl}/api/clip-import/status`);
          const data = retryRes.data;
          setEnabled(data.enabled);
          setRunning(data.running);
          setAvailable(data.available !== false);
          setLastError(data.last_error || '');
          setConfig(data.config || {});
          setRecentImports(data.recent_imports || []);
          return;
        } catch {
          // fall through
        }
      }
    }
  }, [recoverApiBaseUrl, resolvedApiBaseUrl]);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await axios.get(`${resolvedApiBaseUrl}/api/clip-import/settings`);
      const data = res.data;
      setConfig(data.config || {});
    } catch (error) {
      const recoveredBaseUrl = await recoverApiBaseUrl();
      if (recoveredBaseUrl && recoveredBaseUrl !== resolvedApiBaseUrl) {
        try {
          const retryRes = await axios.get(`${recoveredBaseUrl}/api/clip-import/settings`);
          const data = retryRes.data;
          setConfig(data.config || {});
          return;
        } catch {
          // fall through
        }
      }
    }
  }, [recoverApiBaseUrl, resolvedApiBaseUrl]);

  const fetchLocalFolders = useCallback(async () => {
    try {
      const res = await axios.get(`${resolvedApiBaseUrl}/api/clip-import/local-folders`);
      setLocalFolderOptions(res.data.folders || []);
    } catch {
      // 获取失败保持空列表
    }
  }, [resolvedApiBaseUrl]);

  const fetchDavinciFolders = useCallback(async () => {
    try {
      const res = await axios.get(`${resolvedApiBaseUrl}/api/clip-import/davinci-folders`);
      setDavinciFolderOptions(res.data.folders || []);
    } catch {
      // 获取失败保持空列表
    }
  }, [resolvedApiBaseUrl]);

  useEffect(() => {
    fetchSettings();
    fetchStatus();
    fetchLocalFolders();
    fetchDavinciFolders();
    pollRef.current = setInterval(fetchStatus, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchSettings, fetchStatus, fetchLocalFolders, fetchDavinciFolders]);

  // clear highlight after 3s
  useEffect(() => {
    if (newItemIds.size > 0) {
      const timer = setTimeout(() => setNewItemIds(new Set()), 3000);
      return () => clearTimeout(timer);
    }
  }, [newItemIds]);

  const handleToggle = async () => {
    const newState = !enabled;
    try {
      const res = await axios.post(`${resolvedApiBaseUrl}/api/clip-import/toggle`, { enabled: newState });
      setEnabled(res.data.enabled);
      setRunning(res.data.running);
      setAvailable(res.data.available !== false);
      setLastError(!res.data.running && newState ? (res.data.message || '') : '');
    } catch (error) {
      // silently fail, status polling will reflect real state
    }
  };

  const handleSaveSetting = async (key, value) => {
    const newConfig = { ...config, [key]: value };
    setConfig(newConfig);
    try {
      const res = await axios.post(`${resolvedApiBaseUrl}/api/clip-import/settings`, { [key]: value });
      setConfig(res.data || newConfig);
    } catch (error) {
      // silently fail
    }
  };

  const handleClearHistory = async () => {
    try {
      await axios.delete(`${resolvedApiBaseUrl}/api/clip-import/history`);
      setRecentImports([]);
    } catch (error) {
      // silently fail
    }
  };

  const localFolderSelectOptions = useMemo(
    () => buildFolderOptions(localFolderOptions, config.local_target_folder, '项目根目录'),
    [config.local_target_folder, localFolderOptions]
  );

  const davinciFolderSelectOptions = useMemo(
    () => buildFolderOptions(davinciFolderOptions, config.davinci_folder, '达芬奇根目录（Master）'),
    [config.davinci_folder, davinciFolderOptions]
  );

  const formatSize = (bytes) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  const statusColor = !available || lastError
    ? '#FF3B30'
    : running
      ? '#34C759'
      : enabled
        ? '#FF9F0A'
        : '#8E8E93';
  const statusText = !available
    ? '当前环境不支持剪贴板监听'
    : lastError
      ? '监听启动失败'
      : running
        ? '监听中'
        : enabled
          ? '启动中...'
          : '已暂停';
  const indicatorClass = !available || lastError
    ? 'is-error'
    : running
      ? 'is-running'
      : enabled
        ? 'is-starting'
        : 'is-stopped';

  return (
    <motion.div
      className="clip-import-page page-content"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
    >
      <div className="clip-import-inner">
        {/* ① 状态横幅 */}
        <div className="glass-panel clip-import-status-banner">
          <div className="clip-import-status-body">
            <div className="clip-import-status-indicator">
              <span
                className={`clip-import-indicator-dot ${indicatorClass}`}
              />
            </div>
            <div className="clip-import-status-copy">
              <span className="clip-import-status-text" style={{ color: statusColor }}>
                {statusText}
              </span>
              <span className="clip-import-status-subtext">
                {lastError || '复制图片后将自动写入项目目录，并尝试导入当前媒体池。'}
              </span>
            </div>
          </div>
          {available && !lastError && (
            <button
              onClick={handleToggle}
              className={`mac-btn ${enabled ? 'clip-import-btn-danger-outline' : 'primary'}`}
              style={{ minWidth: '96px', whiteSpace: 'nowrap' }}
            >
              {enabled ? '暂停监听' : '开始监听'}
            </button>
          )}
          {available && lastError && (
            <button
              onClick={handleToggle}
              className="mac-btn danger"
              style={{ minWidth: '96px', whiteSpace: 'nowrap' }}
            >
              重新启动
            </button>
          )}
        </div>

        <div className="mac-settings-section">
          <div className="mac-settings-title">导入设置</div>
          <div className="mac-settings-group">
            <div className="mac-settings-row">
              <div className="mac-settings-row-left">
                <div className="mac-settings-icon-wrapper" style={{ background: 'rgba(10,132,255,0.12)', color: '#0A84FF' }}>
                  <Folder size={16} />
                </div>
                <div className="mac-settings-text-block">
                  <div className="mac-settings-label">保存位置 (本地)</div>
                  <div className="mac-settings-desc" style={!config.local_target_folder ? { color: '#FF9F0A' } : undefined}>
                    {config.local_target_folder
                      ? '截图和复制图片的本地存储目录'
                      : '请先创建达芬奇项目'}
                  </div>
                </div>
              </div>
              <div className="mac-settings-row-right">
                <MacSelect
                  width="220px"
                  value={config.local_target_folder || ''}
                  onChange={(v) => handleSaveSetting('local_target_folder', v)}
                  options={localFolderSelectOptions}
                  placeholder={localFolderOptions.length === 0 ? '未检测到达芬奇项目' : '请选择保存位置'}
                />
              </div>
            </div>

            <div className="mac-settings-row">
              <div className="mac-settings-row-left">
                <div className="mac-settings-icon-wrapper" style={{ background: 'rgba(175,82,222,0.12)', color: '#AF52DE' }}>
                  <Monitor size={16} />
                </div>
                <div className="mac-settings-text-block">
                  <div className="mac-settings-label">媒体池目录 (达芬奇)</div>
                  <div className="mac-settings-desc" style={!config.davinci_folder ? { color: '#FF9F0A' } : undefined}>
                    {config.davinci_folder
                      ? '图片导入到达芬奇媒体池的目标目录'
                      : '需要先打开达芬奇应用'}
                  </div>
                </div>
              </div>
              <div className="mac-settings-row-right">
                <MacSelect
                  width="220px"
                  value={config.davinci_folder || ''}
                  onChange={(v) => handleSaveSetting('davinci_folder', v)}
                  options={davinciFolderSelectOptions}
                  placeholder={davinciFolderOptions.length === 0 ? '请先打开达芬奇' : '请选择媒体池目录'}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="clip-import-history-section">
          <div className="clip-import-history-header">
            <div className="clip-import-history-title">
              导入历史
              {recentImports.length > 0 && (
                <span className="clip-import-history-badge">{recentImports.length}</span>
              )}
            </div>
            {recentImports.length > 0 && (
              <button
                onClick={handleClearHistory}
                className="clip-import-clear-btn"
              >
                <Trash2 size={13} />
                清空历史
              </button>
            )}
          </div>

          <div className="glass-panel clip-import-history-panel">
          {recentImports.length === 0 ? (
            <div className="clip-import-empty-state">
              <div className="clip-import-empty-icon">
                <Clipboard size={24} />
              </div>
              <div className="clip-import-empty-title">暂无导入记录</div>
              <div className="clip-import-empty-desc">
                开启监听后，复制到剪贴板的图片将<br />自动显示在这里
              </div>
            </div>
          ) : (
            <div className="clip-import-history-list">
              {recentImports.map((item, idx) => {
                const isNew = newItemIds.has(item.timestamp);

                let IconComponent;
                let iconClass;
                if (item.status === 'skipped') {
                  IconComponent = AlertTriangle;
                  iconClass = 'is-skipped';
                } else if (item.status === 'error') {
                  IconComponent = X;
                  iconClass = 'is-error';
                } else {
                  IconComponent = Check;
                  iconClass = 'is-success';
                }

                return (
                  <div
                    key={item.timestamp || idx}
                    className={`clip-import-history-row${isNew ? ' is-new' : ''}`}
                  >
                    <div className={`clip-import-history-icon ${iconClass}`}>
                      <IconComponent size={13} />
                    </div>
                    <span className="clip-import-history-name" title={item.filename}>
                      {item.filename}
                    </span>
                    <span className="clip-import-history-size">
                      {formatSize(item.size || 0)}
                    </span>
                    <span className={`clip-import-history-status ${iconClass}`}>
                      {item.status_text || item.status}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function buildFolderOptions(values, currentValue, rootLabel = '根目录') {
  const orderedValues = [];
  if (currentValue) {
    orderedValues.push(currentValue);
  }
  (values || []).forEach((value) => orderedValues.push(value));
  return [...new Set(orderedValues)].map((value) => {
    if (value === '.') {
      return { value, label: rootLabel };
    }
    return {
      value,
      label: value === currentValue && !(values || []).includes(value) ? `${value}（当前配置）` : value,
    };
  });
}
