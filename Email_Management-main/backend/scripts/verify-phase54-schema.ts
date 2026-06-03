import "dotenv/config";
import { Client } from "pg";

const requiredTables = [
  "bulk_import_jobs",
  "bulk_import_rows",
  "generated_templates",
] as const;

const requiredCampaignColumns = [
  "daily_send_window_start",
  "daily_send_window_end",
  "send_weekdays",
  "daily_send_limit",
  "pause_reason",
  "paused_at",
] as const;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const useSsl = process.env.DATABASE_SSL === "true" || url.includes("sslmode=require");
  const client = new Client({
    connectionString: url,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
  });

  await client.connect();
  try {
    const tableResult = await client.query<{ table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = 'public'
         and table_name = any($1)
       order by table_name`,
      [requiredTables],
    );
    const columnResult = await client.query<{ column_name: string }>(
      `select column_name
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'campaigns'
         and column_name = any($1)
       order by column_name`,
      [requiredCampaignColumns],
    );

    const tables = tableResult.rows.map((row) => row.table_name);
    const campaignColumns = columnResult.rows.map((row) => row.column_name);
    const missingTables = requiredTables.filter((table) => !tables.includes(table));
    const missingCampaignColumns = requiredCampaignColumns.filter((column) => !campaignColumns.includes(column));

    console.log(JSON.stringify({ tables, campaignColumns, missingTables, missingCampaignColumns }, null, 2));

    if (missingTables.length > 0 || missingCampaignColumns.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
