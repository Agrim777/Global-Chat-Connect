import TelegramBot from "node-telegram-bot-api";
import { db, pool, usersTable, bannedUsersTable } from "@workspace/db";
import { and, eq, ne } from "drizzle-orm";
import { logger } from "../lib/logger";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? "0");
const POLICY_VERSION = "2026-08-08";
const MAX_REPORTS_BEFORE_ALERT = 3;
const ONLINE_WINDOW_MS = 2 * 60 * 1000; // users seen in the last two minutes are considered online
const bot = new TelegramBot(TOKEN, { polling: false });
export { bot };

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
  help: "🛡️ Safety Help",
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
  `);
  logger.info("Safety schema ensured");
}
void ensureSchema().catch((err) => logger.error({ err }, "Safety schema migration failed"));

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
  const rows: TelegramBot.KeyboardButton[][] = [[{ text: BUTTONS.match }], [{ text: BUTTONS.profile }, { text: BUTTONS.help }]];
  if (user.gender !== "female" && !isPaidAndActive(user)) rows.push([{ text: BUTTONS.premium }]);
  return { keyboard: rows, resize_keyboard: true };
}

async function sendMain(chatId: number, user: any, text?: string) {
  await bot.sendMessage(chatId, text || `Welcome, ${displayName(user)}. This is an anonymous text-chat service between human users.`, { reply_markup: mainKeyboard(user) });
}

const DISCLAIMER = `
<b>IMPORTANT: READ BEFORE USING</b>

This bot is an anonymous text-chat service for adults. It is <b>not a dating bot</b>, does not arrange dates or relationships, and does not guarantee any specific gender match. Gender is self-declared and may be inaccurate.

<b>18+ only</b>
You must be at least 18 years old. No minors are allowed. Do not use this service if you are under 18. We may suspend accounts and report unlawful conduct where required.

<b>Safety and scam warning</b>
Never share Instagram, Telegram handles, phone numbers, OTPs, passwords, payment details, address, workplace, private photos, or other personal information. A scammer may claim to be a girl, ask you to move to Instagram/DM, and use manipulated or morphed images to harass or extort people. Treat every gender claim and every request to move off-platform as unverified. The bot blocks media and suspicious social-contact requests for safety.

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
To create and operate your account, enforce the 18+ requirement, match available users, process Telegram Stars access, prevent abuse and scams, handle reports, protect users, and respond to lawful requests.

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
  await bot.sendMessage(chatId, "🛡️ <b>Safety & privacy reminder</b>", { parse_mode: "HTML" });
  await bot.sendMessage(chatId, DISCLAIMER, { parse_mode: "HTML", disable_web_page_preview: true });
  await bot.sendMessage(chatId, PRIVACY, { parse_mode: "HTML", disable_web_page_preview: true });
}

async function sendScamWarning(senderId: number, recipientId?: number, originalText?: string) {
  const warning = `🚨 <b>SAFETY ALERT — MESSAGE BLOCKED</b>\n\nMoving to Instagram, Signal, WhatsApp, Snapchat, personal Telegram DMs, or any other app can expose you to scams, fake identities, harassment, or extortion. Never share photos, OTPs, money, passwords, phone numbers, usernames, or location.\n\nThe same warning was sent to both people for protection. Report and end the chat if anyone pressures you.\n\nThis bot does not verify identity or gender.`;
  await bot.sendMessage(senderId, warning, { parse_mode: "HTML" }).catch(() => {});
  if (recipientId) await bot.sendMessage(recipientId, warning, { parse_mode: "HTML" }).catch(() => {});
  await sendAdmin(`⚠️ <b>Social-contact request blocked</b>\nSender: <code>${senderId}</code>\nRecipient: <code>${recipientId ?? "—"}</code>\nText: ${escHtml((originalText || "").slice(0, 240))}`);
}

async function sendMediaBlocked(chatId: number) {
  await bot.sendMessage(chatId, `🛡️ <b>Media sharing blocked</b>\n\nPhotos, videos, files, voice notes, contacts, and locations are not allowed. This rule exists for girls' safety and to reduce fake-photo, morphing, harassment, and extortion risks. Please use text only.`, { parse_mode: "HTML" });
}

