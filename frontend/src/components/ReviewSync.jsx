import { useState, useRef, useEffect, useCallback } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Link, RefreshCw, Clock, MessageSquare, User, FileVideo,
  ChevronDown, ChevronRight, ExternalLink, AlertCircle,
  CheckCircle2, Copy, Download, Eye, Search, X, Play,
  Flag, Send, Settings, Globe, MapPin,
} from 'lucide-react';
import { fetchReviewComments } from '../yueliuApi';

/* ── 项目持久化 ──────────────────────────────────────── */
const PROJECTS_STORAGE_KEY = 'quickclip:review-projects';

function loadProjects() {
  try {
    const raw = localStorage.getItem(PROJECTS_STORAGE_KEY);
    if (!raw) return { projects: [], activeId: null };
    const data = JSON.parse(raw);
    return {
      projects: (data.projects || []).map(p => ({
        ...p,
        completedIds: new Set(p.completedIds || []),
      })),
      activeId: data.activeId || null,
    };
  } catch { return { projects: [], activeId: null }; }
}

function saveProjects(state) {
  try {
    const serializable = {
      projects: state.projects.map(p => ({
        ...p,
        completedIds: [...(p.completedIds || [])],
      })),
      activeId: state.activeId,
    };
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(serializable));
  } catch {}
}

function generateProjectId() {
  return 'rev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/* ── 工具函数 ────────────────────────────────────────── */
function formatSize(bytes) {
  if (!bytes) return '? MB';
  const mb = bytes / (1024 * 1024);
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

function formatDuration(ms) {
  const sec = Math.floor((ms || 0) / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ── 动画 ────────────────────────────────────────────── */
const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.04 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0 },
};

/* ── 空状态 ──────────────────────────────────────────── */
function EmptyState() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', padding: '48px 24px', gap: '16px',
    }}>
      <div style={{
        width: 64, height: 64, borderRadius: 16,
        background: 'var(--mac-input-bg)',
        border: '1px solid var(--mac-border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--mac-text-secondary)',
      }}>
        <MessageSquare size={28} />
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--mac-text)', marginBottom: 4 }}>
          同步审阅评论
        </div>
        <div style={{ fontSize: 12, color: 'var(--mac-text-secondary)', lineHeight: 1.6, maxWidth: 360 }}>
          粘贴审阅分享链接，一键拉取所有带时间戳的评论，方便对照时间线进行修改。
        </div>
      </div>
    </div>
  );
}

/* ── 评论列表项 ──────────────────────────────────────── */
function CommentItem({ comment, index, onCopyTime, onSeekTo, searchQuery, isCompleted, onToggleComplete }) {
  const [expanded, setExpanded] = useState(false);
  const hasLongContent = comment.content && comment.content.length > 120;

  const highlightText = (text, query) => {
    if (!query || !text) return text;
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark style={{
          background: 'rgba(10, 132, 255, 0.2)',
          color: 'var(--mac-accent)',
          borderRadius: 3,
          padding: '0 1px',
        }}>{text.slice(idx, idx + query.length)}</mark>
        {text.slice(idx + query.length)}
      </>
    );
  };

  const displayContent = hasLongContent && !expanded
    ? comment.content.slice(0, 120) + '…'
    : comment.content;

  return (
    <motion.div
      variants={itemVariants}
      style={{
        display: 'flex', gap: 10, padding: '10px 14px',
        borderRadius: 10,
        border: '1px solid var(--mac-border)',
        background: 'var(--mac-input-bg)',
        transition: 'border-color 0.15s, background 0.15s',
      }}
      whileHover={{ borderColor: 'var(--mac-border-highlight)' }}
    >
      {/* 序号 — 最左侧 */}
      <span style={{
        flexShrink: 0, width: 20, textAlign: 'center',
        fontSize: 11, color: 'var(--mac-text-secondary)',
        fontWeight: 500, alignSelf: 'center',
      }}>
        {index + 1}
      </span>

      {/* 内容 */}
      <div style={{ flex: 1, minWidth: 0, opacity: isCompleted ? 0.45 : 1, transition: 'opacity 0.2s' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3,
        }}>
          <span style={{
            fontSize: 12, fontWeight: 600, color: 'var(--mac-text)',
          }}>
            {comment.user || '匿名'}
          </span>
          <span style={{
            fontSize: 10, color: 'var(--mac-text-secondary)',
            flexShrink: 0,
          }}>
            {formatDate(comment.createdAt)}
          </span>
          {comment.replyCount > 0 && (
            <span style={{
              fontSize: 10, color: 'var(--mac-accent)',
              background: 'rgba(10, 132, 255, 0.08)',
              padding: '1px 6px', borderRadius: 999,
            }}>
              {comment.replyCount} 条回复
            </span>
          )}
        </div>
        <div style={{
          fontSize: 13, lineHeight: 1.55, color: 'var(--mac-text)',
          whiteSpace: hasLongContent && !expanded ? 'nowrap' : 'pre-wrap',
          overflow: 'hidden',
        }}>
          {highlightText(displayContent, searchQuery)}
        </div>
        {hasLongContent && (
          <button
            onClick={() => setExpanded(!expanded)}
            style={{
              background: 'none', border: 'none', padding: '2px 0',
              color: 'var(--mac-accent)', fontSize: 11, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 4, marginTop: 2,
            }}
          >
            {expanded ? '收起' : '展开全部'}
            <ChevronDown size={10} style={{
              transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s',
            }} />
          </button>
        )}
        {comment.files && comment.files.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {comment.files.map((f, i) => (
              <span key={i} style={{
                fontSize: 10, color: 'var(--mac-text-secondary)',
                background: 'var(--mac-surface-muted)', padding: '2px 8px',
                borderRadius: 6, border: '1px solid var(--mac-border)',
              }}>
                📎 {f.name || '附件'}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 时间戳 — 画面右侧 */}
      <button
        onClick={() => onSeekTo(comment.timeMs, comment.timeFormatted)}
        onContextMenu={(e) => { e.preventDefault(); onCopyTime(comment.timeFormatted); }}
        title="左键跳转达芬奇播放头 | 右键复制时间码"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 3,
          padding: '3px 8px', borderRadius: 6,
          background: 'rgba(10, 132, 255, 0.08)',
          border: '1px solid rgba(10, 132, 255, 0.12)',
          color: 'var(--mac-accent)',
          fontSize: 11, fontWeight: 700,
          fontFamily: "'SF Mono', 'Geist Mono', monospace",
          cursor: 'pointer', flexShrink: 0,
          transition: 'all 0.15s',
          alignSelf: 'center',
        }}
      >
        <Play size={10} />
        {comment.timeFormatted}
      </button>

      {/* 完成勾选 */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggleComplete(); }}
        title={isCompleted ? '标记为未完成' : '标记为已完成'}
        style={{
          flexShrink: 0, width: 26, height: 26,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 7,
          background: isCompleted ? 'rgba(52, 199, 89, 0.15)' : 'var(--mac-input-bg)',
          border: isCompleted ? '1px solid rgba(52, 199, 89, 0.3)' : '1px solid var(--mac-border)',
          color: isCompleted ? '#34C759' : 'var(--mac-text-secondary)',
          cursor: 'pointer', padding: 0,
          transition: 'all 0.15s',
          alignSelf: 'center',
        }}
      >
        {isCompleted ? <CheckCircle2 size={15} /> : <div style={{ width: 10, height: 10, borderRadius: 3, border: '1.5px solid currentColor' }} />}
      </button>
    </motion.div>
  );
}

