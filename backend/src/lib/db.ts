import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

// Use SSL only for remote/cloud DB (set DATABASE_SSL=true or use ?sslmode=require in URL). Local PostgreSQL on VPS usually needs ssl: false.
const connUrl = process.env.DATABASE_URL ?? '';
const useSsl = process.env.DATABASE_SSL === 'true' || connUrl.includes('sslmode=require');
const pool = new Pool({
  connectionString: connUrl,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});
export const db = drizzle(pool);
export const dbPool = pool;
