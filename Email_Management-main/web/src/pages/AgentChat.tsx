import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  BarChart2,
  Bot,
  Inbox,
  Megaphone,
  Paperclip,
  RefreshCw,
  Send,
  Settings,
  Sparkles,
} from 'lucide-react';
import { Button, Card, CardContent, CardHeader, TextArea } from '../components/ui';
import { AgentResponseCard } from '../components/AgentResponseCard';
import { MarkdownMessage } from '../components/MarkdownMessage';
import { agentApi, type AgentPendingAction } from '../lib/api';
import { type AgentStructuredResult, extractCampaignIdFromText, isCapabilitiesText, isCampaignData } from '../lib/agentMessage';

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
}

interface PersistedChat {
  sessionId?: string;
  activeCampaignId?: string;
  messages: Array<{
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
  'Create an AI campaign',
  'Show all campaigns',
  'Check SMTP configuration',
  'Show inbox replies',
  'Generate personalized emails',
  'Pause a campaign',
] as const;

// ── localStorage helpers ───────────────────────────────────────────────────────

function loadPersisted(): PersistedChat | null {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedChat) : null;
  } catch {
    return null;
  }
}

function savePersisted(sessionId: string | undefined, messages: ChatMessage[], activeCampaignId?: string): void {
  try {
    const payload: PersistedChat = {
      sessionId,
      activeCampaignId,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp.toISOString(),
        structured: m.structured,
        navigatePath: m.navigatePath,
      })),
    };
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage unavailable (private mode / quota exceeded)
  }
}

