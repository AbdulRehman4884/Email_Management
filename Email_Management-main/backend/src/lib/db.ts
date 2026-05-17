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
