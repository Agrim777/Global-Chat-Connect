import TelegramBot from "node-telegram-bot-api";
import { db, pool, usersTable, bannedUsersTable } from "@workspace/db";
import { and, eq, gte, ne, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? "0");
const POLICY_VERSION = "2026-08-23";
const MAX_REPORTS_BEFORE_ALERT = 3;
let activeOfferExpiresAt: Date | null = null;
const ONLINE_WINDOW_MS = 2 * 60 * 1000; // users seen in the last two minutes are considered online
const MATCH_ACTIVE_WINDOW_MINUTES = 10;
const bot = new TelegramBot(TOKEN, { polling: false });
export { bot };

const editField = new Map<number, "name" | "age" | "bio" | "country">();

const PREMIUM_PLANS = {
  twoweek: { label: "2 Week Access", stars: 150, days: 14 },
  month: { label: "1 Month Access", stars: 250, days: 30 },
  lifetime: { label: "Lifetime Access", stars: 1000, days: null },
} as const;
type PremiumPlanKey = keyof typeof PREMIUM_PLANS;

const BUTTONS = {
  start: "✨ Create Profile",
  match: "💘 Find a Match",
  profile: "👤 My Profile",
  premium: "⭐ Unlock Premium",
  stop: "🛑 End Chat",
  report: "🚩 Report User",
  edit: "✏️ Edit Profile",
  delete: "🗑️ Delete Account",
  adminFemale: "👩 Match Female",
  adminMale: "👨 Match Male",
  adminPanel: "🛠️ Admin Panel",
} as const;

const SCAM_PATTERNS = [
  /\binstagram\b/i,
  /\binsta\b/i,
  /\big\s*(?:id|handle|username)\b/i,
  /\bdm\s*(?:me|on)\b.*\b(?:instagram|insta|ig)\b/i,
  /\b(?:telegram|contact)\s*(?:username|id|handle)\b/i,
  /\b(?:send|share|give)\s*(?:me\s*)?(?:your\s*)?(?:insta|instagram|ig)\b/i,
  /\b(?:signal|whatsapp|what\s*sapp|snapchat|snap|discord|messenger)\b/i,
  /\b(?:move|take|talk|chat|connect|message)\b.*\b(?:off[- ]?app|off[- ]?platform|outside|another app|privately)\b/i,
  /\b(?:send|share|give)\s+(?:me\s*)?(?:your\s*)?(?:number|phone|contact|handle|username|id)\b/i,
  /@[_a-z0-9]{4,}/i,
];

function escHtml(value: unknown): string {
  return String(value ?? "—")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function displayName(user: any): string {
  return user?.name || user?.firstName || "Anonymous user";
}

function normalizeAction(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isScamContactRequest(text: string): boolean {
  return SCAM_PATTERNS.some((pattern) => pattern.test(text));
}

function isMediaMessage(msg: TelegramBot.Message): boolean {
  return Boolean(
    msg.photo || msg.video || msg.document || msg.audio || msg.voice || msg.animation ||
    msg.sticker || msg.video_note || msg.contact || msg.location,
  );
}

function isPaidAndActive(user: any): boolean {
  if (user.gender === "female") return true;
  if (!user.hasPaid) return false;
  if (user.premiumPlan === "lifetime") return true;
  return Boolean(user.premiumExpiresAt && new Date(user.premiumExpiresAt) > new Date());
}

function isRecentlyOnline(user: any): boolean {
  if (!user?.lastSeenAt) return false;
  return Date.now() - new Date(user.lastSeenAt).getTime() <= ONLINE_WINDOW_MS;
}

async function ensureSchema() {
  await pool.query(`
    DO $$ BEGIN
      CREATE TYPE gender AS ENUM ('male', 'female', 'other');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE looking_for AS ENUM ('male', 'female', 'any');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE bot_state AS ENUM ('idle', 'setup_name', 'setup_age', 'setup_gender', 'setup_looking_for', 'setup_bio', 'setup_country', 'chatting');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT PRIMARY KEY,
      telegram_username VARCHAR(100), first_name VARCHAR(100), name VARCHAR(100), age INTEGER,
      gender gender, looking_for looking_for, bio TEXT, country VARCHAR(100),
      is_profile_complete BOOLEAN NOT NULL DEFAULT FALSE, is_active BOOLEAN NOT NULL DEFAULT TRUE,
      is_banned BOOLEAN NOT NULL DEFAULT FALSE, has_paid BOOLEAN NOT NULL DEFAULT FALSE,
      chat_count INTEGER NOT NULL DEFAULT 0, state bot_state NOT NULL DEFAULT 'idle', chatting_with BIGINT,
      terms_accepted BOOLEAN NOT NULL DEFAULT FALSE, terms_accepted_at TIMESTAMP,
      age_verified BOOLEAN NOT NULL DEFAULT FALSE, privacy_accepted BOOLEAN NOT NULL DEFAULT FALSE,
      gender_locked BOOLEAN NOT NULL DEFAULT FALSE, compliance_version VARCHAR(30),
      female_join_notified BOOLEAN NOT NULL DEFAULT FALSE,
      premium_plan VARCHAR(20), premium_expires_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(), updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS terms_accepted BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS age_verified BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS privacy_accepted BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS gender_locked BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS compliance_version VARCHAR(30),
      ADD COLUMN IF NOT EXISTS female_join_notified BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS premium_plan VARCHAR(20),
      ADD COLUMN IF NOT EXISTS premium_expires_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP NOT NULL DEFAULT NOW();
    CREATE TABLE IF NOT EXISTS banned_users (
      id BIGINT PRIMARY KEY, banned_at TIMESTAMP NOT NULL DEFAULT NOW(), banned_by BIGINT, reason TEXT
    );
    CREATE TABLE IF NOT EXISTS user_reports (
      id BIGSERIAL PRIMARY KEY,
      reporter_id BIGINT NOT NULL,
      reported_id BIGINT NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (reporter_id, reported_id)
    );
    CREATE TABLE IF NOT EXISTS premium_payments (
      telegram_charge_id VARCHAR(255) PRIMARY KEY,
      user_id BIGINT NOT NULL,
      invoice_payload VARCHAR(255) NOT NULL,
      amount INTEGER NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS match_history (
      user_a BIGINT NOT NULL,
      user_b BIGINT NOT NULL,
      matched_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_a, user_b),
      CHECK (user_a < user_b)
    );
    CREATE INDEX IF NOT EXISTS match_history_recent_idx ON match_history (matched_at DESC);
  `);
  logger.info("Safety schema ensured");
}
const schemaReady = ensureSchema().catch((err) => {
  logger.error({ err }, "Safety schema migration failed");
});

async function getUser(id: number) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!user) return null;
  if (user.hasPaid && user.premiumPlan !== "lifetime" && user.premiumExpiresAt && new Date(user.premiumExpiresAt) <= new Date()) {
    await db.update(usersTable).set({ hasPaid: false, premiumPlan: null, premiumExpiresAt: null, updatedAt: new Date() }).where(eq(usersTable.id, id));
    return { ...user, hasPaid: false, premiumPlan: null, premiumExpiresAt: null };
  }
  return user;
}

