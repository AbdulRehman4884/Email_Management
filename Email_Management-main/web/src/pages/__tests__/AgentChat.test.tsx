/**
 * AgentChat — frontend regression tests
 *
 * Coverage:
 *   A — Message alignment (user right, assistant left)
 *   B — Suggested prompt chips (render, click-to-send, disabled states)
 *   C — Empty state (welcome screen, starter chips send)
 *   D — Input keyboard behaviour (Enter sends, Shift+Enter is a newline)
 *   E — Rich assistant content (bullets, numbered lists, bold)
 *   F — Typing indicator lifecycle
 *   G — localStorage persistence (save, restore, clear on New Chat)
 *   H — Error rendering
 *   I — Approval flow (card renders, confirm/cancel wired)
 *   J — Response normalisation (null / undefined guards)
 *   K — Double-action prevention
 *   L — Unmount safety (navigate away during in-flight requests)
 */

import React from 'react';
import {
  render,
  screen,
  waitFor,
  within,
  cleanup,
  act,
  fireEvent,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentChat } from '../AgentChat';

// ── API mock ───────────────────────────────────────────────────────────────────

const mockChat    = vi.fn();
const mockConfirm = vi.fn();
const mockCancel  = vi.fn();
const mockChatWithFile = vi.fn();

// AgentChat calls useNavigate(); these tests render it without a <Router>.
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => <a href={to} {...rest}>{children}</a>,
}));

const mockChatsList = vi.fn();
const mockChatsGet = vi.fn();
const mockChatsSave = vi.fn();
const mockChatsRemove = vi.fn();

