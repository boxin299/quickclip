import { memo, useState, useEffect, useRef, useMemo, useCallback, useDeferredValue, useSyncExternalStore, useTransition } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { convertFileSrc } from '@tauri-apps/api/core';
import { startDrag } from '@crabnebula/tauri-plugin-drag';
import { appCacheDir, join } from '@tauri-apps/api/path';
import { writeFile, mkdir } from '@tauri-apps/plugin-fs';
import tauriAPI from '../tauriAPI';
import {
  FolderOpen,
  Play,
  Pause,
  Trash2,
  Settings,
  ChevronRight,
  ChevronDown,
  Volume2,
  Search,
  X,
  Loader,
  Folder,
  FileAudio,
  RefreshCw,
  HardDrive,
  AlertCircle,
  CheckCircle2,
  FolderPlus,
  FileMusic,
} from 'lucide-react';

const BROWSE_PAGE_SIZE = 160;
const WAVEFORM_REQUEST_CONCURRENCY = 2;
const WAVEFORM_BATCH_SIZE = 32;
const WAVEFORM_IDLE_STATE = Object.freeze({
  status: 'idle',
  data: null,
  error: null,
  sessionId: 0,
  controller: null,
  promise: null,
});

const waveformStore = new Map();
const waveformSubscribers = new Map();
const waveformQueue = [];
let waveformActiveRequests = 0;
let currentWaveformSessionId = 0;

function isWaveformAbortError(error) {
  return error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED' || error?.message === 'canceled';
}

function getWaveformSnapshot(path) {
  if (!path) return WAVEFORM_IDLE_STATE;
  return waveformStore.get(path) || WAVEFORM_IDLE_STATE;
}

function emitWaveformChange(path) {
  const listeners = waveformSubscribers.get(path);
  if (!listeners) return;
  listeners.forEach((listener) => listener());
}

function setWaveformSnapshot(path, nextState) {
  if (!path) return WAVEFORM_IDLE_STATE;
  const prev = waveformStore.get(path) || WAVEFORM_IDLE_STATE;
  const merged = { ...prev, ...nextState };
  if (merged.status === 'success' || merged.status === 'empty' || merged.status === 'error' || merged.status === 'idle') {
    merged.controller = null;
    merged.promise = null;
  }
  waveformStore.set(path, merged);
  emitWaveformChange(path);
  return merged;
}

function subscribeWaveform(path, listener) {
  if (!path) return () => {};
  let listeners = waveformSubscribers.get(path);
  if (!listeners) {
    listeners = new Set();
    waveformSubscribers.set(path, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      waveformSubscribers.delete(path);
    }
  };
}

function pickNextWaveformRequest() {
  if (waveformQueue.length === 0) return null;
  let bestIndex = 0;
  for (let index = 1; index < waveformQueue.length; index += 1) {
    const current = waveformQueue[index];
    const best = waveformQueue[bestIndex];
    if (current.sessionId > best.sessionId || (current.sessionId === best.sessionId && current.priority < best.priority)) {
      bestIndex = index;
    }
  }
  return waveformQueue.splice(bestIndex, 1)[0];
}

function pumpWaveformQueue() {
  while (waveformActiveRequests < WAVEFORM_REQUEST_CONCURRENCY) {
    const seed = pickNextWaveformRequest();
    if (!seed) return;
    if (seed.sessionId !== currentWaveformSessionId) continue;

    const batch = [seed];
    for (let index = waveformQueue.length - 1; index >= 0 && batch.length < WAVEFORM_BATCH_SIZE; index -= 1) {
      const item = waveformQueue[index];
      if (!item || item.sessionId !== seed.sessionId || item.apiBaseUrl !== seed.apiBaseUrl) continue;
      waveformQueue.splice(index, 1);
      batch.push(item);
    }

    const activeBatch = batch.filter((item) => {
      const existing = waveformStore.get(item.path);
      return existing?.status !== 'success' && existing?.status !== 'empty';
    });
    if (activeBatch.length === 0) continue;

    const controller = new AbortController();
    waveformActiveRequests += 1;
    activeBatch.forEach((item) => {
      setWaveformSnapshot(item.path, {
        status: 'loading',
        error: null,
        sessionId: item.sessionId,
        controller,
        promise: null,
      });
    });
    const promise = axios
      .post(`${seed.apiBaseUrl}/api/sound-effects/waveforms/batch`, {
        paths: activeBatch.map((item) => item.path),
        samples: 150,
      }, {
        timeout: 60000,
        signal: controller.signal,
      })
      .then((res) => {
        const waveforms = res.data?.waveforms || {};
        activeBatch.forEach((item) => {
          const current = waveformStore.get(item.path);
          if (current?.sessionId !== item.sessionId || item.sessionId !== currentWaveformSessionId) return;
          const payload = waveforms[item.path];
          if (payload?.status === 'success') {
            const nextData = Array.isArray(payload.data) && payload.data.length > 0 ? payload.data : 'empty';
            setWaveformSnapshot(item.path, {
              status: nextData === 'empty' ? 'empty' : 'success',
              data: nextData === 'empty' ? null : nextData,
              error: null,
              sessionId: item.sessionId,
            });
          } else {
            setWaveformSnapshot(item.path, {
              status: payload?.status === 'empty' ? 'empty' : 'error',
              data: null,
              error: payload?.message || payload?.error || 'waveform_failed',
              sessionId: item.sessionId,
            });
          }
        });
      })
      .catch((error) => {
        activeBatch.forEach((item) => {
          const current = waveformStore.get(item.path);
          if (current?.sessionId !== item.sessionId) return;
          if (isWaveformAbortError(error)) {
            setWaveformSnapshot(item.path, {
              status: current.data ? 'success' : 'idle',
              sessionId: item.sessionId,
            });
            return;
          }
          setWaveformSnapshot(item.path, {
            status: 'error',
            data: null,
            error: error?.message || 'waveform_failed',
            sessionId: item.sessionId,
          });
        });
      })
      .finally(() => {
        waveformActiveRequests = Math.max(0, waveformActiveRequests - 1);
        pumpWaveformQueue();
      });

    activeBatch.forEach((item) => {
      setWaveformSnapshot(item.path, {
        promise,
      });
    });
  }
}

function requestWaveform({ path, apiBaseUrl, sessionId, priority }) {
  if (!path || !apiBaseUrl) return;
  const existing = waveformStore.get(path);
  if (existing?.status === 'success' || existing?.status === 'empty') return;
  if (existing?.status === 'loading') {
    if ((existing.sessionId || 0) >= sessionId) return;
    existing.controller?.abort();
  }

  const queuedIndex = waveformQueue.findIndex((item) => item.path === path);
  if (queuedIndex >= 0) {
    waveformQueue[queuedIndex] = {
      ...waveformQueue[queuedIndex],
      apiBaseUrl,
      sessionId,
      priority: Math.min(priority, waveformQueue[queuedIndex].priority),
    };
  } else {
    waveformQueue.push({ path, apiBaseUrl, sessionId, priority });
  }
  pumpWaveformQueue();
}

function activateWaveformSession(sessionId) {
  currentWaveformSessionId = sessionId;
  for (let index = waveformQueue.length - 1; index >= 0; index -= 1) {
    if (waveformQueue[index]?.sessionId !== sessionId) {
      waveformQueue.splice(index, 1);
    }
  }
  waveformStore.forEach((entry) => {
    if (entry?.status === 'loading' && entry.sessionId !== sessionId) {
      entry.controller?.abort();
    }
  });
  pumpWaveformQueue();
}