function clearPersisted(): void {
  try {
    localStorage.removeItem(CHAT_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

function TypingIndicator() {
  return (
    <div className="flex justify-start animate-msgIn" data-testid="typing-indicator">
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
  const toolLabel = action.toolName.replace(/_/g, ' ');
  const minutesLeft = Math.max(
    0,
    Math.round((new Date(action.expiresAt).getTime() - Date.now()) / 60_000),
  );

  return (
    <div
      data-testid="approval-card"
      role="region"
      aria-label="Action requires approval"
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

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
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

const CAPABILITIES = [
  { icon: <Sparkles className="w-4 h-4" />, label: 'AI Campaigns', desc: 'Personalized emails'  },
  { icon: <Megaphone className="w-4 h-4" />, label: 'Campaigns',   desc: 'Create, update & run' },
  { icon: <BarChart2 className="w-4 h-4" />, label: 'Analytics',   desc: 'Stats & open rates'   },
  { icon: <Inbox     className="w-4 h-4" />, label: 'Inbox',       desc: 'Replies & summaries'  },
  { icon: <Settings  className="w-4 h-4" />, label: 'Settings',    desc: 'SMTP configuration'   },
];

function EmptyState({
  onSend,
  disabled,
}: {
  onSend: (t: string) => void;
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
          <div
            key={cap.label}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.5rem 0.75rem',
              borderRadius: '0.5rem',
              background: '#f9fafb',
              border: '1px solid #f3f4f6',
            }}
          >
            <span style={{ color: '#6b7280', flexShrink: 0 }}>{cap.icon}</span>
            <div style={{ textAlign: 'left', minWidth: 0 }}>
              <p className="text-xs font-semibold text-gray-700">{cap.label}</p>
              <p className="text-xs text-gray-400">{cap.desc}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Starter chips */}
      <div style={{ width: '100%', maxWidth: '24rem' }}>
        <p className="text-xs text-gray-400 mb-2">Try asking:</p>
        <div className="flex flex-wrap justify-center gap-2">
          {(['Create an AI campaign', 'Show all campaigns', 'Show inbox replies'] as const).map(
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
    return saved.messages.map((m) => ({
      id: makeId(m.role),
      role: m.role,
      content: m.content,
      timestamp: new Date(m.timestamp),
      structured: m.structured,
      navigatePath: m.navigatePath,
    }));
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

  const navigate = useNavigate();

  // ── Refs ───────────────────────────────────────────────────────────────────

  const messagesEndRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // Prevents setState calls after the component has unmounted (e.g. navigating
  // away mid-request). React 18 no longer warns but async mutations can still
  // corrupt state if the component remounts with stale closures.
  const mountedRef = React.useRef(true);

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

  // ── Scroll ─────────────────────────────────────────────────────────────────

  const scrollToBottom = React.useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
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
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  // ── Message helper ─────────────────────────────────────────────────────────

  const appendMessage = React.useCallback(
    (msg: Pick<ChatMessage, 'role' | 'content'> & { structured?: AgentStructuredResult; navigatePath?: string }) => {
      setMessages((prev) => [
        ...prev,
        { ...msg, id: makeId(msg.role), timestamp: new Date() },
      ]);
    },
    [],
  );

  // ── Core send (input + chip clicks) ───────────────────────────────────────

  const doSend = React.useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loading || pendingAction) return;

      setInput('');
      appendMessage({ role: 'user', content: trimmed });
      setLoading(true);

      const result = await agentApi.chat(trimmed, sessionId);
      if (!mountedRef.current) return;
      setLoading(false);

      if (!result.success) {
        appendMessage({ role: 'error', content: result.error });
        focusInput();
        return;
      }

      const payload = result.data;
      if (payload.sessionId) setSessionId(payload.sessionId);

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
    [appendMessage, focusInput, loading, navigate, pendingAction, sessionId],
  );

  const sendMessage = React.useCallback(() => doSend(input), [doSend, input]);

  // ── CSV file upload — send through agent for parse + preview ─────────────

  const handleFileUpload = React.useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = '';

      if (loading || pendingAction) return;

      appendMessage({ role: 'user', content: `📎 ${file.name}` });
      setFileUploading(true);

      const result = await agentApi.chatWithFile(
        `I've uploaded a file: ${file.name}`,
        file,
        sessionId,
      );

      if (!mountedRef.current) return;
      setFileUploading(false);

      if (!result.success) {
        appendMessage({ role: 'error', content: result.error });
        return;
      }

      const payload = result.data;
      if (payload.sessionId) setSessionId(payload.sessionId);

      const msg =
        payload.result?.message ??
        payload.response ??
        'File received. Parsing…';

      const resultStatus = (payload.result as { status?: string } | undefined)?.status;
      const isTyped = resultStatus === 'success' || resultStatus === 'needs_input';

      appendMessage({
        role: 'assistant',
        content: msg,
        structured: isTyped ? (payload.result as AgentStructuredResult) : undefined,
      });

      focusInput();
    },
    [appendMessage, focusInput, loading, pendingAction, sessionId],
  );

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
    const confirmMsg =
      typeof result.data?.response === 'string' && result.data.response.trim()
        ? result.data.response
        : 'Action confirmed.';
    appendMessage({ role: 'assistant', content: confirmMsg });
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
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">AI Agent</h1>
          <p className="text-gray-500 mt-1">
            Campaign assistant for stats, inbox, and campaign actions.
          </p>
        </div>
        <Button
          variant="outline"
          data-testid="new-chat-button"
          onClick={() => {
            setMessages([]);
            setSessionId(undefined);
            setActiveCampaignId(undefined);
            setPendingAction(null);
            clearPersisted();
            focusInput();
          }}
          leftIcon={<RefreshCw className="w-4 h-4" />}
        >
          New chat
        </Button>
      </div>

      <Card>
        <CardHeader className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-gray-700" />
          <span className="font-semibold text-gray-900">Chat</span>
        </CardHeader>
        <CardContent className="space-y-3">

          {/* ── Message list ─────────────────────────────────────────────── */}
          <div className="chat-messages-container flex flex-col justify-start items-stretch overflow-y-auto overflow-x-hidden rounded-lg border border-gray-200 bg-gray-50 p-4 gap-2">
            {messages.length === 0 && !loading ? (
              <EmptyState onSend={doSend} disabled={interactionDisabled} />
            ) : (
              <>
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    data-testid={`message-${msg.role}`}
                    className={`flex animate-msgIn ${
                      msg.role === 'user' ? 'justify-end' : 'justify-start'
                    }`}
                  >
                    {/* Bubble column: content + timestamp */}
                    <div
                      className={`${
                        msg.structured ? 'chat-bubble-structured' : 'chat-bubble'
                      } flex flex-col ${
                        msg.role === 'user' ? 'items-end' : 'items-start'
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
                            ? 'text-white whitespace-pre-wrap'
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
                      <span
                        className="text-xs text-gray-400 mt-0.5"
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
                ))}

                {loading && <TypingIndicator />}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

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
            <div className="flex flex-wrap gap-2" style={{ paddingTop: '0.125rem' }}>
              {SUGGESTED_PROMPTS.map((prompt) => (
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
            </div>
          )}

          {/* ── Input row ────────────────────────────────────────────────── */}
          <div className="flex gap-2 items-end">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              style={{ display: 'none' }}
              onChange={handleFileUpload}
            />
            <div className="flex-1" style={{ minWidth: 0 }}>
              <TextArea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type your request… (Enter to send, Shift+Enter for new line)"
                rows={2}
                disabled={interactionDisabled}
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
              title={activeCampaignId ? 'Upload CSV recipients' : 'Create a campaign first to upload recipients'}
              data-testid="attach-button"
            >
              <Paperclip className="w-4 h-4" />
            </Button>
            <Button
              onClick={() => void sendMessage()}
              isLoading={loading}
              disabled={!input.trim() || interactionDisabled}
              leftIcon={<Send className="w-4 h-4" />}
              data-testid="send-button"
            >
              Send
            </Button>
          </div>

        </CardContent>
      </Card>
    </div>
  );
}