async function isBanned(id: number): Promise<boolean> {
  const [ban] = await db.select({ id: bannedUsersTable.id }).from(bannedUsersTable).where(eq(bannedUsersTable.id, id));
  return Boolean(ban);
}

async function upsertUser(id: number, data: Partial<typeof usersTable.$inferInsert>) {
  await db.insert(usersTable).values({ id, ...data } as typeof usersTable.$inferInsert).onConflictDoUpdate({
    target: usersTable.id,
    set: { ...data, updatedAt: new Date(), lastSeenAt: new Date() },
  });
  return getUser(id);
}

async function sendAdmin(text: string) {
  if (!ADMIN_ID) {
    logger.warn({ text }, "Admin alert skipped: ADMIN_TELEGRAM_ID is not configured");
    return;
  }
  await bot.sendMessage(ADMIN_ID, text, { parse_mode: "HTML" }).catch((err) => logger.warn({ err }, "Admin alert failed"));
}

async function notifyFemaleJoin(user: any) {
  if (user.gender !== "female" || !user.isProfileComplete) return;
  const result = await pool.query(
    "UPDATE users SET female_join_notified = TRUE WHERE id = $1 AND female_join_notified = FALSE RETURNING id",
    [user.id],
  );
  if (result.rowCount) {
    await sendAdmin(`🚺 <b>Female profile joined</b>\nID: <code>${user.id}</code>\nUsername: @${escHtml(user.telegramUsername || "not set")}\nAge: ${escHtml(user.age)}\n\nReminder: gender is user-provided and is not verified.`);
  }
}

function mainKeyboard(user: any): TelegramBot.ReplyKeyboardMarkup {
  const rows: TelegramBot.KeyboardButton[][] = [
    [{ text: BUTTONS.match }],
    [{ text: BUTTONS.profile }, { text: BUTTONS.edit }],
    [{ text: BUTTONS.delete }],
  ];
  if (user.gender !== "female" && !isPaidAndActive(user)) rows.push([{ text: BUTTONS.premium }]);
  if (user.id === ADMIN_ID) {
    rows.push([{ text: BUTTONS.adminFemale }, { text: BUTTONS.adminMale }]);
    rows.push([{ text: BUTTONS.adminPanel }]);
  }
  return { keyboard: rows, resize_keyboard: true };
}

async function sendMain(chatId: number, user: any, text?: string) {
  await bot.sendMessage(chatId, text || `💘 Welcome, ${displayName(user)}! Find someone interesting for an anonymous conversation. Stay respectful and stay safe. 😊`, { reply_markup: mainKeyboard(user) });
}

const DISCLAIMER = `
<b>IMPORTANT: READ BEFORE USING</b>

This bot is an anonymous chat service for adults. It is not a dating bot and does not arrange dates or relationships. It helps people meet others for conversations, but gender is self-declared and may be inaccurate.

<b>18+ only</b>
You must be at least 18 years old. No minors are allowed. Do not use this service if you are under 18. We may suspend accounts and report unlawful conduct where required.

<b>Safety and scam warning</b>
Never share Instagram, Telegram handles, phone numbers, OTPs, passwords, payment details, address, workplace, private photos, or other personal information. A scammer may claim to be a girl, ask you to move to Instagram/DM, and use manipulated or morphed images to harass or extort people. Treat every gender claim and every request to move off-platform as unverified. The bot shows a safety warning when social-contact details appear; media sharing remains blocked for safety.

<b>Human-only chat</b>
There is no free AI chat, fake persona, or automated person pretending to be a user. Availability depends on real users. We do not guarantee a specific gender or conversation outcome.

By tapping “I am 18+ and agree”, you confirm the age statement, accept the Privacy Policy and these terms, and consent to the processing described there. This is general product copy, not legal advice; the operator should obtain India-specific legal review before launch.`;

