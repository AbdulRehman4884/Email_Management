import { create } from 'zustand';
import { authApi, getAccessToken } from '../lib/api';

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

/**
 * Bug 36: the app has no dark styles yet and no theme control, so it always runs in light mode.
 * A saved "dark" / "system" preference (server or browser) is ignored, and "light" is stored in the browser
 * so the early script in index.html also starts in light mode. Remove this when a dark theme is built.
 */
const LIGHT_ONLY = true;

function applyTheme(theme: ThemeValue) {
  const effective = LIGHT_ONLY ? 'light' : resolveEffectiveTheme(theme);
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
  theme: LIGHT_ONLY ? 'light' : 'dark',

  setTheme: (value) => {
    set({ theme: value });
    applyTheme(value);
    try {
      localStorage.setItem(THEME_KEY, value);
    } catch {}
    // Signed in = there is an in-memory session (N-07: no token in storage any more).
    if (getAccessToken()) {
      authApi.updatePreferredTheme(value).catch(() => {});
    }
  },

  hydrate: () => {
    const stored = LIGHT_ONLY ? 'light' : getStoredTheme();
    set({ theme: stored });
    applyTheme(stored);
    if (LIGHT_ONLY) {
      try {
        localStorage.setItem(THEME_KEY, 'light');
      } catch {}
    }
  },

  setThemeFromServer: (preferredTheme) => {
    const value: ThemeValue = LIGHT_ONLY
      ? 'light'
      : preferredTheme === 'light' || preferredTheme === 'dark' || preferredTheme === 'system' ? preferredTheme : 'dark';
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
