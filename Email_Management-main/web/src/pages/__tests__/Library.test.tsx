import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/ui';

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const libraryApi = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), blob: vi.fn(), remove: vi.fn() }));
vi.mock('../../lib/libraryApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/libraryApi')>()),
  libraryApi,
}));

import { Library } from '../Library';

const file = (id: number, fileName: string) => ({ id, fileName, mimeType: 'text/csv', sizeBytes: 2048, sessionId: 's1', createdAt: '2026-11-24T10:00:00.000Z' });
const page = (files: ReturnType<typeof file>[], usedBytes = 2048) => ({ files, usedBytes, limitBytes: 150 * 1024 * 1024 });

beforeEach(() => vi.clearAllMocks());

describe('Library page', () => {
  it('lists the files with the 150 MB usage; filters and search ask the server', async () => {
    libraryApi.list.mockResolvedValue(page([file(1, 'leads.csv'), file(2, 'q4.xlsx')], 75 * 1024 * 1024));
    render(<ToastProvider><Library /></ToastProvider>);
    expect(await screen.findAllByTestId('library-file')).toHaveLength(2);
    expect(screen.getByTestId('library-usage')).toHaveTextContent('75.0 MB of 150.0 MB used');
    await userEvent.click(screen.getByRole('tab', { name: 'Excel' }));
    await waitFor(() => expect(libraryApi.list).toHaveBeenLastCalledWith({ search: '', type: 'excel' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search files' }), 'q4');
    await waitFor(() => expect(libraryApi.list).toHaveBeenLastCalledWith({ search: 'q4', type: 'excel' }));
  });

  it('"Use in chat" opens the AI Agent with the file; Delete asks first', async () => {
    libraryApi.list.mockResolvedValue(page([file(1, 'leads.csv')]));
    libraryApi.remove.mockResolvedValue(undefined);
    render(<ToastProvider><Library /></ToastProvider>);
    await userEvent.click(await screen.findByRole('button', { name: /use in chat/i }));
    expect(navigate).toHaveBeenCalledWith('/agent', { state: { libraryFile: { id: 1, fileName: 'leads.csv' } } });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await userEvent.click(screen.getByRole('button', { name: 'Delete leads.csv' }));
    expect(libraryApi.remove).not.toHaveBeenCalled();
    confirmSpy.mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: 'Delete leads.csv' }));
    await waitFor(() => expect(libraryApi.remove).toHaveBeenCalledWith(1));
    confirmSpy.mockRestore();
  });

  it('empty Library explains where files come from', async () => {
    libraryApi.list.mockResolvedValue(page([], 0));
    render(<ToastProvider><Library /></ToastProvider>);
    expect(await screen.findByTestId('library-empty')).toHaveTextContent('Files you attach in the AI Agent chat');
  });
});
