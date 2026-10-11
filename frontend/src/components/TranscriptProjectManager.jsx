import { useState, useRef, useEffect } from 'react';
import { FolderOpen, X, Settings, Plus, MapPin, Globe, Trash2 } from 'lucide-react';

/* ── 持久化 ──────────────────────────────────────── */
const META_STORAGE_KEY = 'quickclip:transcript-project-meta';

function loadMeta() {
  try {
    const raw = localStorage.getItem(META_STORAGE_KEY);
    if (!raw) return { projects: [], activeId: null };
    return JSON.parse(raw);
  } catch { return { projects: [], activeId: null }; }
}

function saveMeta(state) {
  try {
    localStorage.setItem(META_STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

function generateMetaId() {
  return 'tpm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

/* ── 项目标签页 ──────────────────────────────────── */
export function TranscriptProjectTabs({
  projects = [],
  activeId,
  resolveStatus,
  disabled = false,
  disabledReason = '',
  onSwitch,
  onClose,
  onRefresh,
  onManage,
  onAdd,
  showManage = true,
}) {
  const visibleProjects = projects.filter(p => {
    if (p.bindingScope === 'global' || p.bindingScope === 'current') return true;
    if (p.bindingScope === 'project') return p.boundDavinciProject === resolveStatus?.project;
    if (!resolveStatus?.project) return true;
    return !p.boundDavinciProject || p.boundDavinciProject === resolveStatus.project;
  });

  const deduped = (() => {
    const nameCounts = {};
    visibleProjects.forEach(p => { nameCounts[p.name] = (nameCounts[p.name] || 0) + 1; });
    const nameCounters = {};
    return visibleProjects.map(p => ({
      ...p,
      displayName: nameCounts[p.name] > 1
        ? `${p.name}_${String((nameCounters[p.name] = (nameCounters[p.name] || 0) + 1)).padStart(2, '0')}`
        : p.name,
    }));
  })();

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {deduped.slice(0, 8).map((project) => (
        <div
          key={project.id}
          onClick={(e) => {
            if (disabled) {
              e.preventDefault();
              return;
            }
            onSwitch?.(project.id);
          }}
          aria-disabled={disabled}
          title={disabled ? disabledReason : project.displayName || project.name}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '6px 10px',
            borderRadius: '8px',
            cursor: disabled ? 'not-allowed' : 'pointer',
            background: activeId === project.id ? 'rgba(0, 122, 255, 0.15)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${activeId === project.id ? 'rgba(0, 122, 255, 0.3)' : 'var(--mac-border)'}`,
            color: activeId === project.id ? 'var(--mac-accent)' : 'var(--mac-text-secondary)',
            fontSize: '12px',
            fontWeight: activeId === project.id ? 500 : 400,
            whiteSpace: 'nowrap',
            transition: 'all 0.15s',
            opacity: disabled && activeId !== project.id ? 0.55 : 1,
          }}
        >
          <FolderOpen size={12} />
          <span>{project.displayName || project.name}</span>
          {project.segment_count !== undefined && (
            <span style={{ opacity: 0.5, fontSize: '10px' }}>({project.segment_count}段)</span>
          )}
          {project.bindingScope === 'global' && (
            <Globe size={10} style={{ opacity: 0.5 }} />
          )}
          {project.bindingScope === 'current' && (
            <span style={{ fontSize: 9, opacity: 0.5, flexShrink: 0, color: '#30D158' }}>
              [当前]
            </span>
          )}
          {project.bindingScope === 'project' && project.boundDavinciProject && (
            <span style={{ fontSize: 9, opacity: 0.5, flexShrink: 0 }}>
              [{project.boundDavinciProject.slice(0, 8)}]
            </span>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              if (disabled) return;
              onClose?.(project.id);
            }}
            title={disabled ? disabledReason : '关闭转录项目'}
            style={{
              background: 'transparent', border: 'none', padding: '1px',
              cursor: disabled ? 'not-allowed' : 'pointer', color: 'inherit', opacity: 0.5,
              display: 'flex', alignItems: 'center', marginLeft: 2,
            }}
          >
            <X size={10} />
          </button>
        </div>
      ))}
      {onRefresh && (
        <button
          type="button"
          disabled={disabled}
          aria-label="刷新转录项目列表"
          onClick={() => {
            if (disabled) return;
            onRefresh?.();
          }}
          style={{
            background: 'transparent', border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
            color: 'var(--mac-text-secondary)', opacity: 0.5, padding: '4px',
            display: 'flex',
          }}
          title={disabled ? disabledReason : '刷新转录项目列表'}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
          </svg>
        </button>
      )}
      {showManage && onManage && (
        <button
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            onManage?.();
          }}
          title={disabled ? disabledReason : '管理转录项目'}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '5px 10px', borderRadius: 8,
            background: 'var(--mac-input-bg)', border: '1px solid var(--mac-border)',
            color: 'var(--mac-text-secondary)', fontSize: 11, fontWeight: 500,
            cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
            fontFamily: 'inherit',
            opacity: disabled ? 0.5 : 1,
          }}
        >
          <Settings size={11} />
          管理
        </button>
      )}
    </div>
  );
}

