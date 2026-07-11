import { pgTable, bigint, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Permanent ban ledger, keyed by Telegram user id.
 *
 * This is intentionally a separate table from `users` so a ban survives
 * account deletion: `/deleteaccount` and `/deleteuser` hard-delete the row
 * in `users`, but a banned user's id stays here forever until an admin
 * explicitly runs /unban. Any /start (or message) from a banned id is
 * rejected before a fresh `users` row is ever created, so a banned user
 * cannot "delete and rejoin" to escape the ban.
 */
export const bannedUsersTable = pgTable("banned_users", {
  id: bigint("id", { mode: "number" }).primaryKey(), // Telegram user id
  bannedAt: timestamp("banned_at").defaultNow().notNull(),
  bannedBy: bigint("banned_by", { mode: "number" }),
  reason: text("reason"),
});

export type BannedUser = typeof bannedUsersTable.$inferSelect;
