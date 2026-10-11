import { useRef, useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, useInView } from 'framer-motion';
import {
    Mic, Scissors, FileText, Music, Package, FolderTree,
    Download, ArrowRight, ChevronDown, Monitor,
    Sparkles, Subtitles, FileOutput, ShieldCheck, LayoutGrid,
} from 'lucide-react';
import './WelcomeView.css';

/* ═══════════════════════════════════════════════════════════
   Micro-Components
   ═══════════════════════════════════════════════════════════ */

function SectionReveal({ children, className = '', delay = 0 }) {
    const ref = useRef(null);
    const inView = useInView(ref, { once: true, margin: '-80px' });
    return (
        <motion.div
            ref={ref}
            className={className}
            initial={{ opacity: 0, y: 32 }}
            animate={inView ? { opacity: 1, y: 0 } : {}}
            transition={{ type: 'spring', stiffness: 80, damping: 18, delay }}
        >
            {children}
        </motion.div>
    );
}

function StaggerList({ children, className = '' }) {
    const ref = useRef(null);
    const inView = useInView(ref, { once: true, margin: '-40px' });
    return (
        <motion.div
            ref={ref}
            className={className}
            variants={{ hidden: {}, show: { transition: { staggerChildren: 0.06, delayChildren: 0.1 } } }}
            initial="hidden"
            animate={inView ? 'show' : 'hidden'}
        >
            {Array.isArray(children)
                ? children.map((c, i) => (
                    <motion.div
                        key={i}
                        variants={{
                            hidden: { opacity: 0, y: 20 },
                            show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 120, damping: 20 } },
                        }}
                    >
                        {c}
                    </motion.div>
                ))
                : children}
        </motion.div>
    );
}

/* ═══════════════════════════════════════════════════════════
   REAL FEATURES
   ═══════════════════════════════════════════════════════════ */

const coreFeatures = [
    {
        icon: Mic, color: '#0A84FF',
        title: 'AI 语音转录',
        desc: '本地语音识别引擎，毫秒级字级时间戳。支持多种语言、说话人分离、热词优化。',
        size: 'lg',
    },
    {
        icon: Scissors, color: '#FF2D55',
        title: '文本驱动文本剪辑',
        desc: '选中文字 = 标记剪辑点。三种应用模式：新建时间线 / 追加到末尾 / 原位删主轨。支持 50 步撤销重做，按说话人颜色区分段落。',
        size: 'wide',
    },
    {
        icon: FileText, color: '#AF52DE',
        title: '字幕处理与自动同步字幕',
        desc: 'SRT 表格编辑、双击改文本、一键插入达芬奇。实时追踪音频片段变速变化，字幕自动同步对齐。',
        size: '',
    },
];

const practicalTools = [
    {
        icon: Music, color: '#5AC8FA',
        title: '音效管理',
        desc: '本地音效库浏览，SVG 波形图预览，拖拽到时间线智能导入。已用音效自动归档到媒体池，未用自动清理。',
    },
    {
        icon: Package, color: '#FF9500',
        title: '素材打包',
        desc: '扫描时间线全部轨道素材，勾选所需素材一键打包到目标目录，自动去重统计。',
    },
    {
        icon: ShieldCheck, color: '#34C759',
        title: '时间线检查',
        desc: '检测夹帧（可配帧数阈值）、黑帧、黑边，支持批量标记 marker 到时间线，一键定位问题片段。',
    },
    {
        icon: FolderTree, color: '#32ADE6',
        title: '文件夹结构映射',
        desc: '管理本地素材路径到达芬奇媒体池的自动映射规则。支持拖拽排序、导出导入配置、系统预设锁定。',
    },
    {
        icon: FileOutput, color: '#34C759',
        title: '导出与备份',
        desc: '文件名模板拖拽组合（项目名/时间线名/日期/版本号）。支持渲染导出和仅备份两种模式，子文件夹自动创建。',
    },
];

/* ═══════════════════════════════════════════════════════════
   WELCOME VIEW
   ═══════════════════════════════════════════════════════════ */

