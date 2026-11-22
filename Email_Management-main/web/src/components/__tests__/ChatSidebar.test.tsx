import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChatSidebar, relativeTime } from '../ChatSidebar';
import type { AgentChatSummary } from '../../lib/api';

const now = new Date(2026, 10, 19, 15, 0, 0);
const chat = (i: number, updatedAt = now.toISOString()): AgentChatSummary => ({ id: i, sessionId: `s${i}`, title: `Chat ${i}`, messageCount: 2, updatedAt });

function props(over: Partial<React.ComponentProps<typeof ChatSidebar>> = {}) {
  return {
    chats: [chat(1)] as AgentChatSummary[] | null | false,
    activeSessionId: undefined as string | undefined,
    disabled: false,
    open: false,
    onClose: vi.fn(),
    onNewChat: vi.fn(),
    onOpenChat: vi.fn(),
    onDeleteChat: vi.fn(),
    ...over,
  };
}

describe('relativeTime', () => {
  it('just now, minutes, hours, yesterday, days', () => {
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    expect(relativeTime(ago(20_000), now)).toBe('Just now');
    expect(relativeTime(ago(5 * 60_000), now)).toBe('5m ago');
    expect(relativeTime(ago(2 * 3_600_000), now)).toBe('2h ago');
    expect(relativeTime(new Date(2026, 10, 18, 9, 0).toISOString(), now)).toBe('Yesterday');
    expect(relativeTime(new Date(2026, 10, 14, 9, 0).toISOString(), now)).toBe('5 days ago');
    expect(relativeTime('not a date', now)).toBe('');
  });
});

describe('ChatSidebar', () => {
  it('shows at most the 10 latest chats, newest first, under "Recent"', () => {
    render(<ChatSidebar {...props({ chats: Array.from({ length: 13 }, (_, i) => chat(i + 1)) })} />);
    expect(screen.getByText('Recent')).toBeInTheDocument();
    const items = screen.getAllByTestId('chat-history-item');
    expect(items).toHaveLength(10);
    expect(items[0]).toHaveTextContent('Chat 1');
    expect(screen.queryByText('Chat 11')).not.toBeInTheDocument();
  });

  it('says how long chats are kept', () => {
    render(<ChatSidebar {...props()} />);
    expect(screen.getByTestId('chat-sidebar')).toHaveTextContent('Your last 10 chats are kept for 30 days, then deleted.');
  });

  it('highlights the open chat and opens another on click', async () => {
    const p = props({ chats: [chat(1), chat(2)], activeSessionId: 's2' });
    render(<ChatSidebar {...p} />);
    const [first, second] = screen.getAllByTestId('chat-history-item');
    expect(second).toHaveAttribute('data-active', 'true');
    expect(first).toHaveAttribute('data-active', 'false');
    await userEvent.click(within(first!).getByTitle('Chat 1'));
    expect(p.onOpenChat).toHaveBeenCalledWith('s1');
  });

  it('+ New chat and delete call back', async () => {
    const p = props({ chats: [chat(1)] });
    render(<ChatSidebar {...p} />);
    await userEvent.click(screen.getByTestId('sidebar-new-chat'));
    expect(p.onNewChat).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete chat Chat 1' }));
    expect(p.onDeleteChat).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }));
  });

  it('is locked while a reply is on its way', () => {
    render(<ChatSidebar {...props({ disabled: true })} />);
    expect(screen.getByTestId('sidebar-new-chat')).toBeDisabled();
    expect(screen.getByTitle('Chat 1')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete chat Chat 1' })).toBeDisabled();
  });

  it('loading / unavailable / empty states', () => {
    const { rerender } = render(<ChatSidebar {...props({ chats: null })} />);
    expect(screen.getByTestId('sidebar-loading')).toBeInTheDocument();
    rerender(<ChatSidebar {...props({ chats: false })} />);
    expect(screen.getByTestId('sidebar-unavailable')).toHaveTextContent("isn't available right now");
    rerender(<ChatSidebar {...props({ chats: [] })} />);
    expect(screen.getByTestId('sidebar-empty')).toBeInTheDocument();
  });

  it('phone drawer: open flag, backdrop and close button close it', async () => {
    const p = props({ open: true });
    render(<ChatSidebar {...p} />);
    expect(screen.getByTestId('chat-sidebar')).toHaveAttribute('data-open', 'true');
    await userEvent.click(screen.getByTestId('chat-sidebar-backdrop'));
    await userEvent.click(screen.getByTestId('sidebar-close'));
    expect(p.onClose).toHaveBeenCalledTimes(2);
  });
});
