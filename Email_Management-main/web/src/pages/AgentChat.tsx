import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  BarChart2,
  Bot,
  Check,
  Copy,
  Download,
  Menu,
  Inbox,
  Megaphone,
  Paperclip,
  RefreshCw,
  X,
  Send,
  Settings,
  Sparkles,
  Square,
} from 'lucide-react';
import { Button, Card, CardContent, CardHeader, TextArea } from '../components/ui';
import { AgentResponseCard } from '../components/AgentResponseCard';
import { MarkdownMessage } from '../components/MarkdownMessage';
import { ChatSidebar } from '../components/ChatSidebar';
import { ChatSearchDialog } from '../components/ChatSearchDialog';
import { agentApi, agentChatsApi, type AgentChatSummary, type AgentPendingAction } from '../lib/api';
import { libraryApi } from '../lib/libraryApi';
import { type AgentStructuredResult, type ScheduleChoice, type SenderChoice, extractCampaignIdFromText, isCapabilitiesText, isCampaignData, isNeedsInputResult } from '../lib/agentMessage';
import { ChatScheduleForm } from '../components/ChatScheduleForm';
import { ChatSenderForm } from '../components/ChatSenderForm';

// ── Types ──────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  timestamp: Date;
  /** Structured agent result — present when the backend returned a typed response envelope. */
  structured?: AgentStructuredResult;
  /** Present when the agent returned a redirect action — renders an "Open Settings" button. */
  navigatePath?: string;
  /** A failed request: the text the Retry button sends again (QA P4 bug 7). */
  retryText?: string;
  /** Not saved to the browser or server history (a failed request and its error bubble). */
  transient?: boolean;
}

interface PersistedChat {
  sessionId?: string;
  activeCampaignId?: string;
  messages: Array<{
    id?: string;
    role: 'user' | 'assistant' | 'error';
    content: string;
    timestamp: string; // ISO string
    structured?: AgentStructuredResult;
    navigatePath?: string;
  }>;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const CHAT_STORAGE_KEY = 'mailflow-agent-chat-v1';

const SUGGESTED_PROMPTS = [
  'Create campaign',
  // Automations: form leads or campaign follow-ups; the agent asks which one.
  'Create automation',
  'Show all campaigns',
  'Check SMTP configuration',
  'Show inbox replies',
  'Generate personalized emails',
  'Pause a campaign',
  // Lead Finder: the agent asks for the business type (and focus) and the city.
  'Find new leads',
] as const;

const SCRIPT_GENERATION_PROMPT = 'Save this file for script generation';

/** Shown as starters on the empty chat; the chip row hides them meanwhile (bug A-18). */
const EMPTY_STATE_PROMPTS = ['Create campaign', 'Show all campaigns', 'Show inbox replies'] as const;

/** Same limit as the agent API (bugs A-12 / A-20). */
const MAX_MESSAGE_LENGTH = 4000;
const INTERRUPTED_REPLY = 'This reply was interrupted before it was saved.';

function isResearchReport(content: string): boolean {
  return /^# (?:Outreach Email Templates|Executive Campaign Intelligence Report|Company Intelligence Report|Bulk Campaign Workflow|Template Generation Progress|Template Preview|Campaign Draft Created)/m.test(content);
}

// ── localStorage helpers ───────────────────────────────────────────────────────

function loadPersisted(): PersistedChat | null {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedChat) : null;
  } catch {
    return null;
  }
}

function serializeMessages(messages: ChatMessage[]): PersistedChat['messages'] {
  return messages.filter((m) => !m.transient).map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    timestamp: m.timestamp.toISOString(),
    structured: m.structured,
    navigatePath: m.navigatePath,
  }));
}

/**
 * markInterrupted: a chat whose last message is the user's had its reply cut off (page reload). Not for a chat
 * another tab just saved — that tab may still be waiting for the reply.
 */
function deserializeMessages(saved: PersistedChat['messages'], markInterrupted = true): ChatMessage[] {
  const messages: ChatMessage[] = saved.map((m) => ({
    id: m.id || makeId(m.role),
    role: m.role,
    content: m.content,
    timestamp: new Date(m.timestamp),
    structured: m.structured,
    navigatePath: m.navigatePath,
  }));
  const last = messages[messages.length - 1];
  if (markInterrupted && last?.role === 'user') {
    messages.push({
      id: makeId('error'),
      role: 'error',
      content: INTERRUPTED_REPLY,
      timestamp: new Date(),
    });
  }
  return messages;
}

function savePersisted(sessionId: string | undefined, messages: ChatMessage[], activeCampaignId?: string): void {
  try {
    const payload: PersistedChat = {
      sessionId,
      activeCampaignId,
      messages: serializeMessages(messages),
    };
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage unavailable (private mode / quota exceeded)
  }
}

/**
 * "New chat": an empty chat is stored (not removed) so this browser does not reopen the newest
 * chat from the server on the next visit — that only happens on a browser with no chat at all.
 */
function clearPersisted(): void {
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify({ messages: [] } satisfies PersistedChat));
  } catch {
    // ignore
  }
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

/**
 * "09:20" for today; "1 Oct, 09:20" for an older message (and the year when it is not this year),
 * so old stats are not read as current (QA P4 bug 27).
 */
export function formatTime(date: Date, now: Date = new Date()): string {
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return time;
  const day = date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
  return `${day}, ${time}`;
}

/** The chat as plain text for "Download chat" (QA P4 bug 15). Markdown stars are removed. */
export function chatAsText(messages: Array<Pick<ChatMessage, 'role' | 'content' | 'timestamp'>>): string {
  const who = { user: 'You', assistant: 'MailFlow AI', error: 'Error' } as const;
  return messages
    .map((m) => `[${m.timestamp.toLocaleString()}] ${who[m.role]}:\n${m.content.replace(/\*\*(.+?)\*\*/g, '$1')}`)
    .join('\n\n');
}

