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
  it('shows every chat (no 10 limit) under "Recent", pinned ones under "Pinned"', () => {
    const chats = Array.from({ length: 13 }, (_, i) => chat(i + 1));
    chats[4] = { ...chats[4]!, pinned: true };
    render(<ChatSidebar {...props({ chats })} />);
    expect(screen.getAllByTestId('chat-history-item')).toHaveLength(13);
    expect(within(screen.getByTestId('sidebar-pinned')).getAllByTestId('chat-history-item')).toHaveLength(1);
    expect(within(screen.getByTestId('sidebar-pinned')).getByText('Chat 5')).toBeInTheDocument();
    expect(within(screen.getByTestId('sidebar-recent')).getAllByTestId('chat-history-item')).toHaveLength(12);
  });

  it('⋯ menu: Pin / Unpin, Rename, Delete; a 4th pin is disabled', async () => {
    const onPinChat = vi.fn();
    const chats = [chat(1), { ...chat(2), pinned: true }, { ...chat(3), pinned: true }, { ...chat(4), pinned: true }];
    render(<ChatSidebar {...props({ chats, onPinChat, onRenameChat: vi.fn() })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Chat options for Chat 1' }));
    expect(screen.getByRole('menuitem', { name: 'Pin' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('chat-menu')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Chat options for Chat 2' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Unpin' }));
    expect(onPinChat).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's2' }), false);
  });

  it('rename: Escape cancels, empty name is not saved', async () => {
    const onRenameChat = vi.fn().mockResolvedValue(true);
    render(<ChatSidebar {...props({ chats: [chat(1)], onRenameChat })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Chat options for Chat 1' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Chat name' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Chat options for Chat 1' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'Chat name' }));
    await userEvent.keyboard('{Enter}');
    expect(onRenameChat).not.toHaveBeenCalled();
  });

  it('says how long chats are kept', () => {
    render(<ChatSidebar {...props()} />);
    expect(screen.getByTestId('chat-sidebar')).toHaveTextContent('Chats are kept for 30 days after the last message. Pinned chats stay until you unpin them.');
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
    await userEvent.click(screen.getByRole('button', { name: 'Chat options for Chat 1' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete chat Chat 1' }));
    expect(p.onDeleteChat).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }));
  });

  it('is locked while a reply is on its way', () => {
    render(<ChatSidebar {...props({ disabled: true })} />);
    expect(screen.getByTestId('sidebar-new-chat')).toBeDisabled();
    expect(screen.getByTitle('Chat 1')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Chat options for Chat 1' })).toBeDisabled();
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