/* ── 项目标签页栏 ────────────────────────────────────── */
function ProjectTabs({ projects, activeId, onSwitch, onClose, onAdd, resolveStatus }) {
  const visibleProjects = projects.filter(p => {
    if (p.bindingScope === 'global' || p.bindingScope === 'current') return true;
    if (p.bindingScope === 'project') return p.boundDavinciProject === resolveStatus?.project;
    // backward compat: old projects without bindingScope
    if (p.isGlobal) return true;
    if (!resolveStatus?.project) return false;
    return p.boundDavinciProject === resolveStatus.project;
  });

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4,
      padding: '6px 0', overflowX: 'auto',
    }}>
      {visibleProjects.map(p => (
        <div key={p.id} style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '5px 8px 5px 12px', borderRadius: 8,
          background: activeId === p.id ? 'var(--mac-accent)' : 'var(--mac-input-bg)',
          color: activeId === p.id ? '#fff' : 'var(--mac-text)',
          fontSize: 12, fontWeight: activeId === p.id ? 600 : 400,
          cursor: 'pointer', whiteSpace: 'nowrap',
          border: activeId === p.id ? '1px solid transparent' : '1px solid var(--mac-border)',
          transition: 'all 0.15s',
        }}
          onClick={() => onSwitch(p.id)}
        >
          <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {p.name || '未命名审阅'}
          </span>
          {p.bindingScope === 'global' && (
            <Globe size={10} style={{ opacity: 0.5 }} />
          )}
          {p.bindingScope === 'current' && (
            <span style={{ fontSize: 9, opacity: 0.5, color: '#30D158', flexShrink: 0 }}>[当前]</span>
          )}
          {p.bindingScope === 'project' && p.boundDavinciProject && (
            <span style={{ fontSize: 9, opacity: 0.7, flexShrink: 0 }}>
              [{p.boundDavinciProject.slice(0, 8)}]
            </span>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onClose(p.id); }}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: activeId === p.id ? 'rgba(255,255,255,0.7)' : 'var(--mac-text-secondary)',
              padding: '2px', display: 'flex', borderRadius: 4,
            }}
            title="关闭项目"
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <button
        onClick={onAdd}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 28, height: 28, borderRadius: 8,
          background: 'var(--mac-input-bg)', border: '1px dashed var(--mac-border)',
          color: 'var(--mac-text-secondary)', cursor: 'pointer', flexShrink: 0,
          fontSize: 16, fontWeight: 600,
        }}
        title="添加审阅项目"
      >
        +
      </button>
    </div>
  );
}

