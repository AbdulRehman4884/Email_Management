import { create } from 'zustand';
import { clearUserScopedState } from '../lib/sessionReset';
import {
  authApi,
  clearLegacyStoredSession,
  onSessionChange,
  refreshSession,
  setSessionTokens,
  takeLegacyStoredToken,
  type SessionResponse,
} from '../lib/api';

// N-07 / N-17: the session is in HttpOnly cookies. This store keeps the user and the short access token in memory
// only (lost on reload, restored by hydrate() through the refresh cookie). Only the last user's id is persisted,
// so user-scoped settings (drafts, reporting scope) are cleared when a *different* account signs in.
const LAST_USER_ID_KEY = 'mailflow_last_user_id';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: string;
  preferredTheme?: 'light' | 'dark' | 'system';
  plan?: {
    code: string;
    name: string;
    smtpLimit: number;
    dailyEmailLimit: number;
    inboxEnabled: boolean;
    followUpEnabled: boolean;
    /** CRM module (plans.crm_enabled). Missing on old sessions = treat as unknown. */
    crmEnabled?: boolean;
    /** Lead Finder (plans.lead_gen_enabled). */
    leadGenEnabled?: boolean;
    leadGenDailyLimit?: number;
  } | null;
}

interface AuthState {
  user: AuthUser | null;
  /** Short-lived access token, in memory only (Bearer for the AI agent). */
  token: string | null;
  isHydrated: boolean;
  /** csrfToken: from login / refresh; omitted = keep the current one (e.g. after /auth/me). */
  setAuth: (user: AuthUser, token: string, csrfToken?: string) => void;
  logout: () => void;
  hydrate: () => Promise<void>;
  setHydrated: (value: boolean) => void;
}

function readLastUserId(): number | null {
  try {
    const raw = localStorage.getItem(LAST_USER_ID_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

function writeLastUserId(id: number | null): void {
  try {
    if (id == null) localStorage.removeItem(LAST_USER_ID_KEY);
    else localStorage.setItem(LAST_USER_ID_KEY, String(id));
  } catch {}
}

/** Clear user-scoped state only when the account actually changes (not on every reload or /auth/me refresh). */
function noteUser(user: AuthUser): void {
  const previousId = readLastUserId();
  if (previousId != null && previousId !== user.id) {
    clearUserScopedState();
  }
  writeLastUserId(user.id);
}

let hydrating: Promise<void> | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: null,
  isHydrated: false,

  setAuth: (user, token, csrfToken) => {
    const currentId = get().user?.id;
    if (currentId == null || currentId !== user.id) noteUser(user);
    setSessionTokens(token, csrfToken);
    set({ user, token });
  },

  logout: () => {
    clearUserScopedState();
    setSessionTokens(null, null);
    clearLegacyStoredSession();
    set({ user: null, token: null });
  },

  // Restores the session after a reload: once per page (RequireAuth, Login and App may all call it).
  hydrate: () => {
    if (get().isHydrated) return Promise.resolve();
    if (hydrating) return hydrating;
    hydrating = (async () => {
      let session: SessionResponse | null = null;
      // Migration (N-07): a 7-day token left in storage by the previous build becomes a cookie session.
      const legacyToken = takeLegacyStoredToken();
      if (legacyToken) {
        try {
          session = await authApi.upgradeLegacySession(legacyToken);
        } catch {
          session = null;
        }
      }
      if (!session) session = await refreshSession();
      if (session) {
        noteUser(session.user);
        setSessionTokens(session.token, session.csrfToken);
        set({ user: session.user, token: session.token, isHydrated: true });
      } else {
        set({ user: null, token: null, isHydrated: true });
      }
    })().finally(() => {
      hydrating = null;
    });
    return hydrating;
  },

  setHydrated: (value) => set({ isHydrated: value }),
}));

// A refresh started anywhere (401 retry, agent call) keeps the store in step; a failed one signs out.
onSessionChange((session) => {
  const state = useAuthStore.getState();
  if (!state.isHydrated) return; // hydrate() handles the first one itself
  if (session) {
    useAuthStore.setState({ token: session.token, user: state.user ? { ...state.user, ...session.user } : session.user });
  } else {
    useAuthStore.setState({ token: null });
  }
});