function useWaveformData(path, apiBaseUrl, isVisible, sessionId, priority) {
  const subscribe = useCallback((listener) => subscribeWaveform(path, listener), [path]);
  const getSnapshot = useCallback(() => getWaveformSnapshot(path), [path]);
  const waveformState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!path || !isVisible) return undefined;
    if (
      waveformState.status === 'success'
      || waveformState.status === 'empty'
      || waveformState.status === 'loading'
      || (waveformState.status === 'error' && waveformState.sessionId === sessionId)
    ) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      requestWaveform({ path, apiBaseUrl, sessionId, priority });
    }, 40 + Math.min(priority, 24) * 12);
    return () => window.clearTimeout(timer);
  }, [apiBaseUrl, isVisible, path, priority, sessionId, waveformState.status]);

  return waveformState;
}


let sharedObserver = null;
function getSharedObserver() {
  if (typeof window !== 'undefined' && typeof IntersectionObserver !== 'undefined' && !sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.target._onVisibilityChange) {
            entry.target._onVisibilityChange(entry.isIntersecting);
          }
        });
      },
      { rootMargin: '400px' }
    );
  }
  return sharedObserver;
}

function WaveformSVG({ data, playing, progress, width = 240, height = 32 }) {
  const clipId = useMemo(() => `clip-${Math.random().toString(36).substring(2, 9)}`, []);

  const pathData = useMemo(() => {
    if (!data || data.length === 0) return '';
    const mid = height / 2;
    const samples = data.length / 2;
    let d = '';
    for (let i = 0; i < samples; i += 1) {
      const min = data[i * 2];
      const max = data[i * 2 + 1];
      const x = ((i / samples) * width).toFixed(1);
      const barW = Math.max(width / samples - 0.5, 0.5).toFixed(1);
      const yTop = (mid + min * mid).toFixed(1);
      const yBot = (mid + max * mid).toFixed(1);
      const barH = Math.max(yBot - yTop, 1).toFixed(1);
      d += `M${x},${yTop} h${barW} v${barH} h-${barW} Z `;
    }
    return d;
  }, [data, width, height]);

  const progressWidth = playing && progress > 0 ? progress * width : 0;

  return (
    <svg width={width} height={height} style={{ display: 'block', borderRadius: '4px' }}>
      <line x1={0} y1={height / 2 - 0.5} x2={width} y2={height / 2 - 0.5} stroke="var(--mac-border)" strokeWidth={1} />
      <path d={pathData} fill="var(--sfx-waveform-fill)" />
      {progressWidth > 0 && (
        <>
          <defs>
            <clipPath id={clipId}>
              <rect x={0} y={0} width={progressWidth} height={height} />
            </clipPath>
          </defs>
          <path d={pathData} fill="var(--mac-accent)" clipPath={`url(#${clipId})`} />
        </>
      )}
    </svg>
  );
}