/** Copy button under an agent reply (QA P4 bug 14). Copies the reply text with its lists and line breaks. */
function CopyReplyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      data-testid="copy-reply"
      aria-label={copied ? 'Copied' : 'Copy reply'}
      title="Copy reply"
      className="chat-copy-button mt-1 inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text.replace(/\*\*(.+?)\*\*/g, '$1'));
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** Full date and time for the hover title of a message time. */
function fullDateTime(date: Date): string {
  return date.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' });
}

function makeId(role: string): string {
  return `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}


/** Renders an error message with an icon inside the bubble. */
function renderError(content: string): React.ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.375rem' }}>
      <AlertCircle
        style={{
          width: '0.875rem',
          height: '0.875rem',
          flexShrink: 0,
          marginTop: '0.15rem',
          color: '#ef4444',
        }}
      />
      <span>{content}</span>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

/**
 * What the agent is doing, from the question (the reply is not streamed). Shown next to the dots so a
 * 6-11 second wait does not look stuck (QA P4 bug 16).
 */
export function progressText(question: string, seconds: number): string {
  const q = question.toLowerCase();
  const what =
    /summar|repl|inbox|interested|responses?/.test(q) ? 'Reading your replies'
    : /stat|open rate|analytic|report|perform|how many|click/.test(q) ? 'Fetching your campaign numbers'
    : /lead|find|search/.test(q) ? 'Looking at your lead searches'
    : /script|file|csv|excel/.test(q) ? 'Reading your file'
    : /campaign/.test(q) ? 'Checking your campaigns'
    : 'Working on it';
  if (seconds >= 12) return `${what}… this one is taking longer than usual, still working.`;
  if (seconds >= 5) return `${what}… almost there.`;
  return `${what}…`;
}

function TypingIndicator({ question }: { question?: string }) {
  const [seconds, setSeconds] = React.useState(0);
  React.useEffect(() => {
    const started = Date.now();
    const t = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="flex justify-start items-center gap-2 animate-msgIn" data-testid="typing-indicator">
      <div
        style={{
          background: '#ffffff',
          border: '1px solid #e5e7eb',
          borderRadius: '0.75rem',
          padding: '0.625rem 0.875rem',
          boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
          display: 'flex',
          alignItems: 'center',
          gap: '5px',
        }}
      >
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </div>
      <span className="text-xs text-gray-600" role="status" aria-live="polite" data-testid="progress-text">
        {progressText(question ?? '', seconds)}
      </span>
    </div>
  );
}

function ApprovalCard({
  action,
  loading,
  onConfirm,
  onCancel,
}: {
  action: AgentPendingAction;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cardRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { cardRef.current?.querySelector<HTMLButtonElement>('[data-testid="cancel-button"]')?.focus(); }, []);
  const toolLabel = action.toolName.replace(/_/g, ' ');
  const minutesLeft = Math.max(
    0,
    Math.round((new Date(action.expiresAt).getTime() - Date.now()) / 60_000),
  );

  return (
    <div
      ref={cardRef}
      data-testid="approval-card"
      role="alert"
      aria-label="Action requires approval"
      tabIndex={-1}
      style={{
        border: '1px solid #fcd34d',
        borderLeft: '3px solid #f59e0b',
        background: '#fffbeb',
        borderRadius: '0.5rem',
        padding: '0.875rem 1rem',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          marginBottom: '0.5rem',
        }}
      >
        <AlertTriangle
          style={{ width: '1rem', height: '1rem', color: '#d97706', flexShrink: 0 }}
        />
        <p className="text-sm font-semibold text-amber-900">
          Action requires your approval
        </p>
      </div>

      {/* Summary */}
      <div style={{ marginBottom: '0.75rem' }}>
        <p className="sr-only">The message box is locked until you confirm or cancel this action.</p>
        <p className="text-sm text-amber-800">
          Tool:{' '}
          <code
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, monospace',
              fontSize: '0.8rem',
              background: 'rgba(0,0,0,0.06)',
              padding: '0.1em 0.4em',
              borderRadius: '0.25rem',
            }}
          >
            {toolLabel}
          </code>
        </p>
        {minutesLeft > 0 && (
          <p className="text-xs text-amber-700 mt-0.5">
            Expires in {minutesLeft} minute{minutesLeft !== 1 ? 's' : ''}
          </p>
        )}
      </div>

      {/* Actions — "approval-actions": 44px targets and a wider gap on touch screens (QA P4 bug 30) */}
      <div className="approval-actions flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={onConfirm}
          isLoading={loading}
          data-testid="confirm-button"
        >
          Confirm
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={onCancel}
          disabled={loading}
          data-testid="cancel-button"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Welcome tiles: a click puts a sample question for that area in the message box (QA P4 bug 28). */
const CAPABILITIES = [
  { icon: <Sparkles className="w-4 h-4" />, label: 'AI Campaigns', desc: 'Personalized emails',  sample: 'Create an AI campaign' },
  { icon: <Megaphone className="w-4 h-4" />, label: 'Campaigns',   desc: 'Create, update & run', sample: 'Show all campaigns' },
  { icon: <BarChart2 className="w-4 h-4" />, label: 'Analytics',   desc: 'Stats & open rates',   sample: 'How are my campaigns doing?' },
  { icon: <Inbox     className="w-4 h-4" />, label: 'Inbox',       desc: 'Replies & summaries',  sample: 'Summarize my inbox replies' },
  { icon: <Settings  className="w-4 h-4" />, label: 'Settings',    desc: 'SMTP configuration',   sample: 'Check SMTP configuration' },
];

function EmptyState({
  onSend,
  onPrefill,
  disabled,
}: {
  onSend: (t: string) => void;
  onPrefill: (t: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-4 py-6 gap-5">
      {/* Avatar + heading */}
      <div className="flex flex-col items-center gap-2">
        <div
          style={{
            width: '3.25rem',
            height: '3.25rem',
            borderRadius: '9999px',
            background: '#f3f4f6',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Bot className="w-6 h-6 text-gray-600" />
        </div>
        <h2 className="text-base font-semibold text-gray-900">
          Hi, I&apos;m your MailFlow AI Agent
        </h2>
        <p className="text-sm text-gray-500" style={{ maxWidth: '22rem' }}>
          Ask me to manage campaigns, check analytics, or read your inbox.
        </p>
      </div>

      {/* Capability grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '0.5rem',
          width: '100%',
          maxWidth: '22rem',
        }}
      >
        {CAPABILITIES.map((cap) => (
          <button
            type="button"
            key={cap.label}
            data-testid="welcome-tile"
            disabled={disabled}
            title={`Try: ${cap.sample}`}
            aria-label={`${cap.label}: put "${cap.sample}" in the message box`}
            onClick={() => onPrefill(cap.sample)}
            className="welcome-tile"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.5rem 0.75rem',
              borderRadius: '0.5rem',
              background: '#f9fafb',
              border: '1px solid #e5e7eb',
              cursor: disabled ? 'default' : 'pointer',
              font: 'inherit',
            }}
          >
            <span style={{ color: '#6b7280', flexShrink: 0 }}>{cap.icon}</span>
            <div style={{ textAlign: 'left', minWidth: 0 }}>
              <p className="text-xs font-semibold text-gray-700">{cap.label}</p>
              <p className="text-xs text-gray-600">{cap.desc}</p>
            </div>
          </button>
        ))}
      </div>

      {/* Starter chips */}
      <div style={{ width: '100%', maxWidth: '24rem' }}>
        <p className="text-xs text-gray-400 mb-2">Try asking:</p>
        <div className="flex flex-wrap justify-center gap-2">
          {EMPTY_STATE_PROMPTS.map(
            (prompt) => (
              <button
                key={prompt}
                className="chat-prompt-chip"
                disabled={disabled}
                data-testid="empty-state-prompt"
                onClick={() => onSend(prompt)}
              >
                {prompt}
              </button>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function AgentChat() {
  // ── State — lazy-initialised from localStorage ─────────────────────────────

  const [messages, setMessages] = React.useState<ChatMessage[]>(() => {
    const saved = loadPersisted();
    if (!saved) return [];
    return deserializeMessages(saved.messages);
  });

  const [sessionId, setSessionId] = React.useState<string | undefined>(
    () => loadPersisted()?.sessionId,
  );

  const [activeCampaignId, setActiveCampaignId] = React.useState<string | undefined>(
    () => loadPersisted()?.activeCampaignId,
  );

  const [input, setInput] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<AgentPendingAction | null>(null);
  const [fileUploading, setFileUploading] = React.useState(false);
  /** File waiting to be sent with the next message — the prompt is required. */
  const [attachedFile, setAttachedFile] = React.useState<File | null>(null);
  /** "Finish the current task first" popup — shown instead of a chat reply. */
  const [busyNotice, setBusyNotice] = React.useState<string | null>(null);

  const navigate = useNavigate();
  const location = useLocation();

  // Library → "Use in chat": the saved file is attached again (nothing is sent until the user presses Send).
  React.useEffect(() => {
    const picked = (location.state as { libraryFile?: { id: number; fileName: string } } | null)?.libraryFile;
    if (!picked) return;
    navigate(location.pathname, { replace: true, state: null });
    void libraryApi
      .blob(picked.id)
      .then((blob) => {
        if (mountedRef.current) setAttachedFile(new File([blob], picked.fileName, { type: blob.type }));
      })
      .catch(() => window.alert('That file could not be loaded from the Library. It may have been deleted.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  // ── Refs ───────────────────────────────────────────────────────────────────

  const messagesEndRef = React.useRef<HTMLDivElement>(null);
  const latestMessageRef = React.useRef<HTMLDivElement>(null);
  const chatMessagesRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // Prevents setState calls after the component has unmounted (e.g. navigating
  // away mid-request). React 18 no longer warns but async mutations can still
  // corrupt state if the component remounts with stale closures.
  const mountedRef = React.useRef(true);
  // Each send gets a number; Stop bumps it so the reply of the stopped request is ignored (QA P4 bug 6).
  const requestSeqRef = React.useRef(0);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Persistence ────────────────────────────────────────────────────────────
  // Skip saving when the conversation is empty — this prevents re-writing
  // {"messages":[]} after clearPersisted() runs on "New chat".

  React.useEffect(() => {
    if (messages.length === 0 && !sessionId) return;
    savePersisted(sessionId, messages, activeCampaignId);
  }, [messages, sessionId, activeCampaignId]);

  // ── Several tabs (QA P3-2 bug 8) ───────────────────────────────────────────
  // Another tab saved the chat: take its messages, so this tab never saves an older copy over them.
  const loadHistoryRef = React.useRef<() => Promise<unknown>>(async () => undefined);
  React.useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== CHAT_STORAGE_KEY || !e.newValue) return;
      try {
        const saved = JSON.parse(e.newValue) as PersistedChat;
        setMessages(deserializeMessages(saved.messages ?? [], false));
        setSessionId(saved.sessionId);
        setActiveCampaignId(saved.activeCampaignId);
        void loadHistoryRef.current();
      } catch { /* ignore a broken value */ }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // ── Chat history on the server (bug A-17) ──────────────────────────────────
  // Every chat is also saved to the account and shown in the "Recent" sidebar (the latest 10; the server
  // keeps 10 chats for 30 days). If the server history is unavailable the page works as before.

  /** null = not loaded; false = history unavailable (the chat stays in this browser only). */
  const [history, setHistory] = React.useState<AgentChatSummary[] | null | false>(null);
  /** The sidebar drawer on phones. */
  const [sidebarOpen, setSidebarOpen] = React.useState(false); // phone drawer
  const [sidebarHidden, setSidebarHidden] = React.useState(false); // large screens: sidebar collapsed

  const loadHistory = React.useCallback(async () => {
    const chats = await agentChatsApi.list();
    if (mountedRef.current) setHistory(chats ?? false);
    return chats;
  }, []);

  React.useEffect(() => { loadHistoryRef.current = loadHistory; }, [loadHistory]);

  React.useEffect(() => {
    if (!sessionId || messages.length === 0) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        const saved = await agentChatsApi.save(sessionId, {
          messages: serializeMessages(messages),
          ...(activeCampaignId ? { activeCampaignId } : {}),
        });
        // The chat now exists on the server: show it (and its new time) at the top of the sidebar.
        if (saved) void loadHistory();
      })();
    }, 800);
    return () => window.clearTimeout(timer);
  }, [messages, sessionId, activeCampaignId, loadHistory]);

  const openChat = React.useCallback(async (chatSessionId: string) => {
    const chat = await agentChatsApi.get(chatSessionId);
    if (!chat || !mountedRef.current) return false;
    setMessages(deserializeMessages(chat.messages as PersistedChat['messages']));
    setSessionId(chat.sessionId);
    setActiveCampaignId(chat.activeCampaignId ?? undefined);
    setPendingAction(null);
    return true;
  }, []);

  // The sidebar list loads when the page opens. A browser with no chat of its own (another device, after
  // sign-in) also opens the newest saved chat.
  React.useEffect(() => {
    const hadChat = loadPersisted() !== null;
    let cancelled = false;
    void (async () => {
      const chats = await loadHistory();
      if (cancelled || hadChat || !chats?.length) return;
      void openChat(chats[0]!.sessionId);
    })();
    return () => { cancelled = true; };
  }, [openChat, loadHistory]);

  // ── Scroll ─────────────────────────────────────────────────────────────────

  const scrollToBottom = React.useCallback(() => {
    // Scroll only the chat viewport. scrollIntoView also moved the page on
    // short phone screens, pushing the answer and composer out of view.
    const viewport = chatMessagesRef.current;
    const message = latestMessageRef.current;
    if (!viewport || !message) return;
    const delta = message.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    viewport.scrollTop = Math.max(0, viewport.scrollTop + delta - 8);
  }, []);

  React.useEffect(() => {
    scrollToBottom();
  }, [messages, loading, scrollToBottom]);

  // ── Auto-resize textarea ───────────────────────────────────────────────────

  React.useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // ── Focus helper ───────────────────────────────────────────────────────────

  const focusInput = React.useCallback(() => {
    // preventScroll: focusing the box scrolled the whole page down after every answer, hiding it on phones (QA P3 bug 46).
    setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 50);
  }, []);

  /** Empty chat; the old one stays in the sidebar (it is on the server). */
  const startNewChat = React.useCallback((saveFirst = true) => {
    // The save above waits 0.8s after the last message; save right now so a quick click on New chat loses nothing.
    if (saveFirst && sessionId && messages.length > 0) {
      void (async () => {
        const saved = await agentChatsApi.save(sessionId, {
          messages: serializeMessages(messages),
          ...(activeCampaignId ? { activeCampaignId } : {}),
        });
        if (saved) void loadHistory();
      })();
    }
    setMessages([]);
    setSessionId(undefined);
    setActiveCampaignId(undefined);
    setPendingAction(null);
    clearPersisted();
    setSidebarOpen(false);
    focusInput();
  }, [focusInput, sessionId, messages, activeCampaignId, loadHistory]);

  const confirmNewChat = React.useCallback(() => {
    // Saved chats stay in "Recent"; without the server history the chat is only in this browser.
    const kept = history !== false && !!sessionId;
    if (
      messages.length > 0 &&
      !window.confirm(
        kept
          ? 'Start a new chat? This conversation stays in Recent chats.'
          : 'Start a new chat? The current conversation will be cleared.',
      )
    ) {
      return;
    }
    startNewChat(true);
  }, [history, messages.length, sessionId, startNewChat]);

  const pickChat = React.useCallback(async (chatSessionId: string) => {
    if (chatSessionId === sessionId) { setSidebarOpen(false); return; }
    if (await openChat(chatSessionId)) {
      setSidebarOpen(false);
      focusInput();
    }
  }, [focusInput, openChat, sessionId]);

  const deleteChat = React.useCallback(async (chat: AgentChatSummary) => {
    if (!window.confirm('Delete this chat? This cannot be undone.')) return;
    if (!(await agentChatsApi.remove(chat.sessionId))) return;
    setHistory((prev) => (Array.isArray(prev) ? prev.filter((c) => c.sessionId !== chat.sessionId) : prev));
    if (chat.sessionId === sessionId) startNewChat(false); // deleted: do not save it again
  }, [sessionId, startNewChat]);

  const serverError = (e: unknown, fallback: string) => {
    const msg = (e as { response?: { data?: { error?: unknown } } } | null)?.response?.data?.error;
    return typeof msg === 'string' && msg.trim() ? msg : fallback;
  };

  /** Pin (at most 3) / unpin. The list is updated in place, then reloaded. */
  const pinChat = React.useCallback(async (chat: AgentChatSummary, pinned: boolean) => {
    try {
      const updated = await agentChatsApi.update(chat.sessionId, { pinned });
      setHistory((prev) => (Array.isArray(prev) ? prev.map((c) => (c.sessionId === chat.sessionId ? { ...c, ...updated } : c)) : prev));
    } catch (e) {
      window.alert(serverError(e, pinned ? 'Could not pin the chat.' : 'Could not unpin the chat.'));
    }
  }, []);

  const renameChat = React.useCallback(async (chat: AgentChatSummary, title: string): Promise<boolean> => {
    try {
      const updated = await agentChatsApi.update(chat.sessionId, { title });
      setHistory((prev) => (Array.isArray(prev) ? prev.map((c) => (c.sessionId === chat.sessionId ? { ...c, ...updated } : c)) : prev));
      return true;
    } catch (e) {
      window.alert(serverError(e, 'Could not rename the chat.'));
      return false;
    }
  }, []);

  const [searchOpen, setSearchOpen] = React.useState(false);


  // ── Message helper ─────────────────────────────────────────────────────────

  const appendMessage = React.useCallback(
    (msg: Pick<ChatMessage, 'role' | 'content'> & { structured?: AgentStructuredResult; navigatePath?: string }) => {
      setMessages((prev) => {
        // The reply arrived after all: a trailing "interrupted" marker for this request was wrong.
        const last = prev[prev.length - 1];
        const base = msg.role !== 'error' && last?.role === 'error' && last.content === INTERRUPTED_REPLY ? prev.slice(0, -1) : prev;
        return [...base, { ...msg, id: makeId(msg.role), timestamp: new Date() }];
      });
    },
    [],
  );

  // ── Core send (input + chip clicks) ───────────────────────────────────────

  const doSend = React.useCallback(
    async (text: string, form?: { schedule?: ScheduleChoice; sender?: SenderChoice }) => {
      const trimmed = text.trim();
      if (!trimmed || loading || pendingAction) return;
      if (trimmed.length > MAX_MESSAGE_LENGTH) {
        appendMessage({
          role: 'error',
          content: `Your message is too long (${trimmed.length.toLocaleString()} characters). Please keep it under ${MAX_MESSAGE_LENGTH.toLocaleString()}.`,
        });
        return;
      }

      const file = attachedFile;
      setInput('');
      setAttachedFile(null);
      setBusyNotice(null);
      appendMessage({ role: 'user', content: file ? `📎 ${file.name}\n${trimmed}` : trimmed });
      setLoading(true);
      if (file) setFileUploading(true);
      const seq = ++requestSeqRef.current;

      const result = file
        ? await agentApi.chatWithFile(trimmed, file, sessionId)
        : await agentApi.chat(trimmed, sessionId, form?.schedule, form?.sender);
      if (!mountedRef.current || seq !== requestSeqRef.current) return; // stopped by the user
      setLoading(false);
      setFileUploading(false);

      if (!result.success) {
        // The failed question and its error are not saved (a reload must not keep the red bubble);
        // the bubble gets a Retry button, plus a connection hint when the service was unreachable.
        const offline = /unable to reach|network|timed? ?out|offline/i.test(result.error);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          const marked = last?.role === 'user' ? [...prev.slice(0, -1), { ...last, transient: true }] : prev;
          return [...marked, {
            id: makeId('error'),
            role: 'error' as const,
            content: offline ? `${result.error} Check your internet connection, then press Retry.` : result.error,
            timestamp: new Date(),
            transient: true,
            retryText: file || form ? undefined : trimmed,
          }];
        });
        if (file) setAttachedFile(file);
        focusInput();
        return;
      }

      const payload = result.data;
      if (payload.sessionId) setSessionId(payload.sessionId);

      // Another task is still in progress: show a popup, drop the command
      // bubble, and leave the conversation exactly where it was.
      if ((payload.result as { status?: string } | undefined)?.status === 'busy') {
        setMessages((prev) => (prev.length > 0 && prev[prev.length - 1]!.role === 'user' ? prev.slice(0, -1) : prev));
        if (file) setAttachedFile(file);
        setBusyNotice(payload.result?.message ?? 'Please finish the current task first.');
        focusInput();
        return;
      }

      // The agent took the file: keep a copy in the Library (never blocks or fails the chat).
      if (file) void libraryApi.save(file, payload.sessionId ?? sessionId);

      if (payload.approvalRequired && payload.pendingAction && payload.message) {
        setPendingAction(payload.pendingAction);
        appendMessage({ role: 'assistant', content: payload.message });
        return;
      }

      if (payload.result) {
        // payload.result.message can be undefined when the backend returns a
        // result envelope with no message field — fall back to a safe string.
        const msg =
          typeof payload.result.message === 'string' && payload.result.message.trim()
            ? payload.result.message
            : 'The agent responded but did not provide a message.';
        // Only attach structured data when the result has a typed status or is
        // a capabilities text — plain-text envelopes (no status, empty message)
        // fall through to the normal MarkdownMessage path so fallback strings work.
        const resultStatus = (payload.result as { status?: string }).status;
        const isTyped =
          resultStatus === 'success' ||
          resultStatus === 'needs_input' ||
          (typeof payload.result.message === 'string' &&
            isCapabilitiesText(payload.result.message));

        // Extract navigation path from redirect results.
        const resultAction = (payload.result as { action?: { type?: string; path?: string } }).action;
        const navigatePath =
          resultStatus === 'redirect' &&
          resultAction?.type === 'navigate' &&
          typeof resultAction.path === 'string' &&
          resultAction.path
            ? resultAction.path
            : undefined;

        appendMessage({
          role: 'assistant',
          content: msg,
          structured: isTyped ? (payload.result as AgentStructuredResult) : undefined,
          navigatePath,
        });

        // Track campaign ID for CSV upload and scheduling context.
        {
          const data = (payload.result as { data?: unknown }).data;
          let newId: string | undefined;

          // Primary: structured tool-result data (create/update/start/pause/resume)
          if (typeof data === 'object' && data !== null) {
            const d = data as Record<string, unknown>;
            const raw = isCampaignData(data) ? data.id : (d.id ?? d.campaignId);
            if (raw != null) {
              const str = String(raw);
              if (/^\d+$/.test(str)) newId = str;
            }
          }

          // Fallback: extract from message text (schedule drafts, explicit-ID acks)
          if (!newId) newId = extractCampaignIdFromText(msg);

          if (newId) {
            setActiveCampaignId(newId);
            console.debug('[AgentChat] activeCampaignId →', newId);
          }
        }

        // Navigate after the message is visible in the DOM.
        if (navigatePath) {
          setTimeout(() => { if (mountedRef.current) navigate(navigatePath); }, 300);
        }
      } else if (payload.response) {
        appendMessage({ role: 'assistant', content: payload.response });

        // Extract campaign ID from plain-text responses
        const textId = extractCampaignIdFromText(payload.response);
        if (textId) {
          setActiveCampaignId(textId);
          console.debug('[AgentChat] activeCampaignId → from response text:', textId);
        }
      } else {
        // Neither result nor response present — show a neutral fallback so the
        // UI never silently drops the turn.
        appendMessage({ role: 'assistant', content: 'The agent completed the request.' });
      }

      focusInput();
    },
    [appendMessage, attachedFile, focusInput, loading, navigate, pendingAction, sessionId],
  );

  const sendMessage = React.useCallback(() => doSend(input), [doSend, input]);

  /** Stop: drop the reply of the request in flight and give the chat back right away. */
  const stopRequest = React.useCallback(() => {
    if (!loading) return;
    requestSeqRef.current++;
    setLoading(false);
    setFileUploading(false);
    appendMessage({ role: 'assistant', content: 'Stopped. The reply to that request will not be shown — you can send a new message.' });
    focusInput();
  }, [appendMessage, focusInput, loading]);

  // ── File attach — sent together with the next typed prompt ──────────────
  // The prompt decides what happens to the file (e.g. "upload these recipients"
  // vs "cold call scripts for these companies"), so the file is not sent alone.

  const handleFileUpload = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file || loading || pendingAction) return;
      // The picker's accept filter can be switched to "All files" — check the type here (QA P4 bug 11).
      if (!/\.(csv|xlsx|xls)$/i.test(file.name)) {
        appendMessage({
          role: 'error',
          content: `Only CSV or Excel files (.csv, .xlsx, .xls) are supported — "${file.name}" was not attached.`,
        });
        return;
      }
      setAttachedFile(file);
      focusInput();
    },
    [appendMessage, focusInput, loading, pendingAction],
  );

  // ── Script generation chip — needs a file, so it can't send straight away ─
  // File already attached → send now (the file is saved for script generation).
  // Otherwise fill in the prompt and open the file picker; the user sends once
  // the file is attached.

  const handleScriptChip = React.useCallback(() => {
    if (attachedFile) {
      void doSend(input.trim() || SCRIPT_GENERATION_PROMPT);
      return;
    }
    setInput(SCRIPT_GENERATION_PROMPT);
    fileInputRef.current?.click();
  }, [attachedFile, doSend, input]);

  // ── Confirm / cancel ───────────────────────────────────────────────────────

  const handleConfirm = React.useCallback(async () => {
    if (!pendingAction || loading) return;
    setLoading(true);
    const result = await agentApi.confirm(pendingAction.id);
    if (!mountedRef.current) return;
    setLoading(false);

    if (!result.success) {
      appendMessage({ role: 'error', content: result.error });
      focusInput();
      return;
    }
    setPendingAction(null);
    const isWorkflowError = result.data?.error === true;
    const confirmMsg =
      typeof result.data?.response === 'string' && result.data.response.trim()
        ? result.data.response
        : 'Action confirmed.';
    appendMessage({ role: isWorkflowError ? 'error' : 'assistant', content: confirmMsg });
    focusInput();
  }, [appendMessage, focusInput, loading, pendingAction]);

  const handleCancel = React.useCallback(async () => {
    if (!pendingAction || loading) return;
    setLoading(true);
    const result = await agentApi.cancel(pendingAction.id);
    if (!mountedRef.current) return;
    setLoading(false);

    if (!result.success) {
      appendMessage({ role: 'error', content: result.error });
      focusInput();
      return;
    }
    setPendingAction(null);
    const cancelMsg =
      typeof result.data?.message === 'string' && result.data.message.trim()
        ? result.data.message
        : 'Action cancelled.';
    appendMessage({ role: 'assistant', content: cancelMsg });
    focusInput();
  }, [appendMessage, focusInput, loading, pendingAction]);

  // ── Derived ────────────────────────────────────────────────────────────────

  const interactionDisabled = loading || !!pendingAction;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="agent-chat-page space-y-3">
      {/* Page header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">AI Agent</h1>
          <p className="text-sm text-gray-500">
            Campaign assistant for stats, inbox, and campaign actions.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid="download-chat-button"
            disabled={messages.length === 0}
            title="Download this chat as a text file"
            onClick={() => {
              const blob = new Blob([chatAsText(messages)], { type: 'text/plain;charset=utf-8' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `mailflow-ai-chat-${new Date().toISOString().slice(0, 10)}.txt`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              URL.revokeObjectURL(url);
            }}
            leftIcon={<Download className="w-4 h-4" />}
          >
            Download
          </Button>
        </div>
      </div>

      <div className="agent-chat-body">
        <ChatSidebar
          chats={history}
          activeSessionId={sessionId}
          disabled={interactionDisabled}
          open={sidebarOpen}
          collapsed={sidebarHidden}
          onClose={() => setSidebarOpen(false)}
          onNewChat={confirmNewChat}
          onOpenChat={(id) => void pickChat(id)}
          onDeleteChat={(chat) => void deleteChat(chat)}
          onOpenSearch={() => setSearchOpen(true)}
          onPinChat={(chat, pinned) => void pinChat(chat, pinned)}
          onRenameChat={renameChat}
        />
        <ChatSearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} onOpenChat={(id) => void pickChat(id)} />

      <Card className="agent-chat-card">
        <CardHeader className="agent-chat-header flex items-center gap-2">
          {/* Opens/closes the recent chats: a drawer on phones, a collapsible column on larger screens. */}
          <Button
            variant="outline"
            size="sm"
            data-testid="sidebar-toggle"
            className="chat-menu-button"
            aria-label={sidebarHidden ? 'Show recent chats' : 'Hide recent chats'}
            aria-expanded={sidebarOpen || !sidebarHidden}
            title={sidebarHidden ? 'Show recent chats' : 'Hide recent chats'}
            onClick={() => { setSidebarOpen((v) => !v); setSidebarHidden((v) => !v); }}
            leftIcon={<Menu className="w-4 h-4" />}
          >
            Chats
          </Button>
          <Bot className="w-5 h-5 text-gray-700" />
          <span className="font-semibold text-gray-900">Chat</span>
          <Button
            variant="outline"
            size="sm"
            data-testid="new-chat-button"
            className="chat-header-new ml-auto"
            onClick={confirmNewChat}
            leftIcon={<RefreshCw className="w-4 h-4" />}
          >
            New chat
          </Button>
        </CardHeader>
        <CardContent className="agent-chat-card-content space-y-3">

          {/* ── Message list ─────────────────────────────────────────────── */}
          {/* A named, keyboard-reachable log: screen readers announce new messages and read them one by one
              (QA P4 bug 31: axe scrollable-region-focusable; NVDA read the whole chat as one block). */}
          <div
            ref={chatMessagesRef}
            role="log"
            aria-label="Conversation"
            aria-live="polite"
            aria-relevant="additions"
            tabIndex={0}
            data-testid="chat-log"
            className="chat-messages-container flex flex-col justify-start items-stretch overflow-y-auto overflow-x-hidden rounded-lg border border-gray-200 bg-gray-50 p-4 gap-2">
            {messages.length === 0 && !loading ? (
              <EmptyState
                onSend={doSend}
                onPrefill={(text) => { setInput(text); focusInput(); }}
                disabled={interactionDisabled}
              />
            ) : (
              <>
                {messages.map((msg, i) => {
                  const researchReport = msg.role === 'assistant' && !msg.structured && isResearchReport(msg.content);

                  return (
                  <div
                    key={msg.id}
                    ref={i === messages.length - 1 ? latestMessageRef : undefined}
                    role="group"
                    aria-label={`${msg.role === 'user' ? 'You said' : msg.role === 'error' ? 'Error message' : 'MailFlow AI said'}, ${formatTime(msg.timestamp)}`}
                    data-testid={`message-${msg.role}`}
                    className={`flex animate-msgIn ${
                      msg.role === 'user' ? 'justify-end' : 'justify-start'
                    } ${researchReport ? 'chat-message-research' : ''}`}
                  >
                    {/* Bubble column: content + timestamp */}
                    <div
                      className={`${
                        msg.structured ? 'chat-bubble-structured' : researchReport ? 'chat-bubble chat-bubble-research' : 'chat-bubble'
                      } flex flex-col ${
                        msg.role === 'user' ? 'items-end' : researchReport ? 'items-stretch' : 'items-start'
                      }`}
                    >
                      <div
                        style={
                          msg.role === 'user'
                            ? { background: '#111827', borderRadius: '0.75rem' }
                            : msg.role === 'error'
                            ? {
                                background: '#fef2f2',
                                border: '1px solid #fecaca',
                                borderRadius: '0.75rem',
                              }
                            : msg.structured
                            ? { width: '100%' }
                            : {
                                background: '#ffffff',
                                border: '1px solid #e5e7eb',
                                borderRadius: '0.75rem',
                                boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                              }
                        }
                        className={`${msg.structured ? '' : 'px-3 py-2'} text-sm break-words ${
                          msg.role === 'user'
                            ? 'text-white whitespace-pre-wrap user-message-bubble'
                            : msg.role === 'error'
                            ? 'text-red-700'
                            : 'text-gray-800'
                        }`}
                      >
                        {msg.role === 'assistant'
                          ? msg.structured
                            ? <AgentResponseCard result={msg.structured} />
                            : <MarkdownMessage content={msg.content} />
                          : msg.role === 'error'
                          ? renderError(msg.content)
                          : msg.content}
                      </div>
                      {msg.role === 'error' && msg.content === INTERRUPTED_REPLY && messages[i - 1]?.role === 'user' && (
                        <button
                          type="button"
                          className="mt-1 text-xs font-medium text-blue-600 hover:text-blue-800 underline"
                          onClick={() => void doSend(messages[i - 1]!.content)}
                        >
                          Retry
                        </button>
                      )}
                      {msg.role === 'assistant' &&
                        i === messages.length - 1 &&
                        msg.structured &&
                        isNeedsInputResult(msg.structured) &&
                        msg.structured.form?.kind === 'schedule' && (
                          <ChatScheduleForm
                            form={msg.structured.form}
                            disabled={interactionDisabled}
                            onSubmit={(choice, text) => void doSend(text, { schedule: choice })}
                          />
                        )}
                      {msg.role === 'assistant' &&
                        i === messages.length - 1 &&
                        msg.structured &&
                        isNeedsInputResult(msg.structured) &&
                        msg.structured.form?.kind === 'sender' && (
                          <ChatSenderForm
                            disabled={interactionDisabled}
                            withAliases={msg.structured.form.aliases !== false}
                            onSubmit={(choice, text) => void doSend(text, { sender: choice })}
                          />
                        )}
                      {msg.role === 'assistant' &&
                        i === messages.length - 1 &&
                        msg.structured &&
                        isNeedsInputResult(msg.structured) &&
                        msg.structured.back && (
                          <button
                            type="button"
                            data-testid="previous-step"
                            disabled={interactionDisabled}
                            className="mt-1.5 inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:border-gray-300 hover:text-gray-900 disabled:opacity-50"
                            onClick={() => void doSend('back')}
                          >
                            ← Previous step
                          </button>
                        )}
                      {msg.role === 'assistant' && msg.content.trim() && <CopyReplyButton text={msg.content} />}
                      {msg.role === 'error' && msg.retryText && (
                        <button
                          type="button"
                          data-testid="retry-button"
                          disabled={interactionDisabled}
                          className="mt-1 text-xs font-medium text-blue-600 hover:text-blue-800 underline"
                          onClick={() => {
                            const text = msg.retryText!;
                            const prevUser = messages[i - 1]?.role === 'user' && messages[i - 1]!.transient ? messages[i - 1]!.id : undefined;
                            setMessages((prev) => prev.filter((m) => m.id !== msg.id && m.id !== prevUser));
                            void doSend(text);
                          }}
                        >
                          Retry
                        </button>
                      )}
                      {/* gray-600 on the gray-50 chat background ≈ 7:1 (gray-400 was 2.4:1; WCAG AA needs 4.5:1, QA P4 bug 13). */}
                      <span
                        className="text-xs text-gray-600 mt-0.5"
                        data-testid="message-time"
                        title={fullDateTime(msg.timestamp)}
                        style={{ paddingLeft: '3px', paddingRight: '3px' }}
                      >
                        {formatTime(msg.timestamp)}
                      </span>
                      {msg.navigatePath && (
                        <button
                          onClick={() => navigate(msg.navigatePath!)}
                          className="mt-1 text-xs font-medium text-blue-600 hover:text-blue-800 underline"
                        >
                          Open Settings →
                        </button>
                      )}
                    </div>
                  </div>
                  );
                })}

                {loading && (
                  <TypingIndicator question={[...messages].reverse().find((m) => m.role === 'user')?.content} />
                )}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {/* ── Busy popup ─────────────────────────────────────────────────── */}
          {busyNotice && (
            <div
              role="alertdialog"
              aria-live="assertive"
              data-testid="busy-popup"
              className="fixed inset-0 z-50 flex items-center justify-center"
              style={{ background: 'rgba(17,24,39,0.35)' }}
              onClick={() => setBusyNotice(null)}
            >
              <div
                className="bg-white rounded-xl shadow-xl p-5 mx-4"
                style={{ maxWidth: '26rem' }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle className="w-5 h-5 text-amber-500" />
                  <span className="font-semibold text-gray-900">Finish the current task first</span>
                </div>
                <div className="text-sm text-gray-700">
                  <MarkdownMessage content={busyNotice} />
                </div>
                <div className="flex justify-end mt-4">
                  <Button size="sm" onClick={() => { setBusyNotice(null); focusInput(); }} data-testid="busy-popup-ok">
                    OK
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* ── Approval card ─────────────────────────────────────────────── */}
          {pendingAction && (
            <ApprovalCard
              action={pendingAction}
              loading={loading}
              onConfirm={handleConfirm}
              onCancel={handleCancel}
            />
          )}

          {/* ── Suggested prompt chips ───────────────────────────────────── */}
          {!interactionDisabled && (
            <div className="chat-suggestion-row flex gap-2" style={{ paddingTop: '0.125rem' }}>
              {SUGGESTED_PROMPTS.filter(
                (prompt) =>
                  messages.length > 0 ||
                  !(EMPTY_STATE_PROMPTS as readonly string[]).includes(prompt),
              ).map((prompt) => (
                <button
                  key={prompt}
                  className="chat-prompt-chip"
                  disabled={interactionDisabled}
                  data-testid="prompt-chip"
                  onClick={() => void doSend(prompt)}
                >
                  {prompt}
                </button>
              ))}
              <button
                className="chat-prompt-chip"
                disabled={interactionDisabled}
                data-testid="script-generation-chip"
                title="Attach an Excel/CSV with Company Name and Website columns"
                onClick={handleScriptChip}
              >
                Script generation
              </button>
            </div>
          )}

          {/* ── Attached file (sent with the next message) ───────────────── */}
          {attachedFile && (
            <div
              data-testid="attached-file"
              className="flex items-center gap-2 text-xs text-gray-700"
              style={{ background: '#f3f4f6', borderRadius: '0.5rem', padding: '0.35rem 0.6rem', alignSelf: 'flex-start' }}
            >
              <Paperclip className="w-3 h-3" />
              <span>{attachedFile.name}</span>
              <span className="text-gray-400">— type what you need, e.g. “script generation”</span>
              <button
                type="button"
                aria-label="Remove attached file"
                data-testid="remove-attached-file"
                onClick={() => setAttachedFile(null)}
                className="text-gray-500 hover:text-gray-800"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* ── Input row ────────────────────────────────────────────────── */}
          {/* flex-wrap + min width: on very narrow phones the buttons drop below the
              box instead of squeezing it to one letter per line (bug U-11). */}
          <div className="flex flex-wrap gap-2 items-end">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              style={{ display: 'none' }}
              onChange={handleFileUpload}
            />
            <div className="flex-1" style={{ minWidth: '12rem' }}>
              <TextArea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={loading
                  ? 'The agent is replying… you can type your next message now.'
                  : 'Type your request… (Enter to send, Shift+Enter for new line)'}
                aria-label="Message the AI agent"
                rows={2}
                maxLength={MAX_MESSAGE_LENGTH}
                // Typing stays possible while a reply is on its way (QA P4 bug 5); the text is kept
                // and sent with Enter / Send once the reply has arrived. Locked only during an approval.
                disabled={!!pendingAction}
                data-testid="chat-input"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void sendMessage();
                  }
                }}
              />
            </div>
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={interactionDisabled || fileUploading}
              title="Attach a CSV or Excel file"
              data-testid="attach-button"
            >
              <Paperclip className="w-4 h-4" />
            </Button>
            {loading && !pendingAction ? (
              <Button
                variant="outline"
                onClick={stopRequest}
                leftIcon={<Square className="w-4 h-4" />}
                data-testid="stop-button"
                aria-label="Stop the current request"
              >
                Stop
              </Button>
            ) : (
              <Button
                onClick={() => void sendMessage()}
                disabled={!input.trim() || interactionDisabled}
                leftIcon={<Send className="w-4 h-4" />}
                data-testid="send-button"
              >
                Send
              </Button>
            )}
          </div>

        </CardContent>
      </Card>
      </div>
    </div>
  );
}
