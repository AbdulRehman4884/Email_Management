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
export const db = drizzle(pool);
export const dbPool = pool;