const PRIVACY = `
<b>PRIVACY POLICY</b>
<b>Effective date:</b> ${POLICY_VERSION}

<b>1. Who this is for</b>
This bot provides anonymous text chat for adults. It is not a dating service and does not guarantee identity, gender, matching, safety, or outcomes.

<b>2. Data we process</b>
We may process your Telegram user ID, username, first name, age confirmation, self-declared gender, optional profile fields, consent records, chat state, payment status, reports, and safety/abuse events. We do not permit or store media sharing through this bot. Chat messages are relayed through Telegram and may be processed by Telegram under its own policies.

<b>3. Why we process it</b>
To create and operate your account, enforce the 18+ requirement, match available users, process Telegram Stars access, warn about scams, handle reports, protect users, and respond to lawful requests.

<b>4. Sharing and retention</b>
We do not sell personal data. Data may be shared with Telegram as needed to operate the bot, with service providers that host the bot/database, or with authorities where legally required. We retain account, consent, payment, and safety records only as long as reasonably necessary for operation, safety, disputes, legal obligations, or fraud prevention.

<b>5. Your choices</b>
You can ask to view or delete your account with /profile or /deleteaccount. Deletion may not remove records required for safety, fraud prevention, disputes, or legal compliance. You can report a user at any time with /report while chatting.

<b>6. Security and limits</b>
We use reasonable safeguards, but no online service is risk-free. Do not send sensitive information. The operator is not responsible for information you voluntarily disclose to another user or for conduct outside the bot.

<b>7. India-focused compliance</b>
This notice is intended to support an India-focused service and should be reviewed by qualified counsel against applicable requirements, including the Digital Personal Data Protection Act, 2023 and other applicable law. Contact the operator through the admin listed in the bot for privacy requests or safety concerns.`;

async function sendCompliance(chatId: number) {
  await bot.sendMessage(chatId, DISCLAIMER, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: "I am 18+ and agree", callback_data: "accept_policy" }],
        [{ text: "I do not agree", callback_data: "decline_policy" }],
        [{ text: "Privacy Policy", callback_data: "show_privacy" }],
      ],
    },
  });
}

async function sendPolicyReminder(chatId: number) {
  await bot.sendMessage(chatId,
    "🛡️ <b>Safety reminder</b>\n\nNever share personal details, money, OTPs, photos, or move chats to Instagram, Signal, WhatsApp, or private DMs. Use /privacy and /disclaimer anytime to read the full notices.",
    { parse_mode: "HTML", disable_web_page_preview: true },
  );
}

async function sendScamWarning(senderId: number, recipientId?: number, originalText?: string) {
  const warning = "⚠️ Contact info detected. Don’t share personal photos or contact details. Share at your own risk.";
  await bot.sendMessage(senderId, warning).catch(() => {});
  if (recipientId) await bot.sendMessage(recipientId, warning).catch(() => {});
}

async function sendMediaBlocked(chatId: number) {
  await bot.sendMessage(chatId, `🛡️ <b>Media sharing blocked</b>\n\nPhotos, videos, files, voice notes, contacts, and locations are not allowed. This rule exists for girls' safety and to reduce fake-photo, morphing, harassment, and extortion risks. Please use text only.`, { parse_mode: "HTML" });
}

async function sendPremium(chatId: number) {
  await bot.sendMessage(chatId, `⭐ <b>Paid access required</b>\n\nComplete a Telegram Stars purchase to unlock anonymous human matching. Payment does not guarantee a specific gender, person, response, or outcome.`, { parse_mode: "HTML" });
  for (const [key, plan] of Object.entries(PREMIUM_PLANS) as [PremiumPlanKey, (typeof PREMIUM_PLANS)[PremiumPlanKey]][]) {
    await bot.sendInvoice(chatId, plan.label, `Anonymous dating-chat access: ${plan.label}.`, `access:${key}`, "", "XTR", [{ label: plan.label, amount: plan.stars }], {
      reply_markup: { inline_keyboard: [[{ text: `Pay ${plan.stars} ⭐`, pay: true }]] },
    });
  }
}

function planExpiry(plan: PremiumPlanKey): Date | null {
  if (plan === "lifetime") return null;
  const date = new Date();
  date.setDate(date.getDate() + PREMIUM_PLANS[plan].days!);
  return date;
}

async function activatePremium(userId: number, plan: PremiumPlanKey) {
  const expiry = planExpiry(plan);
  await db.update(usersTable).set({ hasPaid: true, premiumPlan: plan, premiumExpiresAt: expiry, updatedAt: new Date() }).where(eq(usersTable.id, userId));
  return expiry;
}

async function disconnect(userId: number, reason: string) {
  const user = await getUser(userId);
  if (!user) return;
  const partnerId = user.chattingWith;
  logger.info({ userId, partnerId: partnerId || null, reason }, "Chat ended");
  await db.update(usersTable).set({ state: "idle", chattingWith: null, updatedAt: new Date() }).where(eq(usersTable.id, userId));
  if (partnerId && partnerId !== 0) {
    await db.update(usersTable).set({ state: "idle", chattingWith: null, updatedAt: new Date() }).where(and(eq(usersTable.id, partnerId), eq(usersTable.chattingWith, userId)));
    await sendMain(partnerId, await getUser(partnerId), `The anonymous chat ended. ${reason}`).catch(() => {});
  }
  await sendMain(userId, await getUser(userId), reason).catch(() => {});
}

