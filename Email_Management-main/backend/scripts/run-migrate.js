require('dotenv/config');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const migrationPath = path.join(__dirname, '..', 'drizzle', '0001_puzzling_cloak.sql');

async function run() {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const statements = sql
    .split(/--> statement-breakpoint\n?/)
    .map((s) => s.trim())
    .filter(Boolean);
  const client = await pool.connect();
  try {
    for (const stmt of statements) {
      if (stmt) {
        await client.query(stmt);
        console.log('OK:', stmt.slice(0, 50) + '...');
      }
    }
    console.log('Migration 0001 applied.');
  } catch (e) {
    if (e.code === '42P07') console.log('Table smtp_settings already exists.');
    else if (e.message && e.message.includes('already exists')) console.log('Columns already exist.');
    else throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
