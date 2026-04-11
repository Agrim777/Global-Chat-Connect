import { pgTable, bigint, text, integer, varchar, timestamp, boolean, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const genderEnum = pgEnum("gender", ["male", "female", "other"]);
export const lookingForEnum = pgEnum("looking_for", ["male", "female", "any"]);
export const botStateEnum = pgEnum("bot_state", [
  "idle",
  "setup_name",
  "setup_age",
  "setup_gender",
  "setup_looking_for",
  "setup_bio",
  "setup_country",
  "chatting",
]);

export const usersTable = pgTable("users", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  telegramUsername: varchar("telegram_username", { length: 100 }),
  firstName: varchar("first_name", { length: 100 }),
  name: varchar("name", { length: 100 }),
  age: integer("age"),
  gender: genderEnum("gender"),
  lookingFor: lookingForEnum("looking_for"),
  bio: text("bio"),
  country: varchar("country", { length: 100 }),
  isProfileComplete: boolean("is_profile_complete").default(false).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  hasPaid: boolean("has_paid").default(false).notNull(),
  chatCount: integer("chat_count").default(0).notNull(),
  state: botStateEnum("state").default("idle").notNull(),
  chattingWith: bigint("chatting_with", { mode: "number" }),
  termsAccepted: boolean("terms_accepted").default(false).notNull(),
  termsAcceptedAt: timestamp("terms_accepted_at"),
  referralCode: varchar("referral_code", { length: 20 }).unique(),
  referredBy: bigint("referred_by", { mode: "number" }),
  referralCount: integer("referral_count").default(0).notNull(),
  bonusChats: integer("bonus_chats").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ createdAt: true, updatedAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
