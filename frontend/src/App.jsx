import { Suspense, useState, useEffect, lazy, useTransition } from 'react';

import { motion, AnimatePresence } from 'framer-motion';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { LayoutGrid, Library } from 'lucide-react';
import { workspaceRegistry } from './workspaces/registry';
import { ensureBackendReady } from './backendLauncher';
import './App.css';

/* ── Tauri window drag ──────────────────────────────────── */
let _startDragFn = null;
if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
    import('@tauri-apps/api/window').then(m => {
        const win = m.getCurrentWindow();
        _startDragFn = () => { try { win.startDragging(); } catch {} };
    });
}

function isInteractiveElement(el) {
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'A' || tag === 'svg' || tag === 'path') return true;
    if (el.closest('button, input, select, textarea, a, [role="button"], .nav-item, .split-marker, .segment-word, .segment-actions, .segment-text, [contenteditable="true"]')) return true;
    return false;
}

function setupTauriWindowDrag() {
    if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return () => {};

    const onMouseDown = (e) => {
        if (e.clientY > 40) return;           // 仅顶部 40px 可拖动窗口
        if (isInteractiveElement(e.target)) return;
        if (_startDragFn) _startDragFn();
    };

    document.addEventListener('mousedown', onMouseDown, { capture: true });
    return () => document.removeEventListener('mousedown', onMouseDown, { capture: true });
}

const AppContent = lazy(() => import('./AppContent'));

/* ── 启动器 ──────────────────────────────────────────
   开源版：启动本地后端后直接进入主工作区
   ─────────────────────────────────────────────────── */
function Launcher() {
    const [backendReady, setBackendReady] = useState(false);

    useEffect(() => {
        if (!backendReady) {
            ensureBackendReady().then(
                () => setBackendReady(true),
                err => {
                    const msg = String(err?.message || err);
                    console.error('[App] backend start failed:', msg);
                    setBackendReady(true); // 失败也放行，允许手动重试
                },
            );
        }
    }, [backendReady]);

    return backendReady ? <Navigate to="/app" replace /> : null;
}

