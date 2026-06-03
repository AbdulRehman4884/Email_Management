import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, types } from 'pg';

// Return raw strings for timestamp columns instead of converting to Date objects.
// OID 1114 = timestamp without timezone, OID 1184 = timestamp with timezone.
types.setTypeParser(1114, (val: string) => val);
types.setTypeParser(1184, (val: string) => val);

// Use SSL only for remote/cloud DB (set DATABASE_SSL=true or use ?sslmode=require in URL). Local PostgreSQL on VPS usually needs ssl: false.
const connUrl = process.env.DATABASE_URL ?? '';
const useSsl = process.env.DATABASE_SSL === 'true' || connUrl.includes('sslmode=require');
const pool = new Pool({
  connectionString: connUrl,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

function maskDatabaseUrl(value: string): string {
  if (!value) return "(not set)";
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    if (url.username) url.username = url.username ? '***' : '';
    return url.toString();
  } catch {
    return value.replace(/:\/\/([^:/?#]+):([^@/?#]+)@/, '://***:***@');
  }
}

/** `NOW()` and timestamp defaults are evaluated in this zone so DB values match local time (e.g. PKT). Override with `DB_TIMEZONE=Asia/Dubai` etc. */
const DEFAULT_TZ = 'Asia/Karachi';
function getSafePgTimeZone(): string {
  const raw = (process.env.DB_TIMEZONE || process.env.PGTZ || DEFAULT_TZ).trim();
  return /^[A-Za-z0-9_/+:.-]+$/.test(raw) ? raw : DEFAULT_TZ;
}

pool.on('connect', (client) => {
  const tz = getSafePgTimeZone();
  void client.query(`SET TIME ZONE '${tz.replace(/'/g, "''")}'`);
});

export const db = drizzle(pool);
export const dbPool = pool;

export async function logDbConnectionInfo(label = 'backend'): Promise<void> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{
      database_name: string;
      host: string | null;
      port: number | null;
      current_schema: string;
    }>(
      `SELECT current_database() AS database_name,
              inet_server_addr()::text AS host,
              inet_server_port() AS port,
              current_schema() AS current_schema`,
    );
    const row = rows[0];
    console.log(
      `[db:${label}] database=${row?.database_name ?? 'unknown'} ` +
      `host=${row?.host ?? 'local-socket'} ` +
      `port=${row?.port ?? 'unknown'} ` +
      `schema=${row?.current_schema ?? 'unknown'} ` +
      `url=${maskDatabaseUrl(connUrl)}`,
    );
  } finally {
    client.release();
  }
}

// ── Startup schema validator ───────────────────────────────────────────────────
//
// Run once at server startup.  Queries information_schema (read-only, no ORM)
// so a schema-drift error surfaces as a precise human message instead of a
// deep DrizzleQueryError inside the first request handler.
//
// Does NOT crash the server — logs warnings and lets operators decide.

interface SchemaCheck {
  kind:   "column" | "table";
  table:  string;
  column?: string;
}

const CRITICAL_SCHEMA: SchemaCheck[] = [
  { kind: "table",  table: "user_notifications" },
  { kind: "table",  table: "follow_up_jobs" },
  { kind: "table",  table: "bulk_import_jobs" },
  { kind: "table",  table: "bulk_import_rows" },
  { kind: "table",  table: "generated_templates" },
  { kind: "column", table: "campaigns",  column: "smtp_settings_id" },
  { kind: "column", table: "campaigns",  column: "daily_send_window_start" },
  { kind: "column", table: "campaigns",  column: "daily_send_window_end" },
  { kind: "column", table: "campaigns",  column: "send_weekdays" },
  { kind: "column", table: "campaigns",  column: "daily_send_limit" },
  { kind: "column", table: "campaigns",  column: "pause_reason" },
  { kind: "column", table: "campaigns",  column: "paused_at" },
  { kind: "column", table: "campaigns",  column: "follow_up_templates" },
  { kind: "column", table: "recipients", column: "custom_fields" },
  { kind: "column", table: "recipients", column: "last_send_error" },
  { kind: "column", table: "users",      column: "preferred_theme" },
];

export async function validateDbSchema(options: { throwOnError?: boolean } = {}): Promise<void> {
  const client = await pool.connect();
  const missing: string[] = [];

  try {
    for (const check of CRITICAL_SCHEMA) {
      if (check.kind === "table") {
        const { rows } = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = $1
           ) AS exists`,
          [check.table],
        );
        if (!rows[0]?.exists) {
          missing.push(`Missing DB table: ${check.table}`);
        }
      } else {
        const { rows } = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name  = $1
               AND column_name = $2
           ) AS exists`,
          [check.table, check.column],
        );
        if (!rows[0]?.exists) {
          missing.push(`Missing DB column: ${check.table}.${check.column}`);
        }
      }
    }
  } finally {
    client.release();
  }

  if (missing.length === 0) {
    console.log('[db] Schema validation passed — all critical columns/tables present.');
    return;
  }

  console.error('[db] *** SCHEMA DRIFT DETECTED ***');
  for (const msg of missing) {
    console.error(`[db]   ${msg}`);
  }
  console.error('[db] Run: npx tsx scripts/fix-schema-drift.ts');
  console.error('[db] Then restart the server.');
  if (options.throwOnError) {
    throw new Error(`Schema drift detected: ${missing.join('; ')}`);
  }
}
