import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const connectionString = process.env.PROD_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const isRailway = connectionString.includes("railway") || connectionString.includes("rlwy.net");

export const pool = new Pool({
  connectionString,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ...(isRailway ? { ssl: { rejectUnauthorized: false } } : {}),
});
export const db = drizzle(pool, { schema });

export * from "./schema";

/**
 * Run safe, idempotent schema migrations at startup.
 * Uses ADD COLUMN IF NOT EXISTS so it's a no-op if the column already exists.
 */
export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS premium_expires_at TIMESTAMP;
    `);
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE;
    `);
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP NOT NULL DEFAULT NOW();
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS banned_users (
        id BIGINT PRIMARY KEY,
        banned_at TIMESTAMP NOT NULL DEFAULT NOW(),
        banned_by BIGINT,
        reason TEXT
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  } finally {
    client.release();
  }
}
