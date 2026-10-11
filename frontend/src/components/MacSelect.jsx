import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown } from 'lucide-react';

export default function MacSelect({ value, onChange, options, placeholder, width = '100%', showPlaceholderOption = true }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const [dropdownStyle, setDropdownStyle] = useState({});

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const availableBelow = viewportHeight - rect.bottom - 8;
    const maxH = Math.max(120, Math.min(320, availableBelow));
    setDropdownStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      zIndex: 10000,
      maxHeight: maxH + 'px'
    });
  }, []);

  useEffect(() => {
    if (open) {
      updatePosition();
      const onScroll = () => updatePosition();
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onScroll);
      return () => {
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onScroll);
      };
    }
  }, [open, updatePosition]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (open && triggerRef.current && !triggerRef.current.contains(e.target)) {
        const dropdownEl = document.getElementById('mac-select-dropdown');
        if (dropdownEl && dropdownEl.contains(e.target)) return;
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const selected = options.find(o => o.value === value);

  return (
    <div ref={triggerRef} style={{ position: 'relative', width }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          width: '100%',
          padding: '8px 28px 8px 12px',
          fontSize: '13px',
          borderRadius: '8px',
          border: '1px solid var(--mac-border)',
          background: 'var(--mac-input-bg)',
          color: selected ? 'var(--mac-text)' : 'var(--mac-text-secondary)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          userSelect: 'none',
          transition: 'border-color 0.15s',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
      >
        {selected ? selected.label : placeholder}
        <ChevronDown size={14} style={{
          position: 'absolute',
          right: '8px',
          top: '50%',
          transform: `translateY(-50%) rotate(${open ? 180 : 0}deg)`,
          transition: 'transform 0.2s',
          pointerEvents: 'none',
          color: 'var(--mac-text-secondary)'
        }} />
      </div>
      {open && createPortal(
        <AnimatePresence>
          <motion.div
            id="mac-select-dropdown"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            style={{
              ...dropdownStyle,
              background: 'var(--mac-bg, #1e1e1e)',
              border: '1px solid var(--mac-border)',
              borderRadius: '8px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              padding: '4px',
              overflowY: 'auto'
            }}
          >
            {showPlaceholderOption && (
              <div
                onClick={() => { onChange(''); setOpen(false); }}
                style={{
                  padding: '7px 10px',
                  fontSize: '13px',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  color: !value ? 'var(--mac-accent)' : 'var(--mac-text)',
                  background: !value ? 'var(--mac-accent-bg)' : 'transparent',
                }}
                onMouseEnter={e => { if (value) e.currentTarget.style.background = 'var(--mac-hover)'; }}
                onMouseLeave={e => { if (value) e.currentTarget.style.background = 'transparent'; }}
              >
                {placeholder}
              </div>
            )}
            {options.map(opt => (
              <div
                key={opt.value}
                onClick={() => { onChange(opt.value); setOpen(false); }}
                style={{
                  padding: '7px 10px',
                  fontSize: '13px',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  color: opt.value === value ? 'var(--mac-accent)' : 'var(--mac-text)',
                  background: opt.value === value ? 'var(--mac-accent-bg)' : 'transparent',
                }}
                onMouseEnter={e => { if (opt.value !== value) e.currentTarget.style.background = 'var(--mac-hover)'; }}
                onMouseLeave={e => { if (opt.value !== value) e.currentTarget.style.background = 'transparent'; }}
              >
                {opt.label}
              </div>
            ))}
          </motion.div>
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
}