function App() {
    const location = useLocation();
    const navigate = useNavigate();
    const SfxWorkspace = workspaceRegistry.sfx.Component;
    const [winLabel, setWinLabel] = useState(null);

    const isWorkspaceRoute = location.pathname.startsWith('/app') || location.pathname.startsWith('/sfx');
    const isSFX = location.pathname.startsWith('/sfx');
    const showWorkspaceHeader = isWorkspaceRoute;

    const [, startTransition] = useTransition();

    const handleWorkspaceSwitch = (target) => {
        if (target === 'sfx' && !isSFX) startTransition(() => navigate('/sfx/library'));
        else if (target === 'main' && isSFX) startTransition(() => navigate('/app'));
    };

    useEffect(() => setupTauriWindowDrag(), []);

    useEffect(() => {
        if (typeof window !== 'undefined' && (window.__TAURI__ || window.__TAURI_INTERNALS__)) {
            import('@tauri-apps/api/window').then(m => {
                setWinLabel(m.getCurrentWindow().label);
            }).catch(() => {
                setWinLabel('tauri-fallback');
            });
        } else {
            setWinLabel('web');
        }
    }, []);

    // Signal Rust to show the window once the real workspace is rendered.
    useEffect(() => {
        if (winLabel && isWorkspaceRoute && (window.__TAURI__ || window.__TAURI_INTERNALS__)) {
            const timer = setTimeout(() => {
                import('@tauri-apps/api/core').then(({ invoke }) => {
                    invoke('show_main_window').catch(() => {});
                });
            }, 80);
            return () => clearTimeout(timer);
        }
    }, [winLabel, isWorkspaceRoute]);

    if (!winLabel) return null;

    const fallback = (
        <div
            style={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--mac-bg)',
                color: 'var(--mac-text-secondary)',
                fontSize: '12px'
            }}
        >
            正在载入…
        </div>
    );

    return (
        <div style={{ height: '100vh', width: '100vw', background: 'var(--mac-bg)', position: 'relative', overflow: 'hidden' }}>
            {/* Fixed header overlay */}
            {showWorkspaceHeader && (
                <>
                    {/* Solid backdrop — prevents any content from bleeding through the glass header */}
                    <div style={{
                        position: 'fixed',
                        top: '8px',
                        left: '8px',
                        width: '220px',
                        height: '116px',
                        zIndex: 199,
                        background: 'var(--mac-bg)',
                        borderRadius: 'var(--mac-radius-lg) var(--mac-radius-lg) 0 0',
                    }} />
                    <div style={{
                        position: 'fixed',
                        top: '8px',
                        left: '8px',
                        width: '220px',
                        zIndex: 200,
                        background: 'var(--mac-sidebar-bg)',
                        backdropFilter: 'blur(var(--glass-blur))',
                        WebkitBackdropFilter: 'blur(var(--glass-blur))',
                        borderRadius: 'var(--mac-radius-lg) var(--mac-radius-lg) 0 0',
                    }}>
                    <div className="sidebar-native-titlebar-spacer" />
                    <div style={{ padding: '0 8px 6px' }}>
                        <div style={{
                            padding: '4px 10px 10px',
                            fontSize: '16px',
                            fontWeight: '700',
                            color: 'var(--mac-text)',
                            letterSpacing: '-0.3px',
                            lineHeight: 1
                        }}>
                            QuickClip
                        </div>

                        <div className="workspace-tabs" style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 0,
                            background: 'var(--mac-input-bg)',
                            borderRadius: '10px',
                            padding: '3px',
                            border: '1px solid var(--mac-border)',
                        }}>
                            {/* Main Workspace Tab */}
                            <motion.button
                                className="ws-tab"
                                layout
                                transition={{ type: "spring", stiffness: 450, damping: 38, mass: 0.8 }}
                                onClick={() => handleWorkspaceSwitch('main')}
                                style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    gap: isSFX ? '0px' : '6px',
                                    padding: isSFX ? '6px 8px' : '6px 10px',
                                    borderRadius: '8px', border: 'none',
                                    background: isSFX ? 'transparent' : 'var(--mac-accent-bg)',
                                    color: isSFX ? 'var(--mac-text-secondary)' : 'var(--mac-accent)',
                                    cursor: isSFX ? 'pointer' : 'default',
                                    fontSize: '12px', fontWeight: '600',
                                    whiteSpace: 'nowrap', overflow: 'hidden',
                                    flex: isSFX ? '0 0 auto' : '1 1 auto',
                                    willChange: 'transform',
                                }}
                            >
                                <LayoutGrid size={15} style={{ flexShrink: 0 }} />
                                <AnimatePresence mode="sync">
                                    {!isSFX && (
                                        <motion.span
                                            key="main-label"
                                            initial={{ maxWidth: 0, opacity: 0 }}
                                            animate={{ maxWidth: 100, opacity: 1 }}
                                            exit={{ maxWidth: 0, opacity: 0 }}
                                            transition={{ type: "spring", stiffness: 450, damping: 38, mass: 0.8 }}
                                            style={{ overflow: 'hidden', whiteSpace: 'nowrap', display: 'inline-block', verticalAlign: 'middle' }}
                                        >主工作区</motion.span>
                                    )}
                                </AnimatePresence>
                            </motion.button>

                            {/* Separator with guard container — matched spring to tabs */}
                            <div style={{
                                width: 14, flexShrink: 0,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                overflow: 'hidden',
                            }}>
                                <motion.div
                                    layout
                                    transition={{ type: "spring", stiffness: 450, damping: 38, mass: 0.8 }}
                                    style={{
                                        width: '1px', height: '18px',
                                        background: 'var(--mac-text-secondary)',
                                        borderRadius: '999px',
                                        opacity: 0.35,
                                    }}
                                />
                            </div>

                            {/* Sound Effects Tab */}
                            <motion.button
                                className="ws-tab"
                                layout
                                transition={{ type: "spring", stiffness: 450, damping: 38, mass: 0.8 }}
                                onClick={() => handleWorkspaceSwitch('sfx')}
                                style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    gap: isSFX ? '6px' : '0px',
                                    padding: isSFX ? '6px 10px' : '6px 8px',
                                    borderRadius: '8px', border: 'none',
                                    background: isSFX ? 'var(--mac-accent-bg)' : 'transparent',
                                    color: isSFX ? 'var(--mac-accent)' : 'var(--mac-text-secondary)',
                                    cursor: isSFX ? 'default' : 'pointer',
                                    fontSize: '12px', fontWeight: '600',
                                    whiteSpace: 'nowrap', overflow: 'hidden',
                                    flex: isSFX ? '1 1 auto' : '0 0 auto',
                                    willChange: 'transform',
                                }}
                            >
                                <Library size={15} style={{ flexShrink: 0 }} />
                                <AnimatePresence mode="sync">
                                    {isSFX && (
                                        <motion.span
                                            key="sfx-label"
                                            initial={{ maxWidth: 0, opacity: 0 }}
                                            animate={{ maxWidth: 100, opacity: 1 }}
                                            exit={{ maxWidth: 0, opacity: 0 }}
                                            transition={{ type: "spring", stiffness: 450, damping: 38, mass: 0.8 }}
                                            style={{ overflow: 'hidden', whiteSpace: 'nowrap', display: 'inline-block', verticalAlign: 'middle' }}
                                        >音效库</motion.span>
                                    )}
                                </AnimatePresence>
                            </motion.button>
                        </div>
                    </div>
                </div>
                </>
            )}

            <div style={{ height: '100%', background: 'var(--mac-bg)' }}>
                <Suspense fallback={fallback}>
                    <Routes location={location}>
                        <Route path="/" element={<Launcher />} />
                        <Route path="/sfx/*" element={<SfxWorkspace />} />
                        <Route path="/app" element={<AppContent />} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                </Suspense>
            </div>

        </div>
    );
}

export default App;
