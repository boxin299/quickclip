import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import './StartupView.css';

/* ═══════════════════════════════════════════════════════════
   Pure CSS pulse indicator (no external deps)
   ═══════════════════════════════════════════════════════════ */

function StartupView({ onComplete }) {
    const [phase, setPhase] = useState('logo'); // logo → fadeout → done

    useEffect(() => {
        const t1 = setTimeout(() => setPhase('fadeout'), 1400);
        const t2 = setTimeout(() => {
            setPhase('done');
            onComplete?.();
        }, 2000);
        return () => {
            clearTimeout(t1);
            clearTimeout(t2);
        };
    }, [onComplete]);

    return (
        <AnimatePresence>
            {phase !== 'done' && (
                <motion.div
                    className="startup-root"
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.35, ease: 'easeOut' }}
                >
                    <motion.div
                        className="startup-center"
                        initial={{ opacity: 0, scale: 0.94 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ type: 'spring', stiffness: 120, damping: 18, delay: 0.08 }}
                    >
                        {/* Logo mark */}
                        <div className="startup-mark">
                            <svg
                                width="48"
                                height="48"
                                viewBox="0 0 48 48"
                                fill="none"
                                xmlns="http://www.w3.org/2000/svg"
                            >
                                <rect width="48" height="48" rx="14" fill="#10b981" fillOpacity="0.12" />
                                <rect
                                    x="12"
                                    y="16"
                                    width="24"
                                    height="16"
                                    rx="3"
                                    stroke="#10b981"
                                    strokeWidth="2.5"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                />
                                <path
                                    d="M18 16V12a6 6 0 0 1 12 0v4"
                                    stroke="#10b981"
                                    strokeWidth="2.5"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                />
                                <circle cx="24" cy="24" r="3" fill="#10b981" />
                            </svg>
                        </div>

                        {/* Brand */}
                        <div className="startup-brand">QuickClip</div>
                        <div className="startup-tagline">文本驱动视频剪辑</div>

                        {/* Progress bar */}
                        <div className="startup-progress-track">
                            <motion.div
                                className="startup-progress-fill"
                                initial={{ width: '0%' }}
                                animate={{ width: '100%' }}
                                transition={{ duration: 1.6, ease: 'easeInOut' }}
                            />
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

export default StartupView;
