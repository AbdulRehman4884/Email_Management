import { useCampaignStore, useDashboardStore } from '../store';
import { incrementSessionGeneration } from './api';
import { REPORTING_SMTP_PROFILE_STORAGE_KEY } from './reportingScope';
import { FOLLOW_UP_SCHEDULE_DRAFT_KEY } from './followUpScheduleDraft';

/** localStorage keys that hold data scoped to the currently logged-in user. */
const USER_SCOPED_LOCAL_STORAGE_KEYS = [
  REPORTING_SMTP_PROFILE_STORAGE_KEY,
  'mailflow-agent-chat-v1',
  'create-campaign-draft-v1',
  'inbox-active-thread-root-id',
  'inbox-active-tab',
];

/** sessionStorage keys that hold data scoped to the currently logged-in user. */
const USER_SCOPED_SESSION_STORAGE_KEYS = [FOLLOW_UP_SCHEDULE_DRAFT_KEY];

/** Window event the ToastProvider listens for to drop any toasts from the previous session. */
export const CLEAR_USER_TOASTS_EVENT = 'mailflow:clear-user-toasts';

/**
 * Clears all in-memory store state and persisted keys that belong to a specific user, so
 * switching accounts never surfaces the previous user's campaigns, stats, drafts, or filters.
 * Auth token/user removal is handled separately by the auth store.
 */
export function clearUserScopedState(): void {
  // Bump the generation counter first so any in-flight requests from the
  // previous session are silently discarded by the api.ts response interceptor.
  incrementSessionGeneration();
  try {
    useCampaignStore.getState().reset();
  } catch {
    // store may not be initialized in some contexts (e.g. tests)
  }
  try {
    useDashboardStore.getState().reset();
  } catch {
    // ignore
  }
  for (const key of USER_SCOPED_LOCAL_STORAGE_KEYS) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // ignore private-mode / quota errors
    }
  }
  for (const key of USER_SCOPED_SESSION_STORAGE_KEYS) {
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
  try {
    window.dispatchEvent(new Event(CLEAR_USER_TOASTS_EVENT));
  } catch {
    // ignore (non-browser environments)
  }
}
