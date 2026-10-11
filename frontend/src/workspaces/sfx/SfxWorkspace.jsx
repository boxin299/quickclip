import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import axios from 'axios';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { startDrag } from '@crabnebula/tauri-plugin-drag';
import { appCacheDir, join } from '@tauri-apps/api/path';
import { writeFile, mkdir, copyFile } from '@tauri-apps/plugin-fs';
import {
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  Folder,
  FolderCheck,
  FolderPlus,
  FolderOpen,
  Heart,
  Library,
  Loader2,
  LogOut,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Star,
  Tag,
  PanelRightClose,
  PanelRightOpen,
  Check,
  Layers,
  HardDrive,
  RotateCcw,
  Info
} from 'lucide-react';
import { API_BASE_URL } from '../../config';

const SMART_FOLDERS_STORAGE_KEY = 'sfx.smartFolders.v1';
const SFX_CACHE_KEY = 'sfx.cache.v1';
const SFX_WAVEFORM_DB_NAME = 'sfx.waveforms.v1';
const SFX_WAVEFORM_DB_STORE = 'waveforms';
const SFX_BROWSE_PAGE_SIZE = 120;
const SFX_BROWSE_CACHE_MAX = 48;
const WAVEFORM_MEMORY_CACHE_MAX = 180;
const WAVEFORM_PERSIST_LOOKUP_TIMEOUT_MS = 120;
const DRAG_ICON_FILENAME = 'sfx-drag-icon.png';
const DRAG_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAP0lEQVR42u3RAQ0AAAgDIN8/9K3hHBQ0lV3Zs2fPnj179uzZs2fPnj179uzZs2fPnj179uzZs2fPnt0LZl8C8uY0ZK0AAAAASUVORK5CYII=';

const WAVEFORM_MEMORY_CACHE = new Map();
const WAVEFORM_READY_KEYS = new Set();
const WAVEFORM_INFLIGHT = new Map();
const WAVEFORM_INFLIGHT_META = new Map();
let WAVEFORM_ACTIVE = 0;
const WAVEFORM_QUEUE = [];
const WAVEFORM_QUEUED_JOBS = new Map();
const WAVEFORM_MAX_CONCURRENT = 2;
const WAVEFORM_BATCH_SIZE = 32;
const WAVEFORM_GRID_SAMPLES = 160;
const WAVEFORM_BACKGROUND_PAGE_SIZE = 200;
const WAVEFORM_BACKGROUND_IDLE_MS = 12000;
const WAVEFORM_JOB_STATE = new Map();
const WAVEFORM_PROGRESS_LISTENERS = new Set();
const WAVEFORM_PRIORITY_ACTIVE = 0;
const WAVEFORM_PRIORITY_VIEW = 1;
const WAVEFORM_PRIORITY_IDLE = 2;
let WAVEFORM_JOB_SEQUENCE = 0;
const WAVEFORM_INFLIGHT_CONTROLLERS = new Map();
const WAVEFORM_PERSIST_READS = new Map();
let WAVEFORM_DB_PROMISE = null;

export function getInitialSfxExpandedFolders() {
  return new Set();
}

export function buildSfxInsertToTimelinePayload(asset, ioRange = {}) {
  return {
    source_path: asset?.path,
    source_relative_path: asset?.relativePath || asset?.relative_path || '',
    in_point: ioRange.inPoint,
    out_point: ioRange.outPoint,
    track_index: 0,
  };
}

function openWaveformDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (WAVEFORM_DB_PROMISE) return WAVEFORM_DB_PROMISE;
  WAVEFORM_DB_PROMISE = new Promise((resolve) => {
    try {
      const request = indexedDB.open(SFX_WAVEFORM_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const store = db.objectStoreNames.contains(SFX_WAVEFORM_DB_STORE)
          ? request.transaction.objectStore(SFX_WAVEFORM_DB_STORE)
          : db.createObjectStore(SFX_WAVEFORM_DB_STORE, { keyPath: 'key' });
        if (!store.indexNames.contains('libraryPath')) {
          store.createIndex('libraryPath', 'libraryPath', { unique: false });
        }
        if (!store.indexNames.contains('updatedAt')) {
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return WAVEFORM_DB_PROMISE;
}

async function withWaveformStore(mode, runner) {
  const db = await openWaveformDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(SFX_WAVEFORM_DB_STORE, mode);
      const store = tx.objectStore(SFX_WAVEFORM_DB_STORE);
      const result = runner(store, tx);
      tx.oncomplete = () => resolve(result ?? true);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function emitWaveformProgress() {
  const stamp = Date.now();
  WAVEFORM_PROGRESS_LISTENERS.forEach((listener) => {
    try {
      listener(stamp);
    } catch {}
  });
}

function subscribeWaveformProgress(listener) {
  if (typeof listener !== 'function') return () => {};
  WAVEFORM_PROGRESS_LISTENERS.add(listener);
  listener(Date.now());
  return () => {
    WAVEFORM_PROGRESS_LISTENERS.delete(listener);
  };
}

function getWaveformCacheKey(path, samples) {
  return `${path}::${samples}`;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getSfxBrowseCacheKey(libraryPath, params = {}) {
  return JSON.stringify({
    library: libraryPath || '',
    query: params.query || '',
    selectedFolder: params.selectedFolder || '',
    forcedTag: params.forcedTag || '',
    favoriteOnly: Boolean(params.favoriteOnly),
    untaggedOnly: Boolean(params.untaggedOnly),
    sortMode: params.sortMode || 'name_asc',
    smartRules: params.smartRules || {},
    offset: Number(params.offset || 0),
    limit: Number(params.limit || SFX_BROWSE_PAGE_SIZE),
  });
}

function writeSfxBrowseCache(cache, key, value) {
  if (!cache || !key || !value) return;
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > SFX_BROWSE_CACHE_MAX) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

function getWaveformJobStatus(key) {
  if (!key) return 'idle';
  if (WAVEFORM_MEMORY_CACHE.has(key)) return 'ready';
  return WAVEFORM_JOB_STATE.get(key) || 'idle';
}

function markWaveformReady(key) {
  if (!key) return;
  WAVEFORM_READY_KEYS.add(key);
  WAVEFORM_JOB_STATE.delete(key);
  emitWaveformProgress();
}

function getWaveformPathFromKey(key) {
  const raw = String(key || '');
  const separatorIndex = raw.lastIndexOf('::');
  return separatorIndex >= 0 ? raw.slice(0, separatorIndex) : raw;
}

function normalizeLibraryPath(path) {
  return String(path || '').replace(/[\\/]+$/, '');
}

function resolveLibraryPathFromWaveformPath(path) {
  const normalizedPath = normalizeLibraryPath(path);
  if (!normalizedPath) return '';
  const segments = normalizedPath.split(/[\\/]/).filter(Boolean);
  if (segments.length <= 1) return normalizedPath;
  let bestMatch = '';
  for (let index = 1; index <= segments.length; index += 1) {
    const candidate = normalizedPath.split(/[\\/]/).slice(0, index).join('/');
    if (candidate.length > bestMatch.length) bestMatch = candidate;
  }
  return bestMatch || normalizedPath;
}

function keyBelongsToLibrary(key, libraryPath) {
  const normalizedLibrary = normalizeLibraryPath(libraryPath);
  if (!normalizedLibrary) return false;
  const waveformPath = normalizeLibraryPath(getWaveformPathFromKey(key));
  return waveformPath === normalizedLibrary
    || waveformPath.startsWith(`${normalizedLibrary}/`)
    || waveformPath.startsWith(`${normalizedLibrary}\\`);
}

function cacheWaveformData(key, value, duration = 0) {
  const data = Array.isArray(value) ? value : value?.data;
  const resolvedDuration = Array.isArray(value) ? duration : Number(value?.duration || 0);
  if (!key || !Array.isArray(data) || data.length === 0) return;
  markWaveformReady(key);
  WAVEFORM_MEMORY_CACHE.set(key, {
    data,
    duration: Number.isFinite(resolvedDuration) && resolvedDuration > 0 ? resolvedDuration : 0,
  });
  trimWaveformCache(WAVEFORM_MEMORY_CACHE_MAX);
}

async function persistWaveformData(key, value, duration = 0) {
  const data = Array.isArray(value) ? value : value?.data;
  const resolvedDuration = Array.isArray(value) ? duration : Number(value?.duration || 0);
  if (!key || !Array.isArray(data) || data.length === 0) return false;
  const path = getWaveformPathFromKey(key);
  const libraryPath = resolveLibraryPathFromWaveformPath(path);
  const payload = {
    key,
    path,
    libraryPath,
    data,
    duration: Number.isFinite(resolvedDuration) && resolvedDuration > 0 ? resolvedDuration : 0,
    updatedAt: Date.now(),
  };
  const result = await withWaveformStore('readwrite', (store) => {
    store.put(payload);
    return true;
  });
  return Boolean(result);
}

async function loadPersistedWaveformData(key) {
  if (!key) return null;
  const inflight = WAVEFORM_PERSIST_READS.get(key);
  if (inflight) return inflight;
  const promise = withWaveformStore('readonly', (store) => new Promise((resolve) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  })).finally(() => {
    WAVEFORM_PERSIST_READS.delete(key);
  });
  WAVEFORM_PERSIST_READS.set(key, promise);
  return promise;
}

async function safeLoadPersistedWaveformData(key, timeoutMs = WAVEFORM_PERSIST_LOOKUP_TIMEOUT_MS) {
  try {
    return await Promise.race([
      loadPersistedWaveformData(key),
      sleep(timeoutMs).then(() => null),
    ]);
  } catch {
    return null;
  }
}

async function countPersistedWaveformsForLibrary(libraryPath) {
  const normalizedLibrary = normalizeLibraryPath(libraryPath);
  if (!normalizedLibrary) return 0;
  const db = await openWaveformDb();
  if (!db) return 0;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(SFX_WAVEFORM_DB_STORE, 'readonly');
      const store = tx.objectStore(SFX_WAVEFORM_DB_STORE);
      const values = [];
      if (store.indexNames.contains('libraryPath')) {
        const index = store.index('libraryPath');
        const request = index.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(values.filter((value) => keyBelongsToLibrary(value?.key, normalizedLibrary)).length);
            return;
          }
          values.push(cursor.value);
          cursor.continue();
        };
        request.onerror = () => resolve(0);
      } else {
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(values.filter((value) => keyBelongsToLibrary(value?.key, normalizedLibrary)).length);
            return;
          }
          values.push(cursor.value);
          cursor.continue();
        };
        request.onerror = () => resolve(0);
      }
      tx.onerror = () => resolve(0);
      tx.onabort = () => resolve(0);
    } catch {
      resolve(0);
    }
  });
}

function sortWaveformQueue() {
  WAVEFORM_QUEUE.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.sequence - b.sequence;
  });
}

let sharedWaveformObserver = null;
function getSharedWaveformObserver() {
  if (!sharedWaveformObserver) {
    sharedWaveformObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.target._onVisible) {
            entry.target._onVisible();
            sharedWaveformObserver.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '600px 0px', threshold: 0.01 }
    );
  }
  return sharedWaveformObserver;
}

function trimWaveformCache(maxItems = 1500) {
  while (WAVEFORM_MEMORY_CACHE.size > maxItems) {
    const firstKey = WAVEFORM_MEMORY_CACHE.keys().next().value;
    if (!firstKey) break;
    WAVEFORM_MEMORY_CACHE.delete(firstKey);
  }
}

function mergeBrowseItems(prevItems, nextItems) {
  const merged = new Map();
  (prevItems || []).forEach((item) => {
    if (item?.id) merged.set(item.id, item);
  });
  (nextItems || []).forEach((item) => {
    if (item?.id) merged.set(item.id, item);
  });
  return Array.from(merged.values());
}

function cancelWaveformJobs(matcher = () => true) {
  for (let index = WAVEFORM_QUEUE.length - 1; index >= 0; index -= 1) {
    const job = WAVEFORM_QUEUE[index];
    if (!job || !matcher(job)) continue;
    WAVEFORM_QUEUE.splice(index, 1);
    WAVEFORM_QUEUED_JOBS.delete(job.key);
    WAVEFORM_JOB_STATE.delete(job.key);
  }
  WAVEFORM_INFLIGHT_CONTROLLERS.forEach((controller, key) => {
    const meta = WAVEFORM_INFLIGHT_META.get(key) || { key, path: getWaveformPathFromKey(key), priority: WAVEFORM_PRIORITY_VIEW };
    if (!matcher(meta)) return;
    controller.abort();
    WAVEFORM_INFLIGHT_CONTROLLERS.delete(key);
    WAVEFORM_INFLIGHT_META.delete(key);
    WAVEFORM_JOB_STATE.delete(key);
  });
  emitWaveformProgress();
}

function pumpWaveformQueue() {
  while (WAVEFORM_ACTIVE < WAVEFORM_MAX_CONCURRENT && WAVEFORM_QUEUE.length > 0) {
    const seed = WAVEFORM_QUEUE.shift();
    if (!seed) return;
    WAVEFORM_QUEUED_JOBS.delete(seed.key);

    const batch = [seed];
    for (let index = 0; index < WAVEFORM_QUEUE.length && batch.length < WAVEFORM_BATCH_SIZE;) {
      const candidate = WAVEFORM_QUEUE[index];
      if (candidate?.samples !== seed.samples || candidate?.priority !== seed.priority) {
        index += 1;
        continue;
      }
      WAVEFORM_QUEUE.splice(index, 1);
      WAVEFORM_QUEUED_JOBS.delete(candidate.key);
      batch.push(candidate);
    }

    WAVEFORM_ACTIVE += 1;
    batch.forEach((job) => {
      WAVEFORM_JOB_STATE.set(job.key, 'active');
    });
    emitWaveformProgress();
    const controller = new AbortController();
    batch.forEach((job) => {
      WAVEFORM_INFLIGHT_CONTROLLERS.set(job.key, controller);
      WAVEFORM_INFLIGHT_META.set(job.key, { key: job.key, path: job.path, priority: job.priority });
    });
    axios
      .post(`${API_BASE_URL}/api/sound-effects/waveforms/batch`, {
        paths: batch.map((job) => job.path),
        samples: seed.samples,
      }, {
        signal: controller.signal,
      })
      .then((res) => {
        const waveforms = res.data?.waveforms || {};
        batch.forEach((job) => {
          const payload = waveforms[job.path] || {};
          const data = payload?.data;
          if (Array.isArray(data) && data.length > 0) {
            WAVEFORM_JOB_STATE.delete(job.key);
          } else if (payload?.error || payload?.fallback || payload?.status === 'error') {
            WAVEFORM_JOB_STATE.set(job.key, 'failed');
          } else {
            WAVEFORM_JOB_STATE.delete(job.key);
          }
          job.resolve(payload);
        });
        emitWaveformProgress();
      })
      .catch((error) => {
        batch.forEach((job) => {
          if (error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED') {
            WAVEFORM_JOB_STATE.delete(job.key);
          } else {
            WAVEFORM_JOB_STATE.set(job.key, 'failed');
          }
          job.reject(error);
        });
        emitWaveformProgress();
      })
      .finally(() => {
        batch.forEach((job) => {
          WAVEFORM_INFLIGHT_CONTROLLERS.delete(job.key);
          WAVEFORM_INFLIGHT_META.delete(job.key);
        });
        WAVEFORM_ACTIVE -= 1;
        emitWaveformProgress();
        pumpWaveformQueue();
      });
  }
}

function fetchWaveformQueued(path, samples, options = {}) {
  const key = getWaveformCacheKey(path, samples);
  const inflight = WAVEFORM_INFLIGHT.get(key);
  const priority = Number.isFinite(options.priority) ? Number(options.priority) : WAVEFORM_PRIORITY_VIEW;
  if (inflight) {
    const queuedJob = WAVEFORM_QUEUED_JOBS.get(key);
    if (queuedJob && priority < queuedJob.priority) {
      queuedJob.priority = priority;
      sortWaveformQueue();
      emitWaveformProgress();
    }
    return inflight;
  }
  const p = new Promise((resolve, reject) => {
    const job = {
      key,
      path,
      samples,
      priority,
      sequence: WAVEFORM_JOB_SEQUENCE += 1,
      resolve,
      reject,
    };
    WAVEFORM_JOB_STATE.set(key, 'queued');
    WAVEFORM_QUEUED_JOBS.set(key, job);
    WAVEFORM_QUEUE.push(job);
    sortWaveformQueue();
    emitWaveformProgress();
    pumpWaveformQueue();
  }).finally(() => {
    WAVEFORM_INFLIGHT.delete(key);
    emitWaveformProgress();
  });
  WAVEFORM_INFLIGHT.set(key, p);
  emitWaveformProgress();
  return p;
}

