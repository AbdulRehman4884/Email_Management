/**
 * AI Agent Library: every file the user attaches in the AI Agent chat is kept here (mounted at /api, login required).
 *
 *   GET    /agent-library[?search=&type=csv|excel]   the user's files, newest first + used / limit bytes
 *   POST   /agent-library                            multipart: file (CSV / Excel, max 10 MB), sessionId? (the chat)
 *   GET    /agent-library/:id/download               the file itself
 *   DELETE /agent-library/:id                        delete one file
 *
 * Each user keeps at most LIBRARY_LIMIT_BYTES (150 MB). When a new file goes over it, the OLDEST files are deleted
 * until the total fits again (the new file is always kept: one file is at most 10 MB).
 * Answers 503 until drizzle/0044_agent_chat_pins_library.sql is applied (scripts/run-agent-chat-migration.ts).
 */
import type { Request, Response } from 'express';
import { dbPool } from '../lib/db.js';

export const LIBRARY_LIMIT_BYTES = 150 * 1024 * 1024;
export const LIBRARY_FILE_MAX_BYTES = 10 * 1024 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

const TYPES: Record<string, string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let tableReady = false;
async function libraryReady(): Promise<boolean> {
  if (tableReady) return true;
  const r = await dbPool.query<{ t: string | null }>(`SELECT to_regclass('public.agent_library_files')::text AS t`);
  tableReady = !!r.rows[0]?.t;
  return tableReady;
}

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      if (!req.user?.id) throw new HttpError(401, 'Unauthorized');
      if (!(await libraryReady())) {
        throw new HttpError(503, 'The Library is not set up yet. Run the agent chat migrations first (npx tsx scripts/run-agent-chat-migration.ts).');
      }
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('[agent library]', err);
      res.status(500).json({ error: 'Something went wrong' });
    }
  };
}

/** csv | xlsx | xls from the file name, or null when the file type is not allowed. */
export function libraryExtension(fileName: string): string | null {
  const m = /\.(csv|xlsx|xls)$/i.exec(fileName.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** A file name safe to store and show: no path, no control characters, at most 200 characters. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001F\u007F"]/g, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 200) return cleaned || 'file';
  const ext = /\.[A-Za-z0-9]{1,5}$/.exec(cleaned)?.[0] ?? '';
  return cleaned.slice(0, 200 - ext.length) + ext;
}

function idParam(req: Request): number {
  const n = Number.parseInt(String(req.params.id ?? ''), 10);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Invalid file id');
  return n;
}

const META = `id, file_name AS "fileName", mime_type AS "mimeType", size_bytes AS "sizeBytes", session_id AS "sessionId",
  created_at AS "createdAt"`;

/** Deletes the user's oldest files until the total is within the limit. Returns the deleted file names. */
export async function enforceLibraryLimit(userId: number, limitBytes = LIBRARY_LIMIT_BYTES): Promise<string[]> {
  const r = await dbPool.query<{ file_name: string }>(
    `DELETE FROM agent_library_files
      WHERE id IN (
        SELECT id FROM (
          SELECT id, sum(size_bytes) OVER (ORDER BY created_at DESC, id DESC) AS running
            FROM agent_library_files WHERE user_id = $1
        ) t WHERE running > $2
      )
      RETURNING file_name`,
    [userId, limitBytes],
  );
  return r.rows.map((row) => row.file_name);
}

async function usedBytes(userId: number): Promise<number> {
  const r = await dbPool.query<{ used: string }>(`SELECT COALESCE(sum(size_bytes), 0)::text AS used FROM agent_library_files WHERE user_id = $1`, [userId]);
  return Number(r.rows[0]?.used ?? 0);
}

export const listLibraryFiles = handle(async (req, res) => {
  const userId = req.user!.id;
  const search = typeof req.query.search === 'string' ? req.query.search.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
  const pattern = search ? `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const type = req.query.type === 'csv' ? 'csv' : req.query.type === 'excel' ? 'excel' : null;
  const r = await dbPool.query(
    `SELECT ${META} FROM agent_library_files
      WHERE user_id = $1
        AND ($2::text IS NULL OR file_name ILIKE $2)
        AND ($3::text IS NULL OR ($3 = 'csv' AND file_name ILIKE '%.csv') OR ($3 = 'excel' AND (file_name ILIKE '%.xlsx' OR file_name ILIKE '%.xls')))
      ORDER BY created_at DESC, id DESC
      LIMIT 500`,
    [userId, pattern, type],
  );
  res.json({ files: r.rows, usedBytes: await usedBytes(userId), limitBytes: LIBRARY_LIMIT_BYTES });
});

export const uploadLibraryFile = handle(async (req, res) => {
  const userId = req.user!.id;
  const file = req.file;
  if (!file) throw new HttpError(400, 'Attach a CSV or Excel file (.csv, .xlsx, .xls)');
  const ext = libraryExtension(file.originalname);
  if (!ext) throw new HttpError(400, 'Only CSV or Excel files (.csv, .xlsx, .xls) can be saved');
  if (!file.size) throw new HttpError(400, 'The file is empty');
  if (file.size > LIBRARY_FILE_MAX_BYTES) throw new HttpError(413, 'The file is larger than 10 MB');
  const sessionId = typeof req.body?.sessionId === 'string' && SESSION_ID_RE.test(req.body.sessionId) ? req.body.sessionId : null;
  const r = await dbPool.query(
    `INSERT INTO agent_library_files (user_id, session_id, file_name, mime_type, size_bytes, content)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${META}`,
    [userId, sessionId, cleanFileName(file.originalname), TYPES[ext]!, file.size, file.buffer],
  );
  const removed = await enforceLibraryLimit(userId);
  res.status(201).json({ file: r.rows[0], removed, usedBytes: await usedBytes(userId), limitBytes: LIBRARY_LIMIT_BYTES });
});

export const downloadLibraryFile = handle(async (req, res) => {
  const userId = req.user!.id;
  const id = idParam(req);
  const r = await dbPool.query<{ file_name: string; mime_type: string; content: Buffer }>(
    `SELECT file_name, mime_type, content FROM agent_library_files WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  const row = r.rows[0];
  if (!row) throw new HttpError(404, 'File not found');
  const ascii = row.file_name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Type', row.mime_type);
  res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.file_name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(row.content);
});

export const deleteLibraryFile = handle(async (req, res) => {
  const userId = req.user!.id;
  const id = idParam(req);
  const r = await dbPool.query(`DELETE FROM agent_library_files WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!r.rowCount) throw new HttpError(404, 'File not found');
  res.json({ deleted: true, usedBytes: await usedBytes(userId), limitBytes: LIBRARY_LIMIT_BYTES });
});