async function findMatch(userId: number, chatId: number, desiredGender?: "male" | "female") {
  const isAdmin = userId === ADMIN_ID;
  logger.info({ userId, desiredGender: desiredGender || "compatible" }, "Match requested");
  await schemaReady;
  await upsertUser(userId, { isActive: true });
  const user = await getUser(userId);
  if (!user) { await bot.sendMessage(chatId, "Please use /start first."); return; }
  if (!isAdmin && (!user.isProfileComplete || !user.termsAccepted || !user.ageVerified)) {
    await sendCompliance(chatId);
    return;
  }
  if (!isAdmin && !isPaidAndActive(user)) {
    await sendPremium(chatId);
    return;
  }

  let partnerId: number | null = null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Release abandoned or half-created chats so the queue cannot fill with stuck users.
    await client.query("UPDATE users SET state = 'idle', chatting_with = NULL, updated_at = NOW() WHERE state = 'chatting' AND (chatting_with IS NULL OR chatting_with = 0 OR last_seen_at < NOW() - INTERVAL '10 minutes')");
    const params: unknown[] = [userId];
    const filters = [
      "u.id <> $1", "u.is_profile_complete = TRUE", "u.is_active = TRUE",
      "u.is_banned = FALSE", "u.terms_accepted = TRUE", "u.age_verified = TRUE",
      "u.state = 'idle'", "u.gender IS NOT NULL",
      `u.last_seen_at >= NOW() - INTERVAL '${MATCH_ACTIVE_WINDOW_MINUTES} minutes'`,
      `NOT EXISTS (
        SELECT 1 FROM match_history mh
        WHERE mh.user_a = LEAST(u.id, $1)
          AND mh.user_b = GREATEST(u.id, $1)
      )`,
    ];
    if (!isAdmin) {
      filters.push("(u.gender = 'female' OR (u.has_paid = TRUE AND (u.premium_plan = 'lifetime' OR u.premium_expires_at > NOW())))");
      if (desiredGender) { params.push(desiredGender); filters.push(`u.gender = $${params.length}`); }
      if (user.gender === "female") filters.push("u.gender = 'male'");
      if (user.gender === "male") filters.push("(u.gender = 'male' OR (u.gender = 'female' AND (u.looking_for IS NULL OR u.looking_for IN ('any', 'male'))))");
    } else if (desiredGender) {
      params.push(desiredGender); filters.push(`u.gender = $${params.length}`);
    }
    const result = await client.query(
      `SELECT u.id FROM users u WHERE ${filters.join(" AND ")} ORDER BY (u.last_seen_at >= NOW() - INTERVAL '2 minutes') DESC, (u.last_seen_at >= NOW() - INTERVAL '24 hours') DESC, u.last_seen_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      params,
    );
    const candidateId = result.rows[0] ? Number(result.rows[0].id) : null;
    if (candidateId) {
      const claimed = await client.query(
        "UPDATE users SET state = 'chatting', chatting_with = $2, updated_at = NOW() WHERE id = $1 AND state = 'idle' RETURNING id",
        [userId, candidateId],
      );
      const claimedPartner = await client.query(
        "UPDATE users SET state = 'chatting', chatting_with = $2, updated_at = NOW() WHERE id = $1 AND state = 'idle' RETURNING id",
        [candidateId, userId],
      );
      if (claimed.rowCount && claimedPartner.rowCount) {
        partnerId = candidateId;
        await client.query(
          "INSERT INTO match_history (user_a, user_b) VALUES ($1, $2) ON CONFLICT (user_a, user_b) DO NOTHING",
          [Math.min(userId, candidateId), Math.max(userId, candidateId)],
        );
        await client.query(
          "UPDATE users SET chat_count = chat_count + 1, updated_at = NOW() WHERE id IN ($1, $2)",
          [userId, candidateId],
        );
      }
      else {
        await client.query("UPDATE users SET state = 'idle', chatting_with = NULL, updated_at = NOW() WHERE id = $1 AND chatting_with = $2", [userId, candidateId]);
        await client.query("UPDATE users SET state = 'idle', chatting_with = NULL, updated_at = NOW() WHERE id = $1 AND chatting_with = $2", [candidateId, userId]);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error({ err, userId }, "Match lookup failed");
    await bot.sendMessage(chatId, "Match service is busy right now. Please tap Find a Match again.", { reply_markup: mainKeyboard(user) });
    return;
  } finally {
    client.release();
  }
  if (!partnerId) {
    logger.info({ userId, desiredGender: desiredGender || "compatible" }, "No match available");
    await bot.sendMessage(chatId, "💭 No match is free right now. Try again in a moment — new people are joining. 😊", { reply_markup: mainKeyboard(user) });
    return;
  }
  logger.info({ userId, partnerId, desiredGender: desiredGender || "compatible" }, "Match established");
  const chatKeyboard = {
    keyboard: [[{ text: BUTTONS.stop }, { text: BUTTONS.report }]],
    resize_keyboard: true,
    input_field_placeholder: "Type a message or tap End Chat",
  };
  const partner = await getUser(partnerId);
  const myName = displayName(user);
  const partnerName = displayName(partner);
  await Promise.all([
    bot.sendMessage(chatId, `💘 Connected with <b>${escHtml(partnerName)}</b>! Say hello and keep it respectful — text only. 😊`, { parse_mode: "HTML", reply_markup: chatKeyboard }),
    bot.sendMessage(partnerId, `💘 Connected with <b>${escHtml(myName)}</b>! Say hello and keep it respectful — text only. 😊`, { parse_mode: "HTML", reply_markup: chatKeyboard }),
  ]);
}
async function reportUser(reporterId: number, reportedId: number, reason = "User report") {
  if (!reportedId || reporterId === reportedId) return 0;
  const result = await pool.query(
    `INSERT INTO user_reports (reporter_id, reported_id, reason) VALUES ($1, $2, $3) ON CONFLICT (reporter_id, reported_id) DO NOTHING RETURNING id`,
    [reporterId, reportedId, reason.slice(0, 500)],
  );
  const countResult = await pool.query("SELECT COUNT(*)::int AS count FROM user_reports WHERE reported_id = $1", [reportedId]);
  const count = Number(countResult.rows[0]?.count ?? 0);
  // Reports are stored for admin review through /stats and database tools,
  // but individual reports are not pushed to the admin chat.
  return count;
}

async function startProfile(chatId: number, id: number) {
  await upsertUser(id, { state: "setup_name", isActive: true });
  await bot.sendMessage(chatId, "👋 Welcome! Let’s create your anonymous chatting profile.\n\n✨ What’s your name?\n(Use a first name or nickname — never share your surname or contact details.)");
}

async function deleteAccount(chatId: number, id: number) {
  const user = await getUser(id);
  const partnerId = user?.chattingWith;
  if (partnerId && partnerId !== 0) {
    await db.update(usersTable).set({ state: "idle", chattingWith: null, updatedAt: new Date() }).where(and(eq(usersTable.id, partnerId), eq(usersTable.chattingWith, id)));
    await sendMain(partnerId, await getUser(partnerId), "The other user deleted their account. The chat has ended.").catch(() => {});
  }
  await db.delete(usersTable).where(eq(usersTable.id, id));
  editField.delete(id);
  await bot.sendMessage(chatId, "✅ Your account has been deleted. Active profile data was removed. Safety, fraud-prevention, payment, and legal records may be retained where required. Use /start to create a new account.");
}

bot.onText(/^\/start(?:\s+.*)?$/i, async (msg) => {
  const id = msg.from?.id;
  if (!id) return;
  if (await isBanned(id) && id !== ADMIN_ID) { await bot.sendMessage(msg.chat.id, "This account is not allowed to use the bot."); return; }
  const user = await upsertUser(id, { telegramUsername: msg.from?.username ?? null, firstName: msg.from?.first_name ?? null, isActive: true });
  if (!user?.termsAccepted || !user.ageVerified || !user.privacyAccepted || user.complianceVersion !== POLICY_VERSION) {
    await sendCompliance(msg.chat.id);
    return;
  }
  await sendPolicyReminder(msg.chat.id);
  if (!user.isProfileComplete) await startProfile(msg.chat.id, id);
  else await sendMain(msg.chat.id, user, "Safety reminder: never move chats to Instagram or personal DMs. Use text only and report suspicious users.");
});

bot.onText(/^\/(?:disclaimer|terms)$/i, (msg) => bot.sendMessage(msg.chat.id, DISCLAIMER, { parse_mode: "HTML" }));
bot.onText(/^\/privacy$/i, (msg) => bot.sendMessage(msg.chat.id, PRIVACY, { parse_mode: "HTML" }));
bot.onText(/^\/help$/i, (msg) => bot.sendMessage(msg.chat.id, "Commands:\n/start — consent and profile\n/profile — view your profile\n/match — find anonymous human text chat\n/premium — male paid access\n/report — report your current chat partner\n/stop — end chat\n/privacy — privacy policy\n/disclaimer — terms and safety disclaimer\n/deleteaccount — delete active account data"));

async function showEditMenu(chatId: number) {
  await bot.sendMessage(chatId, "✏️ <b>Edit Profile</b>\n\nYou can update your name, age, bio, or country. Gender is permanently locked for safety and cannot be edited.", {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: "📝 Change Name", callback_data: "edit_name" }, { text: "🎂 Change Age", callback_data: "edit_age" }],
      [{ text: "📖 Change Bio", callback_data: "edit_bio" }, { text: "🌍 Change Country", callback_data: "edit_country" }],
      [{ text: "🔒 Gender (locked)", callback_data: "edit_gender_locked" }],
    ] },
  });
}

bot.onText(/^\/edit$/i, async (msg) => {
  if (msg.from?.id) await showEditMenu(msg.chat.id);
});

bot.onText(/^\/deleteaccount$/i, async (msg) => {
  if (!msg.from?.id) return;
  await bot.sendMessage(msg.chat.id, "⚠️ <b>Delete your account?</b>\n\nYour active profile will be removed and any current chat will end. This cannot be undone.", {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "✅ Yes, delete my account", callback_data: "delete_account_confirm" }], [{ text: "↩️ Keep my account", callback_data: "delete_account_cancel" }]] },
  });
});

bot.onText(/^\/profile$/i, async (msg) => {
  const id = msg.from?.id; if (!id) return;
  const user = await getUser(id);
  if (!user) { await bot.sendMessage(msg.chat.id, "Use /start first."); return; }
  await bot.sendMessage(msg.chat.id, `<b>Your profile</b>\nName: ${escHtml(user.name)}\nAge: ${escHtml(user.age)}\nGender: ${escHtml(user.gender)} (locked after signup)\nStatus: ${user.gender === "female" ? "Free access" : isPaidAndActive(user) ? `Paid access: ${escHtml(user.premiumPlan)}` : "Payment required"}\n\nGender cannot be changed after your account is created.`, { parse_mode: "HTML" });
});

bot.onText(/^\/(?:match|find)$/i, async (msg) => {
  if (msg.from?.id) await findMatch(msg.from.id, msg.chat.id);
});
bot.onText(/^\/premium$/i, async (msg) => {
  if (msg.from?.id) await sendPremium(msg.chat.id);
});
bot.onText(/^\/stop$/i, async (msg) => {
  if (msg.from?.id) await disconnect(msg.from.id, "The anonymous chat ended.");
});
bot.onText(/^\/(?:end|endchat|end_chat)$/i, async (msg) => {
  if (msg.from?.id) await disconnect(msg.from.id, "The anonymous chat ended.");
});
bot.onText(/^\/report(?:\s+(.+))?$/i, async (msg, match) => {
  const id = msg.from?.id; if (!id) return;
  const user = await getUser(id);
  if (!user?.chattingWith) { await bot.sendMessage(msg.chat.id, "You are not currently chatting. Reports can be made while connected."); return; }
  const count = await reportUser(id, user.chattingWith, match?.[1] || "Reported from chat");
  await bot.sendMessage(msg.chat.id, `🚩 Report received. The other user will not be told who reported them. Current report count against this account: ${count}. The chat is being ended for safety.`);
  await disconnect(id, "The chat ended after your report. Please do not share personal information.");
});
bot.on("callback_query", async (query) => {
  const id = query.from?.id;
  const chatId = query.message?.chat.id;
  const data = query.data || "";
  if (!id || !chatId) return;
  await bot.answerCallbackQuery(query.id).catch(() => {});
  if (data === "show_privacy") { await bot.sendMessage(chatId, PRIVACY, { parse_mode: "HTML" }); return; }
  if (data === "end_chat") { await disconnect(id, "The anonymous chat ended."); return; }
  if (data === "delete_account_cancel") { await bot.sendMessage(chatId, "Cancelled — your account is safe. 😊"); return; }
  if (data === "delete_account_confirm") { await deleteAccount(chatId, id); return; }
  if (data === "edit_gender_locked") { await bot.sendMessage(chatId, "🔒 Gender is locked permanently after signup and cannot be edited."); return; }
  if (["name", "age", "bio", "country"].some((field) => data === "edit_" + field)) {
    const field = data.replace("edit_", "") as "name" | "age" | "bio" | "country";
    editField.set(id, field);
    await bot.sendMessage(chatId, field === "name" ? "📝 Type your new display name:" : field === "age" ? "🎂 Type your new age (18+):" : field === "bio" ? "📖 Type your new short bio:" : "🌍 Type your country:");
    return;
  }
  if (data === "decline_policy") { await bot.sendMessage(chatId, "You cannot use this bot without agreeing to the 18+ requirement, terms, and Privacy Policy. You may return with /start later."); return; }
  if (data === "accept_policy") {
    await upsertUser(id, { termsAccepted: true, privacyAccepted: true, ageVerified: true, termsAcceptedAt: new Date(), complianceVersion: POLICY_VERSION });
    const user = await getUser(id);
    if (!user?.isProfileComplete) await startProfile(chatId, id);
    else await sendMain(chatId, user, "Consent saved. Safety reminder: never share personal details or move to Instagram/personal DMs.");
    return;
  }
  if (data.startsWith("report_user:")) {
    const reportedId = Number(data.split(":")[1]);
    const count = await reportUser(id, reportedId, "Reported with safety button");
    await bot.sendMessage(chatId, `🚩 Report received (${count} total reports against this account). The chat will end now.`);
    await disconnect(id, "The chat ended after your report.");
  }
});

bot.on("pre_checkout_query", async (query) => {
  const validAccess = /^access:(twoweek|month|lifetime)$/.test(query.invoice_payload);
  const validOffer = query.invoice_payload === "offer:lifetime48" && Boolean(activeOfferExpiresAt && activeOfferExpiresAt > new Date());
  const valid = query.currency === "XTR" && (validAccess || validOffer);
  await bot.answerPreCheckoutQuery(query.id, valid, valid ? undefined : { error_message: "This payment is invalid or expired." }).catch((err) => logger.warn({ err }, "Pre-checkout response failed"));
});

bot.on("message", async (msg) => {
  if (!msg.successful_payment) return;
  const id = msg.from?.id;
  const payment = msg.successful_payment;
  if (!id || !payment || payment.currency !== "XTR") return;
  const plan = payment.invoice_payload.match(/^access:(twoweek|month|lifetime)$/)?.[1] as PremiumPlanKey | undefined;
  const isOffer = payment.invoice_payload === "offer:lifetime48" && Boolean(activeOfferExpiresAt && activeOfferExpiresAt > new Date());
  const expectedStars = isOffer ? 250 : plan ? PREMIUM_PLANS[plan].stars : -1;
  if ((!plan && !isOffer) || payment.total_amount !== expectedStars) {
    logger.warn({ userId: id, payload: payment.invoice_payload, amount: payment.total_amount }, "Invalid Telegram Stars payment payload");
    return;
  }
  const paymentRecorded = await pool.query(
    "INSERT INTO premium_payments (telegram_charge_id, user_id, invoice_payload, amount) VALUES ($1, $2, $3, $4) ON CONFLICT (telegram_charge_id) DO NOTHING RETURNING telegram_charge_id",
    [payment.telegram_payment_charge_id, id, payment.invoice_payload, payment.total_amount],
  );
  if (!paymentRecorded.rowCount) {
    logger.info({ userId: id }, "Duplicate Telegram payment ignored");
    return;
  }
  logger.info({ userId: id, payload: payment.invoice_payload, amount: payment.total_amount }, "Telegram Stars payment recorded");
  const activatedPlan = isOffer ? "lifetime" : plan!;
  const expiry = await activatePremium(id, activatedPlan);
  const planLabel = isOffer ? "Lifetime Offer" : PREMIUM_PLANS[activatedPlan].label;
  await sendAdmin(`💰 <b>Premium purchase received</b>\nUser: <code>${id}</code>\nPlan: <b>${escHtml(planLabel)}</b>\nAmount: <b>${payment.total_amount} ⭐</b>`);
  await bot.sendMessage(msg.chat.id, `✅ Paid access activated. Plan: ${escHtml(planLabel)}. ${expiry ? `Expires: ${expiry.toDateString()}` : "Lifetime access."}\n\nYou can now start matching. ⭐`);
  logger.info({ userId: id, plan: activatedPlan, expiresAt: expiry }, "Premium access activated");
  const user = await getUser(id); if (user) await sendMain(msg.chat.id, user);
});

bot.on("message", async (msg) => {
  const id = msg.from?.id;
  if (!id || msg.text?.startsWith("/") || msg.successful_payment) return;
  if (await isBanned(id) && id !== ADMIN_ID) { await bot.sendMessage(msg.chat.id, "This account is not allowed to use the bot."); return; }
  const user = await getUser(id);
  if (!user) { await bot.sendMessage(msg.chat.id, "Use /start first."); return; }
  await upsertUser(id, { telegramUsername: msg.from?.username ?? null, firstName: msg.from?.first_name ?? null, isActive: true });

  if (isMediaMessage(msg)) { await sendMediaBlocked(msg.chat.id); return; }
  const text = (msg.text || "").trim();
  const pendingEdit = editField.get(id);
  if (pendingEdit) {
    if (pendingEdit === "name") {
      if (text.length < 2 || text.length > 40 || !/^[\p{L}\s'_-]+$/u.test(text)) { await bot.sendMessage(msg.chat.id, "Please enter a display name using 2–40 letters."); return; }
      await upsertUser(id, { name: text, state: "idle" });
    } else if (pendingEdit === "age") {
      const age = Number(text);
      if (!Number.isInteger(age) || age < 18 || age > 120) { await bot.sendMessage(msg.chat.id, "Please enter a valid age from 18 to 120."); return; }
      await upsertUser(id, { age, state: "idle", ageVerified: true });
    } else if (pendingEdit === "bio") {
      if (text.length > 300) { await bot.sendMessage(msg.chat.id, "Your bio must be 300 characters or fewer."); return; }
      await upsertUser(id, { bio: text, state: "idle" });
    } else {
      if (text.length < 2 || text.length > 100) { await bot.sendMessage(msg.chat.id, "Please enter a country name."); return; }
      await upsertUser(id, { country: text, state: "idle" });
    }
    editField.delete(id);
    const refreshed = await getUser(id);
    if (refreshed) await sendMain(msg.chat.id, refreshed, "✅ Profile updated successfully! 😊");
    return;
  }

  if (user.state === "setup_name") {
    if (text.length < 2 || text.length > 40 || !/^[\p{L}\s'_-]+$/u.test(text)) { await bot.sendMessage(msg.chat.id, "Please enter a display name using 2–40 letters. Do not use a surname or contact details."); return; }
    await upsertUser(id, { name: text, state: "setup_age" });
    await bot.sendMessage(msg.chat.id, "🎂 Nice to meet you! How old are you?\n\n🔞 Enter your age — you must be 18 or older."); return;
  }
  if (user.state === "setup_age") {
    const age = Number(text);
    if (!Number.isInteger(age) || age < 18 || age > 120) { await bot.sendMessage(msg.chat.id, "Only adults aged 18 or older may use this bot. Enter a valid age."); return; }
    await upsertUser(id, { age, ageVerified: true, state: "setup_gender" });
    await bot.sendMessage(msg.chat.id, "💫 What’s your gender?\n\n🔒 This choice is locked after signup.", { reply_markup: { keyboard: [[{ text: "👨 Male" }, { text: "👩 Female" }]], resize_keyboard: true, one_time_keyboard: true } }); return;
  }
  if (user.state === "setup_gender") {
    const genderText = text.toLowerCase().replace(/^[^a-z]+/, "").trim();
    const gender = genderText === "male" ? "male" : genderText === "female" ? "female" : null;
    if (!gender) { await bot.sendMessage(msg.chat.id, "Please choose Male or Female. Gender cannot be changed after your account is created."); return; }
    const lookingFor = gender === "female" ? "male" : "female";
    await upsertUser(id, { gender, genderLocked: true, lookingFor, isProfileComplete: true, state: "idle" });
    const updated = await getUser(id);
    if (updated) {
      await notifyFemaleJoin(updated);
      const welcome = gender === "female"
        ? "🎉 Profile ready! Female access is free, and you’ll be connected with male users only. Stay safe 💛"
        : "🎉 Buy Premium and start matching with your loved ones! ⭐";
      await sendMain(msg.chat.id, updated, welcome);
      if (gender === "male" && id !== ADMIN_ID) await sendPremium(msg.chat.id);
    }
    return;
  }
  if (!user.termsAccepted || !user.ageVerified || !user.privacyAccepted) { await sendCompliance(msg.chat.id); return; }
  if (user.state === "chatting") {
    const action = normalizeAction(text);
    if (action === "end chat" || action === "stop" || action === "end" || action === "end conversation") {
      await disconnect(id, "The anonymous chat ended.");
      return;
    }
    if (action === "report user" || action === "report" || action === "report chat") {
      const partner = user.chattingWith;
      if (partner) {
        await reportUser(id, partner, "Reported with chat button");
        await bot.sendMessage(msg.chat.id, "🚩 Report received. The chat is ending for safety.");
        await disconnect(id, "The chat ended after your report.");
      }
      return;
    }
    if (isScamContactRequest(text)) { await sendScamWarning(id, user.chattingWith || undefined, text); }
    const recipientId = user.chattingWith;
    if (!recipientId || recipientId === 0) { await disconnect(id, "The chat ended because the partner is no longer available."); return; }
    const recipient = await getUser(recipientId);
    if (!recipient || recipient.state !== "chatting" || recipient.chattingWith !== id) { await disconnect(id, "The chat ended because the partner is no longer available."); return; }
    await bot.sendMessage(recipientId, `💬 <b>${escHtml(displayName(user))}</b>\n${escHtml(text)}`, { parse_mode: "HTML" });
    logger.info({ userId: id, recipientId, messageLength: text.length }, "Chat message relayed");
    return;
  }
  const action = normalizeAction(text);
  if (action === "edit profile") { await showEditMenu(msg.chat.id); return; }
  if (action === "delete account") { await bot.sendMessage(msg.chat.id, "⚠️ Delete your account? Use the confirmation below.", { reply_markup: { inline_keyboard: [[{ text: "✅ Yes, delete my account", callback_data: "delete_account_confirm" }], [{ text: "↩️ Keep my account", callback_data: "delete_account_cancel" }]] } }); return; }
  if (action === "match female" && id === ADMIN_ID) { await findMatch(id, msg.chat.id, "female"); return; }
  if (action === "match male" && id === ADMIN_ID) { await findMatch(id, msg.chat.id, "male"); return; }
  if (action === "admin panel" && id === ADMIN_ID) { await bot.sendMessage(msg.chat.id, "🛠️ <b>Admin controls</b>\n\n/ban ID reason\n/unban ID\n/grantlifetime ID\n/stats\n\nYou can match female or male users with the admin buttons above.", { parse_mode: "HTML", reply_markup: mainKeyboard(user) }); return; }
  if (action === "find a match" || action === "find match" || action === "match") { await findMatch(id, msg.chat.id); return; }
  if (action === "unlock premium") { await sendPremium(msg.chat.id); return; }
  if (action === "my profile") { await bot.sendMessage(msg.chat.id, "Use /profile to view your profile. Gender cannot be changed after signup."); return; }
  if (action === "help") { return; }
  if (action === "create profile") { await startProfile(msg.chat.id, id); return; }
  await sendMain(msg.chat.id, user, "Use the menu buttons to find a match, edit your profile, or manage your account.");
});

bot.onText(/^\/broadcastoffer$/i, async (msg) => {
  if (!ADMIN_ID || msg.from?.id !== ADMIN_ID) return;
  activeOfferExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const activeSince = new Date(Date.now() - ONLINE_WINDOW_MS);
  const activeUsers = await db.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.isActive, true), eq(usersTable.isBanned, false), gte(usersTable.lastSeenAt, activeSince)));
  let sent = 0;
  for (const target of activeUsers) {
    if (target.id === ADMIN_ID) continue;
    try {
      await bot.sendMessage(target.id, "🔥 Limited-time offer! Get Lifetime Premium for only 250 ⭐ — valid for 48 hours.");
      await bot.sendInvoice(target.id, "Lifetime Premium — Special Offer", "Lifetime access for 250 Stars. Offer valid for 48 hours.", "offer:lifetime48", "", "XTR", [{ label: "Lifetime Premium Offer", amount: 250 }], { reply_markup: { inline_keyboard: [[{ text: "Get Lifetime for 250 ⭐", pay: true }]] } });
      sent++;
    } catch { /* blocked users and unavailable chats are skipped */ }
  }
  await bot.sendMessage(msg.chat.id, `✅ Offer sent to ${sent} active users. Valid for 48 hours.`);
});

bot.onText(/^\/stats$/i, async (msg) => {
  if (!ADMIN_ID || msg.from?.id !== ADMIN_ID) return;
  const users = await db.select().from(usersTable);
  await bot.sendMessage(msg.chat.id, `Users: ${users.length}\nFemale: ${users.filter((u: any) => u.gender === "female").length}\nMale: ${users.filter((u: any) => u.gender === "male").length}\nPaid: ${users.filter((u: any) => isPaidAndActive(u)).length}\nActive chats: ${users.filter((u: any) => u.state === "chatting").length}`);
});

bot.onText(/^\/ban\s+(\d+)\s*(.*)$/i, async (msg, match) => {
  if (!ADMIN_ID || msg.from?.id !== ADMIN_ID) return;
  const targetId = Number(match?.[1]); const reason = match?.[2] || "Safety violation";
  await db.insert(bannedUsersTable).values({ id: targetId, bannedBy: ADMIN_ID, reason }).onConflictDoNothing();
  await db.update(usersTable).set({ isBanned: true, isActive: false, state: "idle", chattingWith: null }).where(eq(usersTable.id, targetId));
  await bot.sendMessage(msg.chat.id, `Banned <code>${targetId}</code>.`, { parse_mode: "HTML" });
  await bot.sendMessage(targetId, "Your account has been suspended for a safety violation.").catch(() => {});
});

bot.onText(/^\/unban\s+(\d+)$/i, async (msg, match) => {
  if (!ADMIN_ID || msg.from?.id !== ADMIN_ID) return;
  const targetId = Number(match?.[1]);
  await db.delete(bannedUsersTable).where(eq(bannedUsersTable.id, targetId));
  await db.update(usersTable).set({ isBanned: false, isActive: true, updatedAt: new Date() }).where(eq(usersTable.id, targetId));
  await bot.sendMessage(msg.chat.id, `✅ Unbanned <code>${targetId}</code>.`, { parse_mode: "HTML" });
  await bot.sendMessage(targetId, "✅ Your account has been restored. Use /start to continue.").catch(() => {});
});

bot.onText(/^\/grantlifetime\s+(\d+)$/i, async (msg, match) => {
  if (!ADMIN_ID || msg.from?.id !== ADMIN_ID) return;
  const targetId = Number(match?.[1]);
  await activatePremium(targetId, "lifetime");
  await bot.sendMessage(msg.chat.id, `👑 Lifetime Paid Access granted to <code>${targetId}</code>.`, { parse_mode: "HTML" });
  await bot.sendMessage(targetId, "👑 An admin granted you Lifetime Paid Access. You can now find anonymous matches.").catch(() => {});
});

bot.on("polling_error", (err: Error & { code?: string }) => {
  if (err.code === "ETELEGRAM" && err.message?.includes("409")) return;
  logger.error({ err }, "Telegram polling error");
});
bot.on("error", (err: Error) => {
  logger.error({ err }, "Telegram bot error");
});

const pollingEnabled = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.BOT_POLLING_ENABLED === "true");
if (pollingEnabled) {
  void (async () => {
    for (let i = 0; i < 2; i++) {
      try { await bot.getUpdates({ offset: -1, timeout: 0, limit: 1 }); } catch { /* stale session cleanup is best effort */ }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    await bot.startPolling({ restart: false });
    logger.info("Telegram bot polling started");
  })();
} else {
  logger.warn("Telegram bot polling disabled; set BOT_POLLING_ENABLED=true in the runtime to enable it");
}
