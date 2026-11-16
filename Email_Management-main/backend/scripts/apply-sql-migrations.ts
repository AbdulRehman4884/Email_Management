/**
 * Applies every drizzle/*.sql file (except *_rollback.sql) that is not yet recorded
 * in `_sql_migrations`, in filename order, each in its own transaction.
 *
 * Exists because `drizzle-kit migrate` relies on drizzle/meta/_journal.json staying in
 * sync with the files on disk, and in this repo it repeatedly hasn't (migrations merged
 * from feature branches without their journal entry). Every migration here is written to
 * be safe to run more than once (CREATE ... IF NOT EXISTS, DO $$ ... EXCEPTION WHEN
 * duplicate_object), so tracking by filename instead of journal position is enough.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.join(__dirname, '..', 'drizzle');

const connectionString = process.env.DATABASE_URL ?? '';
const useSsl = process.env.DATABASE_SSL === 'true' || connectionString.includes('sslmode=require');
const pool = new Pool({ connectionString, ssl: useSsl ? { rejectUnauthorized: false } : false });

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _sql_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const files = readdirSync(drizzleDir)
      .filter((f) => f.endsWith('.sql') && !f.endsWith('_rollback.sql'))
      .sort();

    const { rows } = await client.query<{ filename: string }>('SELECT filename FROM _sql_migrations');
    const applied = new Set(rows.map((r) => r.filename));

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`[skip] ${file}`);
        continue;
      }
      console.log(`[apply] ${file} ...`);
      const sql = readFileSync(path.join(drizzleDir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO _sql_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[ok] ${file}`);
        appliedCount++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[FAILED] ${file}`);
        throw err;
      }
    }
    console.log(appliedCount === 0 ? 'Nothing to apply, already up to date.' : `Applied ${appliedCount} migration(s).`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