function formatSize(bytes) {
  const safeBytes = Number(bytes || 0);
  if (safeBytes < 1024) return `${safeBytes} B`;
  if (safeBytes < 1024 * 1024) return `${(safeBytes / 1024).toFixed(1)} KB`;
  return `${(safeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getInitialExpandedFolders(nodes, limit = 24) {
  const expanded = new Set();
  (nodes || []).slice(0, limit).forEach((node) => {
    if (node?.path) expanded.add(node.path);
  });
  return expanded;
}

function useLatest(value) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

const FolderTreeNode = memo(function FolderTreeNode({
  node,
  depth,
  expandedFolders,
  toggleFolder,
  selectedFolder,
  onSelectFolder,
}) {
  const isExpanded = expandedFolders.has(node.path);
  const hasChildren = (node.children && node.children.length > 0) || node.total_audio_count > 0;
  const isSelected = selectedFolder === node.path;

  return (
    <div style={{ contentVisibility: 'auto', containIntrinsicSize: '30px' }}>
      <div
        onClick={() => onSelectFolder(node.path)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '4px 6px',
          marginLeft: depth * 12,
          borderRadius: '7px',
          cursor: 'pointer',
          userSelect: 'none',
          background: isSelected ? 'rgba(0,122,255,0.10)' : 'transparent',
          color: isSelected ? 'var(--mac-accent)' : 'var(--mac-text)',
        }}
        className="sfx-hover-bg"
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) toggleFolder(node.path);
          }}
          style={{
            width: '14px',
            height: '14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            cursor: hasChildren ? 'pointer' : 'default',
            padding: 0,
            flexShrink: 0,
          }}
          aria-label={isExpanded ? '折叠文件夹' : '展开文件夹'}
        >
          {hasChildren ? (isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />) : null}
        </button>
        <Folder size={12} style={{ color: isSelected ? 'var(--mac-accent)' : '#5AC8FA', flexShrink: 0 }} />
        <span
          style={{
            fontSize: '11px',
            fontWeight: isSelected ? '600' : '500',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={node.path}
        >
          {node.name}
        </span>
        <span style={{ fontSize: '9px', color: 'var(--mac-text-secondary)', flexShrink: 0 }}>
          {Number(node.total_audio_count || 0).toLocaleString()}
        </span>
      </div>
      {isExpanded && node.children?.length > 0 && (
        <div>
          {node.children.map((child) => (
            <FolderTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedFolders={expandedFolders}
              toggleFolder={toggleFolder}
              selectedFolder={selectedFolder}
              onSelectFolder={onSelectFolder}
            />
          ))}
        </div>
      )}
    </div>
  );
});

const SoundFileItem = memo(function SoundFileItem({
  file,
  isPlaying,
  isPressing,
  togglePlay,
  onSoundPress,
  audioRef,
  apiBaseUrl,
  waveformSessionId,
  waveformPriority,
}) {
  const [playProgress, setPlayProgress] = useState(0);
  const [isVisible, setIsVisible] = useState(false);
  const itemRef = useRef(null);
  const waveformState = useWaveformData(file.path, apiBaseUrl, isVisible, waveformSessionId, waveformPriority);
  const waveformData = waveformState.status === 'success' ? waveformState.data : null;
  const waveformLoading = waveformState.status === 'loading';
  const waveformEmpty = waveformState.status === 'empty';

  useEffect(() => {
    const el = itemRef.current;
    if (!el) return undefined;
    el._onVisibilityChange = setIsVisible;
    const observer = getSharedObserver();
    if (observer) {
      observer.observe(el);
    } else {
      setIsVisible(true);
    }
    return () => {
      if (observer) observer.unobserve(el);
      delete el._onVisibilityChange;
    };
  }, []);

  useEffect(() => {
    let rafId = 0;
    if (isPlaying && audioRef?.current) {
      const updateProgress = () => {
        if (audioRef?.current) {
          setPlayProgress(audioRef.current.currentTime / (audioRef.current.duration || 1));
          if (!audioRef.current.paused) rafId = requestAnimationFrame(updateProgress);
        }
      };
      rafId = requestAnimationFrame(updateProgress);
    } else {
      setPlayProgress(0);
    }
    return () => cancelAnimationFrame(rafId);
  }, [audioRef, isPlaying]);

  return (
    <div
      ref={itemRef}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 10px',
        borderRadius: '10px',
        border: '1px solid rgba(255,255,255,0.04)',
        background: isPressing ? 'rgba(0,122,255,0.08)' : 'rgba(255,255,255,0.02)',
        cursor: isPressing ? 'grabbing' : 'grab',
        userSelect: 'none',
        contentVisibility: 'auto',
        containIntrinsicSize: '64px',
      }}
      className="sfx-hover-bg"
      onMouseDown={(e) => {
        e.preventDefault();
        onSoundPress(file, 'down');
      }}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          togglePlay(file);
        }}
        style={{
          width: '28px',
          height: '28px',
          borderRadius: '8px',
          border: '1px solid var(--mac-border)',
          background: isPlaying ? 'rgba(0,122,255,0.15)' : 'transparent',
          color: isPlaying ? 'var(--mac-accent)' : 'var(--mac-text-secondary)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {isPlaying ? <Pause size={13} /> : <Play size={13} />}
      </button>
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <div
          style={{
            fontSize: '12px',
            fontWeight: '600',
            color: 'var(--mac-text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            lineHeight: 1.3,
          }}
          title={file.relative_path || file.path}
        >
          {file.name}
        </div>
        <div style={{ marginTop: '4px' }}>
          {waveformEmpty ? (
            <div style={{ width: 180, height: 20, display: 'flex', alignItems: 'center' }}>
              <div
                style={{
                  width: '100%',
                  height: '2px',
                  background:
                    'repeating-linear-gradient(90deg, rgba(255,255,255,0.2) 0, rgba(255,255,255,0.2) 2px, transparent 2px, transparent 4px)',
                }}
                title="文件可能已损坏或不支持解析波形"
              />
            </div>
          ) : waveformData ? (
            isVisible ? <WaveformSVG data={waveformData} playing={isPlaying} progress={playProgress} width={180} height={20} /> : <div style={{ width: 180, height: 20 }} />
          ) : waveformLoading ? (
            <div style={{ height: 20, display: 'flex', alignItems: 'center' }}>
              <Loader size={10} className="spin" style={{ color: 'var(--mac-text-secondary)', opacity: 0.45 }} />
            </div>
          ) : (
            <div style={{ height: 20, display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ fontSize: '9px', color: 'var(--mac-text-secondary)' }}>{String(file.extension || '').toUpperCase().slice(1) || 'AUDIO'}</span>
              <span style={{ fontSize: '9px', color: 'var(--mac-text-secondary)' }}>·</span>
              <span style={{ fontSize: '9px', color: 'var(--mac-text-secondary)' }}>{formatSize(file.size)}</span>
              {file.modified ? (
                <>
                  <span style={{ fontSize: '9px', color: 'var(--mac-text-secondary)' }}>·</span>
                  <span style={{ fontSize: '9px', color: 'var(--mac-text-secondary)' }}>{file.modified}</span>
                </>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export default function SoundEffectsView({ apiBaseUrl, projectContext, resolveStatus }) {
  const [config, setConfig] = useState({
    library_path: '',
    save_subfolder: '音效',
    davinci_folder: '音效',
    local_target_folder: '',
    davinci_archive_folder: '',
    folder_depth: 1,
    folder_depth_direction: 'forward',
  });
  const [showSettings, setShowSettings] = useState(false);
  const [subdirs, setSubdirs] = useState([]);
  const [localPath, setLocalPath] = useState('');
  const [localFolderOptions, setLocalFolderOptions] = useState([]);
  const [davinciFolderOptions, setDavinciFolderOptions] = useState([]);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createParentPath, setCreateParentPath] = useState('');
  const [createFolderName, setCreateFolderName] = useState('');
  const [creating, setCreating] = useState(false);

  const [folderTree, setFolderTree] = useState([]);
  const [browseItems, setBrowseItems] = useState([]);
  const [assetTotal, setAssetTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [browseOffset, setBrowseOffset] = useState(0);
  const [selectedFolder, setSelectedFolder] = useState('');
  const [expandedFolders, setExpandedFolders] = useState(new Set());
  const [currentLibraryPath, setCurrentLibraryPath] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [browseReady, setBrowseReady] = useState(false);
  const [indexStatus, setIndexStatus] = useState(null);
  const [summaryCounts, setSummaryCounts] = useState({ all: 0, favorites: 0, recent: 0, project_used: 0 });
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const normalizedSearchQuery = deferredSearchQuery.trim();
  const isSearching = normalizedSearchQuery.length > 0;
  const browseScopeKey = useMemo(
    () => JSON.stringify([currentLibraryPath || '', selectedFolder || '', normalizedSearchQuery]),
    [currentLibraryPath, normalizedSearchQuery, selectedFolder]
  );

  const [playingFile, setPlayingFile] = useState(null);
  const audioRef = useRef(null);

  const [pressingPath, setPressingPath] = useState(null);
  const currentSessionRef = useRef(null);

  const [resultToast, setResultToast] = useState(null);

  const summaryRequestRef = useRef({ id: 0, controller: null });
  const browseRequestRef = useRef({ id: 0, controller: null });
  const browseScopeRef = useRef('');
  const browseListRef = useRef(null);
  const browseLoadLockRef = useRef(false);
  const waveformSessionCounterRef = useRef(0);
  const [waveformSessionId, setWaveformSessionId] = useState(0);
  const indexStatusPollRef = useRef(null);
  const indexStatusPollSessionRef = useRef(0);
  const indexStatusClearRef = useRef(null);
  const [isFolderPending, startFolderTransition] = useTransition();

  const DRAG_ICON_FILENAME = 'sfx-drag-icon.png';
  const DRAG_ICON_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const dragIconPathRef = useRef(null);

  const ensureDragIcon = useCallback(async () => {
    if (dragIconPathRef.current) return dragIconPathRef.current;
    try {
      const dir = await appCacheDir();
      const iconPath = await join(dir, DRAG_ICON_FILENAME);
      await mkdir(dir, { recursive: true });
      const bytes = Uint8Array.from(atob(DRAG_ICON_BASE64), (c) => c.charCodeAt(0));
      await writeFile(iconPath, bytes);
      dragIconPathRef.current = iconPath;
      return iconPath;
    } catch (e) {
      console.error('[SFX] 拖拽图标创建失败:', e);
      return '';
    }
  }, []);

  const stopIndexStatusPolling = useCallback(() => {
    indexStatusPollSessionRef.current += 1;
    if (indexStatusPollRef.current) {
      window.clearTimeout(indexStatusPollRef.current);
      indexStatusPollRef.current = null;
    }
  }, []);

  const fetchLibraryIndexStatus = useCallback(async (libraryPath) => {
    if (!libraryPath) return null;
    try {
      const res = await axios.post(`${apiBaseUrl}/api/sound-effects/library-index-status`, {
        library_path: libraryPath,
      });
      if (res.data?.status === 'success') {
        return res.data.status_info || null;
      }
    } catch {}
    return null;
  }, [apiBaseUrl]);

  const startIndexStatusPolling = useCallback((libraryPath, optimistic = {}) => {
    if (!libraryPath) return;
    stopIndexStatusPolling();
    const sessionId = indexStatusPollSessionRef.current;
    setIndexStatus((prev) => ({
      ...(prev || {}),
      library_path: libraryPath,
      active: true,
      updated_at: Math.floor(Date.now() / 1000),
      ...optimistic,
    }));
    const poll = async () => {
      const next = await fetchLibraryIndexStatus(libraryPath);
      if (sessionId !== indexStatusPollSessionRef.current) return;
      if (next) {
        setIndexStatus(next);
        if (next.active) {
          indexStatusPollRef.current = window.setTimeout(poll, 700);
          return;
        }
      }
      indexStatusPollRef.current = null;
    };
    void poll();
  }, [fetchLibraryIndexStatus, stopIndexStatusPolling]);

  const refreshLibrarySummary = useCallback(async (libraryPath, options = {}) => {
    if (!libraryPath) {
      summaryRequestRef.current.controller?.abort();
      summaryRequestRef.current.controller = null;
      setFolderTree([]);
      setSummaryCounts({ all: 0, favorites: 0, recent: 0, project_used: 0 });
      return;
    }
    summaryRequestRef.current.controller?.abort();
    const controller = new AbortController();
    const requestId = summaryRequestRef.current.id + 1;
    summaryRequestRef.current = { id: requestId, controller };
    try {
      const res = await axios.post(
        `${apiBaseUrl}/api/sound-effects/library-summary`,
        {
          library_path: libraryPath,
          force_refresh: Boolean(options.forceRefresh),
        },
        { signal: controller.signal }
      );
      if (requestId !== summaryRequestRef.current.id) return;
      if (res.data?.status === 'success') {
        const nextTree = Array.isArray(res.data.folder_tree) ? res.data.folder_tree : [];
        setFolderTree(nextTree);
        setExpandedFolders(getInitialExpandedFolders(nextTree));
        setSummaryCounts(res.data.nav_counts || { all: 0, favorites: 0, recent: 0, project_used: 0 });
      }
    } finally {
      if (summaryRequestRef.current.id === requestId) {
        summaryRequestRef.current.controller = null;
      }
    }
  }, [apiBaseUrl]);

  const refreshLibraryBrowse = useCallback(async (libraryPath, params = {}, options = {}) => {
    if (!libraryPath) {
      browseRequestRef.current.controller?.abort();
      browseRequestRef.current.controller = null;
      setBrowseItems([]);
      setAssetTotal(0);
      setHasMore(false);
      return;
    }
    browseRequestRef.current.controller?.abort();
    const controller = new AbortController();
    const requestId = browseRequestRef.current.id + 1;
    browseRequestRef.current = { id: requestId, controller };
    setLoading(true);
    try {
      const res = await axios.post(
        `${apiBaseUrl}/api/sound-effects/library-browse`,
        {
          library_path: libraryPath,
          query: params.query || '',
          selected_folder: params.selectedFolder || '',
          limit: params.limit || BROWSE_PAGE_SIZE,
          offset: params.offset || 0,
          force_refresh: Boolean(options.forceRefresh),
        },
        { signal: controller.signal }
      );
      if (requestId !== browseRequestRef.current.id) return;
      if (res.data?.status === 'success') {
        const items = Array.isArray(res.data.items) ? res.data.items : [];
        setBrowseItems((prev) => (options.append ? [...prev, ...items] : items));
        setAssetTotal(Number(res.data.total || 0));
        setHasMore(Boolean(res.data.has_more));
      }
    } catch (error) {
      if (error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED') return;
      setResultToast({ type: 'error', message: '加载音效列表失败，请检查本地索引或磁盘连接' });
    } finally {
      if (browseRequestRef.current.id === requestId) {
        browseRequestRef.current.controller = null;
        setLoading(false);
      }
    }
  }, [apiBaseUrl]);

  const scanLibrary = useCallback(async (libraryPath, options = {}) => {
    if (!libraryPath) {
      setCurrentLibraryPath('');
      setSelectedFolder('');
      setFolderTree([]);
      setBrowseItems([]);
      setAssetTotal(0);
      setHasMore(false);
      setBrowseOffset(0);
      setSummaryCounts({ all: 0, favorites: 0, recent: 0, project_used: 0 });
      setIndexStatus(null);
      setBrowseReady(false);
      stopIndexStatusPolling();
      return;
    }

    setCurrentLibraryPath(libraryPath);
    setSelectedFolder('');
    setSearchQuery('');
    setFolderTree([]);
    setBrowseItems([]);
    setAssetTotal(0);
    setHasMore(false);
    setBrowseOffset(0);
    setBrowseReady(false);
    browseScopeRef.current = '';
    browseLoadLockRef.current = false;
    if (browseListRef.current) browseListRef.current.scrollTop = 0;

    const statusBefore = await fetchLibraryIndexStatus(libraryPath);
    startIndexStatusPolling(libraryPath, {
      stage: Boolean(options.forceRefresh) ? 'rebuilding' : statusBefore?.has_cache ? 'loading' : 'starting',
      message: Boolean(options.forceRefresh)
        ? '正在重建本地索引…'
        : statusBefore?.has_cache
          ? '正在读取本地索引…'
          : '首次建立本地索引…',
      processed_files: Number(statusBefore?.processed_files || 0),
      processed_dirs: Number(statusBefore?.processed_dirs || 0),
      current_path: statusBefore?.current_path || libraryPath,
    });

    try {
      await refreshLibrarySummary(libraryPath, options);
      setBrowseReady(true);
    } catch (error) {
      setBrowseReady(true);
      setResultToast({ type: 'error', message: error?.response?.data?.detail || error?.message || '扫描音效库失败' });
    }
  }, [fetchLibraryIndexStatus, refreshLibrarySummary, startIndexStatusPolling, stopIndexStatusPolling]);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await axios.get(`${apiBaseUrl}/api/sound-effects/config`);
      if (res.data.status === 'success') {
        setConfig(res.data.config);
        setSubdirs(res.data.subdirs || []);
        setLocalPath(res.data.local_path || '');
        setLocalFolderOptions(Array.isArray(res.data.local_folder_options) ? res.data.local_folder_options : []);
        setDavinciFolderOptions(Array.isArray(res.data.davinci_folder_options) ? res.data.davinci_folder_options : []);
        const libPath = res.data.config?.library_path || '';
        if (libPath) {
          await scanLibrary(libPath);
        }
      }
    } catch (e) {
      console.error('Failed to fetch config:', e);
    }
  }, [apiBaseUrl, scanLibrary]);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  useEffect(() => {
    window.clearTimeout(indexStatusClearRef.current);
    if (!indexStatus || indexStatus.active) return undefined;
    if (indexStatus.stage === 'ready' || indexStatus.stage === 'error') {
      indexStatusClearRef.current = window.setTimeout(() => {
        setIndexStatus((current) => (current?.active ? current : null));
      }, 2400);
    }
    return () => window.clearTimeout(indexStatusClearRef.current);
  }, [indexStatus]);

  useEffect(() => () => {
    stopIndexStatusPolling();
    window.clearTimeout(indexStatusClearRef.current);
    summaryRequestRef.current.controller?.abort();
    browseRequestRef.current.controller?.abort();
  }, [stopIndexStatusPolling]);

  useEffect(() => {
    waveformSessionCounterRef.current += 1;
    const nextSessionId = waveformSessionCounterRef.current;
    activateWaveformSession(nextSessionId);
    setWaveformSessionId(nextSessionId);
  }, [browseScopeKey]);

  useEffect(() => {
    if (!currentLibraryPath || !browseReady) return;
    const scopeChanged = browseScopeRef.current !== browseScopeKey;
    if (scopeChanged) {
      browseScopeRef.current = browseScopeKey;
      browseLoadLockRef.current = false;
      if (browseListRef.current) browseListRef.current.scrollTop = 0;
      if (browseOffset !== 0) {
        setBrowseOffset(0);
        return;
      }
    }
    void refreshLibraryBrowse(
      currentLibraryPath,
      {
        query: normalizedSearchQuery,
        selectedFolder,
        offset: browseOffset,
        limit: BROWSE_PAGE_SIZE,
      },
      {
        append: browseOffset > 0,
      }
    );
  }, [browseOffset, browseReady, browseScopeKey, currentLibraryPath, normalizedSearchQuery, refreshLibraryBrowse, selectedFolder]);

  useEffect(() => {
    if (!loading) {
      browseLoadLockRef.current = false;
    }
  }, [loading]);

  const requestNextBrowsePage = useCallback(() => {
    if (loading || !hasMore || browseLoadLockRef.current) return;
    browseLoadLockRef.current = true;
    setBrowseOffset((prev) => prev + BROWSE_PAGE_SIZE);
  }, [hasMore, loading]);

  const maybeLoadMoreBrowseItems = useCallback(() => {
    const container = browseListRef.current;
    if (!container || loading || !hasMore) return;
    const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (remaining <= 480) {
      requestNextBrowsePage();
    }
  }, [hasMore, loading, requestNextBrowsePage]);

  useEffect(() => {
    if (!browseItems.length || loading) return;
    maybeLoadMoreBrowseItems();
  }, [browseItems.length, hasMore, loading, maybeLoadMoreBrowseItems]);

  useEffect(() => {
    if (!resultToast) return undefined;
    const timer = window.setTimeout(() => setResultToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [resultToast]);

  const saveConfig = async (newConfig) => {
    try {
      await axios.post(`${apiBaseUrl}/api/sound-effects/config`, newConfig);
      setConfig(newConfig);
    } catch (e) {
      console.error('Failed to save config:', e);
    }
  };

  const setLibraryPath = async (path) => {
    if (!path) return;
    const isReplace = !!(config.library_path);
    const newConfig = { ...config, library_path: path };
    await saveConfig(newConfig);
    await scanLibrary(path);
    setResultToast({ type: 'success', message: isReplace ? '音效库路径已更换' : '音效库路径已添加' });
  };

  const handleSelectExistingFolder = async () => {
    if (!window.electronAPI?.selectDirectory) {
      setResultToast({ type: 'error', message: '当前环境不支持文件夹选择器' });
      return;
    }
    try {
      const dir = await window.electronAPI.selectDirectory({ title: '选择音效库文件夹' });
      if (dir) {
        await setLibraryPath(dir);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleSelectParentFolder = async () => {
    if (!window.electronAPI?.selectDirectory) {
      setResultToast({ type: 'error', message: '当前环境不支持文件夹选择器' });
      return;
    }
    try {
      const dir = await window.electronAPI.selectDirectory({ title: '选择音效库的父目录' });
      if (dir) setCreateParentPath(dir);
    } catch (e) {
      console.error(e);
    }
  };

  const handleCreateLibrary = async () => {
    if (!createParentPath || !createFolderName.trim()) return;
    setCreating(true);
    try {
      const res = await axios.post(`${apiBaseUrl}/api/sound-effects/create-library`, {
        parent_path: createParentPath,
        folder_name: createFolderName.trim(),
      });
      if (res.data.status === 'success') {
        await setLibraryPath(res.data.path);
        setShowCreateModal(false);
        setCreateParentPath('');
        setCreateFolderName('');
        setResultToast({ type: 'success', message: `音效库「${createFolderName.trim()}」已创建` });
      } else {
        setResultToast({ type: 'error', message: res.data.message || '创建失败' });
      }
    } catch (err) {
      setResultToast({ type: 'error', message: err.response?.data?.detail || err.message || '创建失败' });
    } finally {
      setCreating(false);
    }
  };

  const clearLibraryPath = async () => {
    const pathWas = config.library_path;
    await saveConfig({ ...config, library_path: '' });
    if (currentLibraryPath === pathWas) {
      await scanLibrary('');
    }
  };

  const toggleFolder = useCallback((folderPath) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  }, []);

  const selectFolder = useCallback((folderPath) => {
    startFolderTransition(() => {
      setSelectedFolder(folderPath || '');
      if (folderPath) {
        setExpandedFolders((prev) => {
          const next = new Set(prev);
          next.add(folderPath);
          return next;
        });
      }
    });
  }, [startFolderTransition]);

  const togglePlay = useCallback((file) => {
    if (playingFile === file.path) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setPlayingFile(null);
      return;
    }

    if (audioRef.current) {
      audioRef.current.pause();
    }

    let audioUrl;
    try {
      audioUrl = convertFileSrc(file.path);
    } catch {
      audioUrl = `file://${file.path}`;
    }

    const audio = new Audio(audioUrl);
    audio.onended = () => setPlayingFile(null);
    audio.onerror = () => {
      const fallback = new Audio(`file://${file.path}`);
      fallback.onended = () => setPlayingFile(null);
      fallback.onerror = () => setPlayingFile(null);
      fallback.play().catch(() => {});
      audioRef.current = fallback;
    };
    audio.play().catch(() => {});
    audioRef.current = audio;
    setPlayingFile(file.path);
  }, [playingFile]);

  const resolveStatusRef = useLatest(resolveStatus);
  const projectContextRef = useLatest(projectContext);

  const onSoundPress = useCallback(async (file, action) => {
    if (!resolveStatusRef.current?.connected) {
      setResultToast({ type: 'error', message: '请先连接达芬奇' });
      return;
    }
    if (!projectContextRef.current?.local_path) {
      setResultToast({ type: 'error', message: '请先初始化项目' });
      return;
    }

    if (action === 'down') {
      setResultToast(null);
      setPressingPath(file.path);

      let dragDoneResolve = null;
      let dragFailed = false;
      let dragError = '';
      const dragDonePromise = new Promise((resolve) => {
        dragDoneResolve = resolve;
      });
      const dragIcon = await ensureDragIcon().catch(() => '');
      startDrag({ item: [file.path], icon: dragIcon, mode: 'copy' }, (payload) => dragDoneResolve(payload))
        .catch((e) => {
          dragFailed = true;
          dragError = e?.message || String(e);
          console.error('[SFX] startDrag IPC 失败:', dragError);
          dragDoneResolve({ result: 'Cancelled', error: dragError });
        });

      try {
        const res = await axios.post(`${apiBaseUrl}/api/sound-effects/press`, {
          source_path: file.path,
          source_relative_path: file.relative_path || '',
        });

        if (res.data.status !== 'success') {
          setPressingPath(null);
          setResultToast({ type: 'error', message: res.data?.message || '初始化拖拽失败' });
          return;
        }

        const sessionId = res.data.session_id;
        currentSessionRef.current = sessionId;

        if (res.data.need_client_copy) {
          const params = res.data.client_copy_params;
          if (!params) {
            setPressingPath(null);
            setResultToast({ type: 'error', message: '缺少客户端复制参数' });
            return;
          }
          const copyRes = await tauriAPI.copySoundFile(params.source_path, params.dest_dir);
          if (copyRes.status !== 'success') {
            setPressingPath(null);
            setResultToast({ type: 'error', message: copyRes.message || 'Tauri 复制文件失败' });
            return;
          }
          await axios.post(`${apiBaseUrl}/api/sound-effects/press/confirm`, {
            session_id: sessionId,
            local_copy_path: params.dest_path,
          });
        }

        const localCopyPath = res.data.local_copy_path || res.data.client_copy_params?.dest_path || '';
        if (!localCopyPath) {
          setPressingPath(null);
          setResultToast({ type: 'error', message: '获取项目内文件路径失败' });
          return;
        }

        const payload = await dragDonePromise;
        if (dragFailed) {
          setPressingPath(null);
          currentSessionRef.current = null;
          try {
            await axios.post(`${apiBaseUrl}/api/sound-effects/release`, { session_id: sessionId });
          } catch {}
          setResultToast({ type: 'error', message: `拖拽启动失败: ${dragError || '未知错误'}\n请从项目文件夹手动拖入达芬奇` });
          return;
        }

        const dropped = payload?.result !== 'Cancelled';
        try {
          const rel = await axios.post(`${apiBaseUrl}/api/sound-effects/release`, { session_id: sessionId });
          if (rel.data?.status === 'success') {
            // Drag-and-drop is now the primary workflow, so successful imports stay silent.
          } else {
            setResultToast({ type: 'error', message: rel.data?.message || '完成导入失败' });
          }
        } catch (e) {
          setResultToast({ type: 'error', message: e?.response?.data?.detail || e?.message || '完成导入失败' });
        } finally {
          setPressingPath(null);
          currentSessionRef.current = null;
        }
      } catch (err) {
        setPressingPath(null);
        setResultToast({ type: 'error', message: err.response?.data?.detail || '初始化拖拽失败' });
      }
    } else if (action === 'up' && currentSessionRef.current) {
      setPressingPath(null);
      try {
        const res = await axios.post(`${apiBaseUrl}/api/sound-effects/release`, {
          session_id: currentSessionRef.current,
        });
        currentSessionRef.current = null;
        if (res.data.status !== 'success') {
          setResultToast({ type: 'error', message: res.data?.message || '释放处理失败' });
        }
      } catch (err) {
        currentSessionRef.current = null;
        setResultToast({ type: 'error', message: err.response?.data?.detail || '释放处理失败' });
      }
    } else if (action === 'cancel') {
      setPressingPath(null);
    }
  }, [apiBaseUrl, ensureDragIcon, projectContextRef, resolveStatusRef]);

  const currentFolderLabel = useMemo(() => {
    if (isSearching) return '搜索结果';
    if (!selectedFolder) return '全部音效';
    return selectedFolder.split('/').pop() || selectedFolder;
  }, [isSearching, selectedFolder]);

  const showIndexBanner = useMemo(() => {
    if (!indexStatus) return false;
    return Boolean(indexStatus.active) || String(indexStatus.stage || '') === 'error';
  }, [indexStatus]);

  const indexStatusView = useMemo(() => {
    if (!indexStatus) return { title: '', detail: '', tone: 'neutral' };
    const stage = String(indexStatus.stage || '');
    let title = '本地索引处理中';
    let tone = 'neutral';
    if (stage === 'starting') title = '首次建立本地索引';
    else if (stage === 'rebuilding') title = '正在重建本地索引';
    else if (stage === 'scanning') title = '正在扫描音效文件';
    else if (stage === 'writing') title = '正在写入本地索引';
    else if (stage === 'ready') {
      title = '本地索引已就绪';
      tone = 'success';
    } else if (stage === 'error') {
      title = '本地索引建立失败';
      tone = 'error';
    } else if (stage === 'loading') {
      title = '正在读取本地索引';
    }

    const details = [];
    if (Number(indexStatus.processed_files || 0) > 0) {
      details.push(`已发现 ${Number(indexStatus.processed_files).toLocaleString()} 个音效`);
    }
    if (Number(indexStatus.processed_dirs || 0) > 0) {
      details.push(`已遍历 ${Number(indexStatus.processed_dirs).toLocaleString()} 个文件夹`);
    }
    if (indexStatus.current_path) {
      details.push(String(indexStatus.current_path));
    }

    return {
      title,
      detail: String(indexStatus.message || details.join(' · ') || ''),
      meta: details.join(' · '),
      tone,
    };
  }, [indexStatus]);

  const showIndexBadge = useMemo(() => {
    if (!indexStatus) return false;
    if (indexStatus.active) return true;
    const updatedAtMs = Number(indexStatus.updated_at || 0) * 1000;
    if (!updatedAtMs) return false;
    return ['ready', 'error'].includes(String(indexStatus.stage || '')) && Date.now() - updatedAtMs < 2400;
  }, [indexStatus]);

  return (
    <div className="sfx-container" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 0', flexShrink: 0 }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <Search size={13} style={{ position: 'absolute', left: '9px', top: '50%', transform: 'translateY(-50%)', color: 'var(--mac-text-secondary)', pointerEvents: 'none' }} />
          <input
            type="text"
            placeholder="搜索音效或路径..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ width: '100%', padding: '5px 10px 5px 28px', borderRadius: '7px', border: '1px solid var(--mac-border)', background: 'var(--mac-bg)', color: 'var(--mac-text)', fontSize: '11px', outline: 'none' }}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              style={{ position: 'absolute', right: '5px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--mac-text-secondary)', cursor: 'pointer', padding: '2px' }}
            >
              <X size={11} />
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => currentLibraryPath && scanLibrary(currentLibraryPath, { forceRefresh: true })}
          disabled={!currentLibraryPath}
          style={{ padding: '5px', borderRadius: '7px', border: '1px solid var(--mac-border)', background: 'var(--mac-bg)', color: 'var(--mac-text)', cursor: !currentLibraryPath ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center' }}
          title="刷新本地索引"
        >
          <RefreshCw size={12} className={loading ? 'spin' : ''} />
        </button>
        <AnimatePresence>
          {showIndexBadge && (
            <motion.div
              initial={{ opacity: 0, y: -3, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -3, scale: 0.98 }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                padding: '5px 8px',
                borderRadius: '999px',
                border: `1px solid ${indexStatusView.tone === 'error' ? 'rgba(255,59,48,0.22)' : indexStatusView.tone === 'success' ? 'rgba(52,199,89,0.22)' : 'rgba(0,122,255,0.18)'}`,
                background: indexStatusView.tone === 'error' ? 'rgba(255,59,48,0.08)' : indexStatusView.tone === 'success' ? 'rgba(52,199,89,0.08)' : 'rgba(255,255,255,0.04)',
                color: indexStatusView.tone === 'error' ? '#FF3B30' : indexStatusView.tone === 'success' ? '#34C759' : 'var(--mac-text-secondary)',
                flexShrink: 0,
                maxWidth: '220px',
              }}
              title={indexStatusView.detail || indexStatusView.meta || indexStatusView.title}
            >
              {indexStatus?.active ? <Loader size={11} className="spin" /> : indexStatusView.tone === 'success' ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
              <span
                style={{
                  fontSize: '10px',
                  fontWeight: '600',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {indexStatusView.title}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
        <button
          type="button"
          onClick={() => setShowSettings(!showSettings)}
          style={{ padding: '5px', borderRadius: '7px', border: showSettings ? '1px solid var(--mac-accent)' : '1px solid var(--mac-border)', background: showSettings ? 'rgba(0,122,255,0.1)' : 'var(--mac-bg)', color: showSettings ? 'var(--mac-accent)' : 'var(--mac-text)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
          title="设置"
        >
          <Settings size={12} />
        </button>
      </div>

      <AnimatePresence>
        {showIndexBanner && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            style={{
              marginBottom: '8px',
              padding: '9px 10px',
              borderRadius: '12px',
              border: `1px solid ${indexStatusView.tone === 'error' ? 'rgba(255,59,48,0.28)' : indexStatusView.tone === 'success' ? 'rgba(52,199,89,0.28)' : 'rgba(0,122,255,0.18)'}`,
              background: indexStatusView.tone === 'error' ? 'rgba(255,59,48,0.08)' : 'rgba(255,255,255,0.03)',
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {indexStatus?.active ? <Loader size={12} className="spin" style={{ color: 'var(--mac-accent)' }} /> : <AlertCircle size={12} style={{ color: '#FF3B30' }} />}
              <span style={{ fontSize: '11px', fontWeight: '600', color: 'var(--mac-text)' }}>{indexStatusView.title}</span>
            </div>
            {(indexStatusView.detail || indexStatusView.meta) && (
              <div style={{ marginTop: '5px', fontSize: '10px', color: 'var(--mac-text-secondary)', lineHeight: 1.45, wordBreak: 'break-all' }}>
                {indexStatusView.detail || indexStatusView.meta}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showSettings && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 500, damping: 35 }} style={{ overflow: 'hidden', flexShrink: 0 }}>
            <div style={{ padding: '10px', borderRadius: '8px', border: '1px solid var(--mac-border)', background: 'var(--mac-bg)', marginBottom: '8px' }}>
              <div style={{ fontSize: '11px', fontWeight: '600', marginBottom: '6px', color: 'var(--mac-text)' }}>音效库路径</div>
              {config.library_path ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '3px' }}>
                  <HardDrive size={11} style={{ color: 'var(--mac-text-secondary)', flexShrink: 0 }} />
                  <span style={{ fontSize: '10px', color: 'var(--mac-text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{config.library_path}</span>
                  <button type="button" onClick={clearLibraryPath} style={{ background: 'none', border: 'none', color: '#FF3B30', cursor: 'pointer', padding: '1px', flexShrink: 0 }}><Trash2 size={11} /></button>
                </div>
              ) : (
                <div style={{ fontSize: '10px', color: 'var(--mac-text-secondary)', padding: '3px 0 6px', textAlign: 'center' }}>还没有添加音效库路径</div>
              )}
              <div style={{ display: 'flex', gap: '5px', marginTop: '6px' }}>
                <button type="button" onClick={handleSelectExistingFolder} style={{ flex: 1, padding: '6px 12px', borderRadius: '7px', border: '1px solid var(--mac-border)', background: 'var(--mac-bg)', color: 'var(--mac-text)', cursor: 'pointer', fontSize: '11px', fontWeight: '500', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}><FolderOpen size={11} /> {config.library_path ? '更换' : '选择'}文件夹</button>
                <button type="button" onClick={() => { setShowCreateModal(true); setCreateParentPath(''); setCreateFolderName(''); }} style={{ flex: 1, padding: '6px 12px', borderRadius: '7px', border: 'none', background: 'var(--mac-accent)', color: '#FFF', cursor: 'pointer', fontSize: '11px', fontWeight: '500', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}><FolderPlus size={11} /> 新建音效库</button>
              </div>

              <div style={{ borderTop: '1px solid var(--mac-border)', margin: '10px 0 8px' }} />

              <div style={{ fontSize: '11px', fontWeight: '600', marginBottom: '6px', color: 'var(--mac-text)' }}>导入设置</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                <div style={{ fontSize: '10px', color: 'var(--mac-text-secondary)', flexShrink: 0, width: '56px' }}>保存位置</div>
                <select
                  value={config.local_target_folder || config.save_subfolder}
                  onChange={(e) => {
                    const v = e.target.value;
                    saveConfig({ ...config, local_target_folder: v, save_subfolder: config.save_subfolder || v });
                  }}
                  style={{ flex: 1, padding: '4px 6px', borderRadius: '5px', border: '1px solid var(--mac-border)', background: 'var(--mac-bg)', color: 'var(--mac-text)', fontSize: '10px', cursor: 'pointer' }}
                >
                  {(localFolderOptions?.length ? localFolderOptions : (subdirs?.length ? subdirs : ['音效'])).map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                <div style={{ fontSize: '10px', color: 'var(--mac-text-secondary)', flexShrink: 0, width: '56px' }}>媒体池目录</div>
                <select
                  value={config.davinci_archive_folder || config.davinci_folder}
                  onChange={(e) => {
                    const v = e.target.value;
                    saveConfig({ ...config, davinci_archive_folder: v, davinci_folder: config.davinci_folder || v });
                  }}
                  style={{ flex: 1, padding: '4px 6px', borderRadius: '5px', border: '1px solid var(--mac-border)', background: 'var(--mac-bg)', color: 'var(--mac-text)', fontSize: '10px', cursor: 'pointer' }}
                >
                  {(davinciFolderOptions?.length ? davinciFolderOptions : ['音效']).map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <div style={{ fontSize: '10px', color: 'var(--mac-text-secondary)', flexShrink: 0, width: '56px' }}>映射层级</div>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <input type="range" min="0" max="10" value={config.folder_depth} onChange={(e) => saveConfig({ ...config, folder_depth: parseInt(e.target.value, 10) })} style={{ flex: 1, accentColor: 'var(--mac-accent)' }} />
                  <span style={{ fontSize: '10px', color: 'var(--mac-accent)', fontWeight: '500', minWidth: '32px', textAlign: 'right' }}>
                    {config.folder_depth === 0 ? '直接导入' : config.folder_depth + ' 层'}
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px' }}>
                <div style={{ fontSize: '10px', color: 'var(--mac-text-secondary)', flexShrink: 0, width: '56px' }}>映射方式</div>
                <select
                  value={config.folder_depth_direction || 'forward'}
                  onChange={(e) => saveConfig({ ...config, folder_depth_direction: e.target.value })}
                  style={{ flex: 1, padding: '4px 6px', borderRadius: '5px', border: '1px solid var(--mac-border)', background: 'var(--mac-bg)', color: 'var(--mac-text)', fontSize: '10px', cursor: 'pointer' }}
                >
                  <option value="forward">正向（从上到下）</option>
                  <option value="reverse">反向（从下到上）</option>
                </select>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showCreateModal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'absolute', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }} onClick={() => setShowCreateModal(false)}>
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }} style={{ background: 'var(--mac-bg-elevated, #2c2c2e)', borderRadius: '12px', padding: '16px', width: '100%', maxWidth: '320px', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }} onClick={(e) => e.stopPropagation()}>
              <div style={{ fontSize: '13px', fontWeight: '600', color: 'var(--mac-text)', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}><FolderPlus size={14} style={{ color: 'var(--mac-accent)' }} />新建音效库</div>
              <div style={{ marginBottom: '10px' }}>
                <div style={{ fontSize: '10px', color: 'var(--mac-text-secondary)', marginBottom: '3px' }}>保存位置</div>
                <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                  <div style={{ flex: 1, padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--mac-border)', background: 'var(--mac-bg)', fontSize: '10px', color: createParentPath ? 'var(--mac-text)' : 'var(--mac-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{createParentPath || '请选择父目录...'}</div>
                  <button type="button" onClick={handleSelectParentFolder} style={{ padding: '6px 14px', borderRadius: '7px', border: '1px solid var(--mac-border)', background: 'var(--mac-bg)', color: 'var(--mac-text)', cursor: 'pointer', fontSize: '11px', fontWeight: '500', flexShrink: 0 }}>选择</button>
                </div>
              </div>
              <div style={{ marginBottom: '12px' }}>
                <div style={{ fontSize: '10px', color: 'var(--mac-text-secondary)', marginBottom: '3px' }}>音效库名称</div>
                <input type="text" placeholder="例如：我的音效库" value={createFolderName} onChange={(e) => setCreateFolderName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCreateLibrary()} autoFocus style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--mac-border)', background: 'var(--mac-bg)', color: 'var(--mac-text)', fontSize: '11px', outline: 'none', boxSizing: 'border-box' }} />
              </div>
              {createParentPath && createFolderName.trim() && <div style={{ fontSize: '9px', color: 'var(--mac-text-secondary)', marginBottom: '10px', padding: '4px 6px', borderRadius: '4px', background: 'rgba(255,255,255,0.03)', wordBreak: 'break-all' }}>将创建：{createParentPath}/{createFolderName.trim()}</div>}
              <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setShowCreateModal(false)} style={{ padding: '5px 12px', borderRadius: '6px', border: '1px solid var(--mac-border)', background: 'var(--mac-bg)', color: 'var(--mac-text)', cursor: 'pointer', fontSize: '11px' }}>取消</button>
                <button type="button" onClick={handleCreateLibrary} disabled={!createParentPath || !createFolderName.trim() || creating} style={{ padding: '5px 12px', borderRadius: '6px', border: 'none', background: (!createParentPath || !createFolderName.trim()) ? 'rgba(0,122,255,0.3)' : 'var(--mac-accent)', color: '#FFF', cursor: (!createParentPath || !createFolderName.trim()) ? 'not-allowed' : 'pointer', fontSize: '11px', fontWeight: '500', display: 'flex', alignItems: 'center', gap: '3px' }}>{creating ? <Loader size={10} className="spin" /> : <FolderPlus size={10} />} 创建</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {!currentLibraryPath && !config.library_path ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '40px' }}>
          <div style={{ width: '48px', height: '48px', borderRadius: '14px', background: 'rgba(90,200,250,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><FileMusic size={24} style={{ color: '#5AC8FA' }} /></div>
          <div style={{ fontSize: '13px', fontWeight: '600', color: 'var(--mac-text)' }}>设置音效库</div>
          <div style={{ fontSize: '11px', color: 'var(--mac-text-secondary)', textAlign: 'center', maxWidth: '260px' }}>选择已有的音效文件夹，或新建一个音效库</div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button type="button" onClick={handleSelectExistingFolder} style={{ padding: '7px 14px', borderRadius: '7px', border: '1px solid var(--mac-border)', background: 'var(--mac-bg)', color: 'var(--mac-text)', cursor: 'pointer', fontSize: '11px', fontWeight: '500', display: 'flex', alignItems: 'center', gap: '5px' }}><FolderOpen size={13} /> 选择文件夹</button>
            <button type="button" onClick={() => { setShowCreateModal(true); setCreateParentPath(''); setCreateFolderName(''); }} style={{ padding: '7px 14px', borderRadius: '7px', border: 'none', background: 'var(--mac-accent)', color: '#FFF', cursor: 'pointer', fontSize: '11px', fontWeight: '500', display: 'flex', alignItems: 'center', gap: '5px' }}><FolderPlus size={13} /> 新建音效库</button>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) minmax(0, 1fr)', gap: '10px' }}>
          <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--mac-border)', borderRadius: '10px', background: 'rgba(255,255,255,0.02)', overflow: 'hidden' }}>
            <div style={{ padding: '10px 10px 8px', borderBottom: '1px solid var(--mac-border)', flexShrink: 0 }}>
              <div style={{ fontSize: '11px', fontWeight: '600', color: 'var(--mac-text)' }}>文件夹</div>
              <div style={{ marginTop: '3px', fontSize: '10px', color: 'var(--mac-text-secondary)' }}>
                {Number(summaryCounts.all || 0).toLocaleString()} 个音效
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px' }}>
              <div
                onClick={() => selectFolder('')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '6px 8px',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  background: selectedFolder ? 'transparent' : 'rgba(0,122,255,0.10)',
                  color: selectedFolder ? 'var(--mac-text)' : 'var(--mac-accent)',
                  marginBottom: '4px',
                }}
                className="sfx-hover-bg"
              >
                <FileAudio size={12} />
                <span style={{ fontSize: '11px', fontWeight: selectedFolder ? '500' : '600', flex: 1 }}>全部音效</span>
                <span style={{ fontSize: '9px', color: 'var(--mac-text-secondary)' }}>{Number(summaryCounts.all || 0).toLocaleString()}</span>
              </div>
              {folderTree.length === 0 && !indexStatus?.active ? (
                <div style={{ padding: '24px 12px', fontSize: '11px', color: 'var(--mac-text-secondary)', textAlign: 'center' }}>当前音效库里还没有可浏览的文件夹</div>
              ) : (
                folderTree.map((node) => (
                  <FolderTreeNode
                    key={node.path}
                    node={node}
                    depth={0}
                    expandedFolders={expandedFolders}
                    toggleFolder={toggleFolder}
                    selectedFolder={selectedFolder}
                    onSelectFolder={selectFolder}
                  />
                ))
              )}
            </div>
          </div>

          <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--mac-border)', borderRadius: '10px', background: 'rgba(255,255,255,0.02)', overflow: 'hidden' }}>
            <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid var(--mac-border)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '12px', fontWeight: '600', color: 'var(--mac-text)' }}>{currentFolderLabel}</span>
                <span style={{ fontSize: '10px', color: 'var(--mac-text-secondary)' }}>
                  已加载 {browseItems.length.toLocaleString()} / {assetTotal.toLocaleString()}
                </span>
              </div>
              <div style={{ marginTop: '3px', fontSize: '10px', color: 'var(--mac-text-secondary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                {selectedFolder ? <span title={selectedFolder}>{selectedFolder}</span> : <span>当前展示整个音效库，可向下滚动继续加载</span>}
                {searchQuery && <span>· 搜索“{searchQuery}”</span>}
                {searchQuery !== deferredSearchQuery && <span>· 筛选中...</span>}
                {isFolderPending && <span>· 切换中...</span>}
              </div>
            </div>

            <div
              ref={browseListRef}
              onScroll={maybeLoadMoreBrowseItems}
              style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px' }}
            >
              {loading && browseItems.length === 0 ? (
                <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                  <Loader size={14} className="spin" style={{ color: 'var(--mac-accent)' }} />
                  <span style={{ fontSize: '11px', color: 'var(--mac-text-secondary)' }}>加载音效列表中...</span>
                </div>
              ) : browseItems.length === 0 ? (
                <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', color: 'var(--mac-text-secondary)' }}>
                  {isSearching ? '没有匹配的音效文件' : '当前范围内没有音效文件'}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {browseItems.map((file, index) => (
                    <SoundFileItem
                      key={file.asset_key || file.path}
                      file={file}
                      waveformPriority={index}
                      waveformSessionId={waveformSessionId}
                      isPlaying={playingFile === file.path}
                      isPressing={pressingPath === file.path}
                      togglePlay={togglePlay}
                      onSoundPress={onSoundPress}
                      audioRef={audioRef}
                      apiBaseUrl={apiBaseUrl}
                    />
                  ))}
                  {(hasMore || loading) && (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 2px', color: 'var(--mac-text-secondary)', fontSize: '10px', gap: '5px', alignItems: 'center' }}>
                      {loading ? <Loader size={11} className="spin" /> : null}
                      <span>{hasMore ? '继续向下滚动，自动加载更多波形' : '正在整理当前列表…'}</span>
                    </div>
                  )}
                  {!hasMore && browseItems.length > 0 && !loading && (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 2px', color: 'var(--mac-text-secondary)', fontSize: '10px' }}>
                      已展示当前范围内全部音效
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <AnimatePresence>
        {resultToast && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} style={{ position: 'absolute', right: '16px', bottom: '16px', padding: '7px 12px', borderRadius: '10px', background: resultToast.type === 'error' ? 'rgba(255,59,48,0.15)' : resultToast.type === 'success' ? 'rgba(52,199,89,0.15)' : 'rgba(0,122,255,0.12)', border: `1px solid ${resultToast.type === 'error' ? 'rgba(255,59,48,0.3)' : resultToast.type === 'success' ? 'rgba(52,199,89,0.3)' : 'rgba(0,122,255,0.2)'}`, color: resultToast.type === 'error' ? '#FF3B30' : resultToast.type === 'success' ? '#34C759' : 'var(--mac-accent)', fontSize: '11px', fontWeight: '500', display: 'flex', alignItems: 'center', gap: '5px', maxWidth: '320px', whiteSpace: 'pre-wrap', zIndex: 120, boxShadow: '0 10px 30px rgba(0,0,0,0.18)' }}>
            {resultToast.type === 'error' ? <AlertCircle size={12} /> : resultToast.type === 'success' ? <CheckCircle2 size={12} /> : <Volume2 size={12} />}
            {resultToast.message}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
