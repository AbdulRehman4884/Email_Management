import type React from 'react';

/** Small shared styles for the Pipeline Builder (the app's CSS has no form-control utility for compact inputs). */
export const controlStyle: React.CSSProperties = {
  height: 34,
  padding: '0 10px',
  borderRadius: 8,
  border: '1px solid #d1d5db',
  background: '#ffffff',
  color: '#111827',
  fontSize: 13,
  minWidth: 0,
};

export const smallControlStyle: React.CSSProperties = { ...controlStyle, height: 30, fontSize: 12, padding: '0 8px' };

export const iconButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  borderRadius: 6,
  color: '#6b7280',
  flexShrink: 0,
};

export const pillStyle = (color: string): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 8px',
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 600,
  background: `${color}1f`,
  border: `1px solid ${color}66`,
  color: '#111827',
  whiteSpace: 'nowrap',
});

export const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: '#374151',
  marginBottom: 4,
};
