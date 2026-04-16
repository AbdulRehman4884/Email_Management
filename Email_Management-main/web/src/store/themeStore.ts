import { create } from 'zustand';
import { authApi } from '../lib/api';

const THEME_KEY = 'mailflow_theme';
const THEME_VALUES = ['light', 'dark', 'system'] as const;
export type ThemeValue = (typeof THEME_VALUES)[number];

function getStoredTheme(): ThemeValue {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {}
  return 'dark';
}

function resolveEffectiveTheme(theme: ThemeValue): 'light' | 'dark' {
  if (theme === 'system') {
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    return 'light';
  }
  return theme;
}

function applyTheme(theme: ThemeValue) {
  const effective = resolveEffectiveTheme(theme);
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('data-theme', effective);
  }
}

interface ThemeState {
  theme: ThemeValue;
  setTheme: (value: ThemeValue) => void;
  hydrate: () => void;
  setThemeFromServer: (preferredTheme: ThemeValue) => void;
  getEffectiveTheme: () => 'light' | 'dark';
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: 'dark',

  setTheme: (value) => {
    set({ theme: value });
    applyTheme(value);
    try {
      localStorage.setItem(THEME_KEY, value);
    } catch {}
    const token = typeof sessionStorage !== 'undefined' ? (sessionStorage.getItem('auth_token') ?? localStorage.getItem('auth_token')) : null;
    if (token) {
      authApi.updatePreferredTheme(value).catch(() => {});
    }
  },

  hydrate: () => {
    const stored = getStoredTheme();
    set({ theme: stored });
    applyTheme(stored);
  },

  setThemeFromServer: (preferredTheme) => {
    const value: ThemeValue =
      preferredTheme === 'light' || preferredTheme === 'dark' || preferredTheme === 'system' ? preferredTheme : 'dark';
    set({ theme: value });
    applyTheme(value);
    try {
      localStorage.setItem(THEME_KEY, value);
    } catch {}
  },

  getEffectiveTheme: () => resolveEffectiveTheme(get().theme),
}));

let systemListener: (() => void) | null = null;

export function subscribeToSystemTheme(callback: () => void) {
  if (typeof window === 'undefined') return;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => callback();
  mq.addEventListener('change', handler);
  systemListener = () => {
    mq.removeEventListener('change', handler);
    systemListener = null;
  };
  return () => systemListener?.();
}