async function sendPremium(chatId: number) {
  await bot.sendMessage(chatId, `⭐ <b>Paid access for male accounts</b>\n\nFemale accounts can use anonymous text chat free. Male accounts need Telegram Stars access before they can be matched. Payment does not guarantee a specific gender, person, response, or outcome.`, { parse_mode: "HTML" });
  for (const [key, plan] of Object.entries(PREMIUM_PLANS) as [PremiumPlanKey, (typeof PREMIUM_PLANS)[PremiumPlanKey]][]) {
    await bot.sendInvoice(chatId, plan.label, `Anonymous human text-chat access: ${plan.label}.`, `access:${key}`, "", "XTR", [{ label: plan.label, amount: plan.stars }], {
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
  await db.update(usersTable).set({ state: "idle", chattingWith: null, updatedAt: new Date() }).where(eq(usersTable.id, userId));
  if (partnerId && partnerId !== 0) {
    await db.update(usersTable).set({ state: "idle", chattingWith: null, updatedAt: new Date() }).where(and(eq(usersTable.id, partnerId), eq(usersTable.chattingWith, userId)));
    await sendMain(partnerId, await getUser(partnerId), `The anonymous chat ended. ${reason}`).catch(() => {});
  }
  await sendMain(userId, await getUser(userId), reason).catch(() => {});
}

async function findMatch(userId: number, chatId: number) {
  await upsertUser(userId, { isActive: true });
  const user = await getUser(userId);
  if (!user?.isProfileComplete || !user.termsAccepted || !user.ageVerified) {
    await sendCompliance(chatId);
    return;
  }
  if (!isPaidAndActive(user)) {
    await sendPremium(chatId);
    return;
  }
  const candidates = await db.select().from(usersTable).where(and(
    eq(usersTable.isProfileComplete, true),
    eq(usersTable.isActive, true),
    eq(usersTable.termsAccepted, true),
    eq(usersTable.ageVerified, true),
    eq(usersTable.state, "idle"),
    ne(usersTable.id, userId),
  ));
  const available = candidates.filter((candidate: any) => {
    if (!isRecentlyOnline(candidate)) return false;
    if (!candidate.gender || !isPaidAndActive(candidate)) return false;
    if (candidate.lookingFor && candidate.lookingFor !== "any" && candidate.lookingFor !== user.gender) return false;
    if (user.lookingFor && user.lookingFor !== "any" && user.lookingFor !== candidate.gender) return false;
    return true;
  });
  const partner = available[0];
  if (!partner) {
    await bot.sendMessage(chatId, "No eligible anonymous chat is available right now. Please try again later. We never invent or guarantee a match.", { reply_markup: mainKeyboard(user) });
    return;
  }
  const claimed = await db.update(usersTable).set({ state: "chatting", chattingWith: partner.id, updatedAt: new Date() }).where(and(eq(usersTable.id, userId), eq(usersTable.state, "idle"))).returning({ id: usersTable.id });
  const claimedPartner = await db.update(usersTable).set({ state: "chatting", chattingWith: userId, updatedAt: new Date() }).where(and(eq(usersTable.id, partner.id), eq(usersTable.state, "idle"))).returning({ id: usersTable.id });
  if (!claimed.length || !claimedPartner.length) {
    await db.update(usersTable).set({ state: "idle", chattingWith: null, updatedAt: new Date() }).where(and(eq(usersTable.id, userId), eq(usersTable.chattingWith, partner.id)));
    await db.update(usersTable).set({ state: "idle", chattingWith: null, updatedAt: new Date() }).where(and(eq(usersTable.id, partner.id), eq(usersTable.chattingWith, userId)));
    await bot.sendMessage(chatId, "That chat was taken just now. Please tap 💘 Find a Match again.", { reply_markup: mainKeyboard(user) });
    return;
  }
  const safety = "⚠️ Safety first: this is anonymous human text chat, not dating. Gender is not verified. Never share Instagram, personal Telegram, phone, OTPs, money, passwords, or photos. Report anything suspicious.";
  const chatKeyboard = { keyboard: [[{ text: BUTTONS.stop }, { text: BUTTONS.report }]], resize_keyboard: true };
  await bot.sendMessage(chatId, "💘 You are connected! Say hello and keep it respectful — text only. 😊", { reply_markup: chatKeyboard });
  await bot.sendMessage(chatId, safety);
  await bot.sendMessage(partner.id, "✅ Anonymous chat connected. Say hello — text only.", { reply_markup: chatKeyboard });
  await bot.sendMessage(partner.id, safety);
}

async function reportUser(reporterId: number, reportedId: number, reason = "User report") {
  if (!reportedId || reporterId === reportedId) return 0;
  const result = await pool.query(
    `INSERT INTO user_reports (reporter_id, reported_id, reason) VALUES ($1, $2, $3) ON CONFLICT (reporter_id, reported_id) DO NOTHING RETURNING id`,
    [reporterId, reportedId, reason.slice(0, 500)],
  );
  const countResult = await pool.query("SELECT COUNT(*)::int AS count FROM user_reports WHERE reported_id = $1", [reportedId]);
  const count = Number(countResult.rows[0]?.count ?? 0);
  if (result.rowCount) {
    await sendAdmin(`🚩 <b>User report received</b>\nReported: <code>${reportedId}</code>\nReporter: <code>${reporterId}</code>\nReports: <b>${count}</b>\nReason: ${escHtml(reason.slice(0, 500))}${count >= MAX_REPORTS_BEFORE_ALERT ? "\n\n🚨 Multiple reports — review and consider suspension/ban." : ""}`);
  }
  return count;
}

async function startProfile(chatId: number, id: number) {
  await upsertUser(id, { state: "setup_name", isActive: true });
  await bot.sendMessage(chatId, "Create your anonymous profile. Only your chosen display name, age, gender, and optional fields are used for matching. Do not use a real surname or share contact details.\n\nWhat name should other users see?");
}

async function deleteAccount(chatId: number, id: number) {
  const user = await getUser(id);
  if (user?.chattingWith) await disconnect(id, "Your account was deleted and the chat ended.");
  await db.delete(usersTable).where(eq(usersTable.id, id));
  await bot.sendMessage(chatId, "Your account data has been deleted from the active user table. Safety, fraud-prevention, payment, and legal records may be retained where required. Use /start to create a new account.");
}

bot.onText(/^\/start(?:\s+.*)?$/i, async (msg) => {
  const id = msg.from?.id;
  if (!id) return;
  if (await isBanned(id)) { await bot.sendMessage(msg.chat.id, "This account is not allowed to use the bot."); return; }
  const user = await upsertUser(id, { telegramUsername: msg.from?.username ?? null, firstName: msg.from?.first_name ?? null, isActive: true });
  await sendPolicyReminder(msg.chat.id);
  if (!user?.termsAccepted || !user.ageVerified || !user.privacyAccepted || user.complianceVersion !== POLICY_VERSION) {
    await sendCompliance(msg.chat.id);
    return;
  }
  if (!user.isProfileComplete) await startProfile(msg.chat.id, id);
  else await sendMain(msg.chat.id, user, "Safety reminder: never move chats to Instagram or personal DMs. Use text only and report suspicious users.");
});

bot.onText(/^\/(?:disclaimer|terms)$/i, (msg) => bot.sendMessage(msg.chat.id, DISCLAIMER, { parse_mode: "HTML" }));
bot.onText(/^\/privacy$/i, (msg) => bot.sendMessage(msg.chat.id, PRIVACY, { parse_mode: "HTML" }));
bot.onText(/^\/help$/i, (msg) => bot.sendMessage(msg.chat.id, "Commands:\n/start — consent and profile\n/profile — view your profile\n/match — find anonymous human text chat\n/premium — male paid access\n/report — report your current chat partner\n/stop — end chat\n/privacy — privacy policy\n/disclaimer — terms and safety disclaimer\n/deleteaccount — delete active account data"));

bot.onText(/^\/profile$/i, async (msg) => {
  const id = msg.from?.id; if (!id) return;
  const user = await getUser(id);
  if (!user) { await bot.sendMessage(msg.chat.id, "Use /start first."); return; }
  await bot.sendMessage(msg.chat.id, `<b>Your profile</b>\nName: ${escHtml(user.name)}\nAge: ${escHtml(user.age)}\nGender: ${escHtml(user.gender)} (locked after signup)\nStatus: ${user.gender === "female" ? "Free access" : isPaidAndActive(user) ? `Paid access: ${escHtml(user.premiumPlan)}` : "Payment required"}\n\nGender cannot be changed after profile creation.`, { parse_mode: "HTML" });
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
bot.onText(/^\/report(?:\s+(.+))?$/i, async (msg, match) => {
  const id = msg.from?.id; if (!id) return;
  const user = await getUser(id);
  if (!user?.chattingWith) { await bot.sendMessage(msg.chat.id, "You are not currently chatting. Reports can be made while connected."); return; }
  const count = await reportUser(id, user.chattingWith, match?.[1] || "Reported from chat");
  await bot.sendMessage(msg.chat.id, `🚩 Report received. The other user will not be told who reported them. Current report count against this account: ${count}. The chat is being ended for safety.`);
  await disconnect(id, "The chat ended after your report. Please do not share personal information.");
});
bot.onText(/^\/deleteaccount$/i, async (msg) => {
  if (msg.from?.id) await deleteAccount(msg.chat.id, msg.from.id);
});

bot.on("callback_query", async (query) => {
  const id = query.from?.id;
  const chatId = query.message?.chat.id;
  const data = query.data || "";
  if (!id || !chatId) return;
  await bot.answerCallbackQuery(query.id).catch(() => {});
  if (data === "show_privacy") { await bot.sendMessage(chatId, PRIVACY, { parse_mode: "HTML" }); return; }
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
  const valid = /^access:(twoweek|month|lifetime)$/.test(query.invoice_payload) && query.currency === "XTR";
  await bot.answerPreCheckoutQuery(query.id, valid, valid ? undefined : { error_message: "This payment is invalid or expired." }).catch((err) => logger.warn({ err }, "Pre-checkout response failed"));
});

bot.on("successful_payment", async (msg) => {
  const id = msg.from?.id;
  const payment = msg.successful_payment;
  if (!id || !payment || payment.currency !== "XTR") return;
  const plan = payment.invoice_payload.match(/^access:(twoweek|month|lifetime)$/)?.[1] as PremiumPlanKey | undefined;
  if (!plan || payment.total_amount !== PREMIUM_PLANS[plan].stars) {
    await sendAdmin(`⚠️ Invalid Telegram Stars payment payload from <code>${id}</code>.`);
    return;
  }
  const expiry = await activatePremium(id, plan);
  await bot.sendMessage(msg.chat.id, `✅ Paid access activated. Plan: ${PREMIUM_PLANS[plan].label}. ${expiry ? `Expires: ${expiry.toDateString()}` : "Lifetime access."}\n\nPayment does not guarantee a specific gender, person, response, or outcome. Never share personal information.`);
  const user = await getUser(id); if (user) await sendMain(msg.chat.id, user);
});

bot.on("message", async (msg) => {
  const id = msg.from?.id;
  if (!id || msg.text?.startsWith("/")) return;
  if (await isBanned(id)) { await bot.sendMessage(msg.chat.id, "This account is not allowed to use the bot."); return; }
  const user = await getUser(id);
  if (!user) { await bot.sendMessage(msg.chat.id, "Use /start first."); return; }
  await upsertUser(id, { telegramUsername: msg.from?.username ?? null, firstName: msg.from?.first_name ?? null, isActive: true });

  if (isMediaMessage(msg)) { await sendMediaBlocked(msg.chat.id); if (user.state === "chatting" && user.chattingWith) await sendAdmin(`🛡️ Media attempt blocked. Sender: <code>${id}</code>, recipient: <code>${user.chattingWith}</code>`); return; }
  const text = (msg.text || "").trim();
  if (user.state === "setup_name") {
    if (text.length < 2 || text.length > 40 || !/^[\p{L}\s'_-]+$/u.test(text)) { await bot.sendMessage(msg.chat.id, "Please enter a display name using 2–40 letters. Do not use a surname or contact details."); return; }
    await upsertUser(id, { name: text, state: "setup_age" });
    await bot.sendMessage(msg.chat.id, "How old are you? Enter a number. You must be 18 or older."); return;
  }
  if (user.state === "setup_age") {
    const age = Number(text);
    if (!Number.isInteger(age) || age < 18 || age > 120) { await bot.sendMessage(msg.chat.id, "Only adults aged 18 or older may use this bot. Enter a valid age."); return; }
    await upsertUser(id, { age, ageVerified: true, state: "setup_gender" });
    await bot.sendMessage(msg.chat.id, "Choose your gender. This choice is locked permanently after you submit it.", { reply_markup: { keyboard: [[{ text: "Male" }, { text: "Female" }]], resize_keyboard: true, one_time_keyboard: true } }); return;
  }
  if (user.state === "setup_gender") {
    const gender = text.toLowerCase() === "male" ? "male" : text.toLowerCase() === "female" ? "female" : null;
    if (!gender) { await bot.sendMessage(msg.chat.id, "Please choose Male or Female. The choice cannot be changed after signup."); return; }
    await upsertUser(id, { gender, genderLocked: true, lookingFor: "any", isProfileComplete: true, state: "idle" });
    const updated = await getUser(id);
    if (updated) { await notifyFemaleJoin(updated); await sendMain(msg.chat.id, updated, `Profile created. Gender is locked. ${gender === "female" ? "Your access is free." : "Male accounts need paid access before matching."}`); }
    return;
  }
  if (!user.termsAccepted || !user.ageVerified || !user.privacyAccepted) { await sendCompliance(msg.chat.id); return; }
  if (user.state === "chatting") {
    if (text === BUTTONS.stop) { await disconnect(id, "The anonymous chat ended."); return; }
    if (text === BUTTONS.report) { const partner = user.chattingWith; if (partner) { await reportUser(id, partner, "Reported with chat button"); await bot.sendMessage(msg.chat.id, "🚩 Report received. The chat is ending for safety."); await disconnect(id, "The chat ended after your report."); } return; }
    if (isScamContactRequest(text)) { await sendScamWarning(id, user.chattingWith || undefined, text); return; }
    const recipientId = user.chattingWith;
    if (!recipientId || recipientId === 0) { await disconnect(id, "The chat ended because the partner is no longer available."); return; }
    const recipient = await getUser(recipientId);
    if (!recipient || recipient.state !== "chatting" || recipient.chattingWith !== id || !isPaidAndActive(recipient)) { await disconnect(id, "The chat ended because the partner is no longer available."); return; }
    await bot.sendMessage(recipientId, `💬 <b>${escHtml(displayName(user))}</b>\n${escHtml(text)}`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: BUTTONS.report, callback_data: `report_user:${id}` }]] } });
    return;
  }
  if (text === BUTTONS.match) { await findMatch(id, msg.chat.id); return; }
  if (text === BUTTONS.premium) { await sendPremium(msg.chat.id); return; }
  if (text === BUTTONS.profile) { await bot.sendMessage(msg.chat.id, "Use /profile to view your profile. Gender cannot be changed after signup."); return; }
  if (text === BUTTONS.help) { await bot.sendMessage(msg.chat.id, "Safety help: never share Instagram, personal Telegram handles, phone numbers, OTPs, money, passwords, or media. Use /report or the Report User button, then /stop."); return; }
  if (text === BUTTONS.start) { await startProfile(msg.chat.id, id); return; }
  await sendMain(msg.chat.id, user, "Use the menu buttons or /help. This bot only supports anonymous text chat between adults.");
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

bot.on("polling_error", (err: Error & { code?: string }) => {
  if (err.code === "ETELEGRAM" && err.message?.includes("409")) return;
  logger.error({ err }, "Telegram polling error");
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
