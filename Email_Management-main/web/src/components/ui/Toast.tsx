import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { CheckCircle, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  /** ms before auto-dismiss; default 4000 */
  duration?: number;
}

interface ToastContextValue {
  show: (message: string, type?: ToastType, duration?: number) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
}

// ── Context ───────────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

// ── Single toast item ─────────────────────────────────────────────────────────

const CONFIG: Record<ToastType, { bg: string; border: string; text: string; icon: React.ElementType }> = {
  success: { bg: '#f0fdf4', border: '#86efac', text: '#166534', icon: CheckCircle },
  error:   { bg: '#fef2f2', border: '#fca5a5', text: '#991b1b', icon: AlertCircle },
  warning: { bg: '#fffbeb', border: '#fde68a', text: '#92400e', icon: AlertTriangle },
  info:    { bg: '#eff6ff', border: '#93c5fd', text: '#1e40af', icon: Info },
};

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: (id: string) => void }) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { bg, border, text, icon: Icon } = CONFIG[toast.type];

  useEffect(() => {
    // Trigger enter animation on next frame
    const raf = requestAnimationFrame(() => setVisible(true));
    timerRef.current = setTimeout(() => dismiss(), toast.duration ?? 4000);
    return () => {
      cancelAnimationFrame(raf);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function dismiss() {
    setVisible(false);
    setTimeout(() => onRemove(toast.id), 300);
  }

  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.625rem',
        padding: '0.75rem 1rem',
        borderRadius: '0.75rem',
        border: `1px solid ${border}`,
        backgroundColor: bg,
        color: text,
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        minWidth: '280px',
        maxWidth: '360px',
        cursor: 'default',
        transition: 'opacity 0.3s ease, transform 0.3s cubic-bezier(0.34,1.56,0.64,1)',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateX(0)' : 'translateX(24px)',
      }}
    >
      <Icon
        style={{ width: '1.125rem', height: '1.125rem', flexShrink: 0, marginTop: '0.1rem' }}
        aria-hidden
      />
      <span style={{ fontSize: '0.875rem', lineHeight: '1.4', flex: 1, fontWeight: 500 }}>
        {toast.message}
      </span>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        style={{
          background: 'none',
          border: 'none',
          padding: '0',
          cursor: 'pointer',
          color: text,
          opacity: 0.6,
          lineHeight: 0,
          flexShrink: 0,
        }}
      >
        <X style={{ width: '1rem', height: '1rem' }} />
      </button>
    </div>
  );
}

// ── Provider + container ──────────────────────────────────────────────────────

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback((message: string, type: ToastType = 'info', duration?: number) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, message, duration }]);
  }, []);

  const success = useCallback((msg: string, d?: number) => show(msg, 'success', d), [show]);
  const error   = useCallback((msg: string, d?: number) => show(msg, 'error',   d), [show]);
  const warning = useCallback((msg: string, d?: number) => show(msg, 'warning', d), [show]);
  const info    = useCallback((msg: string, d?: number) => show(msg, 'info',    d), [show]);

  return (
    <ToastContext.Provider value={{ show, success, error, warning, info }}>
      {children}

      {/* Bottom-left fixed container */}
      <div
        aria-live="polite"
        style={{
          position: 'fixed',
          bottom: '1.5rem',
          right: '1.5rem',
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
          pointerEvents: toasts.length === 0 ? 'none' : 'auto',
        }}
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onRemove={remove} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