/* ── 绑定切换 ──────────────────────────────────── */
export function TranscriptBindingToggle({ project, resolveStatus, onChange }) {
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
          transition: 'all 0.15s', fontFamily: 'inherit',
          display: 'flex', alignItems: 'center', gap: 2,
        }}
      >
        <Globe size={9} /> 全局
      </button>
      <button
        onClick={() => onChange({ bindingScope: 'current', isGlobal: false, boundDavinciProject: resolveStatus.project })}
        title={`仅在「${resolveStatus.project}」中显示，跟随当前项目切换`}
        style={{
          padding: '4px 8px', fontSize: 10, fontWeight: scope === 'current' ? 600 : 400,
          border: 'none', borderLeft: '1px solid var(--mac-border)',
          cursor: 'pointer', height: 26,
          background: scope === 'current' ? 'var(--mac-accent)' : 'var(--mac-input-bg)',
          color: scope === 'current' ? '#fff' : 'var(--mac-text-secondary)',
          transition: 'all 0.15s', fontFamily: 'inherit',
          maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {resolveStatus.project.length > 6 ? resolveStatus.project.slice(0, 6) + '…' : resolveStatus.project}
      </button>
      <button
        onClick={() => onChange({ bindingScope: 'project', isGlobal: false, boundDavinciProject: project?.davinci_project || resolveStatus.project })}
        title={`仅在此转录项目创建时的达芬奇项目「${project?.davinci_project || resolveStatus.project}」中显示`}
        style={{
          padding: '4px 8px', fontSize: 10, fontWeight: scope === 'project' ? 600 : 400,
          border: 'none', borderLeft: '1px solid var(--mac-border)',
          cursor: 'pointer', height: 26,
          background: scope === 'project' ? 'var(--mac-accent)' : 'var(--mac-input-bg)',
          color: scope === 'project' ? '#fff' : 'var(--mac-text-secondary)',
          transition: 'all 0.15s', fontFamily: 'inherit',
          maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {(project?.davinci_project || resolveStatus.project).length > 6
          ? (project?.davinci_project || resolveStatus.project).slice(0, 6) + '…'
          : (project?.davinci_project || resolveStatus.project)}
      </button>
    </div>
  );
}

/* ── 管理视图 ──────────────────────────────────── */
export function TranscriptProjectManager({
  projects = [],
  resolveStatus,
  onUpdate,
  onDelete,
  onBack,
}) {
  const [editingId, setEditingId] = useState(null);
  const [editField, setEditField] = useState(null);
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
    setEditValue(val || '');
  };

  const commitEdit = () => {
    if (!editingId || !editField) return;
    onUpdate(editingId, { [editField]: editValue.trim() });
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

  const EditableCell = ({ id, field, value, style = {}, placeholder = '' }) => {
    const isEditing = editingId === id && editField === field;
    if (isEditing) {
      return (
        <input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={handleEditKeyDown}
          placeholder={placeholder}
          style={{
            width: '100%', border: '1px solid var(--mac-accent)',
            borderRadius: 4, padding: '4px 6px', fontSize: 12,
            background: 'var(--mac-bg)', color: 'var(--mac-text)',
            outline: 'none', fontFamily: 'inherit',
          }}
        />
      );
    }
    return (
      <span
        onClick={() => startEdit(id, field, value)}
        title={placeholder ? `点击编辑${placeholder}` : '点击编辑'}
        style={{
          cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap', display: 'block', padding: '4px 6px',
          borderRadius: 4, border: '1px solid transparent',
          fontSize: 12, color: value ? 'var(--mac-text)' : 'var(--mac-text-secondary)',
          ...style,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--mac-border)'; e.currentTarget.style.background = 'var(--mac-bg)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.background = 'transparent'; }}
      >
        {value || placeholder}
      </span>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* ── 顶部标题栏 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={onBack} style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '7px 14px', borderRadius: 8,
          background: 'var(--mac-input-bg)', border: '1px solid var(--mac-border)',
          color: 'var(--mac-text)', fontSize: 12, cursor: 'pointer',
          fontFamily: 'inherit', transition: 'all 0.15s',
        }}
        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--mac-surface-muted)'}
        onMouseLeave={(e) => e.currentTarget.style.background = 'var(--mac-input-bg)'}
        >
          ← 返回
        </button>
        <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--mac-text)' }}>
          转录项目管理
        </span>
        <span style={{
          fontSize: 11, fontWeight: 500, color: 'var(--mac-text-secondary)',
          background: 'var(--mac-input-bg)', padding: '3px 10px', borderRadius: 999,
        }}>
          {projects.length} 个项目
        </span>
      </div>

      {projects.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: 56, color: 'var(--mac-text-secondary)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
        }}>
          <FolderOpen size={48} style={{ opacity: 0.15 }} />
          <span style={{ fontSize: 14, fontWeight: 500 }}>暂无转录项目</span>
          <span style={{ fontSize: 11, opacity: 0.6 }}>转录项目将自动出现在这里</span>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 8 }}>
          {sorted.map((p) => {
            const accentColor = p.bindingScope === 'global' ? 'var(--mac-accent)'
              : p.bindingScope === 'current' ? '#30D158'
              : '#AF52DE';
            return (
            <div key={p.id} style={{
              display: 'flex', flexDirection: 'column', gap: 6,
              padding: '9px 12px',
              borderRadius: 8,
              border: '1px solid var(--mac-border)',
              background: 'var(--mac-input-bg)',
              position: 'relative',
              overflow: 'hidden',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--mac-surface-muted)';
              e.currentTarget.style.borderColor = 'var(--mac-border-highlight)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--mac-input-bg)';
              e.currentTarget.style.borderColor = 'var(--mac-border)';
            }}
            >
              {/* 左侧强调线 */}
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0, width: 2,
                background: accentColor, opacity: 0.5,
              }} />

              {/* ── 第 1 行：名称 + 段数 + 日期 + 删除 ── */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 2 }}>
                <FolderOpen size={11} style={{ color: accentColor, flexShrink: 0, opacity: 0.5 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <EditableCell
                    id={p.id} field="name" value={p.name} placeholder="未命名项目"
                    style={{ fontSize: 12, fontWeight: 500 }}
                  />
                </div>
                <span style={{ fontSize: 10, color: 'var(--mac-text-secondary)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  {p.segment_count !== undefined ? `${p.segment_count}段` : '0段'}
                </span>
                {p.createdAt && (
                  <span style={{ fontSize: 10, color: 'var(--mac-text-secondary)', opacity: 0.5, whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {new Date(p.createdAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
                  </span>
                )}
                <button
                  onClick={() => {
                    if (window.confirm(`确定要删除「${p.name || '未命名项目'}」吗？\n此操作不可撤销。`)) {
                      onDelete(p.id);
                    }
                  }}
                  title="删除此转录项目"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 24, height: 24, borderRadius: 5, flexShrink: 0,
                    background: 'transparent', border: '1px solid transparent',
                    color: 'var(--mac-text-secondary)', cursor: 'pointer',
                    transition: 'all 0.15s', opacity: 0.35,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 69, 58, 0.12)';
                    e.currentTarget.style.borderColor = 'rgba(255, 69, 58, 0.2)';
                    e.currentTarget.style.color = '#FF453A';
                    e.currentTarget.style.opacity = '1';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.borderColor = 'transparent';
                    e.currentTarget.style.color = 'var(--mac-text-secondary)';
                    e.currentTarget.style.opacity = '0.35';
                  }}
                >
                  <Trash2 size={11} />
                </button>
              </div>

              {/* ── 第 2 行：绑定切换 ── */}
              <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 2 }}>
                {resolveStatus?.connected && resolveStatus?.project ? (
                  <div style={{
                    display: 'flex', alignItems: 'center',
                    borderRadius: 6, overflow: 'hidden',
                    border: '1px solid var(--mac-border)',
                  }}>
                    <button
                      onClick={() => onUpdate(p.id, { bindingScope: 'global', isGlobal: true, boundDavinciProject: null })}
                      title="所有达芬奇项目中均显示"
                      style={{
                        padding: '3px 7px', fontSize: 10, fontWeight: p.bindingScope === 'global' ? 600 : 400,
                        border: 'none', cursor: 'pointer', height: 24,
                        background: p.bindingScope === 'global' ? accentColor : 'transparent',
                        color: p.bindingScope === 'global' ? '#fff' : 'var(--mac-text-secondary)',
                        transition: 'all 0.15s', fontFamily: 'inherit',
                        display: 'flex', alignItems: 'center', gap: 2,
                      }}
                    >
                      <Globe size={9} />全局
                    </button>
                    <button
                      onClick={() => onUpdate(p.id, { bindingScope: 'current', isGlobal: false, boundDavinciProject: resolveStatus.project })}
                      title={`仅在「${resolveStatus.project}」中显示，跟随项目切换`}
                      style={{
                        padding: '3px 7px', fontSize: 10, fontWeight: p.bindingScope === 'current' ? 600 : 400,
                        border: 'none', borderLeft: '1px solid var(--mac-border)',
                        cursor: 'pointer', height: 24,
                        background: p.bindingScope === 'current' ? accentColor : 'transparent',
                        color: p.bindingScope === 'current' ? '#fff' : 'var(--mac-text-secondary)',
                        transition: 'all 0.15s', fontFamily: 'inherit',
                        maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                    >
                      {(resolveStatus.project?.length > 5 ? resolveStatus.project.slice(0, 5) + '…' : resolveStatus.project)}
                    </button>
                    <button
                      onClick={() => onUpdate(p.id, { bindingScope: 'project', isGlobal: false, boundDavinciProject: p.davinci_project || resolveStatus.project })}
                      title={`仅在转录时的达芬奇项目「${p.davinci_project || resolveStatus.project}」中显示`}
                      style={{
                        padding: '3px 7px', fontSize: 10, fontWeight: p.bindingScope === 'project' ? 600 : 400,
                        border: 'none', borderLeft: '1px solid var(--mac-border)',
                        cursor: 'pointer', height: 24,
                        background: p.bindingScope === 'project' ? accentColor : 'transparent',
                        color: p.bindingScope === 'project' ? '#fff' : 'var(--mac-text-secondary)',
                        transition: 'all 0.15s', fontFamily: 'inherit',
                        maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
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
                    background: p.bindingScope === 'global' ? 'rgba(10, 132, 255, 0.1)'
                      : p.bindingScope === 'current' ? 'rgba(52, 199, 89, 0.1)'
                      : 'rgba(175, 82, 222, 0.1)',
                    color: p.bindingScope === 'global' ? 'var(--mac-accent)'
                      : p.bindingScope === 'current' ? '#30D158'
                      : '#AF52DE',
                    maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 3,
                  }}>
                    {p.bindingScope === 'global' ? (
                      <><Globe size={9} /> 全局</>
                    ) : p.bindingScope === 'current' ? (
                      <><MapPin size={9} /> 当前项目</>
                    ) : (
                      <><MapPin size={9} /> {p.boundDavinciProject || '未绑定'}</>
                    )}
                  </span>
                )}
              </div>
            </div>
          );
          })}
        </div>
      )}
    </div>
  );
}

/* ── 工具函数（供父组件使用） ───────────────────── */
export { loadMeta, saveMeta, generateMetaId, META_STORAGE_KEY };
