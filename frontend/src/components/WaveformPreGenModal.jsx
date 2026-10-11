import { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../config';
import { Activity, Zap, CheckCircle2 } from 'lucide-react';
import './WaveformPreGenModal.css';

export default function WaveformPreGenModal({ libraryPath, onComplete, onSkip }) {
  const [phase, setPhase] = useState('checking'); // checking | confirm | generating | done
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [currentFile, setCurrentFile] = useState('');
  const [speed, setSpeed] = useState(0);
  const [showMini, setShowMini] = useState(false);
  const pollRef = useRef(null);
  const mountedRef = useRef(true);

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await axios.get(`${API_BASE_URL}/api/sound-effects/precompute-status`);
        if (!mountedRef.current) return;
        const st = res.data || {};
        setDone(st.done ?? 0);
        setCurrentFile(st.currentFile || '');
        setSpeed(st.speed || 0);
        if (!st.running && st.done > 0) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setPhase('done');
        }
      } catch { /* ignore poll errors */ }
    }, 500);
  }, []);

  const checkStatus = useCallback(async () => {
    if (!libraryPath) return;
    try {
      const summaryRes = await axios.post(`${API_BASE_URL}/api/sound-effects/library-summary`, {
        library_path: libraryPath,
        query: '',
        selectedFolder: '',
      });
      const totalCount = summaryRes.data?.total_count || 0;

      const statusRes = await axios.get(`${API_BASE_URL}/api/sound-effects/precompute-status`);
      const st = statusRes.data || {};

      if (st.running) {
        setPhase('generating');
        setTotal(st.total || totalCount);
        setDone(st.done || 0);
        setCurrentFile(st.currentFile || '');
        setSpeed(st.speed || 0);
        startPolling();
        return;
      }

      if (st.done > 0 && st.done >= st.total && st.total > 0) {
        setTotal(st.total);
        setDone(st.done);
        setPhase('done');
        onComplete?.();
        return;
      }

      const cacheRes = await axios.get(`${API_BASE_URL}/api/sound-effects/cache-stats`, {
        params: { library_path: libraryPath },
      });
      const cached = cacheRes.data?.waveform_cache_files || 0;
      if (cached >= totalCount && totalCount > 0) {
        setPhase('done');
        onComplete?.();
      } else {
        setTotal(totalCount);
        setPhase('confirm');
      }
    } catch {
      setPhase('confirm');
    }
  }, [libraryPath, onComplete, startPolling]);

  useEffect(() => {
    mountedRef.current = true;
    checkStatus();
    return () => {
      mountedRef.current = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [checkStatus]);

  const handleStart = async () => {
    setPhase('generating');
    try {
      await axios.post(`${API_BASE_URL}/api/sound-effects/precompute-waveforms`, {
        library_path: libraryPath,
        samples: 160,
        limit: 0,
        workers: 8,
      });
      startPolling();
    } catch {
      setPhase('confirm');
    }
  };

  const handleSkip = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    onSkip?.();
  };

  const handleMinimize = () => setShowMini(true);
  const handleExpand = () => setShowMini(false);
  const handleDone = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    onComplete?.();
  };

  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;
  const eta = speed > 0 && total > done ? Math.ceil((total - done) / speed) : null;

  if (phase === 'checking') {
    return (
      <div className="wpgm-overlay">
        <div className="wpgm-panel">
          <div className="wpgm-spinner" />
          <h3 className="wpgm-title" style={{ marginTop: 16 }}>正在检查波形缓存...</h3>
          <p className="wpgm-desc">扫描音效库文件，比对已有缓存</p>
        </div>
      </div>
    );
  }

  if (phase === 'confirm') {
    return (
      <div className="wpgm-overlay">
        <div className="wpgm-panel">
          <div className="wpgm-icon">
            <Activity size={32} color="var(--mac-accent, #0A84FF)" />
          </div>
          <h3 className="wpgm-title">发现 {total.toLocaleString()} 个文件需要生成波形</h3>
          <p className="wpgm-desc">首次生成需要一点时间，之后即可秒开浏览</p>
          <div className="wpgm-buttons">
            <button className="wpgm-btn-primary" onClick={handleStart}>开始生成</button>
            <button className="wpgm-btn-secondary" onClick={handleSkip}>跳过，稍后生成</button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'generating' && !showMini) {
    return (
      <div className="wpgm-overlay">
        <div className="wpgm-panel">
          <div className="wpgm-icon">
            <Zap size={32} color="var(--mac-accent, #0A84FF)" />
          </div>
          <h3 className="wpgm-title">正在生成波形缓存</h3>
          <p className="wpgm-desc">可最小化到后台继续</p>
          <div className="wpgm-progress-wrap">
            <div className="wpgm-progress-stats">
              <span>进度</span>
              <span className="wpgm-progress-count">{done.toLocaleString()} / {total.toLocaleString()}</span>
            </div>
            <div className="wpgm-progress-track">
              <div className="wpgm-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="wpgm-progress-speed">
              <span>速度 {speed} 个/秒</span>
              <span>预计剩余 {eta != null ? `${eta} 秒` : '---'}</span>
            </div>
          </div>
          <p className="wpgm-current-file">{currentFile}</p>
          <div className="wpgm-buttons">
            <button className="wpgm-btn-secondary" onClick={handleMinimize}>隐藏到后台</button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'generating' && showMini) {
    return (
      <div className="wpgm-mini-dock">
        <div className="wpgm-mini-spinner" />
        <div className="wpgm-mini-info">
          <div className="wpgm-mini-label">
            <span>波形生成中</span>
            <span style={{ fontFamily: 'SF Mono, monospace' }}>{progressPct}%</span>
          </div>
          <div className="wpgm-mini-track">
            <div className="wpgm-mini-fill" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
        <button className="wpgm-btn-secondary" style={{ fontSize: 11, padding: '4px 10px' }} onClick={handleExpand}>展开</button>
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div className="wpgm-overlay">
        <div className="wpgm-panel">
          <div className="wpgm-icon">
            <CheckCircle2 size={32} color="#30D158" />
          </div>
          <h3 className="wpgm-title">波形缓存生成完毕</h3>
          <p className="wpgm-desc">{total.toLocaleString()} 个文件已全部缓存</p>
          <div className="wpgm-buttons">
            <button className="wpgm-btn-primary" onClick={handleDone}>开始使用音效库</button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
