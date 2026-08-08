import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;
const connectionString = process.env.PROD_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
const isRailway = connectionString.includes("railway") || connectionString.includes("rlwy.net");
export const pool = new Pool({ connectionString, max: 20, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, ...(isRailway ? { ssl: { rejectUnauthorized: false } } : {}) });
export const db = drizzle(pool, { schema });
export * from "./schema";

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS premium_expires_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS terms_accepted BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS age_verified BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS privacy_accepted BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS gender_locked BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS compliance_version VARCHAR(30),
        ADD COLUMN IF NOT EXISTS female_join_notified BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP NOT NULL DEFAULT NOW();
      CREATE TABLE IF NOT EXISTS banned_users (id BIGINT PRIMARY KEY, banned_at TIMESTAMP NOT NULL DEFAULT NOW(), banned_by BIGINT, reason TEXT);
      CREATE TABLE IF NOT EXISTS user_reports (id BIGSERIAL PRIMARY KEY, reporter_id BIGINT NOT NULL, reported_id BIGINT NOT NULL, reason TEXT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW(), UNIQUE (reporter_id, reported_id));
    `);
  } finally { client.release(); }
}