vi.mock('../../lib/api', () => ({
  agentApi: {
    chat:    (...args: unknown[]) => mockChat(...args),
    confirm: (...args: unknown[]) => mockConfirm(...args),
    cancel:  (...args: unknown[]) => mockCancel(...args),
    chatWithFile: (...args: unknown[]) => mockChatWithFile(...args),
  },
  // Chat history on the server (bug A-17). Unset mocks return undefined = no history.
  agentChatsApi: {
    list:   (...args: unknown[]) => mockChatsList(...args),
    get:    (...args: unknown[]) => mockChatsGet(...args),
    save:   (...args: unknown[]) => mockChatsSave(...args),
    remove: (...args: unknown[]) => mockChatsRemove(...args),
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Standard successful chat response. */
function chatOk(message: string, sessionId = 'sess-1') {
  return { success: true, data: { sessionId, result: { message } } };
}

/** Approval-required chat response. */
function chatApproval(message: string) {
  return {
    success: true,
    data: {
      sessionId: 'sess-1',
      approvalRequired: true,
      message,
      pendingAction: {
        id: 'action-1',
        intent: 'start_campaign',
        toolName: 'start_campaign',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    },
  };
}

// ── Setup / teardown ───────────────────────────────────────────────────────────

const user = userEvent.setup();

beforeEach(() => {
  // resetAllMocks clears both call records AND queued mockReturnValueOnce /
  // mockResolvedValueOnce implementations.  clearAllMocks only clears records —
  // unconsumed queued implementations would leak into the next test and cause
  // the wrong mock value to be returned (especially in the L unmount tests
  // where a pending promise may not be consumed before the component unmounts).
  vi.resetAllMocks();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

// ═══════════════════════════════════════════════════════════════════════════════
// A — Message alignment
// ═══════════════════════════════════════════════════════════════════════════════

describe('A — Message alignment', () => {
  it('user bubble row has justify-end class (right-aligned)', async () => {
    mockChat.mockResolvedValueOnce(chatOk('Hi back'));
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'Hello');
    await user.keyboard('{Enter}');

    await waitFor(() => screen.getByTestId('message-user'));
    expect(screen.getByTestId('message-user')).toHaveClass('justify-end');
  });

  it('assistant bubble row has justify-start class (left-aligned)', async () => {
    mockChat.mockResolvedValueOnce(chatOk('Hello from assistant'));
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'Hey');
    await user.keyboard('{Enter}');

    await waitFor(() => screen.getByTestId('message-assistant'));
    expect(screen.getByTestId('message-assistant')).toHaveClass('justify-start');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B — Prompt chips
// ═══════════════════════════════════════════════════════════════════════════════

describe('B — Suggested prompt chips', () => {
  it('empty chat: chip row skips the 3 prompts already shown as starters (A-18)', () => {
    render(<AgentChat />);
    const texts = screen.getAllByTestId('prompt-chip').map((c) => c.textContent);
    expect(texts).toEqual(['Check SMTP configuration', 'Generate personalized emails', 'Pause a campaign', 'Find new leads']);
    const starters = screen.getAllByTestId('empty-state-prompt').map((c) => c.textContent);
    expect(starters).toEqual(['Create campaign', 'Show all campaigns', 'Show inbox replies']);
  });

  it('after the first message the chip row shows all 7 prompts', async () => {
    mockChat.mockResolvedValueOnce(chatOk('Reply'));
    render(<AgentChat />);
    await user.type(screen.getByTestId('chat-input'), 'hello');
    await user.keyboard('{Enter}');
    await waitFor(() => screen.getByTestId('message-assistant'));
    const texts = screen.getAllByTestId('prompt-chip').map((c) => c.textContent);
    expect(texts).toEqual([
      'Create campaign', 'Show all campaigns', 'Check SMTP configuration',
      'Show inbox replies', 'Generate personalized emails', 'Pause a campaign', 'Find new leads',
    ]);
  });

  it('clicking a chip immediately sends that text via agentApi.chat', async () => {
    mockChat.mockResolvedValueOnce(chatOk('Here are your campaigns'));
    render(<AgentChat />);

    const chip = screen.getAllByTestId('prompt-chip')[0]; // 'Check SMTP configuration'
    await user.click(chip);

    expect(mockChat).toHaveBeenCalledWith('Check SMTP configuration', undefined);
    await waitFor(() => screen.getByTestId('message-user'));
    expect(screen.getByTestId('message-user')).toHaveTextContent('Check SMTP configuration');
  });

  it('chips are hidden while loading', async () => {
    // Keep the promise unresolved so loading stays true
    let resolve: (v: unknown) => void;
    mockChat.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'test');
    await user.keyboard('{Enter}');

    // loading=true → chips unmounted
    await waitFor(() =>
      expect(screen.queryAllByTestId('prompt-chip')).toHaveLength(0),
    );

    // clean up — resolve so component settles before the test exits
    await act(async () => { resolve!(chatOk('done')); });
  });

  it('chips are hidden when a pendingAction is active', async () => {
    mockChat.mockResolvedValueOnce(chatApproval('Please confirm'));
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'start campaign');
    await user.keyboard('{Enter}');

    await waitFor(() => screen.getByTestId('approval-card'));
    expect(screen.queryAllByTestId('prompt-chip')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C — Empty state
// ═══════════════════════════════════════════════════════════════════════════════

describe('C — Empty state', () => {
  it('shows welcome heading when no messages exist', () => {
    render(<AgentChat />);
    expect(
      screen.getByText("Hi, I'm your MailFlow AI Agent"),
    ).toBeInTheDocument();
  });

  it('shows capability grid items', () => {
    render(<AgentChat />);
    expect(screen.getByText('Campaigns')).toBeInTheDocument();
    expect(screen.getByText('Analytics')).toBeInTheDocument();
    expect(screen.getByText('Inbox')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('empty state starter chips call agentApi.chat on click', async () => {
    mockChat.mockResolvedValueOnce(chatOk('Listed campaigns'));
    render(<AgentChat />);

    const starters = screen.getAllByTestId('empty-state-prompt');
    expect(starters.length).toBeGreaterThanOrEqual(1);

    await user.click(starters[1]); // 'Show all campaigns'
    expect(mockChat).toHaveBeenCalledWith('Show all campaigns', undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// D — Keyboard behaviour
// ═══════════════════════════════════════════════════════════════════════════════

describe('D — Keyboard behaviour', () => {
  it('Enter key submits the message', async () => {
    mockChat.mockResolvedValueOnce(chatOk('Reply'));
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'Hello');
    await user.keyboard('{Enter}');

    expect(mockChat).toHaveBeenCalledWith('Hello', undefined);
  });

  it('Shift+Enter does NOT submit the message', async () => {
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'Hello');
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    expect(mockChat).not.toHaveBeenCalled();
  });

  it('Send button is disabled when input is empty', () => {
    render(<AgentChat />);
    expect(screen.getByTestId('send-button')).toBeDisabled();
  });

  it('QA P4 bug 6: while loading Send becomes Stop; Stop ignores the late reply and frees the chat', async () => {
    let resolve: (v: unknown) => void;
    mockChat.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'Summarize replies for DRY RUN');
    await user.keyboard('{Enter}');

    await user.click(await screen.findByTestId('stop-button'));
    expect(screen.getByText(/Stopped\. The reply to that request will not be shown/)).toBeInTheDocument();
    expect(screen.queryByTestId('stop-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-button')).toBeInTheDocument();

    await act(async () => { resolve!(chatOk('LATE REPLY')); });
    expect(screen.queryByText('LATE REPLY')).not.toBeInTheDocument();
  });

  it('QA P4 bug 5: the textarea stays usable while a reply is pending; the typed text is kept and sent after', async () => {
    let resolve: (v: unknown) => void;
    mockChat.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'test');
    await user.keyboard('{Enter}');
    await screen.findByTestId('stop-button');

    const box = screen.getByTestId('chat-input');
    expect(box).not.toBeDisabled();
    await user.type(box, 'next question');
    await user.keyboard('{Enter}'); // still replying → not sent, not cleared
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(box).toHaveValue('next question');

    await act(async () => { resolve!(chatOk('done')); });
    mockChat.mockResolvedValueOnce(chatOk('second'));
    await user.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(mockChat).toHaveBeenLastCalledWith('next question', expect.anything()));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E — Rich assistant content
// ═══════════════════════════════════════════════════════════════════════════════

describe('E — Rich assistant content', () => {
  async function getAssistantBubble(responseText: string) {
    mockChat.mockResolvedValueOnce(chatOk(responseText));
    render(<AgentChat />);
    await user.type(screen.getByTestId('chat-input'), 'q');
    await user.keyboard('{Enter}');
    await waitFor(() => screen.getByTestId('message-assistant'));
    return screen.getByTestId('message-assistant');
  }

  it('renders bullet list as <ul> + <li> elements', async () => {
    const bubble = await getAssistantBubble('- Alpha\n- Beta\n- Gamma');
    const list = bubble.querySelector('ul');
    expect(list).toBeInTheDocument();
    const items = within(bubble).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Alpha');
    expect(items[1]).toHaveTextContent('Beta');
    expect(items[2]).toHaveTextContent('Gamma');
  });

  it('renders numbered list as <ol> + <li> elements', async () => {
    const bubble = await getAssistantBubble('1. First\n2. Second\n3. Third');
    const list = bubble.querySelector('ol');
    expect(list).toBeInTheDocument();
    const items = within(bubble).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('First');
  });

  it('renders **bold** text as <strong>', async () => {
    const bubble = await getAssistantBubble('This is **important** info');
    const strong = bubble.querySelector('strong');
    expect(strong).toBeInTheDocument();
    expect(strong).toHaveTextContent('important');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// F — Typing indicator
// ═══════════════════════════════════════════════════════════════════════════════

describe('F — Typing indicator', () => {
  it('appears while the API call is in-flight', async () => {
    let resolve: (v: unknown) => void;
    mockChat.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'ping');
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(screen.getByTestId('typing-indicator')).toBeInTheDocument(),
    );

    await act(async () => { resolve!(chatOk('pong')); });
  });

  it('disappears after the response arrives', async () => {
    let resolve: (v: unknown) => void;
    mockChat.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'ping');
    await user.keyboard('{Enter}');

    await waitFor(() => screen.getByTestId('typing-indicator'));

    await act(async () => { resolve!(chatOk('pong')); });

    await waitFor(() =>
      expect(screen.queryByTestId('typing-indicator')).not.toBeInTheDocument(),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// G — localStorage persistence
// ═══════════════════════════════════════════════════════════════════════════════

describe('G — localStorage persistence', () => {
  it('saves messages and sessionId to localStorage after a chat turn', async () => {
    mockChat.mockResolvedValueOnce(chatOk('Persisted reply', 'sid-42'));
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'save me');
    await user.keyboard('{Enter}');
    await waitFor(() => screen.getByTestId('message-assistant'));

    const saved = JSON.parse(localStorage.getItem('mailflow-agent-chat-v1') ?? '{}') as {
      sessionId: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(saved.sessionId).toBe('sid-42');
    expect(saved.messages).toHaveLength(2);
    expect(saved.messages[0]).toMatchObject({ role: 'user', content: 'save me' });
    expect(saved.messages[1]).toMatchObject({ role: 'assistant', content: 'Persisted reply' });
  });

  it('restores previous messages on remount', () => {
    localStorage.setItem(
      'mailflow-agent-chat-v1',
      JSON.stringify({
        sessionId: 'prior-session',
        messages: [
          { role: 'user',      content: 'Old question', timestamp: new Date().toISOString() },
          { role: 'assistant', content: 'Old answer',   timestamp: new Date().toISOString() },
        ],
      }),
    );

    render(<AgentChat />);

    expect(screen.getByTestId('message-user')).toHaveTextContent('Old question');
    expect(screen.getByTestId('message-assistant')).toHaveTextContent('Old answer');
  });

  it('clears localStorage and messages when "New chat" is clicked', async () => {
    mockChat.mockResolvedValueOnce(chatOk('Some reply'));
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'hello');
    await user.keyboard('{Enter}');
    await waitFor(() => screen.getByTestId('message-assistant'));

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(screen.getByTestId('new-chat-button'));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();

    expect(screen.queryByTestId('message-user')).not.toBeInTheDocument();
    expect(screen.queryByTestId('message-assistant')).not.toBeInTheDocument();
    // An empty chat is kept (not removed) so this browser does not reopen the old chat from the server.
    expect(JSON.parse(localStorage.getItem('mailflow-agent-chat-v1') ?? 'null')).toEqual({ messages: [] });
  });

  it('"New chat" keeps the conversation when the user cancels the confirm (A-17)', async () => {
    mockChat.mockResolvedValueOnce(chatOk('Some reply'));
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'hello');
    await user.keyboard('{Enter}');
    await waitFor(() => screen.getByTestId('message-assistant'));

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(screen.getByTestId('new-chat-button'));
    confirmSpy.mockRestore();

    expect(screen.getByTestId('message-user')).toHaveTextContent('hello');
  });

  it('"New chat" on an empty chat does not ask', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<AgentChat />);
    await user.click(screen.getByTestId('new-chat-button'));
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

describe('Message length limit (A-20)', () => {
  it('chat box is limited to 4000 characters', () => {
    render(<AgentChat />);
    expect(screen.getByTestId('chat-input')).toHaveAttribute('maxLength', '4000');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// H — Error rendering
// ═══════════════════════════════════════════════════════════════════════════════

describe('H — Error rendering', () => {
  it('shows an error bubble when agentApi.chat fails', async () => {
    mockChat.mockResolvedValueOnce({ success: false, error: 'Network error' });
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'broken');
    await user.keyboard('{Enter}');

    await waitFor(() => screen.getByTestId('message-error'));
    expect(screen.getByTestId('message-error')).toHaveTextContent('Network error');
  });

  it('QA P4 bug 7: network error → hint + Retry resends the question; the failed turn is not saved', async () => {
    mockChat.mockResolvedValueOnce({ success: false, error: 'Unable to reach AI agent service.' });
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'Show stats for campaign id 434');
    await user.keyboard('{Enter}');

    await waitFor(() => screen.getByTestId('message-error'));
    expect(screen.getByTestId('message-error')).toHaveTextContent('Check your internet connection');
    const saved = JSON.parse(localStorage.getItem('mailflow-agent-chat-v1') ?? '{"messages":[]}');
    expect(saved.messages.some((m: { role: string }) => m.role === 'error')).toBe(false);
    expect(saved.messages.some((m: { content: string }) => m.content === 'Show stats for campaign id 434')).toBe(false);

    mockChat.mockResolvedValueOnce(chatOk('Here are the statistics'));
    await user.click(screen.getByTestId('retry-button'));
    await screen.findByText('Here are the statistics');
    expect(mockChat).toHaveBeenLastCalledWith('Show stats for campaign id 434', undefined);
    expect(screen.queryByTestId('message-error')).not.toBeInTheDocument();
    expect(screen.getAllByText('Show stats for campaign id 434')).toHaveLength(1);
  });

  it('error bubble is left-aligned (justify-start)', async () => {
    mockChat.mockResolvedValueOnce({ success: false, error: 'Oops' });
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'fail');
    await user.keyboard('{Enter}');

    await waitFor(() => screen.getByTestId('message-error'));
    expect(screen.getByTestId('message-error')).toHaveClass('justify-start');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// I — Approval flow
// ═══════════════════════════════════════════════════════════════════════════════

describe('I — Approval flow', () => {
  it('renders the ApprovalCard when approvalRequired=true', async () => {
    mockChat.mockResolvedValueOnce(chatApproval('Please confirm starting the campaign.'));
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'start campaign');
    await user.keyboard('{Enter}');

    await waitFor(() => screen.getByTestId('approval-card'));
    expect(screen.getByTestId('approval-card')).toBeInTheDocument();
    expect(screen.getByTestId('approval-card')).toHaveAttribute('role', 'alert');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('cancel-button')));
    expect(screen.getByTestId('confirm-button')).toBeInTheDocument();
    expect(screen.getByTestId('cancel-button')).toBeInTheDocument();
  });

  it('confirm button calls agentApi.confirm with the pending action id', async () => {
    mockChat.mockResolvedValueOnce(chatApproval('Confirm to proceed.'));
    mockConfirm.mockResolvedValueOnce({
      success: true,
      data: { response: 'Campaign started.' },
    });
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'start now');
    await user.keyboard('{Enter}');
    await waitFor(() => screen.getByTestId('confirm-button'));

    await user.click(screen.getByTestId('confirm-button'));

    expect(mockConfirm).toHaveBeenCalledWith('action-1');
    await waitFor(() =>
      expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument(),
    );
    // Two assistant messages exist: initial approval prompt + confirmation reply.
    // The last one must contain the confirm response.
    const assistantMsgs = screen.getAllByTestId('message-assistant');
    expect(assistantMsgs[assistantMsgs.length - 1]).toHaveTextContent('Campaign started.');
  });

  it('cancel button calls agentApi.cancel and removes the approval card', async () => {
    mockChat.mockResolvedValueOnce(chatApproval('Confirm to proceed.'));
    mockCancel.mockResolvedValueOnce({
      success: true,
      data: { message: 'Cancelled.' },
    });
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'start');
    await user.keyboard('{Enter}');
    await waitFor(() => screen.getByTestId('cancel-button'));

    await user.click(screen.getByTestId('cancel-button'));

    expect(mockCancel).toHaveBeenCalledWith('action-1');
    await waitFor(() =>
      expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument(),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// J — Response normalisation (null / undefined guards)
// ═══════════════════════════════════════════════════════════════════════════════

describe('J — Response normalisation', () => {
  it('shows fallback text when payload.result.message is undefined', async () => {
    // Backend may return a result envelope with no message field
    mockChat.mockResolvedValueOnce({
      success: true,
      data: { sessionId: 'sess-1', result: {} },
    });
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'hello');
    await user.keyboard('{Enter}');

    await waitFor(() => screen.getByTestId('message-assistant'));
    expect(screen.getByTestId('message-assistant')).toHaveTextContent(
      'The agent responded but did not provide a message.',
    );
  });

  it('shows fallback text when payload.result.message is an empty string', async () => {
    mockChat.mockResolvedValueOnce({
      success: true,
      data: { sessionId: 'sess-1', result: { message: '   ' } },
    });
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'hello');
    await user.keyboard('{Enter}');

    await waitFor(() => screen.getByTestId('message-assistant'));
    expect(screen.getByTestId('message-assistant')).toHaveTextContent(
      'The agent responded but did not provide a message.',
    );
  });

  it('does not crash and shows fallback when neither result nor response is present', async () => {
    // Minimal payload with no result/response fields
    mockChat.mockResolvedValueOnce({
      success: true,
      data: { sessionId: 'sess-1' },
    });
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'hello');
    await user.keyboard('{Enter}');

    await waitFor(() => screen.getByTestId('message-assistant'));
    expect(screen.getByTestId('message-assistant')).toHaveTextContent(
      'The agent completed the request.',
    );
  });

  it('uses "Action confirmed." fallback when confirm response has no response field', async () => {
    mockChat.mockResolvedValueOnce(chatApproval('Confirm please.'));
    // confirm returns success but data has no response field
    mockConfirm.mockResolvedValueOnce({ success: true, data: {} });
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'start');
    await user.keyboard('{Enter}');
    await waitFor(() => screen.getByTestId('confirm-button'));

    await user.click(screen.getByTestId('confirm-button'));

    await waitFor(() =>
      expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument(),
    );
    const assistantMsgs = screen.getAllByTestId('message-assistant');
    expect(assistantMsgs[assistantMsgs.length - 1]).toHaveTextContent('Action confirmed.');
  });

  it('uses "Action cancelled." fallback when cancel response has no message field', async () => {
    mockChat.mockResolvedValueOnce(chatApproval('Confirm please.'));
    mockCancel.mockResolvedValueOnce({ success: true, data: {} });
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'start');
    await user.keyboard('{Enter}');
    await waitFor(() => screen.getByTestId('cancel-button'));

    await user.click(screen.getByTestId('cancel-button'));

    await waitFor(() =>
      expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument(),
    );
    const assistantMsgs = screen.getAllByTestId('message-assistant');
    expect(assistantMsgs[assistantMsgs.length - 1]).toHaveTextContent('Action cancelled.');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// K — Double-action prevention
// ═══════════════════════════════════════════════════════════════════════════════

describe('K — Double-action prevention', () => {
  it('confirm button is disabled while a confirm call is in-flight', async () => {
    mockChat.mockResolvedValueOnce(chatApproval('Confirm please.'));
    let resolveConfirm: (v: unknown) => void;
    mockConfirm.mockReturnValueOnce(
      new Promise((r) => { resolveConfirm = r; }),
    );
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'start');
    await user.keyboard('{Enter}');
    await waitFor(() => screen.getByTestId('confirm-button'));

    await user.click(screen.getByTestId('confirm-button'));

    // While confirm is in-flight, loading=true → button should be in loading
    // state (disabled or shows spinner).  The ApprovalCard passes loading to
    // the Button which sets disabled=true when loading.
    await waitFor(() =>
      expect(screen.getByTestId('confirm-button')).toBeDisabled(),
    );

    // Settle the promise so the component cleans up before the test exits
    await act(async () => {
      resolveConfirm!({ success: true, data: { response: 'Done.' } });
    });
  });

  it('cancel button is disabled while a confirm call is in-flight', async () => {
    mockChat.mockResolvedValueOnce(chatApproval('Confirm please.'));
    let resolveConfirm: (v: unknown) => void;
    mockConfirm.mockReturnValueOnce(
      new Promise((r) => { resolveConfirm = r; }),
    );
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'start');
    await user.keyboard('{Enter}');
    await waitFor(() => screen.getByTestId('confirm-button'));

    await user.click(screen.getByTestId('confirm-button'));

    await waitFor(() =>
      expect(screen.getByTestId('cancel-button')).toBeDisabled(),
    );

    await act(async () => {
      resolveConfirm!({ success: true, data: { response: 'Done.' } });
    });
  });

  it('sending a second message while the first is loading is a no-op', async () => {
    let resolveFirst: (v: unknown) => void;
    mockChat.mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }));
    mockChat.mockResolvedValueOnce(chatOk('Second reply'));
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'first');
    await user.keyboard('{Enter}');

    // The box stays usable while a reply is pending (QA P4 bug 5), but Enter does not send a second request.
    await screen.findByTestId('stop-button');
    await user.type(screen.getByTestId('chat-input'), 'second');
    await user.keyboard('{Enter}');

    // The second call must never have been made
    expect(mockChat).toHaveBeenCalledTimes(1);

    await act(async () => { resolveFirst!(chatOk('First reply')); });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// L — Unmount safety (navigate away during in-flight requests)
//
// These tests exercise the mountedRef guard added to doSend / handleConfirm /
// handleCancel.  The contract: resolving a network promise after the component
// unmounts must not throw or trigger state updates.
//
// Each test creates its own userEvent instance because manual unmount() mid-test
// can leave the shared module-level instance in a stale document state.
// ═══════════════════════════════════════════════════════════════════════════════

describe('L — Unmount safety', () => {
  it('unmounting during an in-flight chat request does not throw', async () => {
    let resolveChat: (v: unknown) => void;
    mockChat.mockReturnValueOnce(new Promise((r) => { resolveChat = r; }));

    const { unmount } = render(<AgentChat />);

    // Use fireEvent (not userEvent) here: userEvent queues synthetic events on
    // the shared document, and calling unmount() mid-queue leaves stale state
    // that contaminates the next test. fireEvent dispatches synchronously.
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'ping' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });

    // Request in-flight — simulate navigation away
    unmount();

    // Resolve after unmount; mountedRef guard must absorb it silently
    await act(async () => { resolveChat!(chatOk('pong')); });
    // Test passes if no error is thrown
  });

  it('unmounting during an in-flight confirm call does not throw', async () => {
    const lu = userEvent.setup();
    mockChat.mockResolvedValueOnce(chatApproval('Confirm please.'));
    let resolveConfirm: (v: unknown) => void;
    mockConfirm.mockReturnValueOnce(new Promise((r) => { resolveConfirm = r; }));

    const { unmount } = render(<AgentChat />);

    await lu.type(screen.getByTestId('chat-input'), 'start');
    await lu.keyboard('{Enter}');
    await waitFor(() => screen.getByTestId('confirm-button'));

    await lu.click(screen.getByTestId('confirm-button'));

    unmount();

    await act(async () => {
      resolveConfirm!({ success: true, data: { response: 'Campaign started.' } });
    });
    // Test passes if no error is thrown
  });

  it('unmounting during an in-flight cancel call does not throw', async () => {
    const lu = userEvent.setup();
    mockChat.mockResolvedValueOnce(chatApproval('Confirm please.'));
    let resolveCancel: (v: unknown) => void;
    mockCancel.mockReturnValueOnce(new Promise((r) => { resolveCancel = r; }));

    const { unmount } = render(<AgentChat />);

    await lu.type(screen.getByTestId('chat-input'), 'start');
    await lu.keyboard('{Enter}');
    await waitFor(() => screen.getByTestId('cancel-button'));

    await lu.click(screen.getByTestId('cancel-button'));

    unmount();

    await act(async () => {
      resolveCancel!({ success: true, data: { message: 'Cancelled.' } });
    });
    // Test passes if no error is thrown
  });

  it('API call is dispatched exactly once regardless of unmount timing', async () => {
    const lu = userEvent.setup();
    let resolveChat: (v: unknown) => void;
    mockChat.mockReturnValueOnce(new Promise((r) => { resolveChat = r; }));

    const { unmount } = render(<AgentChat />);

    await lu.type(screen.getByTestId('chat-input'), 'test');
    await lu.keyboard('{Enter}');

    expect(mockChat).toHaveBeenCalledTimes(1);

    unmount();

    // Settle the promise to avoid unhandled-rejection noise in the runner
    await act(async () => { resolveChat!(chatOk('late reply')); });

    // Unmount must not trigger a retry or second call
    expect(mockChat).toHaveBeenCalledTimes(1);
  });
});

// ── M — File + prompt (cold-call scripts) ──────────────────────────────────────

describe('M — File attached with a prompt', () => {
  it('does not send the file on its own — it waits for the typed prompt', async () => {
    const u = userEvent.setup();
    render(<AgentChat />);
    const file = new File(['Company,Website\nAcme,acme.com'], 'leads.csv', { type: 'text/csv' });

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await u.upload(input, file);

    expect(screen.getByTestId('attached-file')).toHaveTextContent('leads.csv');
    expect(mockChatWithFile).not.toHaveBeenCalled();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('sends the prompt and the file together, then clears the attachment', async () => {
    const u = userEvent.setup();
    mockChatWithFile.mockResolvedValueOnce(chatOk('Report ready'));
    render(<AgentChat />);
    const file = new File(['x'], 'leads.csv', { type: 'text/csv' });

    await u.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);
    await u.type(screen.getByTestId('chat-input'), 'script generation for these');
    await u.keyboard('{Enter}');

    await waitFor(() => expect(mockChatWithFile).toHaveBeenCalledWith('script generation for these', file, undefined));
    expect(mockChat).not.toHaveBeenCalled();
    expect(screen.queryByTestId('attached-file')).not.toBeInTheDocument();
  });

  it('QA P4 bug 11: a .txt file is not attached and the user is told why', async () => {
    const u = userEvent.setup({ applyAccept: false });
    render(<AgentChat />);
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });

    await u.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);

    expect(screen.queryByTestId('attached-file')).not.toBeInTheDocument();
    expect(screen.getByTestId('message-error')).toHaveTextContent('Only CSV or Excel files (.csv, .xlsx, .xls) are supported — "notes.txt" was not attached.');
    expect(mockChatWithFile).not.toHaveBeenCalled();
  });

  it('removing the attachment sends a normal chat message', async () => {
    const u = userEvent.setup();
    mockChat.mockResolvedValueOnce(chatOk('ok'));
    render(<AgentChat />);

    await u.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File(['x'], 'a.csv'));
    await u.click(screen.getByTestId('remove-attached-file'));
    await u.type(screen.getByTestId('chat-input'), 'hello');
    await u.keyboard('{Enter}');

    await waitFor(() => expect(mockChat).toHaveBeenCalledWith('hello', undefined));
    expect(mockChatWithFile).not.toHaveBeenCalled();
  });

  it('shows the saved-file card with a link to the company list', async () => {
    const u = userEvent.setup();
    mockChatWithFile.mockResolvedValueOnce({
      success: true,
      data: {
        sessionId: 'sess-1',
        result: {
          status: 'success',
          intent: 'script_file_intake',
          message: 'Saved leads.xlsx',
          data: { kind: 'script_file', fileId: 7, filename: 'leads.xlsx', companyCount: 2, totalRows: 3, reportLine: '3 rows: 2 valid, 1 bina website.' },
        },
      },
    });
    render(<AgentChat />);

    await u.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File(['x'], 'leads.xlsx'));
    await u.type(screen.getByTestId('chat-input'), 'script generation');
    await u.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByTestId('script-file-saved-card')).toBeInTheDocument());
    expect(screen.getByTestId('open-script-file-link')).toHaveAttribute('href', '/scripts/files/7');
  });
});

// ── N — Script generation chip ─────────────────────────────────────────────────

describe('N — Script generation chip', () => {
  it('without a file: fills the prompt and opens the file picker, sends nothing', async () => {
    const u = userEvent.setup();
    render(<AgentChat />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');

    await u.click(screen.getByTestId('script-generation-chip'));

    expect(screen.getByTestId('script-generation-chip')).toHaveTextContent('Script generation');
    expect(clickSpy).toHaveBeenCalled();
    expect(screen.getByTestId('chat-input')).toHaveValue('Save this file for script generation');
    expect(mockChat).not.toHaveBeenCalled();
    expect(mockChatWithFile).not.toHaveBeenCalled();
  });

  it('with a file attached: sends the prompt and the file together', async () => {
    const u = userEvent.setup();
    mockChatWithFile.mockResolvedValueOnce(chatOk('ok'));
    render(<AgentChat />);
    const file = new File(['x'], 'leads.xlsx');

    await u.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);
    await u.click(screen.getByTestId('script-generation-chip'));

    await waitFor(() =>
      expect(mockChatWithFile).toHaveBeenCalledWith('Save this file for script generation', file, undefined),
    );
  });
});

// ── O — Busy popup (another task in progress) ──────────────────────────────────

describe('O — Busy popup', () => {
  const busyReply = {
    success: true,
    data: {
      sessionId: 'sess-1',
      result: {
        status: 'busy',
        intent: 'workflow_busy',
        message: "You're in the middle of the **AI campaign setup**. Please finish it first, or reply **cancel** to stop it.",
      },
    },
  };

  it('shows a popup, drops the command bubble and adds no chat reply', async () => {
    const u = userEvent.setup();
    mockChat.mockResolvedValueOnce(busyReply);
    render(<AgentChat />);

    await u.type(screen.getByTestId('chat-input'), 'Show all campaigns');
    await u.keyboard('{Enter}');

    const popup = await screen.findByTestId('busy-popup');
    expect(popup).toHaveTextContent('AI campaign setup');
    expect(popup.textContent).not.toContain('**');
    expect(screen.queryByText('Show all campaigns', { selector: '[data-testid="message-user"] *' })).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('message-assistant')).toHaveLength(0);

    await u.click(screen.getByTestId('busy-popup-ok'));
    expect(screen.queryByTestId('busy-popup')).not.toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// M — Chat history on the server (bug A-17)
// ═══════════════════════════════════════════════════════════════════════════════

describe('M — chat history on the server (A-17)', () => {
  const SAVED = {
    sessionId: 'sid-old',
    title: 'Show me the stats for DRY RUN',
    activeCampaignId: '434',
    updatedAt: new Date().toISOString(),
    messages: [
      { role: 'user', content: 'Show me the stats for DRY RUN', timestamp: new Date().toISOString() },
      { role: 'assistant', content: 'Here are the statistics for DRY RUN', timestamp: new Date().toISOString() },
    ],
  };

  it('saves the chat to the account after a reply', async () => {
    mockChat.mockResolvedValueOnce(chatOk('Saved reply', 'sid-9'));
    mockChatsSave.mockResolvedValue(true);
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'remember this');
    await user.keyboard('{Enter}');
    await waitFor(() => screen.getByTestId('message-assistant'));

    await waitFor(() => expect(mockChatsSave).toHaveBeenCalled(), { timeout: 3000 });
    const [sid, body] = mockChatsSave.mock.calls.at(-1)! as [string, { messages: Array<{ role: string; content: string }> }];
    expect(sid).toBe('sid-9');
    expect(body.messages.map((m) => m.content)).toEqual(['remember this', 'Saved reply']);
  });

  it('a browser with no chat of its own (another device) opens the newest saved chat', async () => {
    mockChatsList.mockResolvedValue([{ id: 1, sessionId: 'sid-old', title: SAVED.title, messageCount: 2, updatedAt: SAVED.updatedAt }]);
    mockChatsGet.mockResolvedValue(SAVED);
    render(<AgentChat />);

    expect(await screen.findByText('Here are the statistics for DRY RUN')).toBeInTheDocument();
    expect(mockChatsGet).toHaveBeenCalledWith('sid-old');
  });

  it('after "New chat" (an empty chat in this browser) the old chat is NOT reopened', async () => {
    localStorage.setItem('mailflow-agent-chat-v1', JSON.stringify({ messages: [] }));
    mockChatsList.mockResolvedValue([{ id: 1, sessionId: 'sid-old', title: SAVED.title, messageCount: 2, updatedAt: SAVED.updatedAt }]);
    render(<AgentChat />);

    await act(async () => { await Promise.resolve(); });
    expect(mockChatsGet).not.toHaveBeenCalled();
    expect(screen.queryByTestId('message-user')).not.toBeInTheDocument();
  });

  it('Recent sidebar lists earlier chats; picking one opens it', async () => {
    localStorage.setItem('mailflow-agent-chat-v1', JSON.stringify({ messages: [] }));
    mockChatsList.mockResolvedValue([{ id: 1, sessionId: 'sid-old', title: SAVED.title, messageCount: 2, updatedAt: SAVED.updatedAt }]);
    mockChatsGet.mockResolvedValue(SAVED);
    render(<AgentChat />);

    const item = await screen.findByTestId('chat-history-item');
    expect(item).toHaveTextContent('Show me the stats for DRY RUN');
    expect(item).toHaveTextContent('Just now');

    await user.click(within(item).getByText('Show me the stats for DRY RUN'));
    expect(await screen.findByText('Here are the statistics for DRY RUN')).toBeInTheDocument();
    expect(mockChatsGet).toHaveBeenCalledWith('sid-old');
    expect(screen.getByTestId('chat-history-item')).toHaveAttribute('data-active', 'true');
  });

  it('without the server history the sidebar says so and the page still works', async () => {
    mockChatsList.mockResolvedValue(null);
    render(<AgentChat />);
    expect(await screen.findByTestId('sidebar-unavailable')).toHaveTextContent(/isn't available right now/);
    expect(screen.getByTestId('chat-input')).toBeInTheDocument();
  });

  it('names the chat input for assistive technology', () => {
    render(<AgentChat />);
    expect(screen.getByRole('textbox', { name: 'Message the AI agent' })).toBeInTheDocument();
  });
});

describe('QA P4 bugs 13 + 27 — message times', () => {
  it('times are readable (gray-600, not gray-400) and older messages show the date with a full-date title', () => {
    localStorage.setItem('mailflow-agent-chat-v1', JSON.stringify({
      messages: [
        { id: 'u1', role: 'user', content: 'Show stats for DRY RUN', timestamp: new Date(2026, 9, 1, 9, 20).toISOString() },
        { id: 'a1', role: 'assistant', content: 'Old stats', timestamp: new Date(2026, 9, 1, 9, 21).toISOString() },
        { id: 'u2', role: 'user', content: 'Hi again', timestamp: new Date().toISOString() },
        { id: 'a2', role: 'assistant', content: 'Hello', timestamp: new Date().toISOString() },
      ],
    }));
    render(<AgentChat />);
    const times = screen.getAllByTestId('message-time');
    expect(times[0]).toHaveClass('text-gray-600');
    expect(times[0]).not.toHaveClass('text-gray-400');
    expect(times[0]!.textContent).toMatch(/^1 Oct( \d{4})?, /);
    expect(times[0]!.getAttribute('title')).toMatch(/October/);
    expect(times[3]!.textContent).not.toMatch(/Oct|Nov|,/); // today: time only
  });
});

describe('QA P4 bugs 14 + 15 — copy a reply, download the chat', () => {
  it('each agent reply has Copy; it copies the text with line breaks (no ** stars)', async () => {
    const u = userEvent.setup(); // installs its own clipboard stub — replace it after
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mockChat.mockResolvedValueOnce(chatOk('**Sent:** 2\n**Opened:** 1'));
    render(<AgentChat />);
    await u.type(screen.getByTestId('chat-input'), 'stats');
    await u.keyboard('{Enter}');
    await u.click(await screen.findByTestId('copy-reply'));
    expect(writeText).toHaveBeenCalledWith('Sent: 2\nOpened: 1');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('chatAsText lists who said what, in order', async () => {
    const { chatAsText } = await import('../AgentChat');
    const t = new Date(2026, 10, 15, 9, 0);
    const text = chatAsText([
      { role: 'user', content: 'Show stats for DRY RUN', timestamp: t },
      { role: 'assistant', content: '**Sent:** 2', timestamp: t },
    ]);
    expect(text).toMatch(/You:\nShow stats for DRY RUN\n\n\[.*\] MailFlow AI:\nSent: 2$/);
  });

  it('Download is disabled on an empty chat', () => {
    render(<AgentChat />);
    expect(screen.getByTestId('download-chat-button')).toBeDisabled();
  });
});

describe('QA P4 bug 16 — progress text while the agent works', () => {
  it('progressText fits the question and says "still working" on a long wait', async () => {
    const { progressText } = await import('../AgentChat');
    expect(progressText('Summarize replies for DRY RUN', 0)).toBe('Reading your replies…');
    expect(progressText('Show stats for DRY RUN', 6)).toBe('Fetching your campaign numbers… almost there.');
    expect(progressText('hello', 13)).toBe('Working on it… this one is taking longer than usual, still working.');
  });

  it('the typing indicator shows the status line for the question sent', async () => {
    let resolve: (v: unknown) => void;
    mockChat.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const u = userEvent.setup();
    render(<AgentChat />);
    await u.type(screen.getByTestId('chat-input'), 'Summarize replies for DRY RUN');
    await u.keyboard('{Enter}');
    expect(await screen.findByTestId('progress-text')).toHaveTextContent('Reading your replies…');
    await act(async () => { resolve!(chatOk('done')); });
  });
});

describe('QA P4 bug 28 — welcome tiles are buttons that fill the message box', () => {
  it('clicking Analytics puts a sample question in the box (not sent)', async () => {
    const u = userEvent.setup();
    render(<AgentChat />);
    const tiles = screen.getAllByTestId('welcome-tile');
    expect(tiles).toHaveLength(5);
    expect(tiles[2]!.tagName).toBe('BUTTON');
    await u.click(tiles[2]!);
    expect(screen.getByTestId('chat-input')).toHaveValue('How are my campaigns doing?');
    expect(mockChat).not.toHaveBeenCalled();
  });
});

describe('QA P4 bug 31 — the chat history is a named, focusable log', () => {
  it('role="log", aria-label "Conversation", tabIndex 0, and each message says who sent it and when', async () => {
    const u = userEvent.setup();
    mockChat.mockResolvedValueOnce(chatOk('Here are your campaigns'));
    render(<AgentChat />);
    await u.type(screen.getByTestId('chat-input'), 'Show all my campaigns');
    await u.keyboard('{Enter}');
    await screen.findByText('Here are your campaigns');

    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(log).toHaveAttribute('tabindex', '0');
    const groups = within(log).getAllByRole('group');
    expect(groups[0]!.getAttribute('aria-label')).toMatch(/^You said, /);
    expect(groups[1]!.getAttribute('aria-label')).toMatch(/^MailFlow AI said, /);
  });
});

describe('QA P3 bug 46 — focusing the box after an answer does not scroll the page', () => {
  it('focus is called with preventScroll', async () => {
    const spy = vi.spyOn(HTMLTextAreaElement.prototype, 'focus');
    const u = userEvent.setup();
    mockChat.mockResolvedValueOnce(chatOk('Here are the statistics'));
    render(<AgentChat />);
    await u.type(screen.getByTestId('chat-input'), 'Show stats for DRY RUN');
    await u.keyboard('{Enter}');
    await screen.findByText('Here are the statistics');
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ preventScroll: true }));
    spy.mockRestore();
  });
});

describe('QA P3-2 bug 8 — a second tab does not overwrite the first', () => {
  it('a chat saved by another tab replaces this tab\'s older copy', async () => {
    render(<AgentChat />);
    const saved = {
      sessionId: 'sid-tab-a',
      messages: [
        { id: 'u1', role: 'user', content: 'Show stats for campaign id 431', timestamp: new Date().toISOString() },
        { id: 'a1', role: 'assistant', content: 'Campaign 3 stats', timestamp: new Date().toISOString() },
      ],
    };
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'mailflow-agent-chat-v1', newValue: JSON.stringify(saved) }));
    });
    expect(await screen.findByText('Campaign 3 stats')).toBeInTheDocument();
  });
});

describe('QA P3-2 bug 14 — phone layout CSS', () => {
  it('chips are one non-wrapping scroll row on phones', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf8');
    expect(css).toMatch(/\.chat-suggestion-row \{\s*flex-wrap: nowrap !important;/);
    expect(css).toMatch(/\.agent-chat-page \{\s*height: calc\(100dvh/);
  });
});

describe('Recent chats sidebar (last 10, ChatGPT style)', () => {
  const sum = (i: number, title = `Chat ${i}`) => ({ id: i, sessionId: `s${i}`, title, messageCount: 2, updatedAt: new Date().toISOString() });

  it('the list loads when the page opens (no click) and shows only 10', async () => {
    localStorage.setItem('mailflow-agent-chat-v1', JSON.stringify({ messages: [] }));
    mockChatsList.mockResolvedValue(Array.from({ length: 12 }, (_, i) => sum(i + 1)));
    render(<AgentChat />);
    expect(await screen.findAllByTestId('chat-history-item')).toHaveLength(10);
  });

  it('after a reply is saved the sidebar is refreshed (the new chat shows at the top)', async () => {
    mockChatsList.mockResolvedValueOnce([sum(1)]);
    mockChat.mockResolvedValueOnce(chatOk('Done', 'sid-new'));
    mockChatsSave.mockResolvedValue(true);
    mockChatsList.mockResolvedValue([sum(2, 'Show stats'), sum(1)]);
    localStorage.setItem('mailflow-agent-chat-v1', JSON.stringify({ messages: [] }));
    render(<AgentChat />);
    await user.type(screen.getByTestId('chat-input'), 'Show stats');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getAllByTestId('chat-history-item')[0]).toHaveTextContent('Show stats'), { timeout: 4000 });
  });

  it('deleting the open chat removes it and starts a new empty chat', async () => {
    localStorage.setItem('mailflow-agent-chat-v1', JSON.stringify({ sessionId: 's1', messages: [
      { id: 'u', role: 'user', content: 'hello there', timestamp: new Date().toISOString() },
      { id: 'a', role: 'assistant', content: 'hi back', timestamp: new Date().toISOString() },
    ] }));
    mockChatsList.mockResolvedValue([sum(1), sum(2)]);
    mockChatsRemove.mockResolvedValue(true);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AgentChat />);
    await user.click(await screen.findByRole('button', { name: 'Delete chat Chat 1' }));
    await waitFor(() => expect(mockChatsRemove).toHaveBeenCalledWith('s1'));
    expect(screen.queryByText('hi back')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('chat-history-item')).toHaveLength(1);
    confirmSpy.mockRestore();
  });

  it('sidebar + New chat clears the chat (old one stays in the list)', async () => {
    localStorage.setItem('mailflow-agent-chat-v1', JSON.stringify({ sessionId: 's1', messages: [
      { id: 'u', role: 'user', content: 'hello there', timestamp: new Date().toISOString() },
    ] }));
    mockChatsList.mockResolvedValue([sum(1)]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AgentChat />);
    await user.click(await screen.findByTestId('sidebar-new-chat'));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('stays in Recent chats'));
    expect(screen.queryByText('hello there')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('chat-history-item')).toHaveLength(1);
    confirmSpy.mockRestore();
  });

  it('the Chats button opens the phone drawer; choosing a chat closes it', async () => {
    localStorage.setItem('mailflow-agent-chat-v1', JSON.stringify({ messages: [] }));
    mockChatsList.mockResolvedValue([sum(1)]);
    mockChatsGet.mockResolvedValue({ sessionId: 's1', title: 'Chat 1', activeCampaignId: null, updatedAt: new Date().toISOString(), messages: [
      { role: 'user', content: 'q', timestamp: new Date().toISOString() }, { role: 'assistant', content: 'a from s1', timestamp: new Date().toISOString() },
    ] });
    render(<AgentChat />);
    await screen.findByTestId('chat-history-item');
    await user.click(screen.getByTestId('sidebar-toggle'));
    expect(screen.getByTestId('chat-sidebar')).toHaveAttribute('data-open', 'true');
    await user.click(screen.getByTitle('Chat 1'));
    expect(await screen.findByText('a from s1')).toBeInTheDocument();
    expect(screen.getByTestId('chat-sidebar')).toHaveAttribute('data-open', 'false');
  });
});