/* ── 项目绑定切换 ──────────────────────────────────── */
function BindingToggle({ project, resolveStatus, onChange }) {
  if (!resolveStatus?.connected || !resolveStatus?.project) return null;

  const scope = project?.bindingScope || (project?.isGlobal ? 'global' : 'project');

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 0,
      borderRadius: 7, overflow: 'hidden', flexShrink: 0,
      border: '1px solid var(--mac-border)',
    }}>
      <button
        onClick={() => onChange({ bindingScope: 'global', isGlobal: true, boundDavinciProject: null })}
        title="所有达芬奇项目中均显示"
        style={{
          padding: '4px 8px', fontSize: 10, fontWeight: scope === 'global' ? 600 : 400,
          border: 'none', cursor: 'pointer', height: 26,
          background: scope === 'global' ? 'var(--mac-accent)' : 'var(--mac-input-bg)',
          color: scope === 'global' ? '#fff' : 'var(--mac-text-secondary)',
          transition: 'all 0.15s',
        }}
      >
        全局
      </button>
      <button
        onClick={() => onChange({ bindingScope: 'current', isGlobal: false, boundDavinciProject: resolveStatus.project })}
        title={`仅在「${resolveStatus.project}」中显示，跟随项目切换`}
        style={{
          padding: '4px 8px', fontSize: 10, fontWeight: scope === 'current' ? 600 : 400,
          border: 'none', borderLeft: '1px solid var(--mac-border)',
          cursor: 'pointer', height: 26,
          background: scope === 'current' ? 'var(--mac-accent)' : 'var(--mac-input-bg)',
          color: scope === 'current' ? '#fff' : 'var(--mac-text-secondary)',
          transition: 'all 0.15s',
          maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {resolveStatus.project?.length > 6 ? resolveStatus.project.slice(0, 6) + '…' : resolveStatus.project}
      </button>
      <button
        onClick={() => onChange({ bindingScope: 'project', isGlobal: false, boundDavinciProject: project?.davinci_project || resolveStatus.project })}
        title={`仅在转录时的项目「${project?.davinci_project || resolveStatus.project}」中显示`}
        style={{
          padding: '4px 8px', fontSize: 10, fontWeight: scope === 'project' ? 600 : 400,
          border: 'none', borderLeft: '1px solid var(--mac-border)',
          cursor: 'pointer', height: 26,
          background: scope === 'project' ? 'var(--mac-accent)' : 'var(--mac-input-bg)',
          color: scope === 'project' ? '#fff' : 'var(--mac-text-secondary)',
          transition: 'all 0.15s',
          maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {(project?.davinci_project || resolveStatus.project)?.length > 6
          ? (project?.davinci_project || resolveStatus.project).slice(0, 6) + '…'
          : (project?.davinci_project || resolveStatus.project)}
      </button>
    </div>
  );
}

/* ── 审阅链接管理视图 ────────────────────────────────── */
function ManagementView({ projects, onUpdate, onDelete, onBack, onAdd, resolveStatus }) {
  const [editingId, setEditingId] = useState(null);
  const [editField, setEditField] = useState(null); // 'name' | 'url'
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId, editField]);

  const startEdit = (id, field, val) => {
    setEditingId(id);
    setEditField(field);
    setEditValue(val);
  };

  const commitEdit = () => {
    if (!editingId || !editField) return;
    if (editField === 'name') {
      onUpdate(editingId, { name: editValue.trim() || '未命名审阅' });
    } else {
      onUpdate(editingId, { url: editValue.trim() });
    }
    setEditingId(null);
    setEditField(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditField(null);
  };

  const handleEditKeyDown = (e) => {
    if (e.key === 'Enter') commitEdit();
    else if (e.key === 'Escape') cancelEdit();
  };

  const sorted = [...projects].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={onBack} style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '6px 12px', borderRadius: 8,
          background: 'var(--mac-input-bg)', border: '1px solid var(--mac-border)',
          color: 'var(--mac-text)', fontSize: 12, cursor: 'pointer',
          fontFamily: 'inherit',
        }}>
          ← 返回
        </button>
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--mac-text)' }}>
          审阅链接管理
        </span>
        <span style={{ fontSize: 11, color: 'var(--mac-text-secondary)' }}>
          共 {projects.length} 个项目
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={() => { onAdd(); onBack(); }} title="新建审阅项目" style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '6px 14px', borderRadius: 8,
          background: 'var(--mac-accent)', border: 'none',
          color: '#fff', fontSize: 12, fontWeight: 600,
          cursor: 'pointer', fontFamily: 'inherit',
        }}>
          + 新建
        </button>
      </div>

      {projects.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--mac-text-secondary)', fontSize: 13 }}>
          暂无审阅项目，点击右上角「+ 新建」添加
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--mac-border)' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '8px 14px',
            background: 'var(--mac-sidebar-bg)',
            borderBottom: '1px solid var(--mac-border)',
            fontSize: 11, fontWeight: 600, color: 'var(--mac-text-secondary)',
          }}>
            <span style={{ flex: 1.2 }}>名称</span>
            <span style={{ flex: 2.8 }}>链接</span>
            <span style={{ width: 120, textAlign: 'center' }}>绑定</span>
            <span style={{ width: 60, textAlign: 'center' }}>操作</span>
          </div>
          {sorted.map((p, idx) => (
            <div key={p.id} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 14px',
              background: idx % 2 === 0 ? 'var(--mac-bg)' : 'var(--mac-input-bg)',
              borderBottom: idx < sorted.length - 1 ? '1px solid var(--mac-border)' : 'none',
              fontSize: 12, color: 'var(--mac-text)',
              transition: 'background 0.1s',
            }}>
              <div style={{ flex: 1.2, minWidth: 0 }}>
                {editingId === p.id && editField === 'name' ? (
                  <input
                    ref={inputRef}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={handleEditKeyDown}
                    style={{
                      width: '100%', border: '1px solid var(--mac-accent)',
                      borderRadius: 4, padding: '4px 6px', fontSize: 12,
                      background: 'var(--mac-bg)', color: 'var(--mac-text)',
                      outline: 'none', fontFamily: 'inherit',
                    }}
                  />
                ) : (
                  <span
                    onClick={() => startEdit(p.id, 'name', p.name)}
                    title="点击编辑名称"
                    style={{
                      cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap', display: 'block', padding: '4px 6px',
                      borderRadius: 4, border: '1px solid transparent',
                    }}
                    onMouseEnter={(e) => { e.target.style.borderColor = 'var(--mac-border)'; e.target.style.background = 'var(--mac-bg)'; }}
                    onMouseLeave={(e) => { e.target.style.borderColor = 'transparent'; e.target.style.background = 'transparent'; }}
                  >
                    {p.name || '未命名审阅'}
                  </span>
                )}
              </div>
              <div style={{ flex: 2.8, minWidth: 0 }}>
                {editingId === p.id && editField === 'url' ? (
                  <input
                    ref={inputRef}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={handleEditKeyDown}
                    style={{
                      width: '100%', border: '1px solid var(--mac-accent)',
                      borderRadius: 4, padding: '4px 6px', fontSize: 12,
                      background: 'var(--mac-bg)', color: 'var(--mac-text)',
                      outline: 'none', fontFamily: 'inherit',
                    }}
                  />
                ) : (
                  <span
                    onClick={() => startEdit(p.id, 'url', p.url)}
                    title="点击编辑链接"
                    style={{
                      cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap', display: 'block', padding: '4px 6px',
                      borderRadius: 4, border: '1px solid transparent',
                      color: 'var(--mac-accent)', fontSize: 11,
                    }}
                    onMouseEnter={(e) => { e.target.style.borderColor = 'var(--mac-border)'; e.target.style.background = 'var(--mac-bg)'; }}
                    onMouseLeave={(e) => { e.target.style.borderColor = 'transparent'; e.target.style.background = 'transparent'; }}
                  >
                    {p.url}
                  </span>
                )}
              </div>
              <div style={{ width: 180, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
                {resolveStatus?.connected && resolveStatus?.project ? (
                  <div style={{
                    display: 'flex', alignItems: 'center', borderRadius: 6, overflow: 'hidden',
                    border: '1px solid var(--mac-border)',
                  }}>
                    <button
                      onClick={() => onUpdate(p.id, { bindingScope: 'global', isGlobal: true, boundDavinciProject: null })}
                      title="所有达芬奇项目中均显示"
                      style={{
                        padding: '3px 6px', fontSize: 10, fontWeight: p.bindingScope === 'global' ? 600 : 400,
                        border: 'none', cursor: 'pointer',
                        background: p.bindingScope === 'global' ? 'var(--mac-accent)' : 'var(--mac-input-bg)',
                        color: p.bindingScope === 'global' ? '#fff' : 'var(--mac-text-secondary)',
                        transition: 'all 0.15s', fontFamily: 'inherit',
                      }}
                    >
                      全局
                    </button>
                    <button
                      onClick={() => onUpdate(p.id, { bindingScope: 'current', isGlobal: false, boundDavinciProject: resolveStatus.project })}
                      title={`仅在「${resolveStatus.project}」中显示，跟随项目切换`}
                      style={{
                        padding: '3px 6px', fontSize: 10, fontWeight: p.bindingScope === 'current' ? 600 : 400,
                        border: 'none', borderLeft: '1px solid var(--mac-border)',
                        cursor: 'pointer',
                        background: p.bindingScope === 'current' ? 'var(--mac-accent)' : 'var(--mac-input-bg)',
                        color: p.bindingScope === 'current' ? '#fff' : 'var(--mac-text-secondary)',
                        transition: 'all 0.15s', fontFamily: 'inherit',
                        maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                    >
                      {(resolveStatus.project?.length > 5 ? resolveStatus.project.slice(0, 5) + '…' : resolveStatus.project)}
                    </button>
                    <button
                      onClick={() => onUpdate(p.id, { bindingScope: 'project', isGlobal: false, boundDavinciProject: p.davinci_project || resolveStatus.project })}
                      title={`仅在转录时的项目「${p.davinci_project || resolveStatus.project}」中显示`}
                      style={{
                        padding: '3px 6px', fontSize: 10, fontWeight: p.bindingScope === 'project' ? 600 : 400,
                        border: 'none', borderLeft: '1px solid var(--mac-border)',
                        cursor: 'pointer',
                        background: p.bindingScope === 'project' ? 'var(--mac-accent)' : 'var(--mac-input-bg)',
                        color: p.bindingScope === 'project' ? '#fff' : 'var(--mac-text-secondary)',
                        transition: 'all 0.15s', fontFamily: 'inherit',
                        maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                    >
                      {((p.davinci_project || resolveStatus.project)?.length > 5
                        ? (p.davinci_project || resolveStatus.project).slice(0, 5) + '…'
                        : (p.davinci_project || resolveStatus.project))}
                    </button>
                  </div>
                ) : (
                  <span style={{
                    fontSize: 10, fontWeight: 500, padding: '2px 8px', borderRadius: 999,
                    background: p.bindingScope === 'global' ? 'rgba(10, 132, 255, 0.08)'
                      : p.bindingScope === 'current' ? 'rgba(52, 199, 89, 0.08)'
                      : 'rgba(175, 82, 222, 0.08)',
                    color: p.bindingScope === 'global' ? 'var(--mac-accent)'
                      : p.bindingScope === 'current' ? '#30D158'
                      : '#AF52DE',
                    maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap', display: 'inline-block',
                  }}>
                    {p.bindingScope === 'global' ? '全局' : p.bindingScope === 'current' ? '当前项目' : (p.boundDavinciProject || '未绑定')}
                  </span>
                )}
              </div>
              <div style={{ width: 60, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
                <button
                  onClick={() => {
                    if (window.confirm(`确定要删除「${p.name || '未命名审阅'}」吗？\n此操作不可撤销。`)) {
                      onDelete(p.id);
                    }
                  }}
                  title="删除此审阅项目"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 28, height: 28, borderRadius: 6,
                    background: 'transparent', border: '1px solid transparent',
                    color: 'var(--mac-text-secondary)', cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                  onMouseEnter={(e) => { e.target.style.background = 'rgba(255, 69, 58, 0.08)'; e.target.style.borderColor = 'rgba(255, 69, 58, 0.2)'; e.target.style.color = '#FF453A'; }}
                  onMouseLeave={(e) => { e.target.style.background = 'transparent'; e.target.style.borderColor = 'transparent'; e.target.style.color = 'var(--mac-text-secondary)'; }}
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   主组件
   ═══════════════════════════════════════════════════════════ */
export default function ReviewSync({ apiBaseUrl, resolveStatus }) {
  const saved = useRef(loadProjects()).current;
  const [projects, setProjects] = useState(saved.projects || []);
  const [activeId, setActiveId] = useState(saved.activeId || null);

  const activeProject = projects.find(p => p.id === activeId) || null;

  const [inputUrl, setInputUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedFiles, setExpandedFiles] = useState({});
  const [copiedTime, setCopiedTime] = useState(null);
  const [syncingFileId, setSyncingFileId] = useState(null);
  const [syncResult, setSyncResult] = useState(null);
  const [markedFileIds, setMarkedFileIds] = useState(new Set());
  const [manageMode, setManageMode] = useState(false);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Persist on change
  useEffect(() => {
    saveProjects({ projects, activeId });
  }, [projects, activeId]);

  // Migrate old single-project data
  useEffect(() => {
    try {
      const oldData = localStorage.getItem('quickclip:review-sync');
      if (oldData) {
        const parsed = JSON.parse(oldData);
        if (parsed.result && parsed.inputUrl) {
          const existing = loadProjects();
          if (existing.projects.length === 0) {
            const migrated = {
              id: generateProjectId(),
              name: parsed.result.shareName || '已迁移审阅',
              url: parsed.inputUrl,
              bindingScope: 'global',
              boundDavinciProject: null,
              isGlobal: true,
              result: parsed.result,
              completedIds: new Set(),
              createdAt: Date.now(),
            };
            setProjects([migrated]);
            setActiveId(migrated.id);
          }
        }
        localStorage.removeItem('quickclip:review-sync');
      }
      localStorage.removeItem('quickclip:review-marked');
    } catch {}
  }, []);

  // Auto-switch to bound project when DaVinci project changes
  useEffect(() => {
    if (!resolveStatus?.project) return;
    if (activeId) {
      const activeProj = projects.find(p => p.id === activeId);
      const activeVisible = activeProj && (
        activeProj.bindingScope === 'global' ||
        activeProj.bindingScope === 'current' ||
        (activeProj.isGlobal) ||
        activeProj.boundDavinciProject === resolveStatus.project
      );
      if (activeProj && !activeVisible) {
        const bound = projects.find(p =>
          (p.bindingScope === 'project' || !p.bindingScope) &&
          !p.isGlobal &&
          p.boundDavinciProject === resolveStatus.project
        );
        setActiveId(bound ? bound.id : null);
        return;
      }
    }
    // Auto-switch to a bound project when entering a matched DaVinci project
    const bound = projects.find(p =>
      !p.isGlobal && p.boundDavinciProject === resolveStatus.project
    );
    if (bound && bound.id !== activeId) {
      setActiveId(bound.id);
    }
  }, [resolveStatus?.project, projects]);

  // Re-check markers when switching projects
  useEffect(() => {
    if (activeProject?.result && resolveStatus?.connected) {
      checkMarkerStatus(activeProject.result.files);
    } else {
      setMarkedFileIds(new Set());
    }
  }, [activeId, resolveStatus?.connected]);

  // Sync inputUrl when switching projects
  useEffect(() => {
    setInputUrl(activeProject?.url || '');
    setError('');
    setSearchQuery('');
    setExpandedFiles({});
  }, [activeId]);

  const handleFetch = useCallback(async () => {
    const url = inputUrl.trim();
    if (!url) return;
    setError('');
    setLoading(true);
    setProgress('正在解析链接...');
    try {
      const data = await fetchReviewComments(url, {
        onProgress: (step, detail) => setProgress(detail),
      });
      const projectId = activeProject?.url === url ? activeProject.id : generateProjectId();
      const projectData = {
        id: projectId,
        name: data.shareName || '未命名审阅',
        url: url,
        bindingScope: activeProject?.bindingScope || 'current',
        boundDavinciProject: activeProject?.boundDavinciProject || null,
        isGlobal: activeProject?.isGlobal ?? true,
        result: data,
        completedIds: activeProject?.completedIds || new Set(),
        createdAt: activeProject?.createdAt || Date.now(),
      };
      setProjects(prev => {
        const exists = prev.findIndex(p => p.id === projectId);
        if (exists >= 0) {
          const next = [...prev];
          next[exists] = projectData;
          return next;
        }
        return [...prev, projectData];
      });
      setActiveId(projectId);
      checkMarkerStatus(data.files);
    } catch (e) {
      setError(e.message || '获取评论失败，请检查链接是否正确');
    } finally {
      setLoading(false);
      setProgress('');
    }
  }, [inputUrl, activeProject]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !loading) handleFetch();
  };

  const handleSwitchProject = useCallback((id) => { setActiveId(id); }, []);

  const handleCloseProject = useCallback((id) => {
    setProjects(prev => {
      const next = prev.filter(p => p.id !== id);
      if (id === activeId) {
        setActiveId(next.length > 0 ? next[0].id : null);
      }
      return next;
    });
  }, [activeId]);

  const handleAddProject = useCallback(() => {
    setInputUrl('');
    setError('');
    setSearchQuery('');
    setExpandedFiles({});
    setActiveId(null);
  }, []);

  const handleBindingChange = useCallback((binding) => {
    if (!activeId) return;
    setProjects(prev => prev.map(p =>
      p.id === activeId ? { ...p, ...binding } : p
    ));
  }, [activeId]);

  const handleUpdateProject = useCallback((id, updates) => {
    setProjects(prev => prev.map(p =>
      p.id === id ? { ...p, ...updates } : p
    ));
  }, []);

  const handleDeleteProject = useCallback((id) => {
    setProjects(prev => {
      const next = prev.filter(p => p.id !== id);
      if (id === activeId) {
        setActiveId(next.length > 0 ? next[0].id : null);
      }
      return next;
    });
  }, [activeId]);

  const handleCopyTime = (timeStr) => {
    navigator.clipboard?.writeText(timeStr).then(() => {
      setCopiedTime(timeStr);
      setTimeout(() => setCopiedTime(null), 1500);
    }).catch(() => {});
  };

  const handleSeekTo = async (timeMs, timeFormatted) => {
    if (!resolveStatus?.connected) return;
    try {
      await axios.post(`${apiBaseUrl}/api/yueliu/seek`, { timeMs });
      setCopiedTime(`已跳转 ${timeFormatted}`);
      setTimeout(() => setCopiedTime(null), 2000);
    } catch (e) {
      // 静默失败
    }
  };

  const checkMarkerStatus = async (files) => {
    if (!resolveStatus?.connected) return;
    try {
      const allIds = files.flatMap(f => (f.comments || []).map(c => c.id)).join(',');
      if (!allIds) return;
      const resp = await axios.get(`${apiBaseUrl}/api/yueliu/markers/status`, {
        params: { commentIds: allIds },
      });
      if (resp.data?.existingMap) {
        // Normalize file IDs to strings for consistent Set lookup
        const fileIdSet = new Set(Object.values(resp.data.existingMap).map(id => String(id)));
        setMarkedFileIds(fileIdSet);
      }
    } catch (e) { /* silent */ }
  };

  const handleAddMarkers = async (fileId, fileName, comments) => {
    if (!resolveStatus?.connected) {
      setSyncResult({ error: '达芬奇未连接，请先打开达芬奇并加载项目' });
      setTimeout(() => setSyncResult(null), 4000);
      return;
    }
    setSyncingFileId(fileId);
    setSyncResult(null);
    try {
      const resp = await axios.post(`${apiBaseUrl}/api/yueliu/mark-timeline`, {
        comments: comments.map(c => ({
          timeMs: c.timeMs, content: c.content, user: c.user, timeFormatted: c.timeFormatted, id: c.id,
        })),
        fileName: fileName || '',
        fileId: fileId != null ? String(fileId) : '',
      });
      if (resp.data?.status === 'success') {
        setSyncResult({ success: resp.data.message });
        setMarkedFileIds(prev => new Set([...prev, String(fileId)]));
      } else {
        setSyncResult({ error: resp.data?.message || '添加失败' });
      }
    } catch (e) {
      const detail = e.response?.data?.detail;
      let errMsg = e.message || '请求失败';
      if (detail) {
        if (Array.isArray(detail)) {
          errMsg = detail.map(d => `${d.loc?.join('.') || ''}: ${d.msg}`).join('; ');
        } else if (typeof detail === 'string') {
          errMsg = detail;
        }
      }
      setSyncResult({ error: errMsg });
    }
    setSyncingFileId(null);
    setTimeout(() => setSyncResult(null), 5000);
  };

  const handleRemoveMarkers = async (fileId, commentIds) => {
    setSyncResult(null);
    try {
      const resp = await axios.post(`${apiBaseUrl}/api/yueliu/mark-timeline/remove`, {
        commentIds: commentIds || [],
      });
      if (resp.data?.status === 'success') {
        setSyncResult({ success: resp.data.message });
        setMarkedFileIds(prev => {
          const next = new Set(prev);
          next.delete(String(fileId));
          return next;
        });
      } else {
        setSyncResult({ error: resp.data?.message || '移除失败' });
      }
    } catch (e) {
      const detail = e.response?.data?.detail;
      let errMsg = e.message || '请求失败';
      if (detail) {
        if (Array.isArray(detail)) {
          errMsg = detail.map(d => `${d.loc?.join('.') || ''}: ${d.msg}`).join('; ');
        } else if (typeof detail === 'string') {
          errMsg = detail;
        }
      }
      setSyncResult({ error: errMsg });
    }
    setTimeout(() => setSyncResult(null), 5000);
  };

  const handleToggleComplete = useCallback((commentId) => {
    if (!activeId) return;
    setProjects(prev => prev.map(p => {
      if (p.id !== activeId) return p;
      const next = new Set(p.completedIds);
      if (next.has(commentId)) {
        next.delete(commentId);
      } else {
        next.add(commentId);
      }
      return { ...p, completedIds: next };
    }));
  }, [activeId]);

  const handlePasteAndFetch = async () => {
    try {
      const text = await navigator.clipboard?.readText();
      if (text && (text.includes('yueliu.link') || text.includes('yueliu.cn'))) {
        setInputUrl(text.trim());
        // 自动拉取
        setTimeout(() => handleFetch(), 200);
      }
    } catch (e) {
      // clipboard not available
    }
  };

  const toggleFile = (fileId) => {
    setExpandedFiles((prev) => ({ ...prev, [fileId]: !prev[fileId] }));
  };

  // 筛选评论
  const filterComments = (comments) => {
    if (!searchQuery.trim()) return comments;
    const q = searchQuery.toLowerCase();
    return comments.filter(
      (c) =>
        c.content.toLowerCase().includes(q) ||
        c.user.toLowerCase().includes(q) ||
        c.timeFormatted.includes(q)
    );
  };

  const totalComments = activeProject?.result
    ? activeProject.result.files.reduce((sum, f) => sum + (f.comments?.length || 0), 0)
    : 0;

  const filteredTotal = activeProject?.result
    ? activeProject.result.files.reduce((sum, f) => sum + filterComments(f.comments || []).length, 0)
    : 0;

  return (
    <div className="page-content" style={{ padding: '20px 24px', gap: '16px', overflowY: 'scroll', scrollbarGutter: 'stable' }}>
      <div className="page-content-inner" style={{ width: '100%', minWidth: 0 }}>
        {manageMode ? (
          <ManagementView
            projects={projects}
            onUpdate={handleUpdateProject}
            onDelete={handleDeleteProject}
            onBack={() => setManageMode(false)}
            onAdd={handleAddProject}
            resolveStatus={resolveStatus}
          />
        ) : (
          <>
            {/* ── 项目标签页 ──────────────────────────── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 6, borderBottom: '1px solid var(--mac-border)' }}>
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <ProjectTabs
                  projects={projects}
                  activeId={activeId}
                  onSwitch={handleSwitchProject}
                  onClose={handleCloseProject}
                  onAdd={handleAddProject}
                  resolveStatus={resolveStatus}
                />
              </div>
              <button
                onClick={() => setManageMode(true)}
                title="管理所有审阅链接"
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '5px 10px', borderRadius: 8,
                  background: 'var(--mac-input-bg)', border: '1px solid var(--mac-border)',
                  color: 'var(--mac-text-secondary)', fontSize: 11, fontWeight: 500,
                  cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                  fontFamily: 'inherit',
                }}
              >
                <Settings size={12} />
                管理
              </button>
            </div>

            {!activeId ? (
          /* ── 新建项目输入区 ────────────────────── */
          <>
            <div style={{
              display: 'flex', gap: 8,
              background: 'var(--mac-sidebar-bg)',
              border: '1px solid var(--mac-border)',
              borderRadius: 14,
              padding: 6,
              marginTop: 12,
              boxShadow: '0 2px 12px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.03)',
            }}>
              <div style={{
                flex: 1, display: 'flex', alignItems: 'center', gap: 8,
                padding: '0 10px',
                background: 'var(--mac-input-bg)',
                borderRadius: 10,
                border: '1px solid var(--mac-input-border)',
              }}>
                <Link size={15} style={{ color: 'var(--mac-text-secondary)', flexShrink: 0 }} />
                <input
                  ref={inputRef}
                  type="text"
                  placeholder="粘贴审阅分享链接 (yueliu.link/...)"
                  value={inputUrl}
                  onChange={(e) => setInputUrl(e.target.value)}
                  onKeyDown={handleKeyDown}
                  style={{
                    flex: 1, border: 'none', outline: 'none',
                    background: 'transparent', color: 'var(--mac-text)',
                    fontSize: 13, fontFamily: 'inherit', padding: '8px 0',
                  }}
                />
                {inputUrl && (
                  <button
                    onClick={() => { setInputUrl(''); setError(''); }}
                    style={{
                      background: 'none', border: 'none', color: 'var(--mac-text-secondary)',
                      cursor: 'pointer', padding: 2, display: 'flex',
                    }}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              <button
                className="mac-btn primary"
                onClick={handleFetch}
                disabled={loading || !inputUrl.trim()}
                style={{
                  padding: '8px 18px', fontSize: 13, fontWeight: 600,
                  whiteSpace: 'nowrap', height: 38,
                }}
              >
                {loading ? (
                  <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} />
                ) : (
                  <RefreshCw size={14} />
                )}
                {loading ? '获取中…' : '获取评论'}
              </button>
              <button
                className="mac-btn secondary"
                onClick={handlePasteAndFetch}
                style={{
                  padding: '8px 12px', fontSize: 12, height: 38,
                }}
                title="粘贴剪贴板中的链接并自动获取"
              >
                <ClipboardIcon />
              </button>
            </div>

            {/* ── 状态区（进度/错误/空状态）── */}
            <div style={{
              maxHeight: (loading || error) ? '80px' : '0px',
              opacity: (loading || error) ? 1 : 0,
              overflow: 'hidden',
              transition: 'max-height 0.3s ease, opacity 0.3s ease',
            }}>
              {loading && (
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '12px 14px', borderRadius: 10,
                    background: 'rgba(10, 132, 255, 0.06)',
                    border: '1px solid rgba(10, 132, 255, 0.12)',
                    fontSize: 12, color: 'var(--mac-accent)',
                  }}
                >
                  <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} />
                  {progress}
                </div>
              )}
              {error && (
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '10px 14px', borderRadius: 10,
                    background: 'rgba(255, 69, 58, 0.06)',
                    border: '1px solid rgba(255, 69, 58, 0.15)',
                    fontSize: 12, color: '#FF453A',
                  }}
                >
                  <AlertCircle size={14} />
                  {error}
                  <button
                    onClick={() => setError('')}
                    style={{
                      marginLeft: 'auto', background: 'none', border: 'none',
                      color: '#FF453A', cursor: 'pointer', padding: 2,
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
            </div>
            {!loading && !error && (
              <EmptyState />
            )}
          </>
        ) : (
          /* ── 活跃项目详情 ──────────────────────── */
          <AnimatePresence mode="wait">
          <motion.div
            key={activeId}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
          >
            {/* 进度 / 错误 — CSS transition 控制高度，确保下方内容平滑跟随 */}
            <div style={{
              maxHeight: (loading || error) ? '80px' : '0px',
              opacity: (loading || error) ? 1 : 0,
              overflow: 'hidden',
              transition: 'max-height 0.3s ease, opacity 0.3s ease',
            }}>
              {loading && (
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 14px', borderRadius: 10,
                    background: 'rgba(10, 132, 255, 0.06)',
                    border: '1px solid rgba(10, 132, 255, 0.12)',
                    fontSize: 12, color: 'var(--mac-accent)',
                  }}
                >
                  <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} />
                  {progress}
                </div>
              )}
              {error && (
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '10px 14px', borderRadius: 10,
                    background: 'rgba(255, 69, 58, 0.06)',
                    border: '1px solid rgba(255, 69, 58, 0.15)',
                    fontSize: 12, color: '#FF453A',
                  }}
                >
                  <AlertCircle size={14} />
                  {error}
                  <button
                    onClick={() => setError('')}
                    style={{
                      marginLeft: 'auto', background: 'none', border: 'none',
                      color: '#FF453A', cursor: 'pointer', padding: 2,
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
            </div>

            {/* 分享概览 + 操作 */}
            {activeProject.result && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                padding: '12px 16px', borderRadius: 12,
                background: 'var(--mac-sidebar-bg)',
                border: '1px solid var(--mac-border)',
              }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 12,
                  background: 'rgba(52, 199, 89, 0.12)',
                  border: '1px solid rgba(52, 199, 89, 0.2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#34C759',
                }}>
                  <CheckCircle2 size={20} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 13, fontWeight: 600, color: 'var(--mac-text)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {activeProject.result.shareName}
                  </div>
                  <div style={{
                    display: 'flex', gap: 6, marginTop: 2,
                    fontSize: 11, color: 'var(--mac-text-secondary)',
                  }}>
                    <span>{activeProject.result.files.length} 个文件</span>
                    <span>·</span>
                    <span>{activeProject.result.files.filter(f => f.commentCount > 0).length} 个有评论</span>
                    <span>·</span>
                    <span>共 {totalComments} 条评论</span>
                  </div>
                </div>
                {/* 操作区：绑定切换 + 刷新 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <BindingToggle
                    project={activeProject}
                    resolveStatus={resolveStatus}
                    onChange={handleBindingChange}
                  />
                  <button
                    className="mac-btn secondary"
                    onClick={handleFetch}
                    disabled={loading}
                    title="重新拉取审阅评论"
                    style={{
                      padding: '4px 10px', fontSize: 11, fontWeight: 600,
                      height: 28, gap: 4, display: 'flex', alignItems: 'center',
                    }}
                  >
                    <RefreshCw size={11} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
                    刷新
                  </button>
                </div>
              </div>
            )}

            {/* 搜索栏 */}
            {totalComments > 5 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 12px', borderRadius: 10,
                background: 'var(--mac-input-bg)',
                border: '1px solid var(--mac-input-border)',
              }}>
                <Search size={13} style={{ color: 'var(--mac-text-secondary)' }} />
                <input
                  type="text"
                  placeholder={`筛选 ${totalComments} 条评论…`}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{
                    flex: 1, border: 'none', outline: 'none',
                    background: 'transparent', color: 'var(--mac-text)',
                    fontSize: 12, fontFamily: 'inherit',
                  }}
                />
                {searchQuery && (
                  <>
                    <span style={{ fontSize: 10, color: 'var(--mac-text-secondary)', whiteSpace: 'nowrap' }}>
                      匹配 {filteredTotal} 条
                    </span>
                    <button
                      onClick={() => setSearchQuery('')}
                      style={{
                        background: 'none', border: 'none', color: 'var(--mac-text-secondary)',
                        cursor: 'pointer', padding: 2, display: 'flex',
                      }}
                    >
                      <X size={12} />
                    </button>
                  </>
                )}
              </div>
            )}

            {/* 文件与评论列表 */}
            {activeProject.result && activeProject.result.files.filter(f => f.commentCount > 0).map((file) => {
              const filteredComments = filterComments(file.comments || []);
              const isExpanded = expandedFiles[file.fileId] === true;

              return (
                <div key={file.fileId} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {/* 文件头 */}
                  <div
                    onClick={() => toggleFile(file.fileId)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      padding: '10px 14px', borderRadius: 11,
                      background: 'var(--mac-sidebar-bg)',
                      border: '1px solid var(--mac-border)',
                      cursor: 'pointer',
                      transition: 'border-color 0.15s',
                    }}
                  >
                    <div style={{
                      width: 34, height: 34, borderRadius: 10,
                      background: 'rgba(175, 82, 222, 0.1)',
                      border: '1px solid rgba(175, 82, 222, 0.15)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#AF52DE',
                    }}>
                      <FileVideo size={16} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 12, fontWeight: 600, color: 'var(--mac-text)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {file.fileName}
                      </div>
                      <div style={{
                        display: 'flex', gap: 10, marginTop: 1,
                        fontSize: 10, color: 'var(--mac-text-secondary)',
                      }}>
                        <span>{formatDuration(file.duration)}</span>
                        <span>{formatSize(file.size)}</span>
                      </div>
                    </div>
                    {file.commentCount > 0 && (
                      <span style={{
                        fontSize: 11, fontWeight: 600, color: 'var(--mac-accent)',
                        background: 'rgba(10, 132, 255, 0.08)',
                        padding: '2px 8px', borderRadius: 999, flexShrink: 0,
                      }}>
                        {file.commentCount} 条
                      </span>
                    )}
                    {file.comments && file.comments.length > 0 && resolveStatus?.connected && (
                      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                        {markedFileIds.has(String(file.fileId)) && (
                          <button
                            className="mac-btn secondary"
                            onClick={() => handleRemoveMarkers(file.fileId, file.comments.map(c => c.id))}
                            title="移除时间线上的评论标签"
                            style={{ padding: '4px 8px', fontSize: 11, fontWeight: 600, height: 26, gap: 3 }}
                          >
                            <X size={10} />
                            删除标签
                          </button>
                        )}
                        <button
                          className="mac-btn primary"
                          onClick={() => handleAddMarkers(file.fileId, file.fileName, file.comments)}
                          disabled={syncingFileId === file.fileId}
                          title="将评论添加到时间线"
                          style={{ padding: '4px 8px', fontSize: 11, fontWeight: 600, height: 26, gap: 3 }}
                        >
                          {syncingFileId === file.fileId ? (
                            <RefreshCw size={10} style={{ animation: 'spin 1s linear infinite' }} />
                          ) : (
                            <Flag size={10} />
                          )}
                          添加标记
                        </button>
                      </div>
                    )}
                    {file.error && (
                      <AlertCircle size={14} style={{ color: '#FF453A', flexShrink: 0 }} />
                    )}
                    <ChevronDown size={14} style={{
                      color: 'var(--mac-text-secondary)',
                      transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
                      transition: 'transform 0.2s',
                      flexShrink: 0,
                    }} />
                  </div>

                  {/* 评论列表 */}
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        style={{ overflow: 'hidden' }}
                      >
                        <div style={{
                          display: 'flex', flexDirection: 'column', gap: 6,
                          paddingLeft: 4, paddingRight: 4,
                        }}>
                          {file.commentCount === 0 && (
                            <div style={{
                              padding: '16px', textAlign: 'center',
                              fontSize: 12, color: 'var(--mac-text-secondary)',
                            }}>
                              该文件暂无评论
                            </div>
                          )}
                          {filteredComments.length === 0 && searchQuery && (
                            <div style={{
                              padding: '16px', textAlign: 'center',
                              fontSize: 12, color: 'var(--mac-text-secondary)',
                            }}>
                              没有匹配 "{searchQuery}" 的评论
                            </div>
                          )}
                          <motion.div
                            variants={containerVariants}
                            initial="hidden"
                            animate="visible"
                            style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                          >
                            {filteredComments.map((c, idx) => (
                              <CommentItem
                                key={c.id}
                                comment={c}
                                index={idx}
                                onCopyTime={handleCopyTime}
                                onSeekTo={handleSeekTo}
                                searchQuery={searchQuery}
                                isCompleted={activeProject?.completedIds?.has(c.id)}
                                onToggleComplete={() => handleToggleComplete(c.id)}
                              />
                            ))}
                          </motion.div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </motion.div>
          </AnimatePresence>
        )}

        {/* 同步结果反馈 */}
        <AnimatePresence>
          {syncResult && (
            <motion.div
              initial={{ opacity: 0, y: 8, x: '-50%' }}
              animate={{ opacity: 1, y: 0, x: '-50%' }}
              exit={{ opacity: 0, y: 4, x: '-50%' }}
              style={{
                position: 'fixed', bottom: 40, left: 'calc(228px + (100vw - 228px) / 2)',
                padding: '10px 18px', borderRadius: 10,
                background: syncResult.error ? 'rgba(255, 69, 58, 0.9)' : 'rgba(52, 199, 89, 0.9)',
                color: '#fff', fontSize: 12, fontWeight: 600, zIndex: 500,
                boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
                display: 'flex', alignItems: 'center', gap: 8,
                maxWidth: 'calc(100vw - 256px)',
              }}
            >
              {syncResult.error ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}
              {syncResult.error || syncResult.success}
            </motion.div>
          )}
        </AnimatePresence>

        {/* 复制时间戳反馈 */}
        <AnimatePresence>
          {copiedTime && (
            <motion.div
              initial={{ opacity: 0, y: 8, x: '-50%' }}
              animate={{ opacity: 1, y: 0, x: '-50%' }}
              exit={{ opacity: 0, y: 4, x: '-50%' }}
              style={{
                position: 'fixed', bottom: 40, left: '50%',
                padding: '8px 16px', borderRadius: 999,
                background: 'var(--mac-text)', color: 'var(--mac-bg)',
                fontSize: 12, fontWeight: 600, zIndex: 500,
                boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <CheckCircle2 size={13} />
              已复制 {copiedTime}
            </motion.div>
          )}
        </AnimatePresence>
          </>
        )}
      </div>
    </div>
  );
}

/* ── 剪贴板图标 ─────────────────────────────────────── */
function ClipboardIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </svg>
  );
}