function loadSfxCache(expectedLibrary) {
  try {
    const raw = sessionStorage.getItem(SFX_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (expectedLibrary && parsed.library !== expectedLibrary) return null;
    return parsed;
  } catch {
    return null;
  }
}

function buildFolderIndexIds(assets, libraryPath) {
  const index = {};
  (assets || []).forEach((a) => {
    const id = a?.id;
    const rel = String(a?.relativePath || '');
    if (!id || !rel) return;
    const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
    const folders = parts.slice(0, Math.max(0, parts.length - 1));
    let acc = String(libraryPath || '').replace(/\/+$/, '');
    folders.forEach((folder) => {
      acc = `${acc}/${folder}`;
      if (!index[acc]) index[acc] = [];
      index[acc].push(id);
    });
  });
  return index;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function hashHue(input) {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

function tagColor(tag) {
  const hue = hashHue(tag);
  return `hsl(${hue} 78% 62%)`;
}

function formatLastUsed(days) {
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days}天前`;
  if (days === 7) return '1周前';
  return `${Math.floor(days / 7)}周前`;
}

function formatTime(seconds) {
  const s = Number.isFinite(seconds) ? seconds : 0;
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function getPlaybackRange(duration, inPoint, outPoint) {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const hasIn = typeof inPoint === 'number' && Number.isFinite(inPoint);
  const hasOut = typeof outPoint === 'number' && Number.isFinite(outPoint);
  if (!hasIn && !hasOut) return null;
  const start = hasIn ? clamp(inPoint, 0, duration) : 0;
  const end = hasOut ? clamp(outPoint, 0, duration) : duration;
  if (end <= start) return null;
  return { start, end };
}

function parseDurationLabel(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const parts = text.split(':').map((item) => Number(item));
  if (parts.length < 2 || parts.some((item) => !Number.isFinite(item) || item < 0)) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function getAssetDurationSeconds(asset, fallback = 0) {
  const numeric = Number(asset?.duration_seconds);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = parseDurationLabel(asset?.duration);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  if (Number.isFinite(fallback) && fallback > 0) return fallback;
  return 0;
}

function toFileUrl(filePath) {
  const p = String(filePath || '');
  if (!p) return '';
  if (p.startsWith('file://')) return p;
  return `file://${encodeURI(p)}`;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getPlayableSrc(filePath) {
  try {
    return convertFileSrc(filePath);
  } catch {
    return toFileUrl(filePath);
  }
}

function WaveformSVG({ data, width, height }) {
  const clipId = useMemo(() => `clip-${Math.random().toString(36).substring(2, 9)}`, []);

  const pathData = useMemo(() => {
    if (!data || data.length === 0) return '';
    const mid = height / 2;
    const bars = Math.floor(data.length / 2);
    let d = '';
    for (let i = 0; i < bars; i++) {
      const min = clamp(data[i * 2], -1, 1);
      const max = clamp(data[i * 2 + 1], -1, 1);
      const x = ((i / (bars - 1 || 1)) * width).toFixed(1);
      const barW = Math.max(width / bars - 0.5, 0.5).toFixed(1);
      const yTop = (mid - max * mid).toFixed(1);
      const yBot = (mid - min * mid).toFixed(1);
      const barH = Math.max(yBot - yTop, 1).toFixed(1);
      d += `M${x},${yTop} h${barW} v${barH} h-${barW} Z `;
    }
    return d;
  }, [data, width, height]);

  return (
    <svg width={width} height={height} style={{ display: 'block', borderRadius: 6 }}>
      <line x1={0} y1={height / 2 - 0.5} x2={width} y2={height / 2 - 0.5} stroke="var(--mac-border)" strokeWidth={1} />
      <path d={pathData} fill="var(--sfx-waveform-fill)" />
    </svg>
  );
}

function SfxWaveform({ path, width, height, progress, className, onSeek, onPreviewSeek, onHoverPosition, onClearRange, priority, duration, inPoint, outPoint, onSetInOut, samples }) {
  const [wave, setWave] = useState(null);
  const [error, setError] = useState('');
  const [resolvedDuration, setResolvedDuration] = useState(Number.isFinite(duration) && duration > 0 ? duration : 0);
  const [cursorMode, setCursorMode] = useState('default');
  const wrapperRef = useRef(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const dragRef = useRef(null);
  const rafRef = useRef(null);
  const pendingPctRef = useRef(null);
  const hoverRef = useRef(null);
  const playheadRef = useRef(null);
  const rangeRef = useRef(null);
  const rangeLeftRef = useRef(null);
  const [hoverVisible, setHoverVisible] = useState(false);
  const [isVisible, setIsVisible] = useState(!!priority);
  const retryRef = useRef(0);
  const [retrySeq, setRetrySeq] = useState(0);
  const wrapperClassName = className || 'sfx-wave-mini';
  const renderWidth = typeof width === 'number' && Number.isFinite(width) ? width : measuredWidth;

  useEffect(() => {
    const updateTheme = () => {
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    };
    updateTheme();
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    mql.addEventListener('change', updateTheme);
    return () => mql.removeEventListener('change', updateTheme);
  }, []);

  useEffect(() => {
    if (typeof width === 'number' && Number.isFinite(width)) return () => {};
    const el = wrapperRef.current;
    if (!el) return () => {};
    const ro = new ResizeObserver((entries) => {
      const rect = entries?.[0]?.contentRect;
      if (!rect) return;
      setMeasuredWidth(Math.floor(rect.width));
    });
    ro.observe(el);
    setMeasuredWidth(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, [width]);

  useEffect(() => {
    let mounted = true;
    setError('');
    setResolvedDuration(() => {
      const next = Number(duration);
      return Number.isFinite(next) && next > 0 ? next : 0;
    });
    if (!path) {
      setWave(null);
      return () => {};
    }
    if (!isVisible) return () => {};
    if (!renderWidth || renderWidth <= 0) return () => {};

    const defaultSamples = height >= 120 ? 320 : height <= 44 ? 160 : 240;
    const normalizedSamples = clamp(Number(samples) || defaultSamples, 80, 320);
    const cacheKey = getWaveformCacheKey(path, normalizedSamples);
    const cached = WAVEFORM_MEMORY_CACHE.get(cacheKey);
    const cachedData = Array.isArray(cached) ? cached : cached?.data;
    const cachedDuration = Array.isArray(cached) ? 0 : Number(cached?.duration || 0);

    const delayMs = priority ? 0 : 120;
    const timer = window.setTimeout(async () => {
      try {
        const persisted = await safeLoadPersistedWaveformData(cacheKey);
        if (!mounted) return;
        const persistedData = Array.isArray(persisted?.data) ? persisted.data : null;
        if (persistedData && persistedData.length > 0) {
          markWaveformReady(cacheKey);
          retryRef.current = 0;
          setWave(persistedData);
          if (Number(persisted?.duration) > 0) setResolvedDuration((prev) => (prev > 0 ? prev : Number(persisted.duration)));
          return;
        }
        if (Array.isArray(cachedData) && cachedData.length > 0) {
          markWaveformReady(cacheKey);
          void persistWaveformData(cacheKey, cached);
          retryRef.current = 0;
          setWave(cachedData);
          if (cachedDuration > 0) {
            setResolvedDuration(cachedDuration);
            return;
          }
          if (Number(duration) > 0) {
            return;
          }
        }
        let payload = null;
        try {
          payload = await fetchWaveformQueued(path, normalizedSamples, {
            priority: priority ? WAVEFORM_PRIORITY_ACTIVE : WAVEFORM_PRIORITY_VIEW,
          });
        } catch {
          if (!mounted) return;
          setWave(null);
          setError('waveform_failed');
          return;
        }
        if (!mounted) return;
        const data = payload?.data;
        if (Array.isArray(data) && data.length > 0) {
          if (priority) {
            cacheWaveformData(cacheKey, payload);
          } else {
            markWaveformReady(cacheKey);
          }
          void persistWaveformData(cacheKey, payload);
          retryRef.current = 0;
          setWave(data);
          if (Number(payload?.duration) > 0) setResolvedDuration((prev) => (prev > 0 ? prev : Number(payload.duration)));
        } else {
          setWave(null);
        }
        if (payload?.error) setError(String(payload.error));
        if ((payload?.fallback || payload?.error) && (!Array.isArray(data) || data.length === 0) && retryRef.current < 2) {
          const n = retryRef.current + 1;
          retryRef.current = n;
          window.setTimeout(() => {
            if (!mounted) return;
            setRetrySeq((v) => v + 1);
          }, 900 * n);
        }
      } catch {
        if (!mounted) return;
        setWave(null);
        setError('waveform_failed');
      }
    }, delayMs);

    return () => {
      mounted = false;
      window.clearTimeout(timer);
    };
  }, [path, renderWidth, priority, isVisible, height, samples, retrySeq]);

  useEffect(() => {
    if (priority) {
      setIsVisible(true);
      return () => {};
    }
    const el = wrapperRef.current;
    if (!el || isVisible) return () => {};
    
    el._onVisible = () => setIsVisible(true);
    const observer = getSharedWaveformObserver();
    observer.observe(el);
    
    return () => {
      observer.unobserve(el);
      delete el._onVisible;
    };
  }, [priority, isVisible]);

  const getPctFromEvent = (e) => {
    const el = wrapperRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (!rect.width) return 0;
    return clamp((e.clientX - rect.left) / rect.width, 0, 1);
  };

  const effectiveDuration = Number.isFinite(duration) && duration > 0 ? duration : resolvedDuration;

  const edgeThresholdPct = useMemo(
    () => Math.max(8 / Math.max(renderWidth || 1, 1), 0.02),
    [renderWidth]
  );

  const normalizedRange = useMemo(() => {
    if (!Number.isFinite(effectiveDuration) || effectiveDuration <= 0) return null;
    const hasIn = typeof inPoint === 'number' && Number.isFinite(inPoint);
    const hasOut = typeof outPoint === 'number' && Number.isFinite(outPoint);
    if (!hasIn && !hasOut) return null;
    const from = hasIn ? clamp(inPoint / effectiveDuration, 0, 1) : 0;
    const to = hasOut ? clamp(outPoint / effectiveDuration, 0, 1) : 1;
    if (to <= from) return null;
    return { from, to };
  }, [effectiveDuration, inPoint, outPoint]);

  const getRangeHitMode = useCallback((pct) => {
    if (!normalizedRange) return 'outside';
    const hitLeft = Math.abs(pct - normalizedRange.from) <= edgeThresholdPct;
    const hitRight = Math.abs(pct - normalizedRange.to) <= edgeThresholdPct;
    if (hitLeft) return 'resize-start';
    if (hitRight) return 'resize-end';
    if (pct > normalizedRange.from && pct < normalizedRange.to) return 'inside';
    return 'outside';
  }, [edgeThresholdPct, normalizedRange]);

  const canInteract = !!onSeek || !!onPreviewSeek || (!!onSetInOut && Number.isFinite(effectiveDuration) && effectiveDuration > 0);
  const cursorStyle = canInteract
    ? {
      cursor: cursorMode === 'resize-start' || cursorMode === 'resize-end'
        ? 'ew-resize'
        : cursorMode === 'inside'
          ? 'default'
          : onSetInOut
            ? 'crosshair'
            : 'pointer'
    }
    : undefined;

  const applyHoverPct = useCallback((pct) => {
    const el = hoverRef.current;
    if (!el) return;
    el.style.left = `${clamp(pct, 0, 1) * 100}%`;
  }, []);

  const applyPlayheadPct = useCallback((pct) => {
    const el = playheadRef.current;
    if (!el) return;
    el.style.left = `${clamp(pct, 0, 1) * 100}%`;
  }, []);

  const applyRange = useCallback((from, to) => {
    const el = rangeRef.current;
    if (!el) return;
    const a = clamp(from, 0, 1);
    const b = clamp(to, 0, 1);
    const left = Math.min(a, b);
    const right = Math.max(a, b);
    const widthPct = Math.max(0, right - left) * 100;
    el.style.left = `${left * 100}%`;
    el.style.width = `${widthPct}%`;
    el.style.display = 'block';
  }, []);

  const hideRange = useCallback(() => {
    const el = rangeRef.current;
    if (!el) return;
    el.style.display = 'none';
  }, []);

  useEffect(() => {
    if (!Number.isFinite(progress)) return;
    applyPlayheadPct(progress);
  }, [progress, applyPlayheadPct]);

  useEffect(() => {
    if (dragRef.current?.active) return;
    if (!normalizedRange) {
      hideRange();
      return;
    }
    applyRange(normalizedRange.from, normalizedRange.to);
  }, [normalizedRange, applyRange, hideRange]);

  useEffect(() => {
    if (hoverVisible) return;
    const el = hoverRef.current;
    if (!el) return;
    el.style.left = '0%';
  }, [hoverVisible]);

  const scheduleMove = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const pct = pendingPctRef.current;
      if (typeof pct !== 'number') return;
      applyHoverPct(pct);
      if (dragRef.current?.active) {
        const drag = dragRef.current;
        if (drag.mode === 'create') {
          applyRange(drag.start, pct);
        } else if (drag.mode === 'resize-start') {
          applyRange(pct, drag.end);
        } else if (drag.mode === 'resize-end') {
          applyRange(drag.start, pct);
        } else if (drag.mode === 'locked-range') {
          applyRange(drag.start, drag.end);
        }
      }
    });
  }, [applyHoverPct, applyRange]);

  useEffect(() => {
    return () => {
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <div
      ref={wrapperRef}
      className={wrapperClassName}
      title={error ? `波形不可用：${error}` : ''}
      style={{ ...cursorStyle, height }}
      onPointerMove={(e) => {
        if (!canInteract) return;
        e.stopPropagation();
        const pct = getPctFromEvent(e);
        pendingPctRef.current = pct;
        onHoverPosition?.(pct, effectiveDuration);
        setCursorMode(getRangeHitMode(pct));
        scheduleMove();
      }}
      onPointerLeave={() => {
        if (dragRef.current?.active) return;
        setCursorMode('default');
        setHoverVisible(false);
      }}
      onPointerEnter={(e) => {
        if (!canInteract) return;
        e.stopPropagation();
        setCursorMode(getRangeHitMode(pendingPctRef.current ?? 0));
        onHoverPosition?.(pendingPctRef.current ?? 0, effectiveDuration);
        setHoverVisible(true);
      }}
      onPointerDown={(e) => {
        if (!canInteract) return;
        if (typeof e.button === 'number' && e.button !== 0) return;
        e.stopPropagation();
        const pct = getPctFromEvent(e);
        pendingPctRef.current = pct;
        onHoverPosition?.(pct, effectiveDuration);
        setHoverVisible(true);
        applyHoverPct(pct);
        if (onSetInOut && Number.isFinite(effectiveDuration) && effectiveDuration > 0) {
          const hitMode = getRangeHitMode(pct);
          if (normalizedRange) {
            if (hitMode === 'resize-start') {
              dragRef.current = { active: true, mode: 'resize-start', start: normalizedRange.from, end: normalizedRange.to };
              applyRange(normalizedRange.from, normalizedRange.to);
              e.currentTarget.setPointerCapture?.(e.pointerId);
              e.preventDefault();
              return;
            }
            if (hitMode === 'resize-end') {
              dragRef.current = { active: true, mode: 'resize-end', start: normalizedRange.from, end: normalizedRange.to };
              applyRange(normalizedRange.from, normalizedRange.to);
              e.currentTarget.setPointerCapture?.(e.pointerId);
              e.preventDefault();
              return;
            }
            if (hitMode === 'inside') {
              dragRef.current = { active: true, mode: 'locked-range', start: normalizedRange.from, end: normalizedRange.to };
              applyRange(normalizedRange.from, normalizedRange.to);
              e.currentTarget.setPointerCapture?.(e.pointerId);
              e.preventDefault();
              return;
            }
          }
          dragRef.current = { active: true, mode: 'create', start: pct, end: pct };
          e.currentTarget.setPointerCapture?.(e.pointerId);
          e.preventDefault();
          return;
        }
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        if (!dragRef.current?.active) return;
        const pct = getPctFromEvent(e);
        const drag = dragRef.current;
        dragRef.current = null;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        if (drag.mode === 'locked-range') {
          applyRange(drag.start, drag.end);
          return;
        }
        const from = drag.mode === 'resize-start' ? Math.min(pct, drag.end) : Math.min(drag.start, pct);
        const to = drag.mode === 'resize-end' ? Math.max(drag.start, pct) : Math.max(drag.mode === 'resize-start' ? drag.end : drag.start, pct);
        const moveThresholdPct = Math.max(8 / Math.max(renderWidth || 1, 1), 0.02);
        const moved = Math.abs(pct - drag.start) >= moveThresholdPct;
        if (!moved) {
          if (normalizedRange) {
            applyRange(normalizedRange.from, normalizedRange.to);
            return;
          }
          hideRange();
          return;
        }
        if (!onSetInOut || !Number.isFinite(effectiveDuration) || effectiveDuration <= 0) return;
        onSetInOut(from * effectiveDuration, to * effectiveDuration);
      }}
      onPointerCancel={() => {
        dragRef.current = null;
        hideRange();
      }}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        if (dragRef.current?.active) return;
        if (!onPreviewSeek) return;
        const pct = getPctFromEvent(e);
        if (normalizedRange && getRangeHitMode(pct) !== 'outside') return;
        pendingPctRef.current = pct;
        onHoverPosition?.(pct, effectiveDuration);
        setHoverVisible(true);
        applyHoverPct(pct);
        onPreviewSeek(pct);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        if (!onSeek) return;
        const pct = getPctFromEvent(e);
        pendingPctRef.current = pct;
        onHoverPosition?.(pct, effectiveDuration);
        setHoverVisible(true);
        applyHoverPct(pct);
        onSeek(pct);
      }}
      onDragStart={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onContextMenu={(e) => {
        if (!normalizedRange || !onClearRange) return;
        e.preventDefault();
        e.stopPropagation();
        onClearRange();
      }}
    >
      {wave ? <WaveformSVG data={wave} width={renderWidth} height={height} /> : null}
      <div className="sfx-wave-overlay">
        <div className="sfx-wave-range" ref={rangeRef} style={{ display: 'none' }}>
          <div className="sfx-wave-range-edge left" ref={rangeLeftRef} />
          <div className="sfx-wave-range-edge right" />
        </div>
        <div className="sfx-wave-playhead" ref={playheadRef} />
        <div className="sfx-wave-hover" ref={hoverRef} style={{ display: hoverVisible ? 'block' : 'none' }} />
      </div>
    </div>
  );
}

function loadSmartFolders() {
  try {
    const raw = localStorage.getItem(SMART_FOLDERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function saveSmartFolders(list) {
  localStorage.setItem(SMART_FOLDERS_STORAGE_KEY, JSON.stringify(list));
}

function buildFolderTree(assets) {
  const root = { id: 'root', name: 'root', fullPath: '', children: new Map(), count: 0 };

  const ensureChild = (parent, name, fullPath) => {
    if (!parent.children.has(fullPath)) {
      parent.children.set(fullPath, { id: fullPath, name, fullPath, children: new Map(), count: 0 });
    }
    return parent.children.get(fullPath);
  };

  assets.forEach((a) => {
    const lib = a.libraryPath || '';
    const libNode = ensureChild(root, lib.split('/').filter(Boolean).slice(-1)[0] || lib || 'Library', lib);
    libNode.count += 1;

    const rel = (a.path || '').startsWith(lib) ? (a.path || '').slice(lib.length) : a.path || '';
    const clean = rel.replace(/^\/+/, '');
    const parts = clean.split('/').filter(Boolean);
    const folders = parts.slice(0, Math.max(0, parts.length - 1));

    let cursor = libNode;
    let acc = lib;
    folders.forEach((p) => {
      acc = `${acc}/${p}`;
      cursor = ensureChild(cursor, p, acc);
      cursor.count += 1;
    });
  });

  const toArray = (node) => {
    const children = Array.from(node.children.values())
      .map((c) => toArray(c))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { ...node, children };
  };

  return toArray(root).children;
}

function applySmartFolderRules(assets, def) {
  if (!def) return assets;
  const rules = def.rules || {};
  return assets.filter((a) => {
    if (rules.favoriteOnly && !a.favorite) return false;
    if (rules.untaggedOnly && (a.tags || []).length > 0) return false;
    if (typeof rules.usedCountMin === 'number' && a.usedCount < rules.usedCountMin) return false;
    if (typeof rules.lastUsedWithinDays === 'number' && a.lastUsedDays > rules.lastUsedWithinDays) return false;
    if (Array.isArray(rules.tagsAny) && rules.tagsAny.length > 0) {
      const set = new Set((a.tags || []).map((t) => t.toLowerCase()));
      if (!rules.tagsAny.some((t) => set.has(String(t).toLowerCase()))) return false;
    }
    if (typeof rules.query === 'string' && rules.query.trim()) {
      const q = rules.query.trim().toLowerCase();
      const inName = (a.name || '').toLowerCase().includes(q);
      const inPath = (a.path || '').toLowerCase().includes(q);
      const inTags = (a.tags || []).some((t) => t.toLowerCase().includes(q));
      if (!inName && !inPath && !inTags) return false;
    }
    return true;
  });
}

function normalizeBackendFolderTree(tree) {
  if (!Array.isArray(tree)) return [];
  const walk = (n) => ({
    id: n.path,
    name: n.name,
    fullPath: n.path,
    count: n.total_audio_count || 0,
    children: Array.isArray(n.children) ? n.children.map(walk) : []
  });
  return tree.map(walk);
}

function SfxSmartFolderModal({ open, initialName, onClose, onCreate }) {
  const [name, setName] = useState(initialName || '');
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [untaggedOnly, setUntaggedOnly] = useState(false);
  const [usedCountMin, setUsedCountMin] = useState(0);
  const [lastUsedWithinDays, setLastUsedWithinDays] = useState(7);

  useEffect(() => {
    if (open) {
      setName(initialName || '');
      setQuery('');
      setTag('');
      setFavoriteOnly(false);
      setUntaggedOnly(false);
      setUsedCountMin(0);
      setLastUsedWithinDays(7);
    }
  }, [open, initialName]);

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        className="sfx-modal-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onMouseDown={onClose}
      >
        <motion.div
          className="sfx-modal"
          initial={{ opacity: 0, y: 10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.98 }}
          transition={{ type: 'spring', stiffness: 900, damping: 40, mass: 0.7 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="sfx-modal-title">新建智能文件夹</div>
          <div className="sfx-modal-desc">保存一组筛选条件，随时一键进入相同视图。</div>

          <div className="sfx-form">
            <div className="sfx-form-row">
              <div className="sfx-form-label">名称</div>
              <input className="sfx-form-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：高频 Whoosh" />
            </div>
            <div className="sfx-form-row">
              <div className="sfx-form-label">关键词</div>
              <input className="sfx-form-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="匹配文件名/路径/标签" />
            </div>
            <div className="sfx-form-row">
              <div className="sfx-form-label">包含标签</div>
              <input className="sfx-form-input" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="例如：whoosh（可留空）" />
            </div>
            <div className="sfx-form-row">
              <div className="sfx-form-label">使用次数 ≥</div>
              <input
                className="sfx-form-input"
                type="number"
                value={usedCountMin}
                onChange={(e) => setUsedCountMin(clamp(Number(e.target.value || 0), 0, 9999))}
              />
            </div>
            <div className="sfx-form-row">
              <div className="sfx-form-label">最近使用（天）≤</div>
              <input
                className="sfx-form-input"
                type="number"
                value={lastUsedWithinDays}
                onChange={(e) => setLastUsedWithinDays(clamp(Number(e.target.value || 0), 0, 3650))}
              />
            </div>
            <div className="sfx-form-row">
              <label className="sfx-toggle">
                <input type="checkbox" checked={favoriteOnly} onChange={(e) => setFavoriteOnly(e.target.checked)} />
                <span>仅收藏</span>
              </label>
              <label className="sfx-toggle">
                <input type="checkbox" checked={untaggedOnly} onChange={(e) => setUntaggedOnly(e.target.checked)} />
                <span>仅未打标签</span>
              </label>
            </div>
          </div>

          <div className="sfx-modal-actions">
            <button className="sfx-secondary-btn" type="button" onClick={onClose}>
              取消
            </button>
            <button
              className="sfx-primary-btn"
              type="button"
              onClick={() => {
                const trimmed = name.trim();
                if (!trimmed) return;
                onCreate({
                  name: trimmed,
                  rules: {
                    query: query.trim() || '',
                    tagsAny: tag.trim() ? [tag.trim()] : [],
                    favoriteOnly,
                    untaggedOnly,
                    usedCountMin: usedCountMin || 0,
                    lastUsedWithinDays
                  }
                });
              }}
            >
              创建
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function SfxAssetBrowser({ forcedTag, smartFolderDef, selectedFolder, folderIndex, assets, query, detailOpen, columns, gridWaveHeight, showGridWaveform, favoriteOverrides, sortMode, filterFavoriteOnly, filterUntaggedOnly, onColumnsCapChange, inPoint, outPoint, onSetInOutRange, onClearInOutRange, onSelectedAssetChange, onToggleFavorite, onAddTag, onRemoveTag, loading, onPrepareImport, activeImport, onTogglePlay, onDragToResolve, onInsertToTimeline, playingAssetId, isPlaying, playerTime, playerDuration, onSeek, onPreviewSeek, onHoverPosition, selectedFolderPathsForBulk, onBulkAddTag, onBulkRemoveTag, onCollectSelected, onClearFolderSelection, serverFiltered = false, totalCount = null, loadedCount = 0, hasMore = false, onRequestNextPage = null, scrollResetKey = '' }) {
  const [selectedId, setSelectedId] = useState(assets[0]?.id || null);
  const [tagInput, setTagInput] = useState('');
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkTagInput, setBulkTagInput] = useState('');
  const [anchorIndex, setAnchorIndex] = useState(null);
  const assetsGridRef = useRef(null);
  const assetsScrollRef = useRef(null);
  const [gridWidth, setGridWidth] = useState(0);
  const assetById = useMemo(() => {
    const m = new Map();
    (assets || []).forEach((a) => {
      if (a?.id) m.set(a.id, a);
    });
    return m;
  }, [assets]);

  const scopeAssets = useMemo(() => {
    if (serverFiltered) return assets || [];
    let scoped = assets;
    if (selectedFolder) {
      const ids = folderIndex?.[selectedFolder] || [];
      scoped = ids.map((id) => assetById.get(id)).filter(Boolean);
    }
    if (forcedTag) {
      const tag = String(forcedTag).toLowerCase();
      scoped = scoped.filter((a) => (a.tags || []).some((t) => t.toLowerCase() === tag));
    }
    if (smartFolderDef) scoped = applySmartFolderRules(scoped, smartFolderDef);
    return scoped;
  }, [assets, forcedTag, smartFolderDef, selectedFolder, folderIndex, assetById, serverFiltered]);

  const getFavorite = useCallback((a) => {
    if (!a) return false;
    if (favoriteOverrides instanceof Map && favoriteOverrides.has(a.id)) return !!favoriteOverrides.get(a.id);
    return !!a.favorite;
  }, [favoriteOverrides]);

  const filtered = useMemo(() => {
    if (serverFiltered) return Array.from(scopeAssets || []);
    const q = String(query || '').trim().toLowerCase();
    let assets = scopeAssets;
    if (filterFavoriteOnly) assets = assets.filter((a) => getFavorite(a));
    if (filterUntaggedOnly) assets = assets.filter((a) => (a.tags || []).length === 0);
    if (q) {
      assets = assets.filter((a) => {
        if ((a.name || '').toLowerCase().includes(q)) return true;
        if ((a.path || '').toLowerCase().includes(q)) return true;
        return (a.tags || []).some((t) => t.toLowerCase().includes(q));
      });
    }
    const list = Array.from(assets || []);
    const mode = String(sortMode || 'name_asc');
    const dir = mode.endsWith('_desc') ? -1 : 1;
    const key = mode.replace(/_(asc|desc)$/, '');
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    list.sort((a, b) => {
      if (key === 'used') return (num(a.usedCount) - num(b.usedCount)) * dir;
      if (key === 'recent') return (num(a.lastUsedDays) - num(b.lastUsedDays)) * dir;
      if (key === 'name') return String(a.name || '').localeCompare(String(b.name || '')) * dir;
      return String(a.name || '').localeCompare(String(b.name || '')) * dir;
    });
    return list;
  }, [query, scopeAssets, filterFavoriteOnly, filterUntaggedOnly, sortMode, getFavorite, serverFiltered]);

  const selected = useMemo(() => filtered.find((a) => a.id === selectedId) || filtered[0] || null, [filtered, selectedId]);

  const selectedItems = useMemo(() => {
    return (filtered || []).filter((a) => selectedIds.has(a.id));
  }, [filtered, selectedIds]);
  const selectedDuration = useMemo(() => {
    const value = getAssetDurationSeconds(selected);
    if (value > 0) return value;
    if (selected?.id && selected.id === playingAssetId && Number.isFinite(playerDuration) && playerDuration > 0) return playerDuration;
    return 0;
  }, [selected, playingAssetId, playerDuration]);

  const allSelectedTags = useMemo(() => {
    const m = new Map();
    selectedItems.forEach((item) => {
      (item.tags || []).forEach((t) => {
        const key = String(t).toLowerCase();
        const entry = m.get(key);
        if (entry) {
          entry.count += 1;
        } else {
          m.set(key, { tag: t, count: 1 });
        }
      });
    });
    return Array.from(m.values()).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }, [selectedItems]);
  const effectiveColumns = useMemo(() => {
    const desired = clamp(Number(columns) || 3, 1, 6);
    if (!gridWidth || gridWidth <= 0) return desired;
    const minCard = 260;
    const maxByWidth = clamp(Math.floor(gridWidth / minCard), 1, 6);
    return Math.min(desired, maxByWidth);
  }, [columns, gridWidth]);

  useEffect(() => {
    const desired = clamp(Number(columns) || 3, 1, 6);
    if (!gridWidth || gridWidth <= 0) {
      onColumnsCapChange?.(desired);
      return;
    }
    const minCard = 260;
    const maxByWidth = clamp(Math.floor(gridWidth / minCard), 1, 6);
    onColumnsCapChange?.(maxByWidth);
  }, [columns, gridWidth, onColumnsCapChange]);

  useEffect(() => {
    const el = assetsGridRef.current;
    if (!el) return () => {};
    const ro = new ResizeObserver((entries) => {
      const rect = entries?.[0]?.contentRect;
      if (!rect) return;
      setGridWidth(Math.floor(rect.width));
    });
    ro.observe(el);
    setGridWidth(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    onSelectedAssetChange?.(selected);
  }, [selected?.id, onSelectedAssetChange]);

  useEffect(() => {
    if (selected?.id && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  useEffect(() => {
    setSelectedIds((prev) => {
      const alive = new Set(filtered.map((a) => a.id));
      const next = new Set();
      prev.forEach((id) => {
        if (alive.has(id)) next.add(id);
      });
      if (next.size > 0) return next;
      return prev;
    });
  }, [filtered]);

  useEffect(() => {
    setTagInput('');
  }, [selected?.id]);

  useEffect(() => {
    const el = assetsScrollRef.current;
    if (!el) return;
    el.scrollTop = 0;
  }, [scrollResetKey]);

  const maybeLoadNextPage = useCallback(() => {
    const el = assetsScrollRef.current;
    if (!el || loading || !hasMore || typeof onRequestNextPage !== 'function') return;
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining <= 720) {
      onRequestNextPage();
    }
  }, [hasMore, loading, onRequestNextPage]);

  useEffect(() => {
    if (!loading) {
      maybeLoadNextPage();
    }
  }, [filtered.length, hasMore, loading, maybeLoadNextPage]);

  const currentPlayer = selected || assets.find((a) => a.id === playingAssetId) || null;
  const currentPlayerDuration = useMemo(() => {
    if (currentPlayer?.id && currentPlayer.id === playingAssetId && Number.isFinite(playerDuration) && playerDuration > 0) return playerDuration;
    const value = getAssetDurationSeconds(currentPlayer);
    if (value > 0) return value;
    return Number.isFinite(playerDuration) && playerDuration > 0 ? playerDuration : 0;
  }, [currentPlayer, playingAssetId, playerDuration]);
  const currentProgress = useMemo(() => {
    if (!Number.isFinite(currentPlayerDuration) || currentPlayerDuration <= 0) return 0;
    return clamp(playerTime / currentPlayerDuration, 0, 1);
  }, [playerTime, currentPlayerDuration]);

  return (
    <div className="page-panel sfx-page">
      <div className="sfx-body">
        <div className="sfx-list">
          <div className="sfx-list-header">
            <div className="sfx-list-meta">{loading ? '正在扫描…' : `${(typeof totalCount === 'number' ? totalCount : filtered.length).toLocaleString()} 个音效`}</div>
            <div className="sfx-list-actions">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {selectedIds.size > 0 || (selectedFolderPathsForBulk?.length || 0) > 0 ? (
                  <>
                    <div style={{ fontSize: 12, color: 'var(--mac-text-secondary)' }}>
                      已选 {selectedIds.size}
                      {(selectedFolderPathsForBulk?.length || 0) > 0 ? ` + 文件夹${selectedFolderPathsForBulk.length}` : ''}
                    </div>
                    <input
                      className="sfx-form-input"
                      value={bulkTagInput}
                      onChange={(e) => setBulkTagInput(e.target.value)}
                      placeholder="批量添加标签（回车）"
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return;
                        e.preventDefault();
                        const v = bulkTagInput.trim();
                        if (!v) return;
                        onBulkAddTag?.(v, Array.from(selectedIds));
                        setBulkTagInput('');
                      }}
                      style={{ width: 220 }}
                    />
                    <button
                      className="sfx-secondary-btn"
                      type="button"
                      onClick={() => {
                        const v = bulkTagInput.trim();
                        if (!v) return;
                        onBulkAddTag?.(v, Array.from(selectedIds));
                        setBulkTagInput('');
                      }}
                    >
                      应用
                    </button>
                    <button
                      className="sfx-secondary-btn"
                      type="button"
                      onClick={() => onCollectSelected?.(Array.from(selectedIds))}
                    >
                      打包到项目
                    </button>
                    <button
                      className="sfx-secondary-btn"
                      type="button"
                      onClick={() => {
                        setSelectedIds(new Set());
                        setAnchorIndex(null);
                        onClearFolderSelection?.();
                      }}
                    >
                      清空选择
                    </button>
                  </>
                ) : (
                  <>
                    {typeof totalCount === 'number' && totalCount > 0 ? (
                      <>
                        <div style={{ fontSize: 12, color: 'var(--mac-text-secondary)' }}>
                          已加载 {(loadedCount || filtered.length).toLocaleString()} / {totalCount.toLocaleString()}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--mac-text-secondary)' }}>
                          {hasMore ? '向下滚动自动加载更多' : '当前范围已全部展示'}
                        </div>
                      </>
                    ) : (
                      <div />
                    )}
                    {filtered.length > 0 && (
                      <button
                        className="sfx-secondary-btn"
                        type="button"
                        onClick={() => {
                          const allIds = new Set(filtered.map((a) => a.id));
                          setSelectedIds(allIds);
                          setAnchorIndex(null);
                        }}
                      >
                        选择全部
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          <div ref={assetsScrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }} onScroll={maybeLoadNextPage}>
            <div
              ref={assetsGridRef}
              className="sfx-assets grid"
              style={{
                gridTemplateColumns: `repeat(${effectiveColumns}, minmax(0, 1fr))`,
                '--sfx-asset-card-height': `${(gridWaveHeight || 76) + 78}px`,
              }}
            >
              {filtered.map((asset, idx) => (
                <div
                  key={asset.id}
                  role="button"
                  tabIndex={0}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    if (e.target?.closest?.('button, input, textarea, select, a')) return;
                    if (selectedId !== asset.id) return;
                    if (!onDragToResolve || activeImport) return;
                    e.preventDefault();
                    e.stopPropagation();
                    onDragToResolve(asset, 'asset_card');
                  }}
                  onClick={(e) => {
                    if (e.shiftKey && typeof anchorIndex === 'number' && anchorIndex >= 0) {
                      const start = Math.min(anchorIndex, idx);
                      const end = Math.max(anchorIndex, idx);
                      const next = new Set();
                      for (let i = start; i <= end; i += 1) next.add(filtered[i].id);
                      setSelectedIds(next);
                      setSelectedId(asset.id);
                    } else if (e.metaKey || e.ctrlKey) {
                      const next = new Set(selectedIds);
                      if (next.has(asset.id)) {
                        next.delete(asset.id);
                        const remaining = Array.from(next);
                        setSelectedId(remaining.length > 0 ? remaining[0] : null);
                      } else {
                        next.add(asset.id);
                        setSelectedId(asset.id);
                      }
                      setSelectedIds(next);
                      setAnchorIndex(idx);
                    } else {
                      setSelectedIds(new Set([asset.id]));
                      setAnchorIndex(idx);
                      setSelectedId(asset.id);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      setSelectedIds(new Set([asset.id]));
                      setAnchorIndex(idx);
                      setSelectedId(asset.id);
                    }
                  }}
                  className={`sfx-asset ${selectedId === asset.id ? 'active' : ''} ${selectedIds.has(asset.id) ? 'selected' : ''}`}
                >
                  <div className="sfx-asset-top">
                    <div className="sfx-asset-name">{asset.name}</div>
                    <div className="sfx-asset-fav" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button
                        className="sfx-icon-btn"
                        type="button"
                        title={isPlaying && playingAssetId === asset.id ? '暂停' : '播放'}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onTogglePlay?.(asset);
                        }}
                        style={{ width: 32, height: 32, opacity: onTogglePlay ? 1 : 0.5 }}
                        disabled={!onTogglePlay}
                      >
                        {isPlaying && playingAssetId === asset.id ? <Pause size={16} /> : <Play size={16} />}
                      </button>
                      <button
                        className="sfx-icon-btn"
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onToggleFavorite(asset.id);
                        }}
                        title={getFavorite(asset) ? '取消收藏' : '收藏'}
                        style={{ width: 32, height: 32 }}
                      >
                        <Star size={16} className={getFavorite(asset) ? 'on' : ''} />
                      </button>
                    </div>
                  </div>
                  {showGridWaveform ? (
                    <SfxWaveform
                      path={asset.path}
                      height={gridWaveHeight || 44}
                      samples={160}
                      progress={selectedId === asset.id && getAssetDurationSeconds(asset) > 0 ? clamp(playerTime / getAssetDurationSeconds(asset), 0, 1) : 0}
                      duration={getAssetDurationSeconds(asset)}
                      inPoint={selectedId === asset.id ? inPoint : null}
                      outPoint={selectedId === asset.id ? outPoint : null}
                      onPreviewSeek={onPreviewSeek ? (pct) => {
                        setSelectedIds(new Set([asset.id]));
                        setAnchorIndex(idx);
                        setSelectedId(asset.id);
                        onPreviewSeek(asset, pct);
                      } : null}
                      onHoverPosition={onHoverPosition ? (pct, effectiveDuration) => onHoverPosition(asset, pct, effectiveDuration) : null}
                      onSeek={onSeek ? (pct) => {
                        setSelectedIds(new Set([asset.id]));
                        setAnchorIndex(idx);
                        setSelectedId(asset.id);
                        onSeek(asset, pct);
                      } : null}
                      onSetInOut={onSetInOutRange ? (a, b) => {
                        setSelectedIds(new Set([asset.id]));
                        setAnchorIndex(idx);
                        setSelectedId(asset.id);
                        onSetInOutRange(asset, a, b);
                      } : null}
                      onClearRange={onClearInOutRange ? () => onClearInOutRange(asset) : null}
                    />
                  ) : null}
                  <div className="sfx-asset-bottom">
                    <div className="sfx-tags">
                      {(asset.tags || []).slice(0, 3).map((t) => (
                        <span key={t} className="sfx-tag" style={{ borderColor: `${tagColor(t)}33`, color: 'var(--mac-text-secondary)' }}>
                          <span className="sfx-tag-dot-mini" style={{ background: tagColor(t) }} />
                          {t}
                        </span>
                      ))}
                    </div>
                    <div className="sfx-asset-right">
                      <span className="sfx-duration">{asset.duration}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {(loading || hasMore) ? (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, padding: '10px 0 2px', fontSize: 12, color: 'var(--mac-text-secondary)' }}>
                {loading ? <Loader2 size={14} className="spin" /> : null}
                <span>{hasMore ? '继续向下滚动，自动加载更多音效' : '正在加载当前列表…'}</span>
              </div>
            ) : null}
          </div>
        </div>

        {detailOpen ? (
        <aside className="sfx-detail">
          {selectedIds.size > 1 ? (
            <>
              <div className="sfx-detail-header">
                <div className="sfx-detail-title">已选 {selectedIds.size} 个音频</div>
              </div>

              <div className="sfx-detail-grid">
                <div className="sfx-kv">
                  <div className="k">选中数量</div>
                  <div className="v">{selectedIds.size}</div>
                </div>
                <div className="sfx-kv">
                  <div className="k">格式分布</div>
                  <div className="v">{(() => {
                    const m = new Map();
                    selectedItems.forEach((a) => {
                      const ext = (a.extension || '').replace('.', '').toUpperCase() || '—';
                      m.set(ext, (m.get(ext) || 0) + 1);
                    });
                    return Array.from(m.entries()).map(([k, v]) => `${k}×${v}`).join(', ');
                  })()}</div>
                </div>
                <div className="sfx-kv">
                  <div className="k">总时长</div>
                  <div className="v">{((items) => {
                    let total = 0;
                    items.forEach((a) => {
                      const d = String(a.duration || '');
                      const parts = d.split(':');
                      if (parts.length === 2) total += Number(parts[0]) * 60 + Number(parts[1]);
                      else if (parts.length === 3) total += Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
                    });
                    if (total <= 0) return '—';
                    const h = Math.floor(total / 3600);
                    const m = Math.floor((total % 3600) / 60);
                    const s = Math.floor(total % 60);
                    return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
                  })(selectedItems)}</div>
                </div>
              </div>

              {allSelectedTags.length > 0 ? (
                <div className="sfx-detail-tags">
                  <div className="sfx-detail-tags-title">标签（{allSelectedTags.length}）</div>
                  <div className="sfx-detail-tags-list">
                    {allSelectedTags.map(({ tag, count }) => (
                      <span key={tag} className="sfx-tag" style={{ borderColor: `${tagColor(tag)}33` }}>
                        <span className="sfx-tag-dot-mini" style={{ background: tagColor(tag) }} />
                        {tag}
                        <span style={{ marginLeft: 2, opacity: 0.5, fontSize: 11 }}>{count}</span>
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={() => onBulkRemoveTag?.(tag, Array.from(selectedIds))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') onBulkRemoveTag?.(tag, Array.from(selectedIds));
                          }}
                          style={{ marginLeft: 4, opacity: 0.7, cursor: 'pointer' }}
                        >
                          ×
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="sfx-detail-tags empty">所选音频均未打标签</div>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="sfx-form-input"
                  value={bulkTagInput}
                  onChange={(e) => setBulkTagInput(e.target.value)}
                  placeholder="批量添加标签（回车）"
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    const v = bulkTagInput.trim();
                    if (!v) return;
                    onBulkAddTag?.(v, Array.from(selectedIds));
                    setBulkTagInput('');
                  }}
                />
                <button
                  className="sfx-secondary-btn"
                  type="button"
                  style={{ width: 88 }}
                  onClick={() => {
                    const v = bulkTagInput.trim();
                    if (!v) return;
                    onBulkAddTag?.(v, Array.from(selectedIds));
                    setBulkTagInput('');
                  }}
                >
                  添加
                </button>
              </div>
            </>
          ) : selected ? (
            <>
              <div
                className="sfx-detail-header"
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  if (e.target?.closest?.('button, input, textarea, select, a')) return;
                  if (!onDragToResolve || activeImport) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onDragToResolve(selected, 'detail_header');
                }}
              >
                <div className="sfx-detail-title">{selected.name}</div>
                <button
                  className="sfx-icon-btn"
                  type="button"
                  onClick={() => onToggleFavorite(selected.id)}
                  title={getFavorite(selected) ? '取消收藏' : '收藏'}
                  style={{ width: 32, height: 32 }}
                >
                  <Star size={16} className={getFavorite(selected) ? 'on' : ''} />
                </button>
              </div>
              <SfxWaveform
                path={selected.path}
                height={140}
                samples={320}
                progress={selectedDuration > 0 ? clamp(playerTime / selectedDuration, 0, 1) : 0}
                className="sfx-detail-wave"
                onSeek={onSeek ? (pct) => onSeek(selected, pct) : null}
                onPreviewSeek={onPreviewSeek ? (pct) => onPreviewSeek(selected, pct) : null}
                onHoverPosition={onHoverPosition ? (pct, effectiveDuration) => onHoverPosition(selected, pct, effectiveDuration) : null}
                priority
                duration={selectedDuration}
                inPoint={inPoint}
                outPoint={outPoint}
                onSetInOut={onSetInOutRange ? (a, b) => onSetInOutRange(selected, a, b) : null}
                onClearRange={onClearInOutRange ? () => onClearInOutRange(selected) : null}
              />
              <div className="sfx-detail-grid">
                <div className="sfx-kv">
                  <div className="k">格式</div>
                  <div className="v">{(selected.extension || '').replace('.', '').toUpperCase() || '—'}</div>
                </div>
                <div className="sfx-kv">
                  <div className="k">采样率</div>
                  <div className="v">{selected.sampleRate ? `${selected.sampleRate} Hz` : '—'}</div>
                </div>
                <div className="sfx-kv">
                  <div className="k">时长</div>
                  <div className="v">{selected.duration || '—'}</div>
                </div>
                <div className="sfx-kv">
                  <div className="k">使用次数</div>
                  <div className="v">{selected.usedCount}</div>
                </div>
                <div className="sfx-kv">
                  <div className="k">最近使用</div>
                  <div className="v">{formatLastUsed(selected.lastUsedDays)}</div>
                </div>
                <div className="sfx-kv">
                  <div className="k">大小</div>
                  <div className="v">{selected.sizeMb != null ? `${selected.sizeMb} MB` : '—'}</div>
                </div>
              </div>

              {(selected.tags || []).length > 0 ? (
                <div className="sfx-detail-tags">
                  <div className="sfx-detail-tags-title">标签</div>
                  <div className="sfx-detail-tags-list">
                    {selected.tags.map((t) => (
                      <span key={t} className="sfx-tag" style={{ borderColor: `${tagColor(t)}33` }}>
                        <span className="sfx-tag-dot-mini" style={{ background: tagColor(t) }} />
                        {t}
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={() => onRemoveTag(selected.id, t)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') onRemoveTag(selected.id, t);
                          }}
                          style={{ marginLeft: 2, opacity: 0.7 }}
                        >
                          ×
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="sfx-detail-tags empty">未打标签</div>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="sfx-form-input"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  placeholder="添加标签（回车）"
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    const v = tagInput.trim();
                    if (!v) return;
                    onAddTag(selected.id, v);
                    setTagInput('');
                  }}
                />
                <button
                  className="sfx-secondary-btn"
                  type="button"
                  style={{ width: 88 }}
                  onClick={() => {
                    const v = tagInput.trim();
                    if (!v) return;
                    onAddTag(selected.id, v);
                    setTagInput('');
                  }}
                >
                  添加
                </button>
              </div>

              <div className="sfx-detail-actions">
                <button
                  className="sfx-secondary-btn"
                  type="button"
                  onClick={() => {
                    invoke('reveal_in_finder', { path: selected.path }).catch(() => {});
                  }}
                >
                  在访达中显示
                </button>
                <button
                  className="sfx-primary-btn"
                  type="button"
                  onClick={() => {
                    if (onInsertToTimeline) onInsertToTimeline(selected);
                  }}
                  disabled={!onInsertToTimeline || !!activeImport}
                >
                  {activeImport ? '请先完成当前导入' : '插入时间线'}
                </button>
              </div>
            </>
          ) : (
            <div className="sfx-empty">请选择一个音效查看详情</div>
          )}
        </aside>
        ) : null}
      </div>

      <div className="sfx-player" style={{ WebkitAppRegion: 'no-drag' }}>
        <div
          className="sfx-player-left"
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            if (!currentPlayer || !onDragToResolve || activeImport) return;
            e.preventDefault();
            e.stopPropagation();
            onDragToResolve(currentPlayer, 'player_panel');
          }}
        >
          <div className="sfx-player-thumb" />
          <div className="sfx-player-now">
            <div className="name">{currentPlayer?.name || '未选择音效'}</div>
            <div className="meta">{formatTime(playerTime)} / {formatTime(currentPlayerDuration)}</div>
          </div>
        </div>
        <div className="sfx-player-mid">
          <button
            className="sfx-icon-btn"
            type="button"
            title={isPlaying ? '暂停' : '播放'}
            onClick={() => {
              if (!currentPlayer) return;
              if (currentPlayer.id !== playingAssetId && currentPlayerDuration > 0 && playerTime > 0) {
                onTogglePlay?.(currentPlayer, clamp(playerTime / currentPlayerDuration, 0, 1));
                return;
              }
              onTogglePlay?.(currentPlayer);
            }}
          >
            {isPlaying ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            {currentPlayer?.path ? (
              <SfxWaveform
                path={currentPlayer.path}
                height={38}
                samples={240}
                progress={currentProgress}
                className="sfx-player-wave"
                onSeek={onSeek ? (pct) => onSeek(currentPlayer, pct) : null}
                onPreviewSeek={onPreviewSeek ? (pct) => onPreviewSeek(currentPlayer, pct) : null}
                onHoverPosition={onHoverPosition ? (pct, effectiveDuration) => onHoverPosition(currentPlayer, pct, effectiveDuration) : null}
                priority
                duration={currentPlayerDuration}
                inPoint={inPoint}
                outPoint={outPoint}
                onSetInOut={onSetInOutRange ? (a, b) => onSetInOutRange(currentPlayer, a, b) : null}
                onClearRange={onClearInOutRange ? () => onClearInOutRange(currentPlayer) : null}
              />
            ) : (
              <div className="sfx-player-wave" />
            )}
          </div>
          <button
            className="sfx-icon-btn"
            type="button"
            title="收藏"
            onClick={() => {
              if (currentPlayer) onToggleFavorite?.(currentPlayer.id);
            }}
          >
            <Star size={16} className={currentPlayer?.favorite ? 'on' : ''} />
          </button>
          <button
            className="sfx-icon-btn"
            type="button"
            title="插入时间线"
            onClick={() => {
              if (currentPlayer?.id) onInsertToTimeline?.(currentPlayer);
            }}
            disabled={!onInsertToTimeline || !!activeImport}
            style={{ opacity: onInsertToTimeline && !activeImport ? 1 : 0.5 }}
          >
            <Plus size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

function SfxNavItem({ icon: Icon, label, active, onClick, rightSlot }) {
  return (
    <div className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>
      <div className="nav-icon">
        <Icon size={16} />
      </div>
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </div>
      {rightSlot ? <div className="sfx-nav-right">{rightSlot}</div> : null}
    </div>
  );
}

function SfxTagRoutePage({ folderIndex, assets, query, detailOpen, columns, gridWaveHeight, showGridWaveform, favoriteOverrides, sortMode, filterFavoriteOnly, filterUntaggedOnly, onColumnsCapChange, inPoint, outPoint, onSetInOutRange, onClearInOutRange, onSelectedAssetChange, onToggleFavorite, onAddTag, onRemoveTag, loading, onPrepareImport, activeImport, onTogglePlay, onDragToResolve, onInsertToTimeline, playingAssetId, isPlaying, playerTime, playerDuration, onSeek, onPreviewSeek, onHoverPosition, selectedFolderPathsForBulk, onBulkAddTag, onBulkRemoveTag, onCollectSelected, onClearFolderSelection, serverFiltered, totalCount, pageOffset, pageSize, onPageChange }) {
  const params = useParams();
  return (
    <SfxAssetBrowser
      forcedTag={params.tag}
      folderIndex={folderIndex}
      assets={assets}
      query={query}
      detailOpen={detailOpen}
      columns={columns}
      gridWaveHeight={gridWaveHeight}
      showGridWaveform={showGridWaveform}
      favoriteOverrides={favoriteOverrides}
      sortMode={sortMode}
      filterFavoriteOnly={filterFavoriteOnly}
      filterUntaggedOnly={filterUntaggedOnly}
      onColumnsCapChange={onColumnsCapChange}
      inPoint={inPoint}
      outPoint={outPoint}
      onSetInOutRange={onSetInOutRange}
      onClearInOutRange={onClearInOutRange}
      onSelectedAssetChange={onSelectedAssetChange}
      onToggleFavorite={onToggleFavorite}
      onAddTag={onAddTag}
      onRemoveTag={onRemoveTag}
      loading={loading}
      onPrepareImport={onPrepareImport}
      activeImport={activeImport}
      onTogglePlay={onTogglePlay}
      onDragToResolve={onDragToResolve}
      onInsertToTimeline={onInsertToTimeline}
      playingAssetId={playingAssetId}
      isPlaying={isPlaying}
      playerTime={playerTime}
      playerDuration={playerDuration}
      onSeek={onSeek}
      onPreviewSeek={onPreviewSeek}
      onHoverPosition={onHoverPosition}
      selectedFolderPathsForBulk={selectedFolderPathsForBulk}
      onBulkAddTag={onBulkAddTag}
      onBulkRemoveTag={onBulkRemoveTag}
      onCollectSelected={onCollectSelected}
      onClearFolderSelection={onClearFolderSelection}
      serverFiltered={serverFiltered}
      totalCount={totalCount}
      pageOffset={pageOffset}
      pageSize={pageSize}
      onPageChange={onPageChange}
    />
  );
}

function SfxSmartFolderRoutePage({ folderIndex, smartFolderDefs, assets, query, detailOpen, columns, gridWaveHeight, showGridWaveform, favoriteOverrides, sortMode, filterFavoriteOnly, filterUntaggedOnly, onColumnsCapChange, inPoint, outPoint, onSetInOutRange, onClearInOutRange, onSelectedAssetChange, onToggleFavorite, onAddTag, onRemoveTag, loading, onPrepareImport, activeImport, onTogglePlay, onDragToResolve, onInsertToTimeline, playingAssetId, isPlaying, playerTime, playerDuration, onSeek, onPreviewSeek, onHoverPosition, selectedFolderPathsForBulk, onBulkAddTag, onBulkRemoveTag, onCollectSelected, onClearFolderSelection, serverFiltered, totalCount, pageOffset, pageSize, onPageChange }) {
  const params = useParams();
  const def = smartFolderDefs.find((d) => d.id === params.folderId) || null;
  return (
    <SfxAssetBrowser
      smartFolderDef={def}
      folderIndex={folderIndex}
      assets={assets}
      query={query}
      detailOpen={detailOpen}
      columns={columns}
      gridWaveHeight={gridWaveHeight}
      showGridWaveform={showGridWaveform}
      favoriteOverrides={favoriteOverrides}
      sortMode={sortMode}
      filterFavoriteOnly={filterFavoriteOnly}
      filterUntaggedOnly={filterUntaggedOnly}
      onColumnsCapChange={onColumnsCapChange}
      inPoint={inPoint}
      outPoint={outPoint}
      onSetInOutRange={onSetInOutRange}
      onClearInOutRange={onClearInOutRange}
      onSelectedAssetChange={onSelectedAssetChange}
      onToggleFavorite={onToggleFavorite}
      onAddTag={onAddTag}
      onRemoveTag={onRemoveTag}
      loading={loading}
      onPrepareImport={onPrepareImport}
      activeImport={activeImport}
      onTogglePlay={onTogglePlay}
      onDragToResolve={onDragToResolve}
      onInsertToTimeline={onInsertToTimeline}
      playingAssetId={playingAssetId}
      isPlaying={isPlaying}
      playerTime={playerTime}
      playerDuration={playerDuration}
      onSeek={onSeek}
      onPreviewSeek={onPreviewSeek}
      onHoverPosition={onHoverPosition}
      selectedFolderPathsForBulk={selectedFolderPathsForBulk}
      onBulkAddTag={onBulkAddTag}
      onBulkRemoveTag={onBulkRemoveTag}
      onCollectSelected={onCollectSelected}
      onClearFolderSelection={onClearFolderSelection}
      serverFiltered={serverFiltered}
      totalCount={totalCount}
      pageOffset={pageOffset}
      pageSize={pageSize}
      onPageChange={onPageChange}
    />
  );
}

function SfxSelect({ value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState(null);
  const ref = useRef(null);
  const menuRef = useRef(null);

  const updatePosition = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const gap = 6;
    const maxH = 248;
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipUp = spaceBelow < maxH + gap && rect.top > spaceBelow;
    const available = (flipUp ? rect.top : spaceBelow) - gap - 8;
    setMenuStyle({
      position: 'fixed',
      left: rect.left,
      width: rect.width,
      maxHeight: Math.min(maxH, Math.max(120, available)),
      ...(flipUp
        ? { bottom: window.innerHeight - rect.top + gap }
        : { top: rect.bottom + gap }),
    });
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    updatePosition();
    const onDown = (e) => {
      if (ref.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onReflow = () => updatePosition();
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [open, updatePosition]);

  return (
    <div className="sfx-set-select-wrap" ref={ref}>
      <button
        type="button"
        className={`sfx-set-select ${open ? 'open' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="sfx-set-select-value">{value}</span>
        <span className="sfx-set-select-chevron"><ChevronDown size={15} /></span>
      </button>
      {open && menuStyle ? createPortal(
        <div className="sfx-set-select-menu" role="listbox" ref={menuRef} style={menuStyle}>
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              role="option"
              aria-selected={opt === value}
              className={`sfx-set-select-option ${opt === value ? 'active' : ''}`}
              onClick={() => { onChange(opt); setOpen(false); }}
            >
              <span>{opt}</span>
              {opt === value ? <Check size={14} className="sfx-set-select-check" /> : null}
            </button>
          ))}
        </div>,
        document.body
      ) : null}
    </div>
  );
}

function SfxStatusIcon({ item }) {
  if (typeof item?.onAction === 'function') {
    return (
      <button
        type="button"
        className="sfx-status-action-icon"
        title={item.actionLabel}
        aria-label={item.actionLabel}
        onClick={item.onAction}
      >
        {item.actionIcon === 'play' ? (
          <Play size={14} style={{ marginLeft: 1 }} />
        ) : (
          <span className="sfx-pause-glyph" aria-hidden="true">
            <span />
            <span />
          </span>
        )}
      </button>
    );
  }
  return <Loader2 size={15} className={item?.spinning ? 'spin' : ''} />;
}

function SfxStatusCard({ item }) {
  return (
    <div className={`sfx-status-card ${item.tone === 'error' ? 'error' : ''} ${item.tone === 'success' ? 'success' : ''} ${item.tone === 'warning' ? 'warning' : ''}`}>
      <div className={`sfx-status-icon ${item.tone === 'error' ? 'error' : ''} ${item.tone === 'success' ? 'success' : ''} ${item.tone === 'warning' ? 'warning' : ''}`}>
        <SfxStatusIcon item={item} />
      </div>
      <div className="sfx-status-main">
        <div className="sfx-status-heading">
          <span>{item.title}</span>
          {item.badge ? <span className="sfx-status-badge">{item.badge}</span> : null}
        </div>
        {item.detail ? <div className="sfx-status-text">{item.detail}</div> : null}
        {item.meta ? <div className="sfx-status-subtext">{item.meta}</div> : null}
        {item.indeterminate ? (
          <div className="sfx-status-progress">
            <div className="sfx-status-progress-indeterminate" />
          </div>
        ) : null}
        {item.segmented && item.progress ? (
          <>
            <div className="sfx-status-progress segmented" aria-hidden="true">
              <div className="sfx-status-progress-fill ready" style={{ width: `${(item.progress.generated / Math.max(item.progress.generated + item.progress.active + item.progress.queued + item.progress.failed + item.progress.waiting, 1)) * 100}%` }} />
              <div className="sfx-status-progress-fill active" style={{ width: `${(item.progress.active / Math.max(item.progress.generated + item.progress.active + item.progress.queued + item.progress.failed + item.progress.waiting, 1)) * 100}%` }} />
              <div className="sfx-status-progress-fill queued" style={{ width: `${(item.progress.queued / Math.max(item.progress.generated + item.progress.active + item.progress.queued + item.progress.failed + item.progress.waiting, 1)) * 100}%` }} />
              <div className="sfx-status-progress-fill failed" style={{ width: `${(item.progress.failed / Math.max(item.progress.generated + item.progress.active + item.progress.queued + item.progress.failed + item.progress.waiting, 1)) * 100}%` }} />
            </div>
            <div className="sfx-status-metrics">
              <span className="sfx-status-metric ready">已生成 {item.progress.generated}</span>
              {item.progress.active > 0 ? <span className="sfx-status-metric active">生成中 {item.progress.active}</span> : null}
              {item.progress.queued > 0 ? <span className="sfx-status-metric queued">排队 {item.progress.queued}</span> : null}
              {item.progress.waiting > 0 ? <span className="sfx-status-metric waiting">待补全 {item.progress.waiting}</span> : null}
              {item.progress.failed > 0 ? <span className="sfx-status-metric failed">失败 {item.progress.failed}</span> : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function SfxCacheStatusCard({
  currentLibrary,
  assetTotal,
  persistedWaveformCount,
  statusItems,
  waveformProgressView,
  onGenerateAllWaveforms,
  onRefreshLibrary,
  loading,
}) {
  const total = Math.max(Number(waveformProgressView?.total || 0), Number(assetTotal || 0));
  const generated = Math.min(Math.max(Number(persistedWaveformCount || 0), Number(waveformProgressView?.generated || 0)), Math.max(total, 0));
  const percent = total > 0 ? Math.round((generated / total) * 100) : 0;
  const canGenerate = Boolean(currentLibrary) && (total === 0 || waveformProgressView?.waiting > 0 || waveformProgressView?.failed > 0 || generated < total);

  return (
    <section className="sfx-set-card sfx-cache-card">
      <div className="sfx-set-card-head">
        <div className="sfx-set-card-icon" style={{ background: 'linear-gradient(135deg, #5E5CE6, #0A84FF)' }}>
          <HardDrive size={17} />
        </div>
        <div className="sfx-set-card-titles">
          <div className="sfx-set-card-title">缓存与状态</div>
          <div className="sfx-set-card-sub">索引状态、音效缓存和全库波形生成</div>
        </div>
        <div className="sfx-cache-actions">
          <button className="sfx-set-btn" type="button" onClick={onRefreshLibrary} disabled={!currentLibrary || loading}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} /> 重建索引
          </button>
          <button className="sfx-set-btn primary" type="button" onClick={onGenerateAllWaveforms} disabled={!canGenerate}>
            <Sparkles size={14} /> 一键生成全部波形
          </button>
        </div>
      </div>
      <div className="sfx-set-card-body">
        <div className="sfx-cache-summary">
          <div className="sfx-cache-stat">
            <div className="sfx-cache-stat-value">{total.toLocaleString()}</div>
            <div className="sfx-cache-stat-label">音效文件</div>
          </div>
          <div className="sfx-cache-stat">
            <div className="sfx-cache-stat-value">{generated.toLocaleString()}</div>
            <div className="sfx-cache-stat-label">已缓存波形</div>
          </div>
          <div className="sfx-cache-stat">
            <div className="sfx-cache-stat-value">{percent}%</div>
            <div className="sfx-cache-stat-label">完成度</div>
          </div>
        </div>
        <div className="sfx-cache-progress" aria-label={`波形缓存完成度 ${percent}%`}>
          <div className="sfx-cache-progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <div className="sfx-status-stack embedded">
          {statusItems.length > 0 ? (
            statusItems.map((item) => <SfxStatusCard key={item.key} item={item} />)
          ) : (
            <div className="sfx-status-empty">
              {currentLibrary ? '当前没有正在运行的索引或波形任务。' : '添加音效库后，这里会显示索引与缓存状态。'}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function SfxSettingsPage({ config, libraries, localFolderOptions, davinciFolderOptions, onAddLibrary, onRemoveLibrary, onSaveConfig, loading, cacheStatusProps }) {
  const libraryPath = config?.library_path || '';
  const [localTargetFolder, setLocalTargetFolder] = useState(config?.local_target_folder || config?.save_subfolder || '音效');
  const [davinciArchiveFolder, setDavinciArchiveFolder] = useState(config?.davinci_archive_folder || config?.davinci_folder || '音效');
  const [folderDepth, setFolderDepth] = useState(config?.folder_depth || 1);
  const [folderDepthDirection, setFolderDepthDirection] = useState(config?.folder_depth_direction || 'forward');

  useEffect(() => {
    setLocalTargetFolder(config?.local_target_folder || config?.save_subfolder || '音效');
    setDavinciArchiveFolder(config?.davinci_archive_folder || config?.davinci_folder || '音效');
    setFolderDepth(config?.folder_depth || 1);
    setFolderDepthDirection(config?.folder_depth_direction || 'forward');
  }, [config?.local_target_folder, config?.davinci_archive_folder, config?.save_subfolder, config?.davinci_folder, config?.folder_depth, config?.folder_depth_direction]);

  const savedLocal = config?.local_target_folder || config?.save_subfolder || '音效';
  const savedDavinci = config?.davinci_archive_folder || config?.davinci_folder || '音效';
  const savedDepth = config?.folder_depth || 1;
  const savedDirection = config?.folder_depth_direction || 'forward';
  const dirty = localTargetFolder !== savedLocal
    || davinciArchiveFolder !== savedDavinci
    || folderDepth !== savedDepth
    || folderDepthDirection !== savedDirection;

  const handleSave = () => onSaveConfig?.({
    ...config,
    local_target_folder: localTargetFolder,
    davinci_archive_folder: davinciArchiveFolder,
    folder_depth: folderDepth,
    folder_depth_direction: folderDepthDirection,
    save_subfolder: config?.save_subfolder || localTargetFolder,
    davinci_folder: config?.davinci_folder || davinciArchiveFolder
  });

  const handleReset = () => {
    setLocalTargetFolder(savedLocal);
    setDavinciArchiveFolder(savedDavinci);
    setFolderDepth(savedDepth);
    setFolderDepthDirection(savedDirection);
  };

  const localOpts = localFolderOptions?.length ? localFolderOptions : ['音效'];
  const davinciOpts = davinciFolderOptions?.length ? davinciFolderOptions : ['音效'];
  const depthLabel = folderDepth === 0 ? '直接导入到音效文件夹' : `保留 ${folderDepth} 层目录结构`;

  return (
    <div className="page-panel sfx-page" style={{ padding: 0 }}>
      <div className="sfx-topbar" style={{ WebkitAppRegion: 'no-drag' }}>
        <div className="sfx-topbar-title">
          <div className="sfx-title">音效设置</div>
          <div className="sfx-subtitle">库路径、导入目录、媒体池归档策略</div>
        </div>
        <div style={{ flex: 1 }} />
      </div>

      <div className="sfx-settings-scroll">
        <div className="sfx-settings-inner">
          <SfxCacheStatusCard {...cacheStatusProps} loading={loading} />

          {/* —— 音效库 —— */}
          <section className="sfx-set-card">
            <div className="sfx-set-card-head">
              <div className="sfx-set-card-icon" style={{ background: 'linear-gradient(135deg, #0A84FF, #0066CC)' }}>
                <Library size={17} />
              </div>
              <div className="sfx-set-card-titles">
                <div className="sfx-set-card-title">音效库</div>
                <div className="sfx-set-card-sub">浏览与导入音效的来源文件夹</div>
              </div>
              {libraryPath ? (
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                  <button className="sfx-set-btn" type="button" onClick={onAddLibrary} disabled={!onAddLibrary || loading}>
                    <FolderOpen size={14} /> 更换
                  </button>
                  <button className="sfx-set-btn danger" type="button" onClick={() => onRemoveLibrary?.(libraryPath)} disabled={loading}>
                    移除
                  </button>
                </div>
              ) : null}
            </div>
            <div className="sfx-set-card-body">
              {libraryPath ? (
                <div className="sfx-set-lib">
                  <div className="sfx-set-lib-icon"><FolderCheck size={19} /></div>
                  <div className="sfx-set-lib-meta">
                    <div className="sfx-set-lib-path" title={libraryPath}>{libraryPath}</div>
                  </div>
                </div>
              ) : (
                <div className="sfx-set-lib empty">
                  <span className="sfx-set-lib-empty-text">尚未添加音效库</span>
                  <button className="sfx-set-btn primary" type="button" onClick={onAddLibrary} disabled={!onAddLibrary || loading}>
                    <FolderPlus size={14} /> 添加音效库
                  </button>
                </div>
              )}
            </div>
          </section>

          <SfxImportStrategyCard
            localTargetFolder={localTargetFolder}
            setLocalTargetFolder={setLocalTargetFolder}
            davinciArchiveFolder={davinciArchiveFolder}
            setDavinciArchiveFolder={setDavinciArchiveFolder}
            folderDepth={folderDepth}
            setFolderDepth={setFolderDepth}
            folderDepthDirection={folderDepthDirection}
            setFolderDepthDirection={setFolderDepthDirection}
            localOpts={localOpts}
            davinciOpts={davinciOpts}
            depthLabel={depthLabel}
          />

          {/* —— 保存栏 —— */}
          <div className="sfx-set-savebar">
            <span className={`sfx-set-savebar-hint ${dirty ? 'dirty' : ''}`}>
              {dirty ? <><Info size={13} /> 有未保存的更改</> : <><Check size={13} /> 已是最新</>}
            </span>
            {dirty ? (
              <button className="sfx-set-btn ghost" type="button" onClick={handleReset}>
                <RotateCcw size={14} /> 还原
              </button>
            ) : null}
            <button className="sfx-set-btn primary" type="button" onClick={handleSave} disabled={!onSaveConfig || !dirty}>
              <Check size={15} /> 保存设置
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SfxImportStrategyCard({ localTargetFolder, setLocalTargetFolder, davinciArchiveFolder, setDavinciArchiveFolder, folderDepth, setFolderDepth, folderDepthDirection, setFolderDepthDirection, localOpts, davinciOpts, depthLabel }) {
  return (
    <section className="sfx-set-card">
      <div className="sfx-set-card-head">
        <div className="sfx-set-card-icon" style={{ background: 'linear-gradient(135deg, #34C759, #28A745)' }}>
          <Download size={17} />
        </div>
        <div className="sfx-set-card-titles">
          <div className="sfx-set-card-title">导入策略</div>
          <div className="sfx-set-card-sub">音效导入到项目和达芬奇媒体池的归档规则</div>
        </div>
      </div>
      <div className="sfx-set-card-body">
        <div className="sfx-set-row">
          <div className="sfx-set-row-info">
            <div className="sfx-set-row-label">项目内本地目录</div>
            <div className="sfx-set-row-desc">音效文件复制到项目内的子文件夹</div>
          </div>
          <div className="sfx-set-row-control">
            <SfxSelect value={localTargetFolder} options={localOpts} onChange={setLocalTargetFolder} />
          </div>
        </div>

        <div className="sfx-set-row">
          <div className="sfx-set-row-info">
            <div className="sfx-set-row-label">媒体池归档目录</div>
            <div className="sfx-set-row-desc">在达芬奇媒体池中归档音效的箱（Bin）</div>
          </div>
          <div className="sfx-set-row-control">
            <SfxSelect value={davinciArchiveFolder} options={davinciOpts} onChange={setDavinciArchiveFolder} />
          </div>
        </div>

        <div className="sfx-set-row">
          <div className="sfx-set-row-info">
            <div className="sfx-set-row-label">映射层级深度</div>
            <div className="sfx-set-row-desc">保留源音效库的多少层目录结构</div>
          </div>
          <div className="sfx-set-row-control">
            <div className="sfx-set-slider-wrap">
              <input
                className="sfx-set-slider"
                type="range"
                min="0"
                max="10"
                value={folderDepth}
                onChange={(e) => setFolderDepth(Number(e.target.value))}
              />
              <span className="sfx-set-badge">{depthLabel}</span>
            </div>
          </div>
        </div>

        <div className="sfx-set-row">
          <div className="sfx-set-row-info">
            <div className="sfx-set-row-label">映射方式</div>
            <div className="sfx-set-row-desc">从目录的顶层还是底层开始保留层级</div>
          </div>
          <div className="sfx-set-row-control">
            <div className="sfx-set-toggle-group">
              <button
                type="button"
                className={`sfx-set-toggle-btn ${folderDepthDirection === 'forward' ? 'active' : ''}`}
                onClick={() => setFolderDepthDirection('forward')}
              >
                正向（从上到下）
              </button>
              <button
                type="button"
                className={`sfx-set-toggle-btn ${folderDepthDirection === 'reverse' ? 'active' : ''}`}
                onClick={() => setFolderDepthDirection('reverse')}
              >
                反向（从下到上）
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}


function useLatest(value) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function SfxWorkspace() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [smartFolders, setSmartFolders] = useState(() => loadSmartFolders());
  const [showSmartFolderModal, setShowSmartFolderModal] = useState(false);
  const [config, setConfig] = useState(null);
  const [localFolderOptions, setLocalFolderOptions] = useState([]);
  const [davinciFolderOptions, setDavinciFolderOptions] = useState([]);
  const [library, setLibrary] = useState('');
  const [currentLibrary, setCurrentLibrary] = useState(() => localStorage.getItem('sfx.currentLibrary') || '');
  const [columns, setColumns] = useState(() => {
    const raw = localStorage.getItem('sfx.columns');
    const v = Number(raw);
    if (Number.isFinite(v)) return clamp(Math.round(v), 1, 6);
    return 3;
  });
  const [assets, setAssets] = useState([]);
  const deferredQuery = useDeferredValue(query);
  const [favoriteOverrides, setFavoriteOverrides] = useState(() => new Map());
  const [, startTransition] = useTransition();
  const [folderTreeBackend, setFolderTreeBackend] = useState([]);
  const [folderIndex] = useState({});
  const [navCountsState, setNavCountsState] = useState({ all: 0, favorites: 0, recent: 0, project_used: 0 });
  const [topTags, setTopTags] = useState([]);
  const [assetTotal, setAssetTotal] = useState(0);
  const [hasMoreAssets, setHasMoreAssets] = useState(false);
  const [assetOffset, setAssetOffset] = useState(0);
  const [indexStatus, setIndexStatus] = useState(null);
  const [waveformProgressTick, setWaveformProgressTick] = useState(0);
  const [loading, setLoading] = useState(false);
  const [resolveStatus, setResolveStatus] = useState({ connected: false, project: null });
  const [projectContext, setProjectContext] = useState(null);

  useEffect(() => {
    const updateTheme = () => {
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    };
    updateTheme();
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    mql.addEventListener('change', updateTheme);
    return () => mql.removeEventListener('change', updateTheme);
  }, []);

  const [importSession, setImportSession] = useState(null);
  const [importPreparing, setImportPreparing] = useState(false);
  const [toast, setToast] = useState(null);
  const [audioTools, setAudioTools] = useState(null);
  const audioRef = useRef(null);
  const selectedAssetRef = useRef(null);
  const hoverWaveRef = useRef({ asset: null, pct: null, time: null, duration: 0, at: 0 });
  const togglePlayRef = useRef(null);
  const playbackFallbackRef = useRef({ token: null, triedPreview: false, retries: 0 });
  const inPointRef = useRef(null);
  const outPointRef = useRef(null);
  const [activeAssetId, setActiveAssetId] = useState(null);
  const [assetIoRanges, setAssetIoRanges] = useState(() => new Map());
  const [playingAssetId, setPlayingAssetId] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playerTime, setPlayerTime] = useState(0);
  const [playerDuration, setPlayerDuration] = useState(0);
  const [playerVolume, setPlayerVolume] = useState(1);
  const [playerRate, setPlayerRate] = useState(1);
  const dragIconPathPromiseRef = useRef(null);
  const pendingSeekPctRef = useRef(null);
  const [sortOpen, setSortOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortMode, setSortMode] = useState('name_asc');
  const [filterFavoriteOnly, setFilterFavoriteOnly] = useState(false);
  const [filterUntaggedOnly, setFilterUntaggedOnly] = useState(false);
  const toolbarRef = useRef(null);
  const indexStatusPollRef = useRef(null);
  const indexStatusClearRef = useRef(null);
  const indexStatusPollSessionRef = useRef(0);
  const summaryRequestRef = useRef({ id: 0, controller: null });
  const browseRequestRef = useRef({ id: 0, controller: null });
  const bootstrapRequestRef = useRef({ id: 0, controller: null });
  const [columnsCap, setColumnsCap] = useState(6);
  const browseCacheRef = useRef(new Map());
  const browseHydrationKeyRef = useRef('');
  const browseScopeRef = useRef('');
  const nextPagePendingRef = useRef(false);
  const [waveformSchedulerState, setWaveformSchedulerState] = useState({
    phase: 'idle',
    total: 0,
    tracked: 0,
    priorityTotal: 0,
    priorityTracked: 0,
    libraryPath: '',
  });
  const activeIoRange = useMemo(() => {
    if (!activeAssetId) return null;
    return assetIoRanges.get(activeAssetId) || null;
  }, [activeAssetId, assetIoRanges]);
  const inPoint = typeof activeIoRange?.inPoint === 'number' && Number.isFinite(activeIoRange.inPoint) ? activeIoRange.inPoint : null;
  const outPoint = typeof activeIoRange?.outPoint === 'number' && Number.isFinite(activeIoRange.outPoint) ? activeIoRange.outPoint : null;
  const waveformPriorityKeysRef = useRef(new Set());
  const waveformGlobalKeysRef = useRef(new Set());
  const waveformLastActivityRef = useRef(Date.now());
  const waveformBackgroundSessionRef = useRef(0);
  const waveformPrioritySessionRef = useRef(0);
  const waveformBackgroundOffsetRef = useRef(0);
  const mainContentRef = useRef(null);
  const [waveformAutofillPaused, setWaveformAutofillPaused] = useState(false);
  const [waveformAutofillKick, setWaveformAutofillKick] = useState(0);
  const [persistedWaveformCount, setPersistedWaveformCount] = useState(0);

  useEffect(() => {
    const onMouseDown = (e) => {
      const el = toolbarRef.current;
      if (!el) return;
      if (el.contains(e.target)) return;
      setSortOpen(false);
      setFilterOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        setSortOpen(false);
        setFilterOpen(false);
      }
    };
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'metadata';
    audioRef.current = audio;

    const handleTime = () => {
      const range = getPlaybackRange(audio.duration, inPointRef.current, outPointRef.current);
      if (range && audio.currentTime >= range.end - 0.02) {
        audio.currentTime = range.start;
        setPlayerTime(range.start);
        return;
      }
      setPlayerTime(audio.currentTime || 0);
    };
    const handleLoaded = () => setPlayerDuration(audio.duration || 0);
    const handleEnded = () => setIsPlaying(false);
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleError = () => setIsPlaying(false);

    const handleLoadedWithSeek = () => {
      handleLoaded();
      const pct = pendingSeekPctRef.current;
      if (typeof pct === 'number' && Number.isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = clamp(pct, 0, 1) * audio.duration;
        pendingSeekPctRef.current = null;
        if (audio.paused) audio.play().catch(() => {});
      }
    };

    audio.addEventListener('timeupdate', handleTime);
    audio.addEventListener('loadedmetadata', handleLoadedWithSeek);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('error', handleError);

    return () => {
      audio.pause();
      audioRef.current = null;
      audio.removeEventListener('timeupdate', handleTime);
      audio.removeEventListener('loadedmetadata', handleLoadedWithSeek);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('error', handleError);
    };
  }, []);

  useEffect(() => {
    inPointRef.current = inPoint;
    outPointRef.current = outPoint;
  }, [inPoint, outPoint]);

  useEffect(() => {
    saveSmartFolders(smartFolders);
  }, [smartFolders]);

  useEffect(() => {
    let mounted = true;
    let timer = null;

    const poll = async () => {
      try {
        const res = await axios.get(`${API_BASE_URL}/api/status`);
        if (!mounted) return;
        setResolveStatus({ connected: res.data.connected === true, project: res.data.project || null });
      } catch {
        if (!mounted) return;
        setResolveStatus({ connected: false, project: null });
      }

      try {
        const res = await axios.get(`${API_BASE_URL}/api/project/context`);
        if (!mounted) return;
        setProjectContext(res.data?.context || null);
      } catch {
        if (!mounted) return;
        setProjectContext(null);
      }
    };

    poll();
    timer = setInterval(poll, 4000);
    return () => {
      mounted = false;
      if (timer) clearInterval(timer);
    };
  }, []);

  const mapBrowseItem = useCallback((libraryPath, item) => ({
    id: item.asset_key || item.path,
    name: item.filename || item.name || String(item.path || '').split('/').slice(-1)[0],
    path: item.path,
    libraryPath,
    relativePath: item.relative_path || '',
    duration: item.duration || '',
    sampleRate: item.sample_rate || 0,
    tags: Array.isArray(item.tags) ? item.tags : [],
    favorite: !!item.favorite,
    usedCount: Number(item.used_count || 0),
    lastUsedDays: Number(item.last_used_days ?? 9999),
    extension: item.extension || '',
    sizeMb: item.size_mb,
    modified: item.modified
  }), []);

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
      const res = await axios.post(`${API_BASE_URL}/api/sound-effects/library-index-status`, {
        library_path: libraryPath
      });
      if (res.data?.status === 'success') {
        return res.data.status_info || null;
      }
    } catch {}
    return null;
  }, []);

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

  const fetchLibraryBrowsePage = useCallback(async (libraryPath, params = {}, signal) => {
    if (!libraryPath) {
      return { items: [], total: 0, offset: 0, limit: 0, has_more: false };
    }
    const res = await axios.post(`${API_BASE_URL}/api/sound-effects/library-browse`, {
      library_path: libraryPath,
      query: params.query || '',
      selected_folder: params.selectedFolder || '',
      forced_tag: params.forcedTag || '',
      favorite_only: Boolean(params.favoriteOnly),
      untagged_only: Boolean(params.untaggedOnly),
      sort_mode: params.sortMode || 'name_asc',
      smart_rules: params.smartRules || {},
      limit: params.limit || SFX_BROWSE_PAGE_SIZE,
      offset: params.offset || 0,
      force_refresh: Boolean(params.forceRefresh),
    }, signal ? { signal } : undefined);
    if (res.data?.status !== 'success') {
      return { items: [], total: 0, offset: 0, limit: 0, has_more: false };
    }
    return {
      items: Array.isArray(res.data.items) ? res.data.items : [],
      total: Number(res.data.total || 0),
      offset: Number(res.data.offset || 0),
      limit: Number(res.data.limit || 0),
      has_more: Boolean(res.data.has_more),
      cached: Boolean(res.data.cached),
      stale: Boolean(res.data.stale),
      refreshing: Boolean(res.data.refreshing),
      generated_at: Number(res.data.generated_at || 0),
    };
  }, []);

  const fetchLibraryBootstrap = useCallback(async (libraryPath, params = {}, signal) => {
    if (!libraryPath) {
      return {
        folder_tree: [],
        nav_counts: { all: 0, favorites: 0, recent: 0, project_used: 0 },
        top_tags: [],
        items: [],
        total: 0,
        offset: 0,
        limit: 0,
        has_more: false,
        cached: false,
        stale: false,
        refreshing: false,
        generated_at: 0,
        status_info: null,
      };
    }
    const requestBody = {
      library_path: libraryPath,
      query: params.query || '',
      selected_folder: params.selectedFolder || '',
      forced_tag: params.forcedTag || '',
      favorite_only: Boolean(params.favoriteOnly),
      untagged_only: Boolean(params.untaggedOnly),
      sort_mode: params.sortMode || 'name_asc',
      smart_rules: params.smartRules || {},
      limit: params.limit || SFX_BROWSE_PAGE_SIZE,
      offset: params.offset || 0,
      force_refresh: Boolean(params.forceRefresh),
    };
    try {
      const res = await axios.post(
        `${API_BASE_URL}/api/sound-effects/library-bootstrap`,
        requestBody,
        signal ? { signal } : undefined,
      );
      if (res.data?.status !== 'success') {
        throw new Error('bootstrap_failed');
      }
      return {
        folder_tree: Array.isArray(res.data.folder_tree) ? res.data.folder_tree : [],
        nav_counts: res.data.nav_counts || { all: 0, favorites: 0, recent: 0, project_used: 0 },
        top_tags: Array.isArray(res.data.top_tags) ? res.data.top_tags : [],
        items: Array.isArray(res.data.items) ? res.data.items : [],
        total: Number(res.data.total || 0),
        offset: Number(res.data.offset || 0),
        limit: Number(res.data.limit || 0),
        has_more: Boolean(res.data.has_more),
        cached: Boolean(res.data.cached),
        stale: Boolean(res.data.stale),
        refreshing: Boolean(res.data.refreshing),
        generated_at: Number(res.data.generated_at || 0),
        status_info: res.data.status_info || null,
      };
    } catch (bootstrapError) {
      if (bootstrapError?.name === 'CanceledError' || bootstrapError?.code === 'ERR_CANCELED') {
        throw bootstrapError;
      }
      const [summaryRes, browseRes, statusRes] = await Promise.all([
        axios.post(
          `${API_BASE_URL}/api/sound-effects/library-summary`,
          {
            library_path: libraryPath,
            force_refresh: Boolean(params.forceRefresh),
          },
          signal ? { signal } : undefined,
        ),
        axios.post(
          `${API_BASE_URL}/api/sound-effects/library-browse`,
          requestBody,
          signal ? { signal } : undefined,
        ),
        axios.post(
          `${API_BASE_URL}/api/sound-effects/library-index-status`,
          { library_path: libraryPath },
          signal ? { signal } : undefined,
        ).catch(() => ({ data: { status_info: null } })),
      ]);
      return {
        folder_tree: Array.isArray(summaryRes.data?.folder_tree) ? summaryRes.data.folder_tree : [],
        nav_counts: summaryRes.data?.nav_counts || { all: 0, favorites: 0, recent: 0, project_used: 0 },
        top_tags: Array.isArray(summaryRes.data?.top_tags) ? summaryRes.data.top_tags : [],
        items: Array.isArray(browseRes.data?.items) ? browseRes.data.items : [],
        total: Number(browseRes.data?.total || 0),
        offset: Number(browseRes.data?.offset || 0),
        limit: Number(browseRes.data?.limit || 0),
        has_more: Boolean(browseRes.data?.has_more),
        cached: Boolean(summaryRes.data?.cached ?? browseRes.data?.cached),
        stale: Boolean(summaryRes.data?.stale ?? browseRes.data?.stale),
        refreshing: Boolean(summaryRes.data?.refreshing ?? browseRes.data?.refreshing),
        generated_at: Number(summaryRes.data?.generated_at || browseRes.data?.generated_at || 0),
        status_info: statusRes.data?.status_info || null,
      };
    }
  }, []);

  const refreshLibrarySummary = useCallback(async (libraryPath, options = {}) => {
    if (!libraryPath) {
      if (summaryRequestRef.current.controller) {
        summaryRequestRef.current.controller.abort();
        summaryRequestRef.current.controller = null;
      }
      setFolderTreeBackend([]);
      setNavCountsState({ all: 0, favorites: 0, recent: 0, project_used: 0 });
      setTopTags([]);
      return;
    }
    if (summaryRequestRef.current.controller) {
      summaryRequestRef.current.controller.abort();
    }
    const controller = new AbortController();
    const requestId = summaryRequestRef.current.id + 1;
    summaryRequestRef.current = { id: requestId, controller };
    try {
      const res = await axios.post(`${API_BASE_URL}/api/sound-effects/library-summary`, {
        library_path: libraryPath,
        force_refresh: Boolean(options.forceRefresh)
      }, { signal: controller.signal });
      if (requestId !== summaryRequestRef.current.id) return;
      if (res.data?.status === 'success') {
        startTransition(() => {
          setFolderTreeBackend(normalizeBackendFolderTree(res.data.folder_tree || []));
          setNavCountsState(res.data.nav_counts || { all: 0, favorites: 0, recent: 0, project_used: 0 });
          setTopTags(Array.isArray(res.data.top_tags) ? res.data.top_tags : []);
        });
      }
    } catch (error) {
      if (error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED') return;
      throw error;
    } finally {
      if (summaryRequestRef.current.id === requestId) {
        summaryRequestRef.current.controller = null;
      }
    }
  }, []);

  const refreshLibraryBrowse = useCallback(async (libraryPath, params = {}, options = {}) => {
    if (!libraryPath) {
      if (browseRequestRef.current.controller) {
        browseRequestRef.current.controller.abort();
        browseRequestRef.current.controller = null;
      }
      setAssets([]);
      setAssetTotal(0);
      setHasMoreAssets(false);
      return;
    }
    if (browseRequestRef.current.controller) {
      browseRequestRef.current.controller.abort();
    }
    const controller = new AbortController();
    const requestId = browseRequestRef.current.id + 1;
    browseRequestRef.current = { id: requestId, controller };
    const normalizedParams = {
      query: params.query || '',
      selectedFolder: params.selectedFolder || '',
      forcedTag: params.forcedTag || '',
      favoriteOnly: Boolean(params.favoriteOnly),
      untaggedOnly: Boolean(params.untaggedOnly),
      sortMode: params.sortMode || 'name_asc',
      smartRules: params.smartRules || {},
      limit: params.limit || SFX_BROWSE_PAGE_SIZE,
      offset: params.offset || 0,
      forceRefresh: Boolean(options.forceRefresh),
    };
    const cacheKey = getSfxBrowseCacheKey(libraryPath, normalizedParams);
    const cachedResult = options.preferCached === false ? null : browseCacheRef.current.get(cacheKey);
    if (cachedResult) {
      startTransition(() => {
        setAssets(cachedResult.items);
        setAssetTotal(Number(cachedResult.total || 0));
        setHasMoreAssets((cachedResult.items?.length || 0) < Number(cachedResult.total || 0));
      });
    }
    setLoading(!cachedResult);
    try {
      const result = await fetchLibraryBrowsePage(libraryPath, normalizedParams, controller.signal);
      if (requestId !== browseRequestRef.current.id) return;
      const mappedItems = result.items.map((item) => mapBrowseItem(libraryPath, item));
      writeSfxBrowseCache(browseCacheRef.current, cacheKey, {
        items: mappedItems,
        total: Number(result.total || 0),
        updatedAt: Date.now(),
      });
      startTransition(() => {
        setAssets((prev) => (normalizedParams.offset > 0 ? mergeBrowseItems(prev, mappedItems) : mappedItems));
        setAssetTotal(Number(result.total || 0));
        setHasMoreAssets(Boolean(result.has_more) || (normalizedParams.offset + mappedItems.length) < Number(result.total || 0));
      });
    } catch (error) {
      if (error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED') return;
      showToast({ type: 'error', message: '加载音效列表失败（请检查本地索引/磁盘/NAS 连接）' });
    } finally {
      if (browseRequestRef.current.id === requestId) {
        browseRequestRef.current.controller = null;
        setLoading(false);
      }
    }
  }, [fetchLibraryBrowsePage, mapBrowseItem]);

  const scanLibrary = useCallback(async (libraryPath, options = {}) => {
    if (!libraryPath) {
      setAssets([]);
      setFolderTreeBackend([]);
      setAssetTotal(0);
      setNavCountsState({ all: 0, favorites: 0, recent: 0, project_used: 0 });
      setTopTags([]);
      setIndexStatus(null);
      stopIndexStatusPolling();
      return;
    }
    if (bootstrapRequestRef.current.controller) {
      bootstrapRequestRef.current.controller.abort();
    }
    const controller = new AbortController();
    const requestId = bootstrapRequestRef.current.id + 1;
    bootstrapRequestRef.current = { id: requestId, controller };
    setLoading(true);
    const statusBefore = await fetchLibraryIndexStatus(libraryPath);
    if (options.forceRefresh || !statusBefore?.has_cache || statusBefore?.active || statusBefore?.stale) {
      startIndexStatusPolling(libraryPath, {
        stage: Boolean(options.forceRefresh) ? 'rebuilding' : (statusBefore?.has_cache ? 'loading' : 'starting'),
        message: Boolean(options.forceRefresh)
          ? '正在重建本地索引…'
          : (statusBefore?.has_cache ? '正在读取本地索引…' : '首次建立本地索引…'),
        processed_files: Number(statusBefore?.processed_files || 0),
        processed_dirs: Number(statusBefore?.processed_dirs || 0),
        current_path: statusBefore?.current_path || libraryPath,
      });
    }
    try {
      const bootstrapParams = {
        query: options.bootstrapParams?.query || '',
        selectedFolder: options.bootstrapParams?.selectedFolder || '',
        forcedTag: options.bootstrapParams?.forcedTag || '',
        favoriteOnly: Boolean(options.bootstrapParams?.favoriteOnly),
        untaggedOnly: Boolean(options.bootstrapParams?.untaggedOnly),
        sortMode: options.bootstrapParams?.sortMode || 'name_asc',
        smartRules: options.bootstrapParams?.smartRules || {},
        offset: Number(options.bootstrapParams?.offset || 0),
        limit: Number(options.bootstrapParams?.limit || SFX_BROWSE_PAGE_SIZE),
        forceRefresh: Boolean(options.forceRefresh),
      };
      const bootstrap = await fetchLibraryBootstrap(libraryPath, bootstrapParams, controller.signal);
      if (requestId !== bootstrapRequestRef.current.id) return;
      const mappedItems = bootstrap.items.map((item) => mapBrowseItem(libraryPath, item));
      const cacheKey = getSfxBrowseCacheKey(libraryPath, bootstrapParams);
      writeSfxBrowseCache(browseCacheRef.current, cacheKey, {
        items: mappedItems,
        total: Number(bootstrap.total || 0),
        updatedAt: Date.now(),
      });
      browseHydrationKeyRef.current = cacheKey;
      startTransition(() => {
        setFolderTreeBackend(normalizeBackendFolderTree(bootstrap.folder_tree || []));
        setNavCountsState(bootstrap.nav_counts || { all: 0, favorites: 0, recent: 0, project_used: 0 });
        setTopTags(Array.isArray(bootstrap.top_tags) ? bootstrap.top_tags : []);
        setAssets(mappedItems);
        setAssetTotal(Number(bootstrap.total || 0));
        setHasMoreAssets(Boolean(bootstrap.has_more) || mappedItems.length < Number(bootstrap.total || 0));
      });
      if (bootstrap.status_info) {
        setIndexStatus(bootstrap.status_info);
        if (bootstrap.status_info.active) {
          startIndexStatusPolling(libraryPath, bootstrap.status_info);
        } else if (!bootstrap.refreshing) {
          stopIndexStatusPolling();
        }
      }
    } catch (error) {
      if (error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED') return;
      showToast({ type: 'error', message: '加载音效库失败（请检查本地索引/磁盘/NAS 连接）' });
    } finally {
      if (bootstrapRequestRef.current.id === requestId) {
        bootstrapRequestRef.current.controller = null;
        setLoading(false);
      }
    }
  }, [fetchLibraryBootstrap, fetchLibraryIndexStatus, mapBrowseItem, startIndexStatusPolling, startTransition, stopIndexStatusPolling]);

  useEffect(() => {
    let mounted = true;
    const run = async () => {
      try {
        const res = await axios.get(`${API_BASE_URL}/api/sound-effects/config`);
        if (!mounted) return;
        if (res.data.status === 'success') {
          setConfig(res.data.config);
          setLocalFolderOptions(Array.isArray(res.data.local_folder_options) ? res.data.local_folder_options : []);
          setDavinciFolderOptions(Array.isArray(res.data.davinci_folder_options) ? res.data.davinci_folder_options : []);
          const libPath = res.data.config?.library_path || '';
          setLibrary(libPath);
          setCurrentLibrary(libPath);
          localStorage.setItem('sfx.currentLibrary', libPath);
          await scanLibrary(libPath);
        }
      } catch {
        setConfig(null);
        setLibrary('');
        setAssets([]);
        setFolderTreeBackend([]);
        setAssetTotal(0);
        showToast({ type: 'error', message: '后端未就绪：音效库数据不可用' });
      }
    };
    run();
    return () => { mounted = false; };
  }, []);

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
    bootstrapRequestRef.current.controller?.abort();
    summaryRequestRef.current.controller?.abort();
    browseRequestRef.current.controller?.abort();
  }, [stopIndexStatusPolling]);

  useEffect(() => subscribeWaveformProgress(() => {
    setWaveformProgressTick((value) => value + 1);
  }), []);

  useEffect(() => {
    let cancelled = false;
    if (!currentLibrary) {
      setPersistedWaveformCount(0);
      return () => {
        cancelled = true;
      };
    }
    void countPersistedWaveformsForLibrary(currentLibrary).then((count) => {
      if (cancelled) return;
      setPersistedWaveformCount(count);
    });
    return () => {
      cancelled = true;
    };
  }, [currentLibrary, waveformProgressTick]);

  useEffect(() => {
    let mounted = true;
    const run = async () => {
      try {
        const res = await axios.get(`${API_BASE_URL}/api/sound-effects/diagnostics`);
        if (!mounted) return;
        if (res.data?.status === 'success') {
          const tools = res.data.tools || null;
          setAudioTools(tools);
          if (tools && tools.ffmpeg_available === false) {
            showToast({
              type: 'warning',
              message: '音频解码组件未就绪：需要安装 imageio-ffmpeg（或系统 ffmpeg），否则 mp3/m4a 等将无法生成波形/播放'
            });
          }
        }
      } catch {
        if (!mounted) return;
        setAudioTools(null);
      }
    };
    run();
    return () => { mounted = false; };
  }, []);

  const navCounts = useMemo(() => ({
    all: Number(navCountsState.all || 0),
    favorites: Number(navCountsState.favorites || 0),
    recent: Number(navCountsState.recent || 0),
    projectUsed: Number(navCountsState.project_used || navCountsState.projectUsed || 0)
  }), [navCountsState]);

  const folderTree = useMemo(() => folderTreeBackend, [folderTreeBackend]);

  const [expandedFolders, setExpandedFolders] = useState(() => new Set());
  const [selectedFolderPaths, setSelectedFolderPaths] = useState(() => new Set());

  useEffect(() => {
    setExpandedFolders(getInitialSfxExpandedFolders(folderTree));
    setSelectedFolderPaths(new Set());
  }, [currentLibrary, folderTreeBackend.length]);

  const selectedFolder = useMemo(() => {
    const raw = searchParams.get('folder');
    if (!raw) return '';
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }, [searchParams]);

  const tags = useMemo(() => topTags, [topTags]);

  const assetById = useMemo(() => {
    const m = new Map();
    (assets || []).forEach((a) => {
      if (a?.id) m.set(a.id, a);
    });
    return m;
  }, [assets]);

  const presetSmartFolders = useMemo(
    () => [
      { id: 'frequent', name: '高频使用', rules: { usedCountMin: 6 } },
      { id: 'recent-7-days', name: '最近7天使用', rules: { lastUsedWithinDays: 7 } },
      { id: 'untagged', name: '未分类', rules: { untaggedOnly: true } }
    ],
    []
  );

  const smartFolderDefs = useMemo(() => {
    const userDefs = smartFolders.map((sf) => ({ id: sf.id, name: sf.name, rules: sf.rules || {} }));
    return [...presetSmartFolders, ...userDefs];
  }, [presetSmartFolders, smartFolders]);

  const isActive = (path) => location.pathname === path || location.pathname.startsWith(`${path}/`);
  const isLibraryRoute = location.pathname.startsWith('/sfx/library');

  const browseContext = useMemo(() => {
    const path = location.pathname || '';
    let forcedTag = '';
    let smartRules = {};
    if (path.startsWith('/sfx/favorites')) smartRules = { favoriteOnly: true };
    else if (path.startsWith('/sfx/recent')) smartRules = { lastUsedWithinDays: 7 };
    else if (path.startsWith('/sfx/project-used')) smartRules = { usedCountMin: 1 };
    else if (path.startsWith('/sfx/tags/')) forcedTag = decodeURIComponent(path.split('/').slice(-1)[0] || '');
    else if (path.startsWith('/sfx/smart/')) {
      const folderId = decodeURIComponent(path.split('/').slice(-1)[0] || '');
      smartRules = smartFolderDefs.find((d) => d.id === folderId)?.rules || {};
    }
    return { forcedTag, smartRules };
  }, [location.pathname, smartFolderDefs]);
  const smartRulesKey = useMemo(() => JSON.stringify(browseContext.smartRules || {}), [browseContext.smartRules]);
  const currentAssetPaths = useMemo(
    () => Array.from(new Set((assets || []).map((asset) => asset?.path).filter(Boolean))),
    [assets]
  );
  const currentBrowseParams = useMemo(() => ({
    query: deferredQuery,
    selectedFolder: isLibraryRoute ? selectedFolder : '',
    forcedTag: browseContext.forcedTag,
    favoriteOnly: filterFavoriteOnly,
    untaggedOnly: filterUntaggedOnly,
    sortMode,
    smartRules: browseContext.smartRules,
  }), [deferredQuery, isLibraryRoute, selectedFolder, browseContext, filterFavoriteOnly, filterUntaggedOnly, sortMode]);
  const browseScopeKey = useMemo(() => JSON.stringify({
    library: currentLibrary || '',
    path: location.pathname || '',
    params: currentBrowseParams,
  }), [currentBrowseParams, currentLibrary, location.pathname]);

  const showIndexBanner = useMemo(() => {
    if (!indexStatus) return false;
    if (indexStatus.active) return true;
    const updatedAtMs = Number(indexStatus.updated_at || 0) * 1000;
    if (!updatedAtMs) return false;
    return ['ready', 'error'].includes(String(indexStatus.stage || '')) && (Date.now() - updatedAtMs < 2400);
  }, [indexStatus]);

  const indexStatusView = useMemo(() => {
    if (!indexStatus) {
      return { title: '', detail: '', tone: 'neutral' };
    }
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
    } else if (stage === 'loading') title = '正在读取本地索引';

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

  const waveformProgressView = useMemo(() => {
    const priorityKeys = Array.from(waveformPriorityKeysRef.current || []);
    const libraryTotal = Math.max(Number(navCountsState?.all || 0), Number(waveformSchedulerState.total || 0), currentAssetPaths.length);
    if (!currentLibrary && libraryTotal === 0 && priorityKeys.length === 0) {
      return {
        show: false,
        title: '',
        detail: '',
        progressLabel: '',
        generated: 0,
        active: 0,
        queued: 0,
        failed: 0,
        waiting: 0,
        priorityGenerated: 0,
        total: libraryTotal,
      };
    }

    let sessionGenerated = 0;
    WAVEFORM_READY_KEYS.forEach((key) => {
      if (keyBelongsToLibrary(key, currentLibrary)) sessionGenerated += 1;
    });

    let active = 0;
    let queued = 0;
    let failed = 0;
    WAVEFORM_JOB_STATE.forEach((status, key) => {
      if (!keyBelongsToLibrary(key, currentLibrary)) return;
      if (status === 'active') active += 1;
      else if (status === 'queued') queued += 1;
      else if (status === 'failed') failed += 1;
    });

    let priorityGenerated = 0;
    priorityKeys.forEach((key) => {
      if (WAVEFORM_READY_KEYS.has(key) || WAVEFORM_MEMORY_CACHE.has(key)) priorityGenerated += 1;
    });

    const generated = Math.min(
      Math.max(Number(persistedWaveformCount || 0), sessionGenerated),
      libraryTotal,
    );
    const total = Math.max(libraryTotal, generated, active + queued + failed);
    const waiting = Math.max(total - generated - active - queued - failed, 0);
    const running = active + queued > 0;
    const phase = waveformSchedulerState.phase || 'idle';
    const show = Boolean(currentLibrary) || total > 0;

    const detailParts = [`全库已生成 ${generated}/${total}`];
    if (waveformSchedulerState.priorityTotal > 0) {
      detailParts.push(`当前视图优先 ${priorityGenerated}/${waveformSchedulerState.priorityTotal}`);
    }
    if (active > 0) detailParts.push(`生成中 ${active}`);
    if (queued > 0) detailParts.push(`排队 ${queued}`);
    if (waiting > 0) {
      detailParts.push(waveformAutofillPaused ? `静默补全已暂停 ${waiting}` : phase === 'paused' ? `等待空闲后自动补全 ${waiting}` : `待补全 ${waiting}`);
    }
    if (failed > 0) detailParts.push(`失败 ${failed}`);

    let title = '正在生成全局波形预览';
    if (waveformAutofillPaused) title = '静默补全已暂停';
    else if (phase === 'done' && waiting === 0 && active === 0 && queued === 0) title = '全局波形预览已就绪';
    else if (phase === 'background') title = '正在静默补全全库波形';
    else if (phase === 'priority') title = '优先生成当前视图波形';
    else if (phase === 'paused' && waiting > 0) title = '等待空闲后自动补全';

    return {
      show,
      title,
      detail: detailParts.join(' · '),
      progressLabel: waveformSchedulerState.priorityTotal > 0 ? '当前视图优先 + 全库静默补全' : '全库静默补全',
      generated,
      active,
      queued,
      failed,
      waiting,
      priorityGenerated,
      total,
      paused: waveformAutofillPaused,
    };
  }, [currentAssetPaths.length, currentLibrary, navCountsState?.all, persistedWaveformCount, waveformAutofillPaused, waveformProgressTick, waveformSchedulerState]);

  const toggleWaveformAutofill = useCallback(() => {
    setWaveformAutofillPaused((prev) => {
      const next = !prev;
      if (next) {
        cancelWaveformJobs((job) => job?.priority === WAVEFORM_PRIORITY_IDLE);
        setWaveformSchedulerState((state) => ({ ...state, phase: 'paused' }));
      } else {
        waveformLastActivityRef.current = Date.now() - WAVEFORM_BACKGROUND_IDLE_MS - 100;
        waveformBackgroundOffsetRef.current = 0;
        setWaveformAutofillKick((value) => value + 1);
      }
      return next;
    });
  }, []);

  const generateAllWaveformsNow = useCallback(() => {
    if (!currentLibrary) return;
    setWaveformAutofillPaused(false);
    waveformLastActivityRef.current = Date.now() - WAVEFORM_BACKGROUND_IDLE_MS - 100;
    waveformBackgroundOffsetRef.current = 0;
    setWaveformSchedulerState((prev) => ({
      ...prev,
      phase: 'background',
      total: Math.max(Number(navCountsState?.all || 0), Number(prev.total || 0), currentAssetPaths.length),
      libraryPath: currentLibrary,
    }));
    setWaveformAutofillKick((value) => value + 1);
  }, [currentAssetPaths.length, currentLibrary, navCountsState?.all]);

  const statusCenterItems = useMemo(() => {
    const items = [];
    if (showIndexBanner) {
      items.push({
        key: 'index',
        tone: indexStatusView.tone,
        spinning: Boolean(indexStatus?.active),
        title: indexStatusView.title,
        badge: indexStatus?.active ? '本地索引' : '',
        detail: indexStatusView.detail,
        meta: indexStatusView.meta && indexStatusView.meta !== indexStatusView.detail ? indexStatusView.meta : '',
        indeterminate: Boolean(indexStatus?.active),
      });
    }
    if (waveformProgressView.show) {
      items.push({
        key: 'waveform',
        tone: waveformProgressView.failed > 0 ? 'warning' : 'neutral',
        spinning: waveformProgressView.active + waveformProgressView.queued > 0,
        title: waveformProgressView.title,
        badge: waveformProgressView.progressLabel,
        detail: waveformProgressView.detail,
        segmented: true,
        progress: waveformProgressView,
        actionLabel: waveformProgressView.paused ? '开始静默补全' : '暂停静默补全',
        actionIcon: waveformProgressView.paused ? 'play' : 'pause',
        onAction: toggleWaveformAutofill,
      });
    }
    return items;
  }, [indexStatus?.active, indexStatusView, showIndexBanner, toggleWaveformAutofill, waveformProgressView]);

  useEffect(() => {
    cancelWaveformJobs(() => true);
    browseScopeRef.current = '';
    nextPagePendingRef.current = false;
    setHasMoreAssets(false);
    setAssetOffset(0);
  }, [browseScopeKey]);

  useEffect(() => {
    if (!loading) {
      nextPagePendingRef.current = false;
    }
  }, [loading]);

  useEffect(() => {
    if (!hasMoreAssets) {
      nextPagePendingRef.current = false;
    }
  }, [hasMoreAssets]);

  useEffect(() => {
    if (!currentLibrary) return;
    const scopeChanged = browseScopeRef.current !== browseScopeKey;
    if (scopeChanged) {
      browseScopeRef.current = browseScopeKey;
      nextPagePendingRef.current = false;
      if (assetOffset !== 0) return;
    }
    const hydrationKey = getSfxBrowseCacheKey(currentLibrary, {
      ...currentBrowseParams,
      offset: assetOffset,
      limit: SFX_BROWSE_PAGE_SIZE,
    });
    if (browseHydrationKeyRef.current && browseHydrationKeyRef.current === hydrationKey) {
      browseHydrationKeyRef.current = '';
      return;
    }
    refreshLibraryBrowse(currentLibrary, {
      ...currentBrowseParams,
      offset: assetOffset,
      limit: SFX_BROWSE_PAGE_SIZE,
    }, {
      preferCached: assetOffset === 0,
    });
  }, [assetOffset, browseScopeKey, currentBrowseParams, currentLibrary, refreshLibraryBrowse]);

  const requestNextAssetPage = useCallback(() => {
    if (loading || !hasMoreAssets || nextPagePendingRef.current) return;
    nextPagePendingRef.current = true;
    setAssetOffset((prev) => prev + SFX_BROWSE_PAGE_SIZE);
  }, [hasMoreAssets, loading]);

  const goBack = useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/');
  }, [navigate]);

  const goForward = useCallback(() => {
    navigate(1);
  }, [navigate]);

  const gridConfig = useMemo(() => {
    const desired = clamp(Math.round(columns), 1, 6);
    const cap = clamp(Number(columnsCap) || 6, 1, 6);
    const c = Math.min(desired, cap);
    const showGridWaveform = true;
    const gridWaveHeight = 76;
    return { columns: c, showGridWaveform, gridWaveHeight };
  }, [columns, columnsCap]);

  useEffect(() => {
    localStorage.setItem('sfx.columns', String(columns));
  }, [columns]);


  const updateIoRangeForAsset = useCallback((assetOrId, updater) => {
    const assetId = typeof assetOrId === 'string' ? assetOrId : assetOrId?.id;
    if (!assetId || typeof updater !== 'function') return;
    setAssetIoRanges((prev) => {
      const next = new Map(prev);
      const current = next.get(assetId) || { inPoint: null, outPoint: null };
      const updated = updater(current) || current;
      const normalized = {
        inPoint: typeof updated.inPoint === 'number' && Number.isFinite(updated.inPoint) ? updated.inPoint : null,
        outPoint: typeof updated.outPoint === 'number' && Number.isFinite(updated.outPoint) ? updated.outPoint : null,
      };
      if (normalized.inPoint === null && normalized.outPoint === null) next.delete(assetId);
      else next.set(assetId, normalized);
      return next;
    });
  }, []);

  const getResolvedIoForAsset = useCallback((asset) => {
    if (!asset?.id) return { inPoint: null, outPoint: null, hasIoRange: false };
    const storedRange = assetIoRanges.get(asset.id)
      || (activeAssetId === asset.id ? { inPoint, outPoint } : null);
    const normalizedIn = typeof storedRange?.inPoint === 'number' && Number.isFinite(storedRange.inPoint)
      ? storedRange.inPoint
      : null;
    const normalizedOut = typeof storedRange?.outPoint === 'number' && Number.isFinite(storedRange.outPoint)
      ? storedRange.outPoint
      : null;
    if (normalizedIn !== null && normalizedOut !== null && normalizedOut <= normalizedIn) {
      return { inPoint: null, outPoint: null, hasIoRange: false };
    }
    return {
      inPoint: normalizedIn,
      outPoint: normalizedOut,
      hasIoRange: normalizedIn !== null || normalizedOut !== null,
    };
  }, [activeAssetId, assetIoRanges, inPoint, outPoint]);

  const handleSelectedAssetChange = useCallback((asset) => {
    const prev = selectedAssetRef.current;
    selectedAssetRef.current = asset || null;
    setActiveAssetId(asset?.id || null);
    if (!asset) {
      setPlayerTime(0);
      setPlayerDuration(0);
      return;
    }
    if (prev?.id === asset.id) return;
    const resolvedDuration = getAssetDurationSeconds(asset);
    const audio = audioRef.current;
    if (playingAssetId && playingAssetId !== asset.id) {
      audio?.pause();
      setPlayingAssetId(null);
      setIsPlaying(false);
    }
    pendingSeekPctRef.current = null;
    setPlayerTime(0);
    setPlayerDuration(playingAssetId === asset.id && playerDuration > 0 ? playerDuration : resolvedDuration);
  }, [playingAssetId, playerDuration]);

  const handleWaveHoverPosition = useCallback((asset, pct, duration) => {
    if (!asset) return;
    const resolvedDuration = Number.isFinite(duration) && duration > 0
      ? duration
      : getAssetDurationSeconds(asset);
    const normalizedPct = clamp(Number(pct) || 0, 0, 1);
    hoverWaveRef.current = {
      asset,
      pct: normalizedPct,
      duration: resolvedDuration,
      time: resolvedDuration > 0 ? normalizedPct * resolvedDuration : null,
      at: Date.now(),
    };
  }, []);

  useEffect(() => {
    const markActive = () => {
      waveformLastActivityRef.current = Date.now();
      setWaveformSchedulerState((prev) => (
        prev.phase === 'background'
          ? { ...prev, phase: 'paused' }
          : prev
      ));
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart'];
    events.forEach((name) => window.addEventListener(name, markActive, true));
    const handleVisibility = () => markActive();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      events.forEach((name) => window.removeEventListener(name, markActive, true));
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  useEffect(() => {
    const visibleKeys = currentAssetPaths.map((path) => getWaveformCacheKey(path, WAVEFORM_GRID_SAMPLES));
    const missingVisibleKeys = visibleKeys.filter((key) => !(WAVEFORM_READY_KEYS.has(key) || WAVEFORM_MEMORY_CACHE.has(key)));
    waveformBackgroundSessionRef.current += 1;
    waveformPrioritySessionRef.current += 1;
    waveformBackgroundOffsetRef.current = 0;
    waveformGlobalKeysRef.current = new Set(visibleKeys);
    waveformPriorityKeysRef.current = new Set(visibleKeys);
    waveformLastActivityRef.current = Date.now();
    setWaveformSchedulerState({
      phase: !currentLibrary ? 'idle' : (missingVisibleKeys.length > 0 ? 'priority' : 'done'),
      total: Math.max(Number(navCountsState?.all || 0), visibleKeys.length),
      tracked: visibleKeys.length,
      priorityTotal: visibleKeys.length,
      priorityTracked: visibleKeys.length,
      libraryPath: currentLibrary || '',
    });
  }, [currentAssetPaths, currentLibrary, navCountsState?.all]);

  useEffect(() => {
    if (!currentLibrary) return () => {};
    let cancelled = false;
    const sessionId = waveformBackgroundSessionRef.current + 1;
    waveformBackgroundSessionRef.current = sessionId;

    const run = async () => {
      while (!cancelled && sessionId === waveformBackgroundSessionRef.current) {
        const totalGoal = Math.max(Number(navCountsState?.all || 0), waveformGlobalKeysRef.current.size);
        const idleLongEnough = !document.hidden && (Date.now() - waveformLastActivityRef.current) >= WAVEFORM_BACKGROUND_IDLE_MS;

        if (waveformAutofillPaused) {
          setWaveformSchedulerState((prev) => ({ ...prev, phase: 'paused', total: Math.max(totalGoal, prev.total) }));
          await sleep(800);
          continue;
        }

        if (!idleLongEnough) {
          setWaveformSchedulerState((prev) => ({
            ...prev,
            phase: prev.priorityTotal > prev.priorityTracked ? 'priority' : 'paused',
            total: Math.max(totalGoal, prev.total),
          }));
          await sleep(800);
          continue;
        }

        setWaveformSchedulerState((prev) => ({ ...prev, phase: 'background', total: Math.max(totalGoal, prev.total) }));

        try {
          const result = await fetchLibraryBrowsePage(currentLibrary, {
            offset: waveformBackgroundOffsetRef.current,
            limit: WAVEFORM_BACKGROUND_PAGE_SIZE,
            sortMode: 'name_asc',
          });
          if (cancelled || sessionId !== waveformBackgroundSessionRef.current) return;

          const items = Array.isArray(result.items) ? result.items : [];
          const backendTotal = Math.max(Number(result.total || 0), Number(navCountsState?.all || 0));
          if (items.length === 0) {
            waveformBackgroundOffsetRef.current = 0;
            setWaveformSchedulerState((prev) => ({ ...prev, phase: 'done', total: Math.max(backendTotal, prev.total) }));
            await sleep(1200);
            continue;
          }

          for (const item of items) {
            if (cancelled || sessionId !== waveformBackgroundSessionRef.current) return;
            const stillIdle = !document.hidden && (Date.now() - waveformLastActivityRef.current) >= WAVEFORM_BACKGROUND_IDLE_MS;
            if (waveformAutofillPaused || !stillIdle) {
              setWaveformSchedulerState((prev) => ({ ...prev, phase: waveformAutofillPaused ? 'paused' : 'priority', total: Math.max(backendTotal, prev.total) }));
              break;
            }
            if (!item?.path) continue;
            const key = getWaveformCacheKey(item.path, WAVEFORM_GRID_SAMPLES);
            waveformGlobalKeysRef.current.add(key);
            if (WAVEFORM_READY_KEYS.has(key) || WAVEFORM_MEMORY_CACHE.has(key)) continue;
            try {
              const payload = await fetchWaveformQueued(item.path, WAVEFORM_GRID_SAMPLES, { priority: WAVEFORM_PRIORITY_IDLE });
              if (Array.isArray(payload?.data) && payload.data.length > 0) {
                markWaveformReady(key);
                void persistWaveformData(key, payload);
              }
            } catch (error) {
              if (error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED') {
                break;
              }
            }
          }

          waveformBackgroundOffsetRef.current += items.length;
          if (waveformBackgroundOffsetRef.current >= backendTotal && backendTotal > 0) {
            waveformBackgroundOffsetRef.current = 0;
            setWaveformSchedulerState((prev) => ({ ...prev, phase: 'done', total: Math.max(backendTotal, prev.total) }));
          }
        } catch {
          setWaveformSchedulerState((prev) => ({ ...prev, phase: 'paused', total: Math.max(totalGoal, prev.total) }));
          await sleep(1500);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [currentLibrary, fetchLibraryBrowsePage, navCountsState?.all, waveformAutofillKick, waveformAutofillPaused]);

  const toggleFolder = useCallback((path) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleFolderSelection = useCallback((path) => {
    setSelectedFolderPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const FolderRow = memo(function FolderRow({ node, depth }) {
    const hasChildren = (node.children || []).length > 0;
    const expanded = expandedFolders.has(node.fullPath);
    const active = isLibraryRoute && selectedFolder === node.fullPath;
    const selected = selectedFolderPaths.has(node.fullPath);

    return (
      <div>
        <div
          className={`sfx-folder-row ${active ? 'active' : ''} ${selected ? 'selected' : ''}`}
          style={{ paddingLeft: `${10 + depth * 14}px` }}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey) {
              toggleFolderSelection(node.fullPath);
              return;
            }
            navigate(`/sfx/library?folder=${encodeURIComponent(node.fullPath)}`);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (hasChildren) {
              toggleFolder(node.fullPath);
            }
          }}
        >
          <div className="sfx-folder-left">
            {hasChildren ? (
              <button
                type="button"
                className="sfx-folder-toggle"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFolder(node.fullPath);
                }}
              >
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            ) : (
              <div className="sfx-folder-toggle-spacer" />
            )}
            <div className="sfx-folder-icon">
              {expanded && hasChildren ? <FolderOpen size={16} /> : <Folder size={16} />}
            </div>
            <div className="sfx-folder-name">{node.name}</div>
          </div>
          <div className="sfx-folder-count">{node.count || 0}</div>
        </div>
        {hasChildren && expanded
          ? node.children.map((c) => <FolderRow key={c.fullPath} node={c} depth={depth + 1} />)
          : null}
      </div>
    );
  });

  const toggleFavorite = async (assetId) => {
    const current = assets.find((a) => a.id === assetId);
    if (!current) return;
    const currentFavorite = favoriteOverrides.has(assetId) ? favoriteOverrides.get(assetId) : current.favorite;
    const nextFavorite = !currentFavorite;
    setFavoriteOverrides((prev) => {
      const next = new Map(prev);
      next.set(assetId, nextFavorite);
      return next;
    });
    startTransition(() => {
      setAssets((prev) => prev.map((a) => (a.id === assetId ? { ...a, favorite: nextFavorite } : a)));
    });
    try {
      await axios.post(`${API_BASE_URL}/api/sound-effects/meta/favorite`, { asset_key: assetId, favorite: nextFavorite });
      setFavoriteOverrides((prev) => {
        if (!prev.has(assetId)) return prev;
        const next = new Map(prev);
        next.delete(assetId);
        return next;
      });
      if (currentLibrary) void refreshLibrarySummary(currentLibrary);
    } catch {
      setFavoriteOverrides((prev) => {
        if (!prev.has(assetId)) return prev;
        const next = new Map(prev);
        next.delete(assetId);
        return next;
      });
      startTransition(() => {
        setAssets((prev) => prev.map((a) => (a.id === assetId ? { ...a, favorite: !nextFavorite } : a)));
      });
      showToast({ type: 'error', message: '收藏更新失败' });
    }
  };

  const addTag = async (assetId, tag) => {
    const t = String(tag).trim();
    if (!t) return;
    const normalized = t.toLowerCase();
    const current = assets.find((a) => a.id === assetId);
    if (!current) return;
    if ((current.tags || []).some((x) => String(x).toLowerCase() === normalized)) return;
    setAssets((prev) => prev.map((a) => (a.id === assetId ? { ...a, tags: [...(a.tags || []), t] } : a)));
    try {
      await axios.post(`${API_BASE_URL}/api/sound-effects/meta/tag/add`, { asset_key: assetId, tag: t });
      if (currentLibrary) void refreshLibrarySummary(currentLibrary);
    } catch {
      setAssets((prev) => prev.map((a) => (a.id === assetId ? { ...a, tags: (a.tags || []).filter((x) => String(x).toLowerCase() !== normalized) } : a)));
      showToast({ type: 'error', message: '标签更新失败' });
    }
  };

  const removeTag = async (assetId, tag) => {
    const normalized = String(tag).trim().toLowerCase();
    if (!normalized) return;
    const current = assets.find((a) => a.id === assetId);
    if (!current) return;
    if (!(current.tags || []).some((x) => String(x).toLowerCase() === normalized)) return;
    setAssets((prev) => prev.map((a) => (a.id === assetId ? { ...a, tags: (a.tags || []).filter((x) => String(x).toLowerCase() !== normalized) } : a)));
    try {
      await axios.post(`${API_BASE_URL}/api/sound-effects/meta/tag/remove`, { asset_key: assetId, tag });
      if (currentLibrary) void refreshLibrarySummary(currentLibrary);
    } catch {
      setAssets((prev) => prev.map((a) => (a.id === assetId ? { ...a, tags: [...(a.tags || []), tag] } : a)));
      showToast({ type: 'error', message: '标签更新失败' });
    }
  };

  const clearFolderSelection = () => setSelectedFolderPaths(new Set());

  const bulkAddTag = async (tag, assetIds) => {
    const t = String(tag).trim();
    if (!t) return;
    const idSet = new Set(Array.isArray(assetIds) ? assetIds : []);
    const list = Array.from(idSet);
    if (list.length === 0 && selectedFolderPaths.size === 0) return;
    setAssets((prev) => prev.map((a) => (idSet.has(a.id) && !(a.tags || []).some((x) => String(x).toLowerCase() === t.toLowerCase()) ? { ...a, tags: [...(a.tags || []), t] } : a)));
    try {
      await axios.post(`${API_BASE_URL}/api/sound-effects/meta/tag/bulk-add`, {
        asset_keys: list,
        tag: t,
        library_path: currentLibrary,
        folder_paths: Array.from(selectedFolderPaths)
      });
      if (currentLibrary) void refreshLibrarySummary(currentLibrary);
    } catch {
      if (currentLibrary) {
        await refreshLibrarySummary(currentLibrary);
      }
      showToast({ type: 'error', message: '批量标签失败' });
    }
  };

  const bulkRemoveTag = async (tag, assetIds) => {
    const t = String(tag).trim();
    if (!t) return;
    const idSet = new Set(Array.isArray(assetIds) ? assetIds : []);
    const list = Array.from(idSet);
    if (list.length === 0 && selectedFolderPaths.size === 0) return;
    const normalized = t.toLowerCase();
    setAssets((prev) => prev.map((a) => (idSet.has(a.id) ? { ...a, tags: (a.tags || []).filter((x) => String(x).toLowerCase() !== normalized) } : a)));
    try {
      await axios.post(`${API_BASE_URL}/api/sound-effects/meta/tag/bulk-remove`, {
        asset_keys: list,
        tag: t,
        library_path: currentLibrary,
        folder_paths: Array.from(selectedFolderPaths)
      });
      if (currentLibrary) void refreshLibrarySummary(currentLibrary);
    } catch {
      if (currentLibrary) {
        await refreshLibrarySummary(currentLibrary);
      }
      showToast({ type: 'error', message: '批量删除标签失败' });
    }
  };

  const collectSelected = async (assetIds) => {
    if (importSession) {
      showToast({ type: 'info', message: '请先完成当前导入' });
      return;
    }
    if (!resolveStatus.connected) {
      showToast({ type: 'error', message: '请先连接达芬奇' });
      return;
    }
    if (!projectContext?.local_path) {
      showToast({ type: 'error', message: '请先初始化项目（需要本地项目目录）' });
      return;
    }
    const idSet = new Set(Array.isArray(assetIds) ? assetIds : []);
    const list = Array.from(idSet);
    if (list.length === 0 && selectedFolderPaths.size === 0) return;
    try {
      const res = await axios.post(`${API_BASE_URL}/api/sound-effects/collect`, {
        asset_keys: list,
        library_path: currentLibrary,
        folder_paths: Array.from(selectedFolderPaths)
      });
      const copied = res.data?.copied?.length || 0;
      const failed = res.data?.failed?.length || 0;
      showToast({ type: failed > 0 ? 'info' : 'success', message: `已打包 ${copied} 个${failed > 0 ? `，失败 ${failed} 个` : ''}` });
    } catch (e) {
      showToast({ type: 'error', message: e.response?.data?.detail || '打包失败' });
    }
  };

  const showToast = useCallback((next) => {
    setToast(next);
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => setToast(null), 3500);
  }, []);

  const ensureDragIconPath = async () => {
    if (dragIconPathPromiseRef.current) return dragIconPathPromiseRef.current;
    dragIconPathPromiseRef.current = (async () => {
      const dir = await appCacheDir();
      const iconPath = await join(dir, DRAG_ICON_FILENAME);
      await mkdir(dir, { recursive: true });
      await writeFile(iconPath, base64ToBytes(DRAG_ICON_BASE64));
      return iconPath;
    })();
    return dragIconPathPromiseRef.current;
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = clamp(playerVolume, 0, 1);
    audio.playbackRate = clamp(playerRate, 0.25, 4);
  }, [playerVolume, playerRate]);

  useEffect(() => {
    if (!playingAssetId) return;
    if (assets.some((a) => a.id === playingAssetId)) return;
    const audio = audioRef.current;
    audio?.pause();
    setPlayingAssetId(null);
    setIsPlaying(false);
    setPlayerTime(0);
    setPlayerDuration(0);
  }, [assets, playingAssetId]);

  const togglePlay = async (asset, startPct) => {
    const audio = audioRef.current;
    if (!audio || !asset?.path) return;
    const selectedAsset = selectedAssetRef.current;
    const getDesiredStartPct = (duration) => {
      if (typeof startPct === 'number') return clamp(startPct, 0, 1);
      const range = getPlaybackRange(duration, inPointRef.current, outPointRef.current);
      if (range) return clamp(range.start / duration, 0, 1);
      if (selectedAsset?.id === asset.id && Number.isFinite(playerTime) && duration > 0 && playerTime > 0) {
        return clamp(playerTime / duration, 0, 1);
      }
      return null;
    };

    const ext = String(asset.extension || '').toLowerCase();
    if (ext && !['.wav', '.mp3', '.m4a', '.aac', '.aiff', '.aif'].includes(ext)) {
      showToast({ type: 'info', message: `该格式可能无法在播放器中解码：${ext}（建议 wav/mp3/m4a/aac）` });
    }

    if (playingAssetId === asset.id) {
      if (typeof startPct === 'number') {
        seekTo(asset, startPct);
        return;
      }
      if (audio.paused) {
        const resumePct = getDesiredStartPct(audio.duration);
        if (typeof resumePct === 'number' && Number.isFinite(audio.duration) && audio.duration > 0) {
          const nextTime = resumePct * audio.duration;
          audio.currentTime = nextTime;
          setPlayerTime(nextTime);
        }
        try {
          await audio.play();
        } catch {
          showToast({ type: 'error', message: '音频无法播放（请检查文件权限/格式）' });
        }
      } else {
        audio.pause();
      }
      return;
    }

    audio.pause();
    audio.currentTime = 0;
    setPlayerTime(0);
    setPlayerDuration(0);
    setPlayingAssetId(asset.id);

    const rawSrc = `${API_BASE_URL}/api/sound-effects/raw?path=${encodeURIComponent(asset.path)}&v=${encodeURIComponent(asset.modified || '')}`;
    const previewSrc = `${API_BASE_URL}/api/sound-effects/preview?path=${encodeURIComponent(asset.path)}&v=${encodeURIComponent(asset.modified || '')}`;
    const token = `${asset.id}::${String(asset.modified || '')}`;
    const preferPreview = ext && !['.wav', '.mp3', '.m4a', '.aac'].includes(ext);
    playbackFallbackRef.current = { token, triedPreview: preferPreview, retries: 0 };
    const scheduleRetry = () => {
      const st = playbackFallbackRef.current;
      if (!st || st.token !== token) return;
      if (st.retries >= 2) return;
      st.retries += 1;
      window.setTimeout(() => {
        const now = playbackFallbackRef.current;
        if (!now || now.token !== token) return;
        audio.play().catch(() => {});
      }, 600 * st.retries);
    };

    audio.onerror = () => {
      const st = playbackFallbackRef.current;
      if (!st || st.token !== token) return;
      if (!st.triedPreview) {
        st.triedPreview = true;
        audio.src = previewSrc;
        audio.play().catch(() => scheduleRetry());
        return;
      }
      scheduleRetry();
      if (st.retries >= 2) showToast({ type: 'error', message: '音频无法播放（请检查文件权限/格式）' });
    };
    const fallbackDuration = getAssetDurationSeconds(asset);
    const desiredStartPct = getDesiredStartPct(fallbackDuration);
    if (typeof desiredStartPct === 'number') pendingSeekPctRef.current = desiredStartPct;
    audio.src = preferPreview ? previewSrc : rawSrc;
    audio.volume = clamp(playerVolume, 0, 1);
    audio.playbackRate = clamp(playerRate, 0.25, 4);

    try {
      await audio.play();
    } catch {
      if (preferPreview) {
        scheduleRetry();
        return;
      }
      audio.src = previewSrc;
      try {
        await audio.play();
      } catch {
        scheduleRetry();
        const st = playbackFallbackRef.current;
        if (!st || st.token !== token) return;
        if (st.retries >= 2) showToast({ type: 'error', message: '音频无法播放（请检查文件权限/格式）' });
      }
    }
  };

  useEffect(() => {
    togglePlayRef.current = togglePlay;
  }, [togglePlay]);

  const previewSeekTo = useCallback((asset, pct) => {
    if (!asset) return;
    const nextPct = clamp(pct, 0, 1);
    const audio = audioRef.current;
    if (playingAssetId === asset.id && audio) {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        const nextTime = nextPct * audio.duration;
        audio.currentTime = nextTime;
        setPlayerTime(nextTime);
        setPlayerDuration(audio.duration || 0);
        return;
      }
      pendingSeekPctRef.current = nextPct;
    }
    const fallbackDuration = getAssetDurationSeconds(asset);
    if (fallbackDuration > 0) {
      setPlayerDuration(fallbackDuration);
      setPlayerTime(nextPct * fallbackDuration);
      return;
    }
    setPlayerTime(0);
  }, [playingAssetId]);

  const seekTo = (asset, pct) => {
    if (!asset) return;
    const audio = audioRef.current;
    if (!audio) return;
    if (playingAssetId !== asset.id) {
      void togglePlay(asset, pct);
      return;
    }
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
      pendingSeekPctRef.current = clamp(pct, 0, 1);
      audio.play().catch(() => {});
      return;
    }
    const range = getPlaybackRange(audio.duration, inPointRef.current, outPointRef.current);
    const nextPct = clamp(pct, 0, 1);
    const unclampedTime = nextPct * audio.duration;
    const nextTime = range
      ? clamp(unclampedTime, range.start, Math.max(range.start, range.end - 0.01))
      : unclampedTime;
    audio.currentTime = nextTime;
    setPlayerTime(nextTime);
    if (audio.paused) {
      audio.play().catch(() => {});
    }
  };

  const setInOutRange = useCallback((assetOrA, aOrB, maybeB) => {
    const targetAsset = (assetOrA && typeof assetOrA === 'object') ? assetOrA : selectedAssetRef.current;
    const x = Number((assetOrA && typeof assetOrA === 'object') ? aOrB : assetOrA);
    const y = Number((assetOrA && typeof assetOrA === 'object') ? maybeB : aOrB);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const from = Math.min(x, y);
    const to = Math.max(x, y);
    if (!targetAsset?.id) return;
    setActiveAssetId(targetAsset.id);
    updateIoRangeForAsset(targetAsset, () => ({ inPoint: from, outPoint: to }));
    // 将播放头跳到 I/O 起点
    const audio = audioRef.current;
    if (playingAssetId === targetAsset.id && audio && Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = clamp(from, 0, audio.duration);
      setPlayerTime(from);
    } else {
      setPlayerTime(from);
      setPlayerDuration(getAssetDurationSeconds(targetAsset));
    }
  }, [updateIoRangeForAsset, playingAssetId]);

  const clearInOutRange = useCallback((assetOrId) => {
    const assetId = typeof assetOrId === 'string' ? assetOrId : assetOrId?.id;
    if (!assetId) return;
    if (activeAssetId === assetId) {
      setActiveAssetId(assetId);
    }
    updateIoRangeForAsset(assetId, () => ({ inPoint: null, outPoint: null }));
  }, [activeAssetId, updateIoRangeForAsset]);

  useEffect(() => {
    const isEditableTarget = (t) => {
      const el = t instanceof HTMLElement ? t : null;
      if (!el) return false;
      if (el.isContentEditable) return true;
      const tag = (el.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      return false;
    };

    const onKeyDown = (e) => {
      if (isEditableTarget(e.target)) return;
      const getCueSource = () => {
        const hovered = hoverWaveRef.current;
        if (
          hovered?.asset
          && Number.isFinite(hovered?.time)
          && Number.isFinite(hovered?.duration)
          && hovered.duration > 0
          && (Date.now() - Number(hovered.at || 0)) < 2000
        ) {
          return {
            candidate: hovered.asset,
            duration: hovered.duration,
            baseTime: hovered.time,
          };
        }
        const audio = audioRef.current;
        const candidate = selectedAssetRef.current || assets.find((a) => a.id === playingAssetId) || null;
        if (!candidate) return null;
        const duration = playingAssetId === candidate.id && audio && Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : getAssetDurationSeconds(candidate);
        const baseTime = playingAssetId === candidate.id && audio && Number.isFinite(audio.currentTime)
          ? audio.currentTime
          : playerTime;
        return { candidate, duration, baseTime };
      };

      if (e.metaKey) {
        const key = e.key;
        if (key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract') {
          e.preventDefault();
          setColumns((v) => clamp(Math.round(v) + 1, 1, 6));
          return;
        }
        if (key === '=' || key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd') {
          e.preventDefault();
          setColumns((v) => clamp(Math.round(v) - 1, 1, 6));
          return;
        }
      }

      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        const cue = getCueSource();
        const candidate = cue?.candidate || null;
        if (!candidate) return;
        const candidateIo = candidate?.id ? assetIoRanges.get(candidate.id) : null;
        const candidateDuration = cue?.duration && Number.isFinite(cue.duration) && cue.duration > 0
          ? cue.duration
          : getAssetDurationSeconds(candidate);
        const range = getPlaybackRange(candidateDuration, candidateIo?.inPoint, candidateIo?.outPoint);
        const startPct = range ? clamp(range.start / candidateDuration, 0, 1) : undefined;
        togglePlayRef.current?.(candidate, startPct);
        return;
      }

      if (e.key === 'Escape') {
        const cue = getCueSource();
        const candidate = cue?.candidate || selectedAssetRef.current || null;
        if (!candidate?.id) return;
        e.preventDefault();
        clearInOutRange(candidate);
        return;
      }

      if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        const cue = getCueSource();
        if (!cue?.candidate) return;
        setActiveAssetId(cue.candidate.id);
        const { duration, baseTime } = cue;
        const nextInPoint = clamp(baseTime, 0, Number.isFinite(duration) && duration > 0 ? duration : baseTime);
        updateIoRangeForAsset(cue.candidate, (prev) => ({
          inPoint: nextInPoint,
          outPoint: typeof prev.outPoint === 'number' && Number.isFinite(prev.outPoint) && prev.outPoint >= nextInPoint
            ? prev.outPoint
            : null,
        }));
        return;
      }

      if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        const cue = getCueSource();
        if (!cue?.candidate) return;
        setActiveAssetId(cue.candidate.id);
        const { duration, baseTime } = cue;
        const nextOutPoint = clamp(baseTime, 0, Number.isFinite(duration) && duration > 0 ? duration : baseTime);
        updateIoRangeForAsset(cue.candidate, (prev) => ({
          inPoint: typeof prev.inPoint === 'number' && Number.isFinite(prev.inPoint) && prev.inPoint <= nextOutPoint
            ? prev.inPoint
            : null,
          outPoint: nextOutPoint,
        }));
      }
    };

    window.addEventListener('keydown', onKeyDown, { passive: false, capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [assets, assetIoRanges, clearInOutRange, playingAssetId, playerTime, updateIoRangeForAsset]);

  const resolveStatusRef = useLatest(resolveStatus);
  const projectContextRef = useLatest(projectContext);

  const dragToResolve = useCallback(async (asset, sourceSurface = 'detail_button') => {
    if (!asset?.path) return;
    if (importSession || importPreparing) {
      showToast({ type: 'info', message: '请先完成当前导入' });
      return;
    }

    if (!resolveStatusRef.current?.connected) {
      showToast({ type: 'error', message: '请先连接达芬奇' });
      return;
    }
    if (!projectContextRef.current?.local_path) {
      showToast({ type: 'error', message: '请先初始化项目（需要本地项目目录）' });
      return;
    }

    try {
      setImportPreparing(true);
      selectedAssetRef.current = asset;
      setActiveAssetId(asset.id || null);
      const ioRange = getResolvedIoForAsset(asset);
      // 1. 先调用 press API，确保项目内副本和 Resolve 媒体池条目都已准备好
      let pressOk = false;
      let sessionId = '';
      let localCopyPath = '';
      try {
        const res = await axios.post(`${API_BASE_URL}/api/sound-effects/press`, {
          source_path: asset.path,
          source_relative_path: asset.relativePath || asset.relative_path || '',
          in_point: ioRange.inPoint,
          out_point: ioRange.outPoint,
          drag_source: sourceSurface,
          drag_probe_path: '',
          drag_probe_name: '',
          drag_probe_token: '',
        });
        if (res.data?.status === 'success') {
          sessionId = res.data.session_id;
          localCopyPath = res.data.local_copy_path || res.data.client_copy_params?.dest_path || '';

          // 如果 Python 进程无权限，通过 Tauri 原生 API 完成文件操作
          if (res.data.need_client_copy) {
            const params = res.data.client_copy_params;
            if (!params) {
              showToast({ type: 'error', message: '缺少客户端复制参数' });
            } else {
              try {
                await mkdir(params.dest_dir, { recursive: true });
                await copyFile(params.source_path, params.dest_path);
                localCopyPath = params.dest_path;
                await axios.post(`${API_BASE_URL}/api/sound-effects/press/confirm`, {
                  session_id: sessionId,
                  local_copy_path: params.dest_path,
                });
                pressOk = true;
              } catch (copyErr) {
                showToast({ type: 'error', message: `Tauri 复制文件失败: ${copyErr?.message || copyErr}` });
              }
            }
          } else {
            pressOk = true;
          }

          if (pressOk) {
            // Direct drag-and-drop is a silent workflow; keep session local and avoid extra floating panels.
          }
        } else {
          const msg = res.data?.message || res.data?.detail || (typeof res.data === 'string' ? res.data : '') || '获取项目内文件路径失败';
          showToast({ type: 'error', message: msg });
        }
      } catch (e) {
        const detail = e?.response?.data?.detail || e?.response?.data?.message;
        const message = e?.message || (typeof e === 'string' ? e : '');
        showToast({ type: 'error', message: detail || message || '获取目标路径失败' });
      }

      if (!pressOk || !sessionId || !localCopyPath) {
        setImportSession(null);
        return;
      }

      // 2. 项目内副本和媒体池条目准备完成后，再开始向 Resolve 拖拽稳定副本
      let dragDoneResolve = null;
      let dragFailed = false;
      let dragError = '';
      const dragDonePromise = new Promise((resolve) => { dragDoneResolve = resolve; });
      startDrag({ item: [localCopyPath], icon: await ensureDragIconPath(), mode: 'copy' }, (payload) => dragDoneResolve(payload))
        .catch((e) => {
          dragFailed = true;
          dragError = e?.message || String(e);
          console.error('[SFX] startDrag IPC 失败:', dragError);
          dragDoneResolve({ result: 'Cancelled', error: dragError });
        });

      // 3. 等待拖拽完成后调用 release
      const payload = await dragDonePromise;

      // 如果 startDrag 的 IPC 调用本身就失败了，拖拽根本没有发起
      if (dragFailed) {
        setImportSession(null);
        // 清理后端 session（让后端自动删除副本）
        try { await axios.post(`${API_BASE_URL}/api/sound-effects/release`, { session_id: sessionId }); } catch {}
        showToast({ type: 'error', message: `拖拽启动失败: ${dragError || '未知错误'}\n请从项目文件夹手动拖入达芬奇` });
        setImportPreparing(false);
        return;
      }

      const dropped = payload?.result !== 'Cancelled';
      try {
        if (dropped) {
          await new Promise((resolve) => window.setTimeout(resolve, 320));
        }
        const rel = await axios.post(`${API_BASE_URL}/api/sound-effects/release`, { session_id: sessionId });
        if (rel.data?.status === 'success') {
          if (rel.data.action === 'used') {
            setAssets((prev) => prev.map((a) => (a.id === asset.id ? { ...a, usedCount: (a.usedCount || 0) + 1, lastUsedDays: 0 } : a)));
            if (currentLibrary) void refreshLibrarySummary(currentLibrary);
            if (ioRange.hasIoRange && !rel.data.trim_applied) {
              const trimError = String(rel.data?.trim_error || '').trim();
              const trimMessage = trimError === 'ambiguous_clip_match'
                ? '时间线上检测到多个候选片段，未自动套用 IO'
                : (trimError || rel.data?.trim_result?.message || '已导入整段，IO 未应用');
              showToast({ type: 'info', message: trimMessage });
            }
          } else if (rel.data.action === 'deleted') {
            // 用户取消拖拽或未落入时间线时，静默清理副本。
          }
        } else {
          showToast({ type: 'error', message: rel.data?.message || '完成导入失败' });
        }
      } catch (e) {
        const detail = e?.response?.data?.detail;
        showToast({ type: 'error', message: detail || '完成导入失败' });
      } finally {
        setImportSession(null);
      }
    } catch (e) {
      const detail = e?.response?.data?.detail || e?.response?.data?.message;
      const message = e?.message || (typeof e === 'string' ? e : '');
      const fallback = !detail && !message ? (() => {
        try { return JSON.stringify(e); } catch { return ''; }
      })() : '';
      showToast({ type: 'error', message: detail || message || fallback || '准备拖拽失败' });
    } finally {
      setImportPreparing(false);
    }
  }, [currentLibrary, getResolvedIoForAsset, importPreparing, importSession, refreshLibrarySummary]);

  const prepareImport = async (asset) => {
    if (!asset?.path) return;
    if (importSession) {
      showToast({ type: 'info', message: '请先完成当前导入' });
      return;
    }
    if (!resolveStatus.connected) {
      showToast({ type: 'error', message: '请先连接达芬奇' });
      return;
    }
    if (!projectContext?.local_path) {
      showToast({ type: 'error', message: '请先初始化项目（需要本地项目目录）' });
      return;
    }
    try {
      setImportPreparing(true);
      const res = await axios.post(`${API_BASE_URL}/api/sound-effects/press`, {
        source_path: asset.path,
        source_relative_path: asset.relativePath || ''
      });
      if (res.data.status === 'success') {
        let localCopyPath = res.data.local_copy_path || res.data.client_copy_params?.dest_path || '';
        let filename = res.data.filename || '';

        if (res.data.need_client_copy) {
          const params = res.data.client_copy_params;
          if (!params) {
            showToast({ type: 'error', message: '缺少客户端复制参数' });
            setImportPreparing(false);
            return;
          }
          try {
            await mkdir(params.dest_dir, { recursive: true });
            await copyFile(params.source_path, params.dest_path);
            localCopyPath = params.dest_path;
            filename = params.filename;
            await axios.post(`${API_BASE_URL}/api/sound-effects/press/confirm`, {
              session_id: res.data.session_id,
              local_copy_path: params.dest_path,
            });
          } catch (copyErr) {
            showToast({ type: 'error', message: `Tauri 复制文件失败: ${copyErr?.message || copyErr}` });
            setImportPreparing(false);
            return;
          }
        }

        setImportSession({
          assetId: asset.id,
          assetName: asset.name,
          sessionId: res.data.session_id,
          localCopyPath,
          filename
        });
      } else {
        showToast({ type: 'error', message: res.data.message || '准备导入失败' });
      }
    } catch (e) {
      showToast({ type: 'error', message: e.response?.data?.detail || '准备导入失败' });
    } finally {
      setImportPreparing(false);
    }
  };

  const finalizeImport = async () => {
    if (!importSession?.sessionId) return;
    const assetId = importSession.assetId;
    try {
      const res = await axios.post(`${API_BASE_URL}/api/sound-effects/release`, {
        session_id: importSession.sessionId
      });
      if (res.data.status === 'success') {
        const action = res.data.action;
        if (action === 'used') {
          setAssets((prev) => prev.map((a) => (a.id === assetId ? { ...a, usedCount: (a.usedCount || 0) + 1, lastUsedDays: 0 } : a)));
          if (currentLibrary) void refreshLibrarySummary(currentLibrary);
        }
      } else {
        showToast({ type: 'error', message: res.data.message || '完成导入失败' });
      }
    } catch (e) {
      showToast({ type: 'error', message: e.response?.data?.detail || '完成导入失败' });
    } finally {
      setImportSession(null);
    }
  };

  const insertToTimeline = useCallback(async (asset) => {
    if (!asset?.path) return;
    if (importSession || importPreparing) {
      showToast({ type: 'info', message: '请先完成当前导入' });
      return;
    }
    if (!resolveStatusRef.current?.connected) {
      showToast({ type: 'error', message: '请先连接达芬奇' });
      return;
    }
    if (!projectContextRef.current?.local_path) {
      showToast({ type: 'error', message: '请先初始化项目（需要本地项目目录）' });
      return;
    }

    setImportPreparing(true);
    const ioRange = getResolvedIoForAsset(asset);
    try {
      const res = await axios.post(`${API_BASE_URL}/api/sound-effects/insert-to-timeline`, {
        ...buildSfxInsertToTimelinePayload(asset, ioRange),
      });
      if (res.data?.status === 'success') {
        showToast({
          type: 'success',
          message: `已插入到轨道 ${res.data.track_index}（播放头位置${typeof res.data.record_frame === 'number' ? ' #' + res.data.record_frame : ''}）`,
        });
      } else {
        showToast({ type: 'error', message: res.data?.message || '插入失败' });
      }
    } catch (e) {
      showToast({ type: 'error', message: e.response?.data?.detail || e.message || '插入时间线失败' });
    } finally {
      setImportPreparing(false);
    }
  }, [getResolvedIoForAsset, importPreparing, importSession, projectContextRef, resolveStatusRef, showToast]);

  const cancelImport = async () => {
    if (!importSession?.sessionId) {
      setImportSession(null);
      return;
    }
    try {
      await axios.post(`${API_BASE_URL}/api/sound-effects/release`, { session_id: importSession.sessionId });
    } catch {}
    setImportSession(null);
    showToast({ type: 'info', message: '已取消导入' });
  };

  const copyImportPath = async () => {
    const p = importSession?.localCopyPath || '';
    if (!p) return;
    try {
      await navigator.clipboard.writeText(p);
      showToast({ type: 'success', message: '已复制项目内音效路径' });
    } catch {
      showToast({ type: 'error', message: '复制失败' });
    }
  };

  const handleAddLibrary = async () => {
    if (!window.electronAPI?.selectDirectory) return;
    const dir = await window.electronAPI.selectDirectory({ title: '选择音效库目录' });
    if (!dir) return;
    const base = config || { library_path: '', save_subfolder: '音效', davinci_folder: '音效', folder_depth: 1, folder_depth_direction: 'forward' };
    const newConfig = { ...base, library_path: dir };
    try {
      const res = await axios.post(`${API_BASE_URL}/api/sound-effects/config`, newConfig);
      if (res.data.status === 'success') {
        setConfig(newConfig);
        setLibrary(dir);
        setCurrentLibrary(dir);
        localStorage.setItem('sfx.currentLibrary', dir);
        navigate('/sfx/library');
        await scanLibrary(dir, {
          forceRefresh: true,
          bootstrapParams: {
            query: '',
            selectedFolder: '',
            forcedTag: '',
            favoriteOnly: false,
            untaggedOnly: false,
            sortMode: 'name_asc',
            smartRules: {},
            offset: 0,
            limit: SFX_BROWSE_PAGE_SIZE,
          },
        });
      }
    } catch {}
  };

  const handleRefresh = async () => {
    if (!currentLibrary) return;
    startIndexStatusPolling(currentLibrary, {
      stage: 'rebuilding',
      message: '正在重建本地索引…',
      processed_files: 0,
      processed_dirs: 0,
      current_path: currentLibrary,
    });
    await scanLibrary(currentLibrary, {
      forceRefresh: true,
      bootstrapParams: {
        query: deferredQuery,
        selectedFolder: isLibraryRoute ? selectedFolder : '',
        forcedTag: browseContext.forcedTag,
        favoriteOnly: filterFavoriteOnly,
        untaggedOnly: filterUntaggedOnly,
        sortMode,
        smartRules: browseContext.smartRules,
        offset: assetOffset,
        limit: SFX_BROWSE_PAGE_SIZE,
      },
    });
  };

  const browserPagingProps = {
    serverFiltered: true,
    totalCount: assetTotal,
    loadedCount: assets.length,
    hasMore: hasMoreAssets,
    onRequestNextPage: requestNextAssetPage,
    scrollResetKey: browseScopeKey,
  };

  return (
    <div className="app-container sfx-workspace">
      <aside className="sidebar sfx-sidebar">
        <div className="sidebar-native-titlebar-spacer" />
        <div className="sidebar-header sfx-sidebar-header">
          <div className="sfx-brand-row">
            <div className="sfx-brand">
              <div className="sfx-brand-title">SFX Manager</div>
              <div className="sfx-brand-badge">PRO</div>
            </div>
            <button className="sfx-icon-btn" type="button" title="退出音效管理" onClick={() => navigate('/')}>
              <LogOut size={16} />
            </button>
          </div>
        </div>

        <div className="nav-body-container" style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div className="nav-body" style={{ flex: 1, overflowY: 'auto' }}>
            <div className="nav-group">
              <SfxNavItem
                active={isLibraryRoute && !selectedFolder}
                icon={Library}
                label="全部音效"
                onClick={() => navigate('/sfx/library')}
                rightSlot={<span className="sfx-nav-count">{navCounts.all.toLocaleString()}</span>}
              />
              <div style={{ marginTop: '6px' }}>
                {folderTree.map((node) => (
                  <FolderRow key={node.fullPath} node={node} depth={0} />
                ))}
              </div>
            </div>

            <div className="nav-group">
              <div className="nav-label">视图</div>
              <SfxNavItem
                active={isActive('/sfx/favorites')}
                icon={Heart}
                label="收藏夹"
                onClick={() => navigate('/sfx/favorites')}
                rightSlot={<span className="sfx-nav-count">{navCounts.favorites.toLocaleString()}</span>}
              />
              <SfxNavItem
                active={isActive('/sfx/recent')}
                icon={Clock}
                label="最近使用"
                onClick={() => navigate('/sfx/recent')}
                rightSlot={<span className="sfx-nav-count">{navCounts.recent.toLocaleString()}</span>}
              />
              <SfxNavItem
                active={isActive('/sfx/project-used')}
                icon={FolderCheck}
                label="当前项目已使用"
                onClick={() => navigate('/sfx/project-used')}
              />
            </div>

            <div className="nav-group">
              <div className="nav-label">标签</div>
              {tags.slice(0, 50).map(({ t, count }) => (
                <SfxNavItem
                  key={t}
                  active={isActive(`/sfx/tags/${t}`)}
                  icon={Tag}
                  label={t}
                  onClick={() => navigate(`/sfx/tags/${t}`)}
                  rightSlot={<span className="sfx-nav-count">{count}</span>}
                />
              ))}
              {tags.length > 50 ? (
                <div style={{ fontSize: 10, color: 'var(--mac-text-secondary)', padding: '4px 10px', textAlign: 'center' }}>
                  仅显示前 50 个标签
                </div>
              ) : null}
            </div>

            <div className="nav-group">
              <div className="nav-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>智能文件夹</span>
                <button className="sfx-icon-btn sfx-icon-btn-sm" type="button" onClick={() => setShowSmartFolderModal(true)} title="新建智能文件夹">
                  <Plus size={14} />
                </button>
              </div>
              {smartFolderDefs.map((sf) => (
                <SfxNavItem
                  key={sf.id}
                  active={isActive(`/sfx/smart/${sf.id}`)}
                  icon={Sparkles}
                  label={sf.name}
                  onClick={() => navigate(`/sfx/smart/${sf.id}`)}
                />
              ))}
            </div>

            <div className="nav-group">
              <div className="nav-label">设置</div>
              <SfxNavItem
                active={isActive('/sfx/settings')}
                icon={Settings}
                label="音效设置"
                onClick={() => navigate('/sfx/settings')}
              />
            </div>
          </div>
        </div>
      </aside>

      <main ref={mainContentRef} className="main-content sfx-main">
        <header className="header sfx-header">
          <div className="sfx-header-row">
            <div className="nav-actions-container" style={{ WebkitAppRegion: 'no-drag' }}>
              <button className="nav-action-btn" type="button" onClick={goBack}>
                <ChevronLeft size={16} strokeWidth={2.5} />
              </button>
              <button className="nav-action-btn" type="button" onClick={goForward}>
                <ChevronRight size={16} strokeWidth={2.5} />
              </button>
            </div>
            <div className="sfx-search" style={{ WebkitAppRegion: 'no-drag' }}>
              <Search size={16} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索音效、标签、描述…" />
            </div>
            <div ref={toolbarRef} className="sfx-toolbar" style={{ WebkitAppRegion: 'no-drag' }}>
              <div className="sfx-popover-anchor">
                <button
                  className="sfx-pill"
                  type="button"
                  onClick={() => {
                    setSortOpen((v) => !v);
                    setFilterOpen(false);
                  }}
                >
                <ArrowUpDown size={14} />
                <span>排序</span>
                </button>
                {sortOpen ? (
                  <div className="sfx-popover">
                    <button className="sfx-popover-item" type="button" onClick={() => { setSortMode('name_asc'); setSortOpen(false); }}>名称 A→Z</button>
                    <button className="sfx-popover-item" type="button" onClick={() => { setSortMode('name_desc'); setSortOpen(false); }}>名称 Z→A</button>
                    <button className="sfx-popover-item" type="button" onClick={() => { setSortMode('used_desc'); setSortOpen(false); }}>使用次数 ↓</button>
                    <button className="sfx-popover-item" type="button" onClick={() => { setSortMode('recent_asc'); setSortOpen(false); }}>最近使用 ↑</button>
                  </div>
                ) : null}
              </div>
              <div className="sfx-popover-anchor">
                <button
                  className="sfx-pill"
                  type="button"
                  onClick={() => {
                    setFilterOpen((v) => !v);
                    setSortOpen(false);
                  }}
                >
                <SlidersHorizontal size={14} />
                <span>筛选</span>
                </button>
                {filterOpen ? (
                  <div className="sfx-popover sfx-filter-popover">
                    <div className="sfx-popover-title">筛选音效</div>
                    <div className="sfx-popover-desc">筛选会和当前文件夹、标签或智能文件夹叠加。</div>
                    <label className={`sfx-popover-check ${filterFavoriteOnly ? 'active' : ''}`}>
                      <input type="checkbox" checked={filterFavoriteOnly} onChange={(e) => setFilterFavoriteOnly(e.target.checked)} />
                      <Star size={14} />
                      <span>仅收藏</span>
                    </label>
                    <label className={`sfx-popover-check ${filterUntaggedOnly ? 'active' : ''}`}>
                      <input type="checkbox" checked={filterUntaggedOnly} onChange={(e) => setFilterUntaggedOnly(e.target.checked)} />
                      <Tag size={14} />
                      <span>仅未打标签</span>
                    </label>
                    <div className="sfx-popover-actions">
                      <button className="sfx-popover-item" type="button" onClick={() => { setFilterFavoriteOnly(false); setFilterUntaggedOnly(false); setFilterOpen(false); }}>清空筛选</button>
                    </div>
                  </div>
                ) : null}
              </div>
              <div className="sfx-pill sfx-density-pill" title="列数（⌘+ / ⌘-）">
                <span>列数</span>
                <input
                  className="sfx-density-slider"
                  type="range"
                  min="1"
                  max="6"
                  step="1"
                  value={columns}
                  onChange={(e) => setColumns(clamp(Number(e.target.value), 1, 6))}
                />
                <span>{gridConfig.columns}</span>
              </div>
              <button className="sfx-icon-btn" type="button" title={indexStatus?.active ? '正在建立索引' : '刷新库'} onClick={handleRefresh} disabled={loading || indexStatus?.active}>
                <RefreshCw size={16} className={indexStatus?.active ? 'spin' : ''} />
              </button>
              <button className="sfx-icon-btn" type="button" title={detailOpen ? '隐藏详情' : '显示详情'} onClick={() => setDetailOpen((v) => !v)}>
                {detailOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
              </button>
            </div>
          </div>
        </header>

        <div className="content-body sfx-content">
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              style={{ height: '100%', width: '100%', position: 'relative', display: 'flex', flexDirection: 'column' }}
            >
              <Routes location={location}>
                <Route index element={<Navigate to="library" replace />} />
                <Route
                  path="library"
                  element={
                    <SfxAssetBrowser
                      selectedFolder={isLibraryRoute ? selectedFolder : ''}
                      folderIndex={folderIndex}
                      assets={assets}
                      {...browserPagingProps}
                      query={query}
                      detailOpen={detailOpen}
                      columns={gridConfig.columns}
                      gridWaveHeight={gridConfig.gridWaveHeight}
                      showGridWaveform={gridConfig.showGridWaveform}
                      favoriteOverrides={favoriteOverrides}
                      sortMode={sortMode}
                      filterFavoriteOnly={filterFavoriteOnly}
                      filterUntaggedOnly={filterUntaggedOnly}
                      onColumnsCapChange={setColumnsCap}
                      inPoint={inPoint}
                      outPoint={outPoint}
                      onSetInOutRange={setInOutRange}
                      onClearInOutRange={clearInOutRange}
                      onSelectedAssetChange={handleSelectedAssetChange}
                      onSelectedAssetChange={handleSelectedAssetChange}
                      onToggleFavorite={toggleFavorite}
                      onAddTag={addTag}
                      onRemoveTag={removeTag}
                      loading={loading}
                      onPrepareImport={prepareImport}
                      activeImport={importSession}
                      onTogglePlay={togglePlay}
                      onDragToResolve={dragToResolve}
                      onInsertToTimeline={insertToTimeline}
                      playingAssetId={playingAssetId}
                      isPlaying={isPlaying}
                      playerTime={playerTime}
                      playerDuration={playerDuration}
                      onSeek={seekTo}
                      onPreviewSeek={previewSeekTo}
                      onHoverPosition={handleWaveHoverPosition}
                      selectedFolderPathsForBulk={Array.from(selectedFolderPaths)}
                      onBulkAddTag={bulkAddTag}
                      onBulkRemoveTag={bulkRemoveTag}
                      onCollectSelected={collectSelected}
                      onClearFolderSelection={clearFolderSelection}
                    />
                  }
                />
                <Route
                  path="favorites"
                  element={
                    <SfxAssetBrowser
                      smartFolderDef={{ rules: { favoriteOnly: true } }}
                      folderIndex={folderIndex}
                      assets={assets}
                      {...browserPagingProps}
                      query={query}
                      detailOpen={detailOpen}
                      columns={gridConfig.columns}
                      gridWaveHeight={gridConfig.gridWaveHeight}
                      showGridWaveform={gridConfig.showGridWaveform}
                      favoriteOverrides={favoriteOverrides}
                      sortMode={sortMode}
                      filterFavoriteOnly={filterFavoriteOnly}
                      filterUntaggedOnly={filterUntaggedOnly}
                      onColumnsCapChange={setColumnsCap}
                      inPoint={inPoint}
                      outPoint={outPoint}
                      onSetInOutRange={setInOutRange}
                      onClearInOutRange={clearInOutRange}
                      onSelectedAssetChange={handleSelectedAssetChange}
                      onToggleFavorite={toggleFavorite}
                      onAddTag={addTag}
                      onRemoveTag={removeTag}
                      loading={loading}
                      onPrepareImport={prepareImport}
                      activeImport={importSession}
                      onDragToResolve={dragToResolve}
                      onInsertToTimeline={insertToTimeline}
                      playingAssetId={playingAssetId}
                      isPlaying={isPlaying}
                      playerTime={playerTime}
                      playerDuration={playerDuration}
                      onSeek={seekTo}
                      onPreviewSeek={previewSeekTo}
                      onHoverPosition={handleWaveHoverPosition}
                      selectedFolderPathsForBulk={Array.from(selectedFolderPaths)}
                      onBulkAddTag={bulkAddTag}
                      onBulkRemoveTag={bulkRemoveTag}
                      onCollectSelected={collectSelected}
                      onClearFolderSelection={clearFolderSelection}
                    />
                  }
                />
                <Route
                  path="recent"
                  element={
                    <SfxAssetBrowser
                      smartFolderDef={{ rules: { lastUsedWithinDays: 7 } }}
                      folderIndex={folderIndex}
                      assets={assets}
                      {...browserPagingProps}
                      query={query}
                      detailOpen={detailOpen}
                      columns={gridConfig.columns}
                      gridWaveHeight={gridConfig.gridWaveHeight}
                      showGridWaveform={gridConfig.showGridWaveform}
                      favoriteOverrides={favoriteOverrides}
                      sortMode={sortMode}
                      filterFavoriteOnly={filterFavoriteOnly}
                      filterUntaggedOnly={filterUntaggedOnly}
                      onColumnsCapChange={setColumnsCap}
                      inPoint={inPoint}
                      outPoint={outPoint}
                      onSetInOutRange={setInOutRange}
                      onClearInOutRange={clearInOutRange}
                      onSelectedAssetChange={handleSelectedAssetChange}
                      onToggleFavorite={toggleFavorite}
                      onAddTag={addTag}
                      onRemoveTag={removeTag}
                      loading={loading}
                      onPrepareImport={prepareImport}
                      activeImport={importSession}
                      onTogglePlay={togglePlay}
                      onDragToResolve={dragToResolve}
                      onInsertToTimeline={insertToTimeline}
                      playingAssetId={playingAssetId}
                      isPlaying={isPlaying}
                      playerTime={playerTime}
                      playerDuration={playerDuration}
                      onSeek={seekTo}
                      onPreviewSeek={previewSeekTo}
                      onHoverPosition={handleWaveHoverPosition}
                      selectedFolderPathsForBulk={Array.from(selectedFolderPaths)}
                      onBulkAddTag={bulkAddTag}
                      onBulkRemoveTag={bulkRemoveTag}
                      onCollectSelected={collectSelected}
                      onClearFolderSelection={clearFolderSelection}
                    />
                  }
                />
                <Route
                  path="project-used"
                  element={
                    <SfxAssetBrowser
                      smartFolderDef={{ rules: { usedCountMin: 1 } }}
                      folderIndex={folderIndex}
                      assets={assets}
                      {...browserPagingProps}
                      query={query}
                      detailOpen={detailOpen}
                      columns={gridConfig.columns}
                      gridWaveHeight={gridConfig.gridWaveHeight}
                      showGridWaveform={gridConfig.showGridWaveform}
                      favoriteOverrides={favoriteOverrides}
                      sortMode={sortMode}
                      filterFavoriteOnly={filterFavoriteOnly}
                      filterUntaggedOnly={filterUntaggedOnly}
                      onColumnsCapChange={setColumnsCap}
                      inPoint={inPoint}
                      outPoint={outPoint}
                      onSetInOutRange={setInOutRange}
                      onClearInOutRange={clearInOutRange}
                      onSelectedAssetChange={handleSelectedAssetChange}
                      onToggleFavorite={toggleFavorite}
                      onAddTag={addTag}
                      onRemoveTag={removeTag}
                      loading={loading}
                      activeImport={importSession}
                      onTogglePlay={togglePlay}
                      onDragToResolve={dragToResolve}
                      onInsertToTimeline={insertToTimeline}
                      playingAssetId={playingAssetId}
                      isPlaying={isPlaying}
                      playerTime={playerTime}
                      playerDuration={playerDuration}
                      onSeek={seekTo}
                      onPreviewSeek={previewSeekTo}
                      onHoverPosition={handleWaveHoverPosition}
                      selectedFolderPathsForBulk={Array.from(selectedFolderPaths)}
                      onBulkAddTag={bulkAddTag}
                      onBulkRemoveTag={bulkRemoveTag}
                      onCollectSelected={collectSelected}
                      onClearFolderSelection={clearFolderSelection}
                    />
                  }
                />
                <Route
                  path="tags/:tag"
                  element={
                    <SfxTagRoutePage
                      folderIndex={folderIndex}
                      assets={assets}
                      {...browserPagingProps}
                      query={query}
                      detailOpen={detailOpen}
                      columns={gridConfig.columns}
                      gridWaveHeight={gridConfig.gridWaveHeight}
                      showGridWaveform={gridConfig.showGridWaveform}
                      favoriteOverrides={favoriteOverrides}
                      sortMode={sortMode}
                      filterFavoriteOnly={filterFavoriteOnly}
                      filterUntaggedOnly={filterUntaggedOnly}
                      onColumnsCapChange={setColumnsCap}
                      inPoint={inPoint}
                      outPoint={outPoint}
                      onSetInOutRange={setInOutRange}
                      onClearInOutRange={clearInOutRange}
                      onSelectedAssetChange={handleSelectedAssetChange}
                      onToggleFavorite={toggleFavorite}
                      onAddTag={addTag}
                      onRemoveTag={removeTag}
                      onPrepareImport={prepareImport}
                      activeImport={importSession}
                      onTogglePlay={togglePlay}
                      onDragToResolve={dragToResolve}
                      onInsertToTimeline={insertToTimeline}
                      playingAssetId={playingAssetId}
                      isPlaying={isPlaying}
                      playerTime={playerTime}
                      playerDuration={playerDuration}
                      onSeek={seekTo}
                      onPreviewSeek={previewSeekTo}
                      onHoverPosition={handleWaveHoverPosition}
                      selectedFolderPathsForBulk={Array.from(selectedFolderPaths)}
                      onBulkAddTag={bulkAddTag}
                      onBulkRemoveTag={bulkRemoveTag}
                      onCollectSelected={collectSelected}
                      onClearFolderSelection={clearFolderSelection}
                    />
                  }
                />
                <Route
                  path="smart/:folderId"
                  element={
                    <SfxSmartFolderRoutePage
                      folderIndex={folderIndex}
                      smartFolderDefs={smartFolderDefs}
                      assets={assets}
                      {...browserPagingProps}
                      query={query}
                      detailOpen={detailOpen}
                      columns={gridConfig.columns}
                      gridWaveHeight={gridConfig.gridWaveHeight}
                      showGridWaveform={gridConfig.showGridWaveform}
                      favoriteOverrides={favoriteOverrides}
                      sortMode={sortMode}
                      filterFavoriteOnly={filterFavoriteOnly}
                      filterUntaggedOnly={filterUntaggedOnly}
                      onColumnsCapChange={setColumnsCap}
                      inPoint={inPoint}
                      outPoint={outPoint}
                      onSetInOutRange={setInOutRange}
                      onClearInOutRange={clearInOutRange}
                      onSelectedAssetChange={handleSelectedAssetChange}
                      onToggleFavorite={toggleFavorite}
                      onAddTag={addTag}
                      onRemoveTag={removeTag}
                      onPrepareImport={prepareImport}
                      activeImport={importSession}
                      onTogglePlay={togglePlay}
                      onDragToResolve={dragToResolve}
                      onInsertToTimeline={insertToTimeline}
                      playingAssetId={playingAssetId}
                      isPlaying={isPlaying}
                      playerTime={playerTime}
                      playerDuration={playerDuration}
                      onSeek={seekTo}
                      onPreviewSeek={previewSeekTo}
                      onHoverPosition={handleWaveHoverPosition}
                      selectedFolderPathsForBulk={Array.from(selectedFolderPaths)}
                      onBulkAddTag={bulkAddTag}
                      onBulkRemoveTag={bulkRemoveTag}
                      onCollectSelected={collectSelected}
                      onClearFolderSelection={clearFolderSelection}
                    />
                  }
                />
                <Route
                  path="settings"
                  element={
                    <SfxSettingsPage
                      config={config}
                      libraries={library}
                      localFolderOptions={localFolderOptions}
                      davinciFolderOptions={davinciFolderOptions}
                      cacheStatusProps={{
                        currentLibrary,
                        assetTotal: navCounts.all || assetTotal,
                        persistedWaveformCount,
                        statusItems: statusCenterItems,
                        waveformProgressView,
                        onGenerateAllWaveforms: generateAllWaveformsNow,
                        onRefreshLibrary: handleRefresh,
                      }}
                      onAddLibrary={handleAddLibrary}
                      onRemoveLibrary={async () => {
                        const base = config || { library_path: '', save_subfolder: '音效', davinci_folder: '音效', folder_depth: 1, folder_depth_direction: 'forward' };
                        const newConfig = { ...base, library_path: '' };
                        try {
                          const res = await axios.post(`${API_BASE_URL}/api/sound-effects/config`, newConfig);
                          if (res.data.status === 'success') {
                            setConfig(newConfig);
                            setLibrary('');
                            setCurrentLibrary('');
                            localStorage.setItem('sfx.currentLibrary', '');
                            setAssets([]);
                            setFolderTreeBackend([]);
                            setAssetTotal(0);
                          }
                        } catch {}
                      }}
                      onSaveConfig={async (newConfig) => {
                        try {
                          const res = await axios.post(`${API_BASE_URL}/api/sound-effects/config`, newConfig);
                          if (res.data.status === 'success') {
                            setConfig(newConfig);
                            setLibrary(newConfig.library_path || '');
                            showToast({ type: 'success', message: '设置已保存' });
                          }
                        } catch {
                          showToast({ type: 'error', message: '设置保存失败' });
                        }
                      }}
                      loading={loading}
                    />
                  }
                />
                <Route path="*" element={<Navigate to="library" replace />} />
              </Routes>
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      <SfxSmartFolderModal
        open={showSmartFolderModal}
        onClose={() => setShowSmartFolderModal(false)}
        onCreate={(payload) => {
          const id = `user-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
          setSmartFolders((prev) => [...prev, { id, name: payload.name, rules: payload.rules }]);
          setShowSmartFolderModal(false);
          navigate(`/sfx/smart/${id}`);
        }}
      />

      <AnimatePresence>
        {toast ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            style={{
              position: 'fixed',
              top: '18px',
              right: '18px',
              padding: '10px 12px',
              borderRadius: '12px',
              background:
                toast.type === 'error'
                  ? 'rgba(44, 10, 10, 0.96)'
                  : toast.type === 'success'
                    ? 'rgba(14, 46, 24, 0.96)'
                    : 'rgba(20, 28, 40, 0.96)',
              border:
                toast.type === 'error'
                  ? '1px solid rgba(255,59,48,0.34)'
                  : toast.type === 'success'
                    ? '1px solid rgba(52,199,89,0.34)'
                    : '1px solid rgba(96,165,250,0.28)',
              color:
                toast.type === 'error'
                  ? '#FF3B30'
                  : toast.type === 'success'
                    ? '#34C759'
                    : 'var(--mac-accent)',
              fontSize: '12px',
              fontWeight: 650,
              zIndex: 3500,
              width: 'min(360px, calc(100vw - 36px))',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.45,
              boxShadow: '0 16px 40px rgba(0,0,0,0.28)'
            }}
          >
            {toast.message}
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {importSession ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            style={{
              position: 'fixed',
              right: '18px',
              bottom: '18px',
              padding: '12px',
              borderRadius: '16px',
              background: 'rgba(22, 22, 24, 0.98)',
              border: '1px solid var(--mac-border)',
              boxShadow: '0 10px 40px rgba(0,0,0,0.35)',
              zIndex: 3499,
              width: 'min(420px, calc(100vw - 36px))',
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 12
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--mac-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                待完成导入：{importSession.assetName}
              </div>
              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--mac-text-secondary)' }}>
                已复制到项目目录。拖入达芬奇后，点“完成导入”即可归档。
              </div>
              {importSession.localCopyPath ? (
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--mac-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {importSession.localCopyPath}
                </div>
              ) : null}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <button className="sfx-secondary-btn" type="button" onClick={copyImportPath}>
                复制路径
              </button>
              <button className="sfx-secondary-btn" type="button" onClick={cancelImport}>
                取消
              </button>
              <button className="sfx-primary-btn" type="button" onClick={finalizeImport}>
                完成导入
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

    </div>
  );
}

export default SfxWorkspace;
