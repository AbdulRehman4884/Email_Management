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

vi.mock('../../lib/api', () => ({
  agentApi: {
    chat:    (...args: unknown[]) => mockChat(...args),
    confirm: (...args: unknown[]) => mockConfirm(...args),
    cancel:  (...args: unknown[]) => mockCancel(...args),
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
  it('renders all 5 suggested prompt chips', () => {
    render(<AgentChat />);
    expect(screen.getAllByTestId('prompt-chip')).toHaveLength(5);
  });

  it('chip text matches the SUGGESTED_PROMPTS list', () => {
    render(<AgentChat />);
    const chips = screen.getAllByTestId('prompt-chip');
    const texts = chips.map((c) => c.textContent);
    expect(texts).toContain('Show all campaigns');
    expect(texts).toContain('Check SMTP configuration');
    expect(texts).toContain('Show inbox replies');
    expect(texts).toContain('Create a campaign');
    expect(texts).toContain('Pause a campaign');
  });

  it('clicking a chip immediately sends that text via agentApi.chat', async () => {
    mockChat.mockResolvedValueOnce(chatOk('Here are your campaigns'));
    render(<AgentChat />);

    const chip = screen.getAllByTestId('prompt-chip')[0]; // 'Show all campaigns'
    await user.click(chip);

    expect(mockChat).toHaveBeenCalledWith('Show all campaigns', undefined);
    await waitFor(() => screen.getByTestId('message-user'));
    expect(screen.getByTestId('message-user')).toHaveTextContent('Show all campaigns');
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

    await user.click(starters[0]); // 'Show all campaigns'
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

  it('Send button is disabled while loading', async () => {
    let resolve: (v: unknown) => void;
    mockChat.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'test');
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(screen.getByTestId('send-button')).toBeDisabled(),
    );

    await act(async () => { resolve!(chatOk('done')); });
  });

  it('textarea is disabled while loading', async () => {
    let resolve: (v: unknown) => void;
    mockChat.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    render(<AgentChat />);

    await user.type(screen.getByTestId('chat-input'), 'test');
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(screen.getByTestId('chat-input')).toBeDisabled(),
    );

    await act(async () => { resolve!(chatOk('done')); });
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

    await user.click(screen.getByTestId('new-chat-button'));

    expect(screen.queryByTestId('message-user')).not.toBeInTheDocument();
    expect(screen.queryByTestId('message-assistant')).not.toBeInTheDocument();
    expect(localStorage.getItem('mailflow-agent-chat-v1')).toBeNull();
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

    // Input is disabled while loading so the second send is blocked at the guard
    await waitFor(() =>
      expect(screen.getByTestId('chat-input')).toBeDisabled(),
    );

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
