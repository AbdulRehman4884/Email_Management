import '@testing-library/jest-dom';
import { vi } from 'vitest';

// ── scrollIntoView stub ────────────────────────────────────────────────────────
// jsdom does not implement scrollIntoView — silence the "not implemented" error
window.HTMLElement.prototype.scrollIntoView = vi.fn();

// ── ResizeObserver stub ────────────────────────────────────────────────────────
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// ── localStorage mock ─────────────────────────────────────────────────────────
// Vitest v4 passes --localstorage-file to Node which replaces jsdom's Storage
// with a minimal stub that lacks .clear() / .key(). Replace it entirely.
const buildLocalStorageMock = () => {
  let store: Record<string, string> = {};
  return {
    get length() { return Object.keys(store).length; },
    key:        (i: number) => Object.keys(store)[i] ?? null,
    getItem:    (k: string) => store[k] ?? null,
    setItem:    (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear:      () => { store = {}; },
  };
};

Object.defineProperty(window, 'localStorage', {
  value: buildLocalStorageMock(),
  writable: true,
});