const COS_LATEST_URL = 'https://quickclip-1340197331.cos.ap-guangzhou.myqcloud.com/releases/latest.json';

export default function WelcomeView() {
    const navigate = useNavigate();
    const [scrolled, setScrolled] = useState(false);
    const [releaseData, setReleaseData] = useState(null);
    const [releaseLoading, setReleaseLoading] = useState(true);

    // Tauri desktop: redirect to app directly
    useEffect(() => {
        if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
            navigate('/app', { replace: true });
        }
    }, [navigate]);

    // Fetch release info from COS
    useEffect(() => {
        let cancelled = false;
        fetch(COS_LATEST_URL)
            .then(res => res.json())
            .then(data => { if (!cancelled) setReleaseData(data); })
            .catch(() => {})
            .finally(() => { if (!cancelled) setReleaseLoading(false); });
        return () => { cancelled = true; };
    }, []);

    // Fix body scroll for landing page
    useEffect(() => {
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'auto';
        document.body.style.height = 'auto';
        return () => {
            document.body.style.overflow = prevOverflow;
            document.body.style.height = '';
        };
    }, []);

    useEffect(() => {
        const onScroll = () => setScrolled(window.scrollY > 40);
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => window.removeEventListener('scroll', onScroll);
    }, []);

    const scrollTo = useCallback((id) => {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    }, []);

    return (
        <div className="lp-root">
            {/* ── Nav ───────────────────────────────────────── */}
            <motion.nav
                className={`lp-nav ${scrolled ? 'scrolled' : ''}`}
                initial={{ y: -60, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 120, damping: 22, delay: 0.1 }}
            >
                <div className="lp-nav-inner">
                    <div className="lp-nav-logo" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
                        <span className="lp-nav-dot" />
                        <span>QuickClip</span>
                    </div>
                    <div className="lp-nav-links">
                        <button onClick={() => scrollTo('features')}>功能</button>
                        <button onClick={() => scrollTo('tools')}>工具</button>
                        <button onClick={() => scrollTo('download')}>下载</button>
                        <button className="lp-nav-app-btn" onClick={() => navigate('/app')}>
                            <LayoutGrid size={14} />
                            进入工作区
                        </button>
                    </div>
                </div>
            </motion.nav>

            {/* ── HERO ──────────────────────────────────────── */}
            <section className="lp-hero">
                <motion.div className="lp-hero-inner">
                    <div className="lp-hero-content">
                        <motion.div
                            className="lp-hero-badge"
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.3, duration: 0.5 }}
                        >
                            <Sparkles size={14} />
                            DaVinci Resolve 文本驱动剪辑助手
                        </motion.div>

                        <motion.h1
                            className="lp-hero-title"
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.4, duration: 0.6, type: 'spring', stiffness: 100, damping: 20 }}
                        >
                            像编辑文字一样
                            <br />
                            编辑<span className="lp-hero-accent">视频</span>
                        </motion.h1>

                        <motion.p
                            className="lp-hero-desc"
                            initial={{ opacity: 0, y: 12 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.55, duration: 0.5 }}
                        >
                            导入视频 → AI 转录音频生成带时间戳的文本时间线
                            → 选中文字删除对应片段 → 导出到 DaVinci Resolve 继续精修。
                            让剪辑像写文章一样直觉。
                        </motion.p>

                        <motion.div
                            className="lp-hero-actions"
                            initial={{ opacity: 0, y: 12 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.7, duration: 0.5 }}
                        >
                            <button className="lp-btn lp-btn-primary" onClick={() => scrollTo('download')}>
                                <Download size={18} />
                                下载 QuickClip
                            </button>
                            <button className="lp-btn lp-btn-outline" onClick={() => scrollTo('features')}>
                                了解功能
                                <ChevronDown size={16} />
                            </button>
                            <button className="lp-btn lp-btn-primary" onClick={() => navigate('/app')}>
                                <LayoutGrid size={18} />
                                进入工作区
                            </button>
                        </motion.div>

                        <motion.div
                            className="lp-hero-stats"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ delay: 0.9, duration: 0.6 }}
                        >
                            <div className="lp-hero-stat">
                                <span className="lp-hero-stat-num">多语言</span>
                                <span className="lp-hero-stat-label">语音识别</span>
                            </div>
                            <div className="lp-hero-stat">
                                <span className="lp-hero-stat-num">3</span>
                                <span className="lp-hero-stat-label">剪辑模式</span>
                            </div>
                            <div className="lp-hero-stat">
                                <span className="lp-hero-stat-num">macOS</span>
                                <span className="lp-hero-stat-label">桌面应用</span>
                            </div>
                        </motion.div>
                    </div>

                    <div className="lp-hero-visual">
                        <motion.div
                            className="lp-hero-mock"
                            initial={{ opacity: 0, x: 40, rotateY: 6 }}
                            animate={{ opacity: 1, x: 0, rotateY: 0 }}
                            transition={{ delay: 0.5, type: 'spring', stiffness: 60, damping: 20 }}
                        >
                            <div className="lp-hero-mock-bar">
                                <span className="lp-hero-mock-dot" />
                                <span className="lp-hero-mock-dot" />
                                <span className="lp-hero-mock-dot" />
                            </div>
                            <div className="lp-hero-mock-body">
                                <div className="lp-hero-mock-seg">
                                    <span className="lp-hero-mock-time">00:00:12</span>
                                    <span className="lp-hero-mock-text">大家好，欢迎收看今天的节目。</span>
                                </div>
                                <div className="lp-hero-mock-seg selected">
                                    <span className="lp-hero-mock-time">00:00:18</span>
                                    <span className="lp-hero-mock-text">今天我们来聊一聊视频剪辑的话题。</span>
                                </div>
                                <div className="lp-hero-mock-seg">
                                    <span className="lp-hero-mock-time">00:00:25</span>
                                    <span className="lp-hero-mock-text">很多人觉得剪辑很复杂，但其实</span>
                                </div>
                                <div className="lp-hero-mock-seg accent">
                                    <span className="lp-hero-mock-time">00:00:32</span>
                                    <span className="lp-hero-mock-text">有了正确的工具，一切都很简单。</span>
                                </div>
                            </div>
                        </motion.div>
                    </div>
                </motion.div>

                <motion.div
                    className="lp-hero-scroll"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 0.5 }}
                    transition={{ delay: 1.2 }}
                >
                    <motion.div animate={{ y: [0, 6, 0] }} transition={{ duration: 1.8, repeat: Infinity }}>
                        <ChevronDown size={20} />
                    </motion.div>
                </motion.div>
            </section>

            {/* ── FEATURES ──────────────────────────────────── */}
            <SectionReveal id="features" className="lp-section">
                <div className="lp-section-eyebrow">核心功能</div>
                <h2 className="lp-section-title">从语音到成片，一气呵成</h2>
                <p className="lp-section-desc">
                    不用在时间线上拖拽找点，直接选中文字来剪辑。每步操作自动同步 DaVinci Resolve。
                </p>

                <StaggerList className="lp-bento-core">
                    {coreFeatures.map((f, i) => (
                        <div key={i} className={`lp-bento-item ${f.size || ''}`}>
                            <div className="lp-bento-icon" style={{ background: `${f.color}18`, color: f.color }}>
                                <f.icon size={22} />
                            </div>
                            <h3 className="lp-bento-title">{f.title}</h3>
                            <p className="lp-bento-desc">{f.desc}</p>
                        </div>
                    ))}
                </StaggerList>
            </SectionReveal>

            {/* ── PRACTICAL TOOLS ───────────────────────────── */}
            <SectionReveal id="tools" className="lp-section lp-section-alt">
                <div className="lp-section-eyebrow">实用工具</div>
                <h2 className="lp-section-title">专业后期，从容掌控</h2>
                <p className="lp-section-desc">
                    音效、素材、检查、导出——把繁琐的组织工作交给 QuickClip，你只需专注创作。
                </p>

                <StaggerList className="lp-tools-grid">
                    {practicalTools.map((f, i) => (
                        <div key={i} className="lp-tool-card">
                            <div className="lp-tool-icon" style={{ color: f.color }}>
                                <f.icon size={20} />
                            </div>
                            <div>
                                <h4 className="lp-tool-title">{f.title}</h4>
                                <p className="lp-tool-desc">{f.desc}</p>
                            </div>
                        </div>
                    ))}
                </StaggerList>
            </SectionReveal>

            {/* ── DOWNLOAD ───────────────────────────────────── */}
            <SectionReveal id="download" className="lp-section">
                <div className="lp-dl-hero">
                    <div className="lp-dl-hero-bg" />
                    <h2 className="lp-dl-hero-title">下载 QuickClip</h2>
                    <p className="lp-dl-hero-desc">
                        QuickClip 是 Tauri 桌面应用，需要下载安装到本地使用。
                        配合 DaVinci Resolve 运行，不支持在浏览器中使用。
                    </p>

                    <div className="lp-dl-platforms">
                        {releaseLoading ? (
                            <div className="lp-dl-platform" style={{ flexDirection: 'column', gap: 10, cursor: 'default' }}>
                                <Monitor size={36} />
                                <span className="lp-dl-platform-name">macOS</span>
                                <span className="lp-dl-platform-chip">加载中…</span>
                            </div>
                        ) : releaseData?.downloads?.['macos-aarch64'] || releaseData?.downloads?.['macos-x86_64'] ? (
                            <>
                                <div className="lp-dl-platform">
                                    <Monitor size={36} />
                                    <span className="lp-dl-platform-name">macOS</span>
                                    <div className="lp-dl-btns">
                                        {releaseData.downloads['macos-aarch64'] && (
                                            <a
                                                className="lp-dl-btn"
                                                href={releaseData.downloads['macos-aarch64']}
                                                download
                                            >
                                                <Download size={16} />
                                                Apple Silicon
                                            </a>
                                        )}
                                        {releaseData.downloads['macos-x86_64'] && (
                                            <a
                                                className="lp-dl-btn"
                                                href={releaseData.downloads['macos-x86_64']}
                                                download
                                            >
                                                <Download size={16} />
                                                Intel
                                            </a>
                                        )}
                                    </div>
                                </div>
                            </>
                        ) : (
                            <div className="lp-dl-platform" style={{ flexDirection: 'column', gap: 10, cursor: 'default' }}>
                                <Monitor size={36} />
                                <span className="lp-dl-platform-name">macOS</span>
                                <span className="lp-dl-platform-chip">Apple Silicon / Intel</span>
                            </div>
                        )}

                        <div className="lp-dl-platform disabled">
                            <Monitor size={36} />
                            <span className="lp-dl-platform-name">Windows</span>
                            <span className="lp-dl-platform-chip">即将支持</span>
                        </div>
                    </div>

                    {!releaseLoading && !releaseData?.downloads?.['macos-aarch64'] && !releaseData?.downloads?.['macos-x86_64'] && (
                        <p className="lp-dl-note">
                            安装包准备中，即将开放下载。关注项目获取最新动态。
                        </p>
                    )}
                </div>
            </SectionReveal>

            {/* ── FOOTER ─────────────────────────────────────── */}
            <footer className="lp-footer">
                <div className="lp-footer-inner">
                    <div className="lp-footer-brand">
                        <div className="lp-footer-logo">
                            <span className="lp-nav-dot" />
                            QuickClip
                        </div>
                        <p className="lp-footer-tagline">
                            DaVinci Resolve 文本驱动剪辑助手 — macOS 桌面应用
                        </p>
                    </div>
                    <div className="lp-footer-links">
                        <div className="lp-footer-col">
                            <h4>产品</h4>
                            <button onClick={() => scrollTo('features')}>功能介绍</button>
                            <button onClick={() => scrollTo('tools')}>实用工具</button>
                            <button onClick={() => scrollTo('download')}>下载</button>
                            <button onClick={() => navigate('/app')}>进入工作区</button>
                        </div>
                    </div>
                </div>
                <div className="lp-footer-bottom">
                    <span>&copy; 2026 QuickClip. 文字驱动视频剪辑。</span>
                </div>
            </footer>
        </div>
    );
}
