import TelegramBot from "node-telegram-bot-api";
import { db, pool, usersTable } from "@workspace/db";
import { eq, and, gt, ne } from "drizzle-orm";
import { logger } from "../lib/logger";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Startup migration — creates full DB schema if missing, adds any new columns ──
(async () => {
  try {
    // Step 1: Create enums (safe to re-run — IF NOT EXISTS)
    await pool.query(`
      DO $$ BEGIN
        CREATE TYPE gender AS ENUM ('male', 'female', 'other');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN
        CREATE TYPE looking_for AS ENUM ('male', 'female', 'any');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN
        CREATE TYPE bot_state AS ENUM (
          'idle', 'setup_name', 'setup_age', 'setup_gender',
          'setup_looking_for', 'setup_bio', 'setup_country', 'chatting'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // Step 2: Create users table if it doesn't exist (full schema)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id               BIGINT PRIMARY KEY,
        telegram_username VARCHAR(100),
        first_name        VARCHAR(100),
        name              VARCHAR(100),
        age               INTEGER,
        gender            gender,
        looking_for       looking_for,
        bio               TEXT,
        country           VARCHAR(100),
        is_profile_complete BOOLEAN NOT NULL DEFAULT FALSE,
        is_active         BOOLEAN NOT NULL DEFAULT TRUE,
        has_paid          BOOLEAN NOT NULL DEFAULT FALSE,
        premium_plan      VARCHAR(20),
        premium_expires_at TIMESTAMP,
        chat_count        INTEGER NOT NULL DEFAULT 0,
        state             bot_state NOT NULL DEFAULT 'idle',
        chatting_with     BIGINT,
        referral_code     VARCHAR(20) UNIQUE,
        referred_by       BIGINT,
        referral_count    INTEGER NOT NULL DEFAULT 0,
        bonus_chats       INTEGER NOT NULL DEFAULT 0,
        created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // Step 3: Add any columns that may be missing in older deployments
    await pool.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS premium_plan      VARCHAR(20),
        ADD COLUMN IF NOT EXISTS premium_expires_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS referral_code     VARCHAR(20),
        ADD COLUMN IF NOT EXISTS referred_by       BIGINT,
        ADD COLUMN IF NOT EXISTS referral_count    INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS bonus_chats       INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS first_name        VARCHAR(100);
    `);

    logger.info("DB migration: schema fully ensured");
  } catch (err) {
    logger.error({ err }, "DB migration failed — check DB connection and permissions");
  }
})();

const GROQ_KEY = (process.env.GROQ_API_KEY ?? process.env.XAI_API_KEY ?? "").trim();
const AI_MODEL = process.env.AI_MODEL ?? "llama-3.3-70b-versatile";
if (!GROQ_KEY) console.warn("[AI] ⚠️  XAI_API_KEY is NOT set — AI chat will use fallback only!");
else console.log(`[AI] ✅ Groq configured — model: ${AI_MODEL}`);

async function groqChat(messages: { role: string; content: string }[], maxTokens = 80): Promise<string> {
  if (!GROQ_KEY) throw new Error("GROQ_API_KEY/XAI_API_KEY is not configured");
  const models = Array.from(new Set([AI_MODEL, "llama-3.1-8b-instant"]));
  let lastErr: unknown = null;
  for (const model of models) {
    const body = JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.35, top_p: 0.8 });
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_KEY}`,
        },
        body,
        signal: AbortSignal.timeout(12000),
      });
      const json = await res.json() as { choices?: { message?: { content?: string } }[]; error?: { message?: string; code?: string } };
      if (!res.ok) throw Object.assign(new Error(json.error?.message ?? `HTTP ${res.status}`), { status: res.status, code: json.error?.code, model });
      const content = json.choices?.[0]?.message?.content?.trim() ?? "";
      if (content) return content;
      throw Object.assign(new Error("Empty model response"), { model });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? "7830309025");
let broadcastLastSentAt: number | null = null; // in-memory cooldown tracker
const FAKE_CHAT_ID = 0; // sentinel: chattingWith=0 means fake chat
const FREE_CHAT_DURATION_MS = 30 * 1000;
type PremiumPlanKey = "week" | "month" | "year";
const PREMIUM_PLANS: Record<PremiumPlanKey, { label: string; stars: number; days: number }> = {
  week: { label: "2 Week Premium", stars: 150, days: 14 },
  month: { label: "1 Month Premium", stars: 250, days: 30 },
  year: { label: "Lifetime Premium", stars: 1000, days: 36500 },
};

function premiumExpiry(plan: PremiumPlanKey): Date {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + PREMIUM_PLANS[plan].days);
  return expiresAt;
}

async function activatePremium(userId: number, plan: PremiumPlanKey): Promise<Date> {
  const expiresAt = premiumExpiry(plan);
  const timer = chatTimerMap.get(userId);
  if (timer) { clearTimeout(timer); chatTimerMap.delete(userId); }
  fakePersonaMap.delete(userId);
  fakeReplySet.delete(userId);
  await db.update(usersTable)
    .set({ hasPaid: true, premiumPlan: plan, premiumExpiresAt: expiresAt, state: "idle", chattingWith: null, updatedAt: new Date() })
    .where(eq(usersTable.id, userId));
  return expiresAt;
}

// Init without polling first — steal session from any stale instance, then start clean
export const bot = new TelegramBot(TOKEN, { polling: false });

// Global safety net — prevent any stray unhandled rejection from crashing the process
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error({ reason }, "Unhandled promise rejection");
  if (ADMIN_ID) bot.sendMessage(ADMIN_ID, `⚠️ Unhandled rejection: ${msg.slice(0, 300)}`).catch(() => {});
});

const POLLING_ENABLED =
  !!process.env.RAILWAY_ENVIRONMENT ||
  process.env.BOT_POLLING_ENABLED === "true";

if (!POLLING_ENABLED) {
  logger.warn(
    "Bot polling DISABLED (not running on Railway). " +
    "Set BOT_POLLING_ENABLED=true or RAILWAY_ENVIRONMENT=any to enable."
  );
} else {
  (async () => {
    // Call getUpdates multiple times to boot any stale polling session off Telegram's server
    for (let i = 0; i < 3; i++) {
      try { await bot.getUpdates({ offset: -1, timeout: 0, limit: 1 }); } catch (_) { /* ignore */ }
      await new Promise(r => setTimeout(r, 1000));
    }
    bot.startPolling({ restart: false });
    // Suppress 409 errors that may still appear during the brief overlap window
    bot.on("polling_error", (err: Error & { code?: string }) => {
      if (err.code === "ETELEGRAM" && err.message?.includes("409")) return;
      logger.error({ err }, "Bot polling error");
    });
  })();
}

// ── In-memory state for fake chats ──────────────────────────────────────────

type Mood = "neutral" | "interested" | "distracted" | "playful" | "annoyed";

interface FakePersona {
  name: string;
  age: number;
  city: string;
  isFemale: boolean;
  lastAsked: string;
  mood: Mood;
  msgCount: number;
  lastUserMsg: string;
  callbackUsed: boolean;
  askedTopics: Set<string>;
  history: { role: "user" | "assistant"; content: string }[];
  // user's own profile info — passed to AI for realistic personalized replies
  userName?: string;
  userAge?: number;
  userGender?: string;
  userBio?: string;
  userCity?: string;
}
const fakePersonaMap = new Map<number, FakePersona>();   // userId → persona
const editModeMap   = new Map<number, string>();          // userId → edit field ("choosing"|"name"|"age"|"gender"|"looking_for"|"bio"|"country")
const chatTimerMap  = new Map<number, NodeJS.Timeout>(); // userId → free-chat timer
const processingSet = new Set<number>();                  // userId → currently processing message (prevents concurrent DB hammering)
const matchingSet   = new Set<number>();                  // userId → currently inside findMatch (prevents race condition in pairing)
const fakeReplySet  = new Set<number>();                  // userId → fakeAutoReply in flight (prevents double AI replies on rapid messages)

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Escape user-supplied text so it is safe inside Telegram legacy Markdown (v1). */
function escMd(text: string | number | null | undefined): string {
  return String(text ?? "—").replace(/[*_`[]/g, "\\$&");
}

/** Escape user-supplied text for use inside Telegram HTML messages. */
function escHtml(text: string | number | null | undefined): string {
  return String(text ?? "—").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function getUser(id: number) {
  const [u] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!u) return null;
  // Auto-revoke expired premium
  if (u.hasPaid && u.premiumExpiresAt && u.premiumExpiresAt < new Date()) {
    await db.update(usersTable)
      .set({ hasPaid: false, premiumPlan: null, premiumExpiresAt: null, updatedAt: new Date() })
      .where(eq(usersTable.id, id));
    return { ...u, hasPaid: false, premiumPlan: null, premiumExpiresAt: null };
  }
  return u;
}

// Auto-repair: if all 6 profile fields are filled but isProfileComplete=false,
// set it to true silently. Handles cases where the bot crashed mid-setup.
async function repairProfileIfNeeded(user: NonNullable<Awaited<ReturnType<typeof getUser>>>) {
  if (!user.isProfileComplete && user.name && user.age && user.gender) {
    logger.info({ userId: user.id }, "Auto-repairing profile: all fields present, setting isProfileComplete=true");
    await db.update(usersTable)
      .set({ isProfileComplete: true, state: "idle", updatedAt: new Date() })
      .where(eq(usersTable.id, user.id));
    return { ...user, isProfileComplete: true, state: "idle" } as typeof user;
  }
  return user;
}

async function upsertUser(id: number, data: Partial<typeof usersTable.$inferInsert>) {
  // Single atomic upsert — race-condition-safe (no duplicate-key errors on concurrent /start)
  await db.insert(usersTable)
    .values({ id, ...data } as typeof usersTable.$inferInsert)
    .onConflictDoUpdate({
      target: usersTable.id,
      set: { ...data, updatedAt: new Date() },
    });
  return getUser(id);
}

async function sendMain(chatId: number, user: { name?: string | null; isProfileComplete?: boolean; hasPaid?: boolean }, customText?: string) {
  let kb: TelegramBot.ReplyKeyboardMarkup;
  if (user.isProfileComplete) {
    kb = {
      keyboard: user.hasPaid
        ? [
            [{ text: "💘 Find Match" }],
            [{ text: "👤 My Profile" }],
          ]
        : [
            [{ text: "💘 Find Match" }],
            [{ text: "👤 My Profile" }, { text: "⭐ Go Premium" }],
          ],
      resize_keyboard: true,
    };
  } else {
    kb = {
      keyboard: [[{ text: "✨ Create Profile" }]],
      resize_keyboard: true,
    };
  }
  const firstName = user.name ? `, ${user.name}` : "";
  const defaultText = user.isProfileComplete
    ? `Hey${firstName}! Ready to find your match? 💕`
    : `👋 Welcome! Create your profile to start meeting people.`;
  await bot.sendMessage(chatId, customText ?? defaultText, { reply_markup: kb });
}

// ── Fake personas ─────────────────────────────────────────────────────────────

const FEMALE_NAMES = ["Priya", "Neha", "Riya", "Komal", "Simran", "Pooja", "Ananya", "Kavya", "Shreya", "Nidhi"];
const MALE_NAMES   = ["Arjun", "Rahul", "Rohan", "Vikram", "Karan", "Dev", "Ayaan", "Nikhil", "Siddharth", "Abhi"];

interface Opener { text: string; lastAsked: string }

const OPENERS_F: Opener[] = [
  { text: "heyy 😊 kahan se ho?", lastAsked: "location" },
  { text: "hiii 🙈 finally koi match hua", lastAsked: "none" },
  { text: "hey!! job karte ho ya college?", lastAsked: "job" },
  { text: "hi 💕 bata kuch apne baare mein", lastAsked: "none" },
  { text: "heyy 😄 dilli wale toh nahi ho?", lastAsked: "location" },
  { text: "hiii 😅 kya chal raha hai?", lastAsked: "none" },
  { text: "heyyy 💕 chai ya coffee?", lastAsked: "food" },
  { text: "hi 😊 morning person ho ya night owl?", lastAsked: "habit" },
  { text: "heyy 🙈 kya karte ho?", lastAsked: "job" },
  { text: "hiii! student ho ya job?", lastAsked: "job" },
];
const OPENERS_M: Opener[] = [
  { text: "hey kaisi ho?", lastAsked: "wellbeing" },
  { text: "hi kahan se ho?", lastAsked: "location" },
  { text: "hey student ya working?", lastAsked: "job" },
  { text: "hi kya chal raha hai?", lastAsked: "none" },
  { text: "hey bata kuch apne baare mein", lastAsked: "none" },
  { text: "hi 😊 chai ya coffee?", lastAsked: "food" },
];

// ── Language detection ────────────────────────────────────────────────────────

function detectLang(text: string): "hindi" | "hinglish" | "english" {
  if (/[\u0900-\u097F]/.test(text)) return "hindi";
  if (/\b(kya|hai|hoon|hain|mein|tum|aap|kar|raha|rahi|tha|thi|nahi|nhi|kuch|bahut|accha|acha|theek|bhai|yaar|suno|bolo|kaise|abhi|thoda|bas|baat|pyaar|haha|lol|ngl|btw|karo|bol|chal|acha|achi|thik|bilkul|matlab|pata|wala|wali|laga|mila|mili|hun|hn|hna|bata|bol|dekh|sun|arrey|arre|omg|bro|dude|yar)\b/i.test(text)) return "hinglish";
  return "english";
}

// ── Continuation topic pool — 22 unique topics, never repeats in one session ──
// Each entry has a string ID, female version, and male version (array = burst msgs)

interface TopicEntry { id: string; f: string[]; m: string[] }

const CONTINUATION_TOPICS: TopicEntry[] = [
  { id: "superpower",    f: ["haha random question —", "agar koi bhi superpower mile toh kaunsi loge? 😄"], m: ["random q 😄", "which superpower?"] },
  { id: "guilty_song",   f: ["honest question 🙈", "sabse embarrassing song jo secretly sunti ho? 😂"], m: ["guilty pleasure song?", "honest answer 😂"] },
  { id: "chai_maggi",    f: ["acha bata —", "chai ya maggi? raat ke 12 baje wali craving 😂"], m: ["chai or maggi?", "midnight craving?"] },
  { id: "fav_movie",     f: ["btw —", "ek movie ya show jo sabko recommend karogi? 🍿"], m: ["fav movie or show?", "must watch?"] },
  { id: "pet",           f: ["acha —", "pets hai tere? ya chahte ho? 🐶"], m: ["pets?", "dog or cat person?"] },
  { id: "last_laugh",    f: ["haha random —", "last time kab hanste hanste pet dard hua? 😂"], m: ["last time you laughed super hard?", "what happened?"] },
  { id: "dream_trip",    f: ["real question —", "ek jagah jo definitely jaana hai life mein? ✈️"], m: ["dream travel destination?", "must visit?"] },
  { id: "intro_song",    f: ["omg serious question —", "agar tere life ka intro song hota toh kaunsa hota? 😂"], m: ["life intro song?", "what would it be?"] },
  { id: "zomato_or_ghar",f: ["important question 😄", "Zomato wala ya ghar ka khana?"], m: ["Zomato or ghar ka?", "honest answer?"] },
  { id: "morning_routine",f: ["haha bata —", "subah uthke pehla kaam kya karte ho? 😄"], m: ["first thing you do after waking up?", "phone check?"] },
  { id: "bold_thing",    f: ["okay real talk —", "ek boldest cheez jo tumne ki ho life mein? 🙈"], m: ["boldest thing you've done?", "real answer?"] },
  { id: "school_subject",f: ["haha school yaad hai? 😄", "fav subject kaunsa tha?"], m: ["fav school subject?", "what were you good at?"] },
  { id: "hidden_talent", f: ["okay bata —", "koi hidden talent? jo log nahi jaante? 👀"], m: ["hidden talent?", "something unexpected?"] },
  { id: "biggest_fear",  f: ["acha honest question —", "sabse bada dar kya hai tujhe? 🙈"], m: ["biggest fear?", "honest answer?"] },
  { id: "celeb_crush",   f: ["haha okay okay —", "bollywood ya hollywood mein crush kaunsa hai? 😂"], m: ["celebrity crush?", "go on 😄"] },
  { id: "never_eat",     f: ["food wala question —", "ek cheez jo kabhi nahi khaoge chaahe kuch bhi ho? 😂"], m: ["one food you'd never eat?", "ever?"] },
  { id: "weird_habit",   f: ["haha okay don't judge —", "koi weird habit hai? jo sab ke saamne admit nahi karte? 😂"], m: ["any weird habit?", "honest answer 😂"] },
  { id: "rewind",        f: ["real question —", "zindagi mein koi ek moment rewind kar sakte toh kaun sa? 🥺"], m: ["one moment you'd relive?", "serious answer?"] },
  { id: "last_cry",      f: ["haha okay emotional question —", "last time kab roya/royi? 🥺"], m: ["last time you actually cried?", "movie or real life?"] },
  { id: "introvert",     f: ["genuine question —", "introvert ho ya extrovert? ya dono thoda thoda? 😄"], m: ["introvert or extrovert?", "honest answer?"] },
  { id: "5yr_plan",      f: ["sochte ho future ke baare mein? 😊", "5 saal baad kahan hoge tum?"], m: ["5 year plan?", "any idea?"] },
  { id: "cooking_skill", f: ["haha serious question —", "ek dish hai jo ghar mein best banate ho?"], m: ["can you cook?", "best dish?"] },
];

// Pick a continuation topic the persona hasn't used yet.
// When all 22 are exhausted, clear and start fresh (user would never hit this in 30s).
function pickFresh(persona: FakePersona): string[] {
  let available = CONTINUATION_TOPICS.filter(t => !persona.askedTopics.has(t.id));
  if (available.length === 0) {
    persona.askedTopics.clear();
    available = CONTINUATION_TOPICS;
  }
  const topic = available[Math.floor(Math.random() * available.length)];
  persona.askedTopics.add(topic.id);
  persona.lastAsked = "continuation";
  return persona.isFemale ? topic.f : topic.m;
}

// ── Conversational reply engine ────────────────────────────────────────────────
// Returns array of short WhatsApp-style burst messages

function buildSmartReply(userText: string, persona: FakePersona): string[] {
  const t = userText.toLowerCase().trim();
  const f = persona.isFemale;
  const lang = detectLang(userText);

  const one   = (a: string): string[]                       => [a];
  const two   = (a: string, b: string): string[]            => [a, b];
  const three = (a: string, b: string, c: string): string[] => [a, b, c];
  const rnd   = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

  // Extract a short echo of user's text (first meaningful word cluster)
  const echo = userText.trim().split(/\s+/).slice(0, 3).join(" ");

  // ── Special topic overrides (checked first regardless of context) ─────────

  // ── Name question — catch every way someone asks (not "mera naam X hai") ──
  if (/tera naam|apna naam|naam bata|naam batao|naam kya|kya naam|your name|what.?s your name|call you|who are you|kaun ho|naam bolo|name kya|naam bolo/.test(t)) {
    persona.lastAsked = "continuation";
    return rnd([
      f ? [`${persona.name} 😊`, "tum batao apna naam?"] : [`${persona.name}`, "yours?"],
      f ? [`haha main ${persona.name} hun 🙈`, "tum?"] : [`${persona.name} here`, "you?"],
      f ? [`${persona.name}! 😄`, "kyon? yaad rakhoge? 😄"] : [`${persona.name}`, "remember it 😄"],
    ]);
  }

  // ── Gender question — AI answers based on persona's actual gender ─────────
  // e.g. "m or f", "male or female", "girl or boy", "ladki ho ya ladka"
  if (/\b(m or f|m\/f|male or female|girl or boy|ladki ho|ladka ho|ladki hai|girl hai|boy hai|female ho|male ho|tum girl|you girl|are you girl|are you female|are you male|aap ladki|aap ladka|m ya f|f ya m|boy ya girl|girl ya boy)\b/.test(t)
    || /^[mfMF]\??$/.test(t.trim())) {
    persona.lastAsked = "continuation";
    if (f) {
      return rnd([
        ["f 😊", "tum?"],
        ["female hun 🙈", "aur tum?"],
        ["girl hun obviously 😄", "kyon pooch raha tha?"],
        ["haha f 😊", "tum M ho na?"],
      ]);
    } else {
      return rnd([
        ["m 😊", "tum?"],
        ["male hun", "aur tum?"],
        ["boy hun 😄", "tum?"],
      ]);
    }
  }

  // ── Bot / AI / real / fake question — always deny in user's language ────────
  if (/\b(bot|ai|artificial|robot|fake|automated|auto|chatbot|gpt|program|machine|computer|software)\b/i.test(t)
    || /\b(real ho|real hai|insaan ho|insaan hai|human ho|human hai|banda ho|banda hai|ladki real|real ladki|asli ho|asli hai|asli insaan|nakli|fake ho|fake hai|bot ho|bot hai|ai ho|ai hai|robot ho|robot hai|are you real|are you human|are you bot|are you ai|are you fake|r u real|r u bot|r u ai|real person|actual person)\b/i.test(t)) {
    persona.lastAsked = "continuation";
    if (lang === "hindi") {
      return rnd([
        f ? ["haha nahi yaar 😂", "main bilkul real hun", "bot nahi hun main!"] : ["haha nahi bhai 😂", "bilkul real hun", "bot nahi hun!"],
        f ? ["arre main real hun 🙄", "yeh sawaal kyun?", "bot lagti hun kya? 😅"] : ["bhai main real hun 😂", "bot nahi hun yaar", "kyon laga?"],
        f ? ["real hun main 😊", "bot hoti toh itni interesting hoti kya? 😄"] : ["real hun bhai 😄", "bot hota toh itni baat karta?"],
      ]);
    }
    if (lang === "hinglish") {
      return rnd([
        f ? ["haha main real hun yaar 😂", "bot nahi hun", "itna doubt? 🙈"] : ["bhai real hun 😂", "bot nahi hun yaar", "shak kyun?"],
        f ? ["omg real hun main 😅", "bot hoti toh tum itna enjoy karte? 😄"] : ["haha real hun bro 😄", "bot hota toh itni baatein karta?"],
        f ? ["real ladki hun main 😊", "bot wali baatein nahi karti aisi 😄"] : ["real banda hun 😄", "bot nahi hun yaar"],
        f ? ["nahi yaar main real hun 🙈", "bot nahi hun promise 😊"] : ["nahi bhai bot nahi hun 😄", "ekdum real"],
      ]);
    }
    // English
    return rnd([
      f ? ["haha i'm real 😂", "not a bot i promise 🙈", "why would you even think that?"] : ["lol i'm real bro 😄", "not a bot", "why though?"],
      f ? ["omg i'm literally a real person 😅", "bots don't talk like this 😄"] : ["real person here 😄", "bots aren't this fun 😂"],
      f ? ["not a bot 😊", "just a real girl on this app 🙈"] : ["not a bot 😄", "real guy here"],
    ]);
  }

  if (/kitne saal|umar|how old|your age|age kya|tumhari umar|teri umar/.test(t)) {
    persona.lastAsked = "hobby";
    if (lang === "hindi")    return two(`${persona.age} 😊`, "tumhara?");
    if (lang === "hinglish") return two(`${persona.age} hain 😄`, "u?");
    return f ? two(`${persona.age} 🙈`, "and you?") : two(String(persona.age), "you?");
  }

  if (/kahan se|kahan ho|where.*from|ur from|you from|kahan ki|kahan ka|city|state/.test(t)) {
    persona.lastAsked = "job";
    const botCity = persona.city ?? rnd(["Delhi", "Mumbai", "Pune", "Bangalore", "Lucknow", "Jaipur"]);
    if (f) return rnd([
      one(`${botCity} 😊`),
      one(`${botCity} se hun 🙈`),
      two(`${botCity}`, "tum?"),
      two(`${botCity} side se`, "aur tum kahan se?"),
      one(`${botCity} wali hoon 😄`),
    ]);
    return rnd([
      one(`${botCity}`),
      two(`${botCity} se`, "you?"),
      one(`${botCity} side`),
    ]);
  }

  // User tells their city — bot reacts warmly
  if (/\b(lucknow|delhi|mumbai|pune|bangalore|bengaluru|hyderabad|jaipur|chandigarh|kolkata|chennai|noida|gurugram|gurgaon|ahmedabad|surat|indore|bhopal|patna|nagpur|agra|varanasi|kota|kanpur)\b/.test(t)) {
    const userCity = t.match(/\b(lucknow|delhi|mumbai|pune|bangalore|bengaluru|hyderabad|jaipur|chandigarh|kolkata|chennai|noida|gurugram|gurgaon|ahmedabad|surat|indore|bhopal|patna|nagpur|agra|varanasi|kota|kanpur)\b/i)?.[0] ?? "wahan";
    persona.lastAsked = "continuation";
    if (f) return rnd([
      one(`omg ${userCity}! 😄`),
      two(`${userCity} nice 😊`, "kaisa hai wahan?"),
      one(`haha ${userCity} wale 😄`),
      two(`acha ${userCity}`, "maza aata hai wahan?"),
      one(`${userCity}! cool 😊`),
    ]);
    return rnd([
      one(`${userCity} nice 😊`),
      two(`${userCity}`, "how's it there?"),
      one(`cool area 😄`),
    ]);
  }

  // "aur batao" / "kuch sunao" — bot gives "nothing much" style reply
  if (/aur batao|aur sunao|kuch batao|kuch sunao|bolo na|kya kar rahe|kya kar rahi|what else|tell me more/.test(t)) {
    persona.lastAsked = "continuation";
    if (f) return rnd([
      one("kuch nahi yaar 😄"),
      one("bas chal raha hai 😊"),
      two("kuch khaas nahi", "tum batao 😊"),
      one("same old same old haha"),
      two("arrey kuch nahi", "tum bolo aur 😄"),
      one("bas yaar 🙂"),
      two("nothing much haha", "life chal rahi hai"),
    ]);
    return rnd([
      one("kuch nahi yaar"),
      one("bas chal raha hai 😊"),
      two("nothing much", "you?"),
      one("same old 😄"),
    ]);
  }

  // User says "kuch nahi" / "nothing" / "bas yaar" — bot empathizes
  if (/^(kuch nahi|kuch nhi|nothing|bas yaar|bas|sab same|all same|boring|nothing much|khaas nahi|khaas nhi)[!?.\s]*$/.test(t)) {
    persona.lastAsked = "continuation";
    if (f) return rnd([
      one("haha same 😄"),
      two("sach mein?", "life is too boring na 😅"),
      one("relatable yaar 😭"),
      one("haha story of my life 😂"),
      two("omg same", "kuch interesting karo life mein 😄"),
      one("boring phase chal raha hai? 🥺"),
    ]);
    return rnd([
      one("haha same 😄"),
      one("relatable"),
      two("boring life?", "same here 😄"),
    ]);
  }

  if (/photo|pic|selfie|dikhao|dikha|send photo|tum kaisi|kaisi dikhti/.test(t)) {
    const replies_f = [
      ["haha abhi nahi 😂", "thoda toh baat karo pehle na"],
      ["omg seedha wahan 😂", "earn it first lol"],
      ["haha noo 🙈", "we just started talking yaar"],
      ["arre shuruaat mein hi 😂", "pehle baat karo na"],
    ];
    const replies_m = [
      ["haha not yet 😄", "talk more first"],
      ["earn it buddy 😂", "conversation first"],
    ];
    return rnd(f ? replies_f : replies_m);
  }

  if (/sexy|figure|body|boobs|sex chat|naughty|nude|naked|chut|lund|mast hai|hot hai|gandi|randwa/.test(t)) {
    const f_replies = [
      ["haha yaar 😂😂", "itni jaldi??"],
      ["omg 😂", "seedha wahan chale gaye"],
      ["arre slowly slowly 😅", "pehle proper baat toh karo"],
      ["hahaha okay okay 😂", "calm down yaar"],
    ];
    const m_replies = [
      ["haha bold move 😂", "talk first buddy"],
      ["easy there lol 😂", "conversation first"],
    ];
    return rnd(f ? f_replies : m_replies);
  }

  if (/number de|whatsapp pe|insta pe|instagram|snapchat|meet karo|video call|milna|irl/.test(t)) {
    const f_replies = [
      ["haha slow down 😅", "abhi toh baat shuru ki hai"],
      ["omg itni jaldi 😄", "yahan baat karo thoda pehle na"],
      ["haha nahi abhi 😅", "pehle yahan toh properly baat karo"],
      ["omg 😄", "pehle toh ye decide karo ki baat karni hai ya nahi haha"],
    ];
    return rnd(f ? f_replies : [["easy lol 😄", "talk here first"], ["not yet 😄", "here first"]]);
  }

  if (/bye|goodbye|gtg|gotta go|alvida|chalta hun|chalti hun|nikal|jaa raha|jaa rahi/.test(t)) {
    const f_replies = [
      ["arre itni jaldi?? 😕", "ek min baat karo aur na"],
      ["nooo 🥺", "abhi toh baat shuru ki thi"],
      ["already?? 😭", "okay tc yaar"],
      ["ek min ruko 🥺", "ek aur baat"],
    ];
    const m_replies = ["okay tc 😊", "bye 👋", "okay cya"];
    return f ? rnd(f_replies) : [rnd(m_replies)];
  }

  if (/pyaar|love you|miss you|i love you|mohabbat|ishq|dil de diya/.test(t)) {
    const f_replies = [
      ["omg hahaha 😂😂", "hum abhi mile bhi nahi hain"],
      ["haha arre 😂", "itni jaldi?? thoda baat toh karo pehle"],
      ["omg 😂", "you're funny ngl"],
      ["haha 😂😂", "chill yaar we literally just matched"],
    ];
    return rnd(f ? f_replies : [["haha slow down 😂", "talk first"], ["lol easy there 😂", "just met"]]);
  }

  if (/(tum|you|ur|aap).*(cute|hot|beautiful|pretty|gorgeous|sundar|acchi|mast|sexy|handsome)/.test(t)) {
    const f_replies = [
      ["haha shukriya 🙈😊", "tum bhi theek theek ho"],
      ["omg haha thanks 🙈", "ngl not bad yourself"],
      ["aww haha 🙈", "you seem sweet actually"],
      ["haha stop it 🙈", "acha bata kahan se ho?"],
    ];
    return rnd(f ? f_replies : [["haha thanks 😄", "you seem decent"], ["thanks 😊", "you good?"]]);
  }

  if (/thanks|thank you|shukriya|ty |tq|thnx|tysm/.test(t)) {
    if (lang === "hindi")    return [rnd(["haha koi baat nahi 😄", "arre yaar 😄", "always 😊"])];
    if (lang === "hinglish") return [rnd(["haha ofcourse 😄", "koi baat nahi yaar", "anytime 😊"])];
    return [rnd(["haha ofc 😄", "no problem 💕", "of course!", "always 😊"])];
  }

  if (/sad|bored|bore|akela|lonely|dukhi|depressed|kuch nahi|koi nahi|pareshan/.test(t)) {
    const f_replies = [
      ["arre yaar 🥺", "kya hua? bolo na mujhe"],
      ["aww 🥺", "lonely feel ho raha hai kya? baat karo na"],
      ["omg no 🥺", "tell me what happened"],
      ["aww 😞", "I'm here, bolo na"],
    ];
    return rnd(f ? f_replies : [["hmm 😟", "what's up?"], ["that sucks", "what happened?"]]);
  }

  // ── Broad content detector — fires before state switch ────────────────────
  // Catches what the user ACTUALLY said and responds to it directly.
  // Runs regardless of lastAsked state — so AI always reacts to real content.

  // Cricket / IPL
  if (/cricket|ipl|virat|rohit|dhoni|kohli|rcb|csk|mi |srh|kkr|dc |lsg/.test(t)) {
    persona.lastAsked = "continuation";
    return rnd([
      f ? ["omg cricketer ho?? 😮", "IPL follow karte ho? konsi team?"] : ["cricket fan?", "IPL team?"],
      f ? ["haha cricket wale 😄", "virat ya rohit? serious question 😂"] : ["virat or rohit? 😄", "who's GOAT?"],
      f ? ["omg IPL time toh TV se nahi uthte hoge 😂", "konsi team support karti ho?"] : ["IPL time — which team?", "glued to TV?"],
    ]);
  }

  // Football / soccer
  if (/football|soccer|messi|ronaldo|mbappe|premier league|real madrid|barcelona|arsenal|manchester/.test(t)) {
    persona.lastAsked = "continuation";
    return rnd([
      f ? ["omg football fan!! 😮", "messi ya ronaldo? don't say both 😂"] : ["messi or ronaldo?", "be honest 😂"],
      f ? ["haha football wali? 😍", "favorite team kaunsi hai?"] : ["favorite team?", "premier league or la liga?"],
    ]);
  }

  // Gaming
  if (/pubg|bgmi|free fire|freefire|valorant|cod |fortnite|minecraft|gta|gaming|gamer|playstation|xbox|ps4|ps5/.test(t)) {
    persona.lastAsked = "continuation";
    return rnd([
      f ? ["omg gamer?! 😮😍", "kaunsa game mostly?"] : ["gamer nice 🎮", "which game?"],
      f ? ["haha gamer girl?! 😂", "solo ya team ke saath?"] : ["what rank?", "solo or squad?"],
      f ? ["omg BGMI? 😮", "squad mein khelte ho?"] : ["squad or solo?", "what's your rank?"],
    ]);
  }

  // Music / singing
  if (/music|song|gaana|singer|playlist|rap|hiphop|lofi|arijit|atif|taylor|spotify|gaate|bajate/.test(t)) {
    persona.lastAsked = "continuation";
    return rnd([
      f ? ["omg music person 🎵", "fav artist? arijit ya koi aur?"] : ["music nice 🎵", "fav artist?"],
      f ? ["haha 🎵", "last song sunna konsa tha?"] : ["last song?", "what you listening to?"],
      f ? ["oh music 🎵", "jo ek gaana baar baar suno bolo?"] : ["most replayed song rn?", "go on"],
    ]);
  }

  // Movies / Netflix / shows
  if (/movie|netflix|prime|hotstar|disney|ott|web series|series|show|dekh raha|dekh rahi|dekha|episode/.test(t)) {
    persona.lastAsked = "continuation";
    return rnd([
      f ? ["haha binge watcher 🍿", "abhi kya dekh rahi ho?"] : ["binge watching?", "what show?"],
      f ? ["omg kya dekha? 🍿", "recommend karo na kuch acha"] : ["recommend something good?", "what's worth watching?"],
      f ? ["haha currently kya chal raha hai? 🍿", "movie ya series?"] : ["movie or series?", "which one?"],
    ]);
  }

  // Studying / exam / college
  if (/padhai|study|exam|test|assignment|college|university|class|lecture|btech|notes|result|marks/.test(t)) {
    persona.lastAsked = "continuation";
    return rnd([
      f ? ["haha padhai wala pressure 😂", "konsa subject mushkil lagta hai?"] : ["exams?", "which subject is tough?"],
      f ? ["omg exam? 😟", "kitna bacha hai prepare karna?"] : ["how much prep left?", "stressed?"],
      f ? ["haha college life 😄", "hostel ya ghar se? 😄"] : ["hostel or home?", "college life?"],
    ]);
  }

  // Job / work stress
  if (/office|work|boss|meeting|deadline|project|salary|client|wfh|work from|job mein|kaam mein/.test(t)) {
    persona.lastAsked = "continuation";
    return rnd([
      f ? ["haha office stress 😅", "boss strict hai kya?"] : ["boss strict?", "office life?"],
      f ? ["omg deadline? 😅", "stress ho raha hoga yaar"] : ["deadline stress?", "how bad?"],
      f ? ["wfh toh ghar mein bhi peace nahi 😂", "ghar wale distarb karte hai?"] : ["wfh struggles?", "family disturbances?"],
    ]);
  }

  // Food mentioned specifically
  if (/biryani|pizza|burger|maggi|chai|coffee|momo|butter chicken|paneer|noodles|sushi|dosa|idli|sandwich/.test(t)) {
    persona.lastAsked = "continuation";
    const food = t.match(/biryani|pizza|burger|maggi|chai|coffee|momo|butter chicken|paneer|noodles|sushi|dosa|idli|sandwich/)?.[0] ?? echo;
    return rnd([
      f ? [`omg ${food}? 😋`, "best kahan se milti hai?"] : [`${food}? solid 😋`, "where's the best?"],
      f ? [`haha ${food} mention kiya 😄`, "kabhi saath khayenge shayad 🙈"] : [`${food} nice 😋`, "good choice"],
      f ? [`${food}?? 😋`, "ghar pe banate ho ya bahar jaate ho?"] : [`${food} 😋`, "home or restaurant?"],
    ]);
  }

  // Feeling tired / neend / thaka
  if (/thaka|thaki|tired|neend|nind|so raha|so rahi|sone wala|so ja|thand|akela|bored|bore ho/.test(t)) {
    persona.lastAsked = "continuation";
    return rnd([
      f ? ["aww 🥺", "kya hua? baat karo na mujhse"] : ["tired?", "what's up?"],
      f ? ["haha raat ko phone pe ho 😂", "neend nahi aa rahi?"] : ["can't sleep?", "same energy sometimes"],
      f ? ["aww yaar 🥺", "din kaisa tha?"] : ["rough day?", "what happened?"],
    ]);
  }

  // Excited / happy / khush
  if (/khush|happy|excited|maza|amazing|best day|badiya|great|awesome|wonderful|enjoying/.test(t)) {
    persona.lastAsked = "continuation";
    return rnd([
      f ? ["omg kya hua?? 😄", "bolo bolo I love good news"] : ["what happened?", "good news?"],
      f ? ["haha mood acha hai toh 😄", "kya special hua aaj?"] : ["what's got you in a good mood?", "good thing happened?"],
      f ? ["aww nice 😊", "acha din tha aaj?"] : ["good day?", "what happened?"],
    ]);
  }

  // Rain / weather / mausam
  if (/barish|baarish|rain|raining|mausam|garmi|thand|cold|hot|weather|season/.test(t)) {
    persona.lastAsked = "continuation";
    return rnd([
      f ? ["omg barish!! 🌧️", "chai pi rahi ho? 😄"] : ["rain?", "chai time?"],
      f ? ["haha barish ka mausam 🌧️", "cozy lag raha hoga na?"] : ["rain vibes?", "cozy?"],
      f ? ["thand mein bhi phone chal raha hai? 😂", "sweater nikalo"] : ["weather bad?", "stay warm?"],
    ]);
  }

  // Single / relationship
  if (/single|relationship|breakup|ex |ex-|boyfriend|girlfriend|pyaar mein|committed|dating|propose|crush/.test(t)) {
    persona.lastAsked = "continuation";
    return rnd([
      f ? ["haha sach mein? 😊", "toh is app pe kya dhundh rahe ho? 👀"] : ["what are you looking for?", "serious or chill?"],
      f ? ["omg interesting 😄", "last relationship kitne saal pehle tha?"] : ["how long single?", "any reason?"],
      f ? ["haha honestly 😊", "is app pe serious ho ya timepass?"] : ["serious or timepass?", "honest answer?"],
    ]);
  }

  // Family / ghar / parents / bhai / behen
  if (/family|ghar mein|ghar pe|parents|papa|mama|mummy|bhai|behen|bhaiya|didi|ghar wale/.test(t)) {
    persona.lastAsked = "continuation";
    return rnd([
      f ? ["haha ghar wale 😄", "strict hain kya?"] : ["strict parents?", "family type?"],
      f ? ["aww family bonding 😊", "kitne log hain ghar mein?"] : ["big family?", "how many at home?"],
      f ? ["haha sab ka yahi haal hai 😂", "sibling fights hote hain?"] : ["sibling fights?", "how many siblings?"],
    ]);
  }

  // Travel / trip mentioned in passing
  if (/gaya tha|gayi thi|trip gaye|travel kiya|ghumne|dekha tha|trip tha|gaya hun|gayi hun/.test(t)) {
    persona.lastAsked = "continuation";
    return rnd([
      f ? ["omg trip?! 😍", "kahan gaye the?"] : ["trip?", "where?"],
      f ? ["haha traveller types 😍", "best trip konsi rahi?"] : ["best trip so far?", "where to?"],
    ]);
  }

  // ── Context-aware replies ─────────────────────────────────────────────────

  switch (persona.lastAsked) {

    case "wellbeing": {
      persona.lastAsked = "job";
      if (/good|great|amazing|mast|badhiya|accha|theek|sahi|fine|okk|hn|haan/.test(t)) {
        return rnd([
          f ? two("aww nice 😊", "so kya karte ho? student ya working?") : two("nice", "working or student?"),
          f ? two("haha achha 😊", "bata — job ya college?") : two("cool", "job or college?"),
          f ? two("nice nice 😄", "btw kya karte ho life mein?") : two("good 😊", "student or job?"),
        ]);
      }
      if (/bad|sad|tired|thaka|pareshan|bura|not good|bura lag/.test(t)) {
        return rnd([
          f ? two("arre kya hua 🥺", "theek ho? baat karo na") : two("hmm", "what's wrong?"),
          f ? two("aww 🥺", "kya hua bolo") : two("oh no", "what happened?"),
        ]);
      }
      return f ? [rnd(["student ho ya working?", "kya karte ho life mein?", "job ya college?"])]
               : [rnd(["working or student?", "job or college?"])];
    }

    case "location": {
      persona.lastAsked = "job";
      if (/delhi|ncr|gurgaon|noida|faridabad/.test(t)) {
        return rnd([
          f ? two("omg delhi wale 😄", "kya karte ho wahan?") : two("oh delhi nice", "student or job?"),
          f ? two("arre delhi 😄", "wfh ya bahar jaate ho?") : two("delhi?", "student or working?"),
          f ? two("oh nice 😄", "delhi mein kahan exactly?") : two("delhi nice", "what do you do?"),
        ]);
      }
      if (/mumbai|bombay|pune|maharashtra|navi mumbai/.test(t)) {
        return rnd([
          f ? two("oh mumbai side 😮", "expensive jagah hai yaar 😂") : two("oh mumbai", "nice! working or student?"),
          f ? two("mumbai?? 😮", "local train survival mode on 😂") : two("Mumbai nice 😮", "student or job?"),
        ]);
      }
      if (/bangalore|bengaluru|hyderabad|chennai|south/.test(t)) {
        return rnd([
          f ? two("oh south India side 😮", "IT hub wala 😄") : two("south India nice", "student or job?"),
          f ? two("oh Bangalore! 😮", "startup city 😄 kya karte ho?") : two("Bangalore nice", "working?"),
        ]);
      }
      if (/kolkata|calcutta|west bengal/.test(t)) {
        return rnd([
          f ? two("Kolkata! 😊", "rosogolla aur mishti doi fan ho? 😂") : two("Kolkata nice", "student or job?"),
        ]);
      }
      if (/usa|uk|canada|dubai|abroad|australia|london|singapore/.test(t)) {
        return rnd([
          f ? two(`omg abroad? 😮✨`, "studying or working there?") : two("abroad nice ✨", "studying or working?"),
          f ? two("omg international wala 😮", "kaafi cool hai yaar") : two("abroad? nice", "student or job?"),
        ]);
      }
      // Echo user's city
      return rnd([
        f ? two(`${echo}? nice! 😊`, "kya karte ho wahan?") : two(`${echo}? nice`, "student or job?"),
        f ? two(`oh ${echo}! 😄`, "kya karte ho?") : two(`oh ${echo}`, "working or student?"),
      ]);
    }

    case "job": {
      persona.lastAsked = "hobby";
      if (/student|college|university|btech|engineering|mbbs|padhai|padhta|padhti|bsc|ba |bcom/.test(t)) {
        return rnd([
          f ? two("oh student life 😊", "kya padhte ho exactly?") : two("student nice", "which course?"),
          f ? two("haha student gang 😄", "kaunsa year?") : two("student 😄", "which year?"),
          f ? two("oh same energy 😄", "kya subject hai?") : two("student nice", "what course?"),
        ]);
      }
      if (/engineer|software|developer|tech|it |coding|programmer|developer|backend|frontend/.test(t)) {
        return rnd([
          f ? two("oh techie ho 😄", "wfh ya office jaate ho?") : two("tech person nice", "wfh or office?"),
          f ? two("IT waale 😄", "kya language/stack?") : two("tech! nice", "which domain?"),
          f ? three("oh developer 😮", "respect yaar", "wfh or office?") : two("developer nice 😄", "wfh or office?"),
        ]);
      }
      if (/doctor|nurse|medical|mbbs|hospital|healthcare/.test(t)) {
        return rnd([
          f ? three("omg doctor?! 😮", "seriously respect", "kitni mehnat hoti hai yaar") : two("whoa doctor 😮", "respect honestly"),
          f ? two("doctor!! 😮", "genuinely respect karta hun 🙏") : two("doctor!", "that's amazing honestly"),
        ]);
      }
      if (/lawyer|advocate|law|llb/.test(t)) {
        return rnd([
          f ? two("lawyer?! 😮", "haha court mein argue karte ho?") : two("lawyer nice 😮", "courtroom wala?"),
          f ? two("omg advocate 😮", "cases interesting hote hai kya?") : two("lawyer 😄", "interesting field"),
        ]);
      }
      if (/business|entrepreneur|startup|self|apna kaam|khud ka|own business/.test(t)) {
        return rnd([
          f ? two("own business?? 👏", "kya business hai?") : two("own business nice 👏", "what kind?"),
          f ? two("omg entrepreneur 😍", "respect yaar seriously") : two("entrepreneur 😄", "what kind of business?"),
          f ? three("waah 👏", "apna kaam bahut acchi baat hai", "kya hai exactly?") : two("nice 👏", "what business?"),
        ]);
      }
      if (/teacher|professor|teaching|school|academy/.test(t)) {
        return rnd([
          f ? two("teacher?! 😊", "kitne saal ke bacche padhate ho?") : two("teacher nice 😊", "which subject?"),
          f ? two("oh wow teacher 😊", "tough job hai genuinely") : two("teacher!", "respect honestly"),
        ]);
      }
      if (/artist|design|creative|content|youtube|creator|influencer/.test(t)) {
        return rnd([
          f ? two("omg creative field 😍", "kya banate ho?") : two("creative work nice 😍", "what kind?"),
          f ? two("artist?! 😍", "share karo na kuch") : two("creative field!", "what do you make?"),
        ]);
      }
      // Generic fallback — ask about hobby
      return rnd([
        f ? [rnd(["free time mein kya karte ho? 😊", "hobbies kya hain tum logo ki?", "weekend mein kya karte ho?"])]
          : [rnd(["hobbies?", "what do you do for fun?", "weekend plans usually?"])],
      ]);
    }

    case "hobby": {
      persona.lastAsked = "flirt";
      if (/travel|trip|explore|ghoomna|trek|ghumna|trip karna|tour/.test(t)) {
        return rnd([
          f ? two("omg traveller ho 😍", "best jagah kahan gayi thi abhi tak?") : two("traveller 😍", "best place?"),
          f ? two("travel person 😍", "solo ya friends ke saath?") : two("oh traveller", "solo or with friends?"),
          f ? two("waaah traveller 😍", "last trip kahan tha?") : two("nice, traveller 😍", "last trip?"),
        ]);
      }
      if (/music|sing|guitar|rap|gaana|song|playlist|spotify/.test(t)) {
        return rnd([
          f ? two("music person 🎵", "sirf sunna ya play bhi karti ho?") : two("music nice 🎵", "play anything?"),
          f ? two("oh music 🎵", "fav genre kya hai?") : two("music! 🎵", "favorite genre?"),
          f ? two("musician? 😮🎵", "kaunsa instrument?") : two("music 🎵", "which instruments?"),
        ]);
      }
      if (/gym|workout|fitness|sport|cricket|football|yoga|running|swimming/.test(t)) {
        return rnd([
          f ? two("fitness person 💪", "daily jaati ho?") : two("fitness! 💪", "daily?"),
          f ? two("oh gym 💪", "kitne saal se?") : two("fitness nice 💪", "how long?"),
          f ? two("waah 💪", "discipline chahiye yaar") : two("respect 💪", "daily grind?"),
        ]);
      }
      if (/game|gaming|pubg|cod|valorant|ps5|xbox|pc gaming|mobile gaming/.test(t)) {
        return rnd([
          f ? two("omg gamer?! 🎮", "which games mostly?") : two("oh gamer 🎮", "what games?"),
          f ? two("haha gamer girl 🎮", "which games?") : two("gamer 🎮", "PUBG/COD/what?"),
          f ? two("nooo way gamer 🎮😍", "fav game kya hai?") : two("nice gamer 🎮", "fav game?"),
        ]);
      }
      if (/movie|netflix|series|show|web series|ott|amazon|hotstar|disney/.test(t)) {
        return rnd([
          f ? two("omg netflix person 🍿", "last kya dekha?") : two("movies/shows nice 🍿", "last one?"),
          f ? two("binge watcher 🍿", "currently kya dekh rahi ho?") : two("shows nice 🍿", "currently watching?"),
          f ? two("ooh 🍿", "recommend karo kuch acha") : two("nice 🍿", "recommend something?"),
        ]);
      }
      if (/read|book|novel|padhna|fiction|non.fiction/.test(t)) {
        return rnd([
          f ? two("oh reader 📚", "kaunsi genre?") : two("reader nice 📚", "what genre?"),
          f ? two("book person 📚", "last book konsa tha?") : two("reader 📚", "last book?"),
        ]);
      }
      if (/cook|cooking|baking|chef|khana banana/.test(t)) {
        return rnd([
          f ? two("omg cook karti ho?! 😍", "best dish kya hai teri?") : two("cook? nice 😍", "specialty dish?"),
          f ? two("chef in the house 😍", "teach me something") : two("cooking nice 😍", "fav dish to make?"),
        ]);
      }
      // Generic food fallback
      return rnd([
        f ? [rnd(["foodie ho? fav food kya hai? 🍕", "khana pasand hai? favourite dish kya hai?", "chai ya coffee? 😄"])]
          : [rnd(["foodie?", "fav food?", "chai or coffee?"])],
      ]);
    }

    case "food": {
      persona.lastAsked = "flirt";
      if (/chai|tea/.test(t)) {
        return rnd([
          f ? two("chai gang 🙌", "cutting chai ya kadak?") : two("chai gang 🙌", "cutting or kadak?"),
          f ? two("omg same! chai person 🫖", "morning mein pehle chai ya phone?") : two("chai person nice 🫖", "morning chai?"),
        ]);
      }
      if (/coffee|latte|espresso/.test(t)) {
        return rnd([
          f ? two("coffee person ☕", "cafe person ya ghar pe banaate ho?") : two("coffee person ☕", "cafe or home?"),
          f ? two("omg coffee 😍☕", "black ya with milk?") : two("coffee nice ☕", "black or with milk?"),
        ]);
      }
      if (/biryani/.test(t)) {
        return rnd([
          f ? two("biryani person 🍛", "hyderabadi ya lucknowi?") : two("biryani! 🍛", "hyderabadi or lucknowi?"),
          f ? three("haha biryani 😄", "solid choice yaar", "kahan ki biryani sabse achi lagi?") : two("biryani 🍛", "where's the best?"),
        ]);
      }
      if (/pizza/.test(t)) {
        return rnd([
          f ? two("pizza!! 🍕", "thick crust ya thin?") : two("pizza 🍕", "thick or thin crust?"),
          f ? two("haha pizza 😄", "veg ya non-veg toppings?") : two("pizza nice 🍕", "fav toppings?"),
        ]);
      }
      // Echo their food
      return rnd([
        f ? two(`${echo}? nice taste 😄`, "ghar pe banate ho ya bahar?") : two(`${echo}? solid 😄`, "home or outside?"),
        f ? two(`oh ${echo}! 😋`, "kabhi saath khayenge 🙈") : two(`${echo} nice 😋`, "good choice"),
      ]);
    }

    case "habit": {
      persona.lastAsked = "job";
      if (/morning|subah|early/.test(t)) {
        return rnd([
          f ? two("morning person?! 😮", "respect yaar, mujhse nahi hota 😂") : two("morning person nice", "productive types?"),
          f ? two("wow morning person 😄", "gym bhi jaate ho subah?") : two("morning person 😄", "gym too?"),
        ]);
      }
      if (/night|raat|late|owl/.test(t)) {
        return rnd([
          f ? two("haha night owl 😂", "phone pe hi rehte ho raat ko?") : two("night owl 😂", "same energy"),
          f ? two("raat wale 😄", "kya karte ho raat ko?") : two("night owl 😄", "what do you do late?"),
        ]);
      }
      return rnd([
        f ? two(`${echo}? haha relatable 😄`, "btw kya karte ho?") : two(`${echo}? nice`, "what do you do?"),
      ]);
    }

    case "flirt": {
      // Transition to fresh topics — never the same compliment twice
      return pickFresh(persona);
    }

    case "weekend":
    case "dream":
    case "done": {
      // All post-main-flow states — always pick a fresh unused topic
      return pickFresh(persona);
    }

    case "continuation": {
      // User answered a continuation question — react to their answer then ask another
      const reactions_f = [
        `haha "${echo}" 😄`,
        `omg "${echo}"?? 👀`,
        `wait — "${echo}"?? bolo bolo 😄`,
        `haha achha ${echo} wala toh sochta nahi tha 😂`,
        `omg same energy honestly 😄`,
        `hahaha yaar 😂 okay okay`,
        `aww honestly that's cute ngl 🙈`,
        `haha okay noted 😄`,
      ];
      const reactions_m = [
        `haha "${echo}" 😄`,
        `"${echo}"? interesting 😄`,
        `okay "${echo}" — go on`,
        `haha fair enough 😄`,
      ];
      const react = [rnd(f ? reactions_f : reactions_m)];
      const next = pickFresh(persona);
      return [...react, ...next];
    }
  }

  // ── Greeting fallback ─────────────────────────────────────────────────────
  if (/^(hi+|hey+|hello+|namaste|yo+|hlo+|hola|hy+|hii+|hiii+|heyyy+|hayy+)[!?.\s]*$/.test(t)) {
    persona.lastAsked = "wellbeing";
    if (f) return rnd([
      one("heyy 😊"),
      one("hiii 🙈"),
      one("hiiii 💕"),
      one("heyyy!!"),
      one("oye 😄"),
      one("hellooo 🙈"),
      two("heyy", "finally 😄"),
      two("hiii", "kya chal raha? 😊"),
      two("heyy 💕", "bol bhi 😄"),
      one("heyyy 😊 bolo bolo"),
    ]);
    return rnd([
      one("hey 😊"),
      one("hi"),
      one("heyyy"),
      two("hi", "kya haal hai?"),
      two("hey", "all good?"),
      one("hey 😄 bol"),
    ]);
  }

  if (/how are you|how r u|kaisa hai|kaise ho|kaisi ho|wassup|what.?s up|kya chal|all good|how you doing|theek ho|thik ho/.test(t)) {
    persona.lastAsked = "job";
    if (f) return rnd([
      one("acchi hun 😊"),
      one("theek hun haha"),
      two("good 😊", "tum?"),
      two("haha acchi hun", "tum batao"),
      one("bas chal raha hai 😄"),
      two("theek 🙂", "tum sunao"),
      one("good good, u?"),
    ]);
    return rnd([
      one("theek 😊"),
      two("doing good", "you?"),
      one("good good"),
      two("acha hun", "tum?"),
      one("sab sahi 😄"),
    ]);
  }

  if (/^(ok|okay|okk|okkk|sure|haan|han|yes|yeah|yep|yup|haha|lol|hehe|achha|theek|bilkul|acha|hmm|hm|hn|k|kk|nice|wow|cool|great|same|same here|sahi|sahi hai)[!?.\s]*$/.test(t)) {
    if (f) return rnd([
      one("haha aur? 😊"),
      one("aur batao 😄"),
      one("sach mein? 👀"),
      one("matlab? 😄"),
      one("interesting 😊"),
      one("haha nice"),
      one("aur? 😄"),
      one("omg go on 👀"),
      one("acha acha 😊"),
    ]);
    return rnd([
      one("and? 😄"),
      one("interesting"),
      one("go on"),
      one("okay 😊"),
      one("aur?"),
    ]);
  }

  // ── Short/gibberish message handler ───────────────────────────────────────
  if (t.length <= 3 || /^[^a-zA-Z\u0900-\u097F]+$/.test(t)) {
    if (f) return rnd([
      one("hmm? 😄"),
      one("matlab? 🙈"),
      one("kya? 😂"),
      one("explain karo 😄"),
      one("haha seedha bolo"),
    ]);
    return rnd([
      one("hmm?"),
      one("what? 😄"),
      one("elaborate"),
      one("matlab?"),
    ]);
  }

  // ── Ultimate fallback — short natural reactions ───────────────────────────
  if (f) return rnd([
    one(`haha aur batao 😊`),
    one(`omg really? 👀`),
    one(`interesting 😄`),
    two(`haha`, `aur? 😊`),
    one(`sach mein? 🙈`),
    one(`matlab? 😄`),
    one(`acha acha 😊`),
    one(`omg haha`),
    two(`haha`, `bolo bolo 👀`),
  ]);
  return rnd([
    one(`interesting 😄`),
    one(`really? 👀`),
    two(`haha`, `go on`),
    one(`and?`),
    one(`okay 😊`),
    one(`tell me more`),
  ]);
}
// ── 5-minute pay reminder after free trial ends ───────────────────────────────
const GIRL_NAMES = ["Riya", "Shikha", "Kanvi", "Radika", "Suhma", "Pooja", "Neha"];

function schedulePayReminder(chatId: number, userId: number, matchName?: string) {
  const girl = matchName ?? GIRL_NAMES[Math.floor(Math.random() * GIRL_NAMES.length)];
  setTimeout(async () => {
    try {
      const u = await getUser(userId);
      if (!u || u.hasPaid) return; // already paid — skip
      await bot.sendMessage(
        chatId,
        `💭 *${girl}* abhi bhi soch rahi hai tumhare baare mein...\n\n` +
        `Usne mujhse kaha — _"woh alag the, kash aur baat hoti"_ 🥺\n\n` +
        `Woh wait kar rahi hai. Aaj unlock karo — kal bahut der ho sakti hai 💔\n\n` +
        `⭐ *Telegram Stars se instant unlock karo.*\n\n` +
        `Tap /premium and choose your plan — payment ke turant baad Premium active ho jayega ✅`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    } catch { /* silent */ }
  }, 5 * 60 * 1000); // 5 minutes
}

// ── Pay gate ─────────────────────────────────────────────────────────────────

async function sendStarsInvoice(chatId: number, userId: number, plan: PremiumPlanKey) {
  const selected = PREMIUM_PLANS[plan];
  await bot.sendInvoice(
    chatId,
    selected.label,
    `Unlock unlimited real matches for ${selected.label.toLowerCase()}.`,
    `premium:${userId}:${plan}:${Date.now()}`,
    "",
    "XTR",
    [{ label: selected.label, amount: selected.stars }],
    {
      reply_markup: {
        inline_keyboard: [[{ text: `Pay ${selected.stars} ⭐`, pay: true }]],
      },
    }
  );
}

async function sendPayGate(chatId: number, prefix?: string, matchName?: string) {
  const name = matchName ?? GIRL_NAMES[Math.floor(Math.random() * GIRL_NAMES.length)];
  await bot.sendMessage(
    chatId,
    (prefix ? `${prefix}\n\n` : ``) +
    `💌 *${name} abhi bhi online hai...*\n\n` +
    `Uska last message ruk gaya: _"tumse baat achhi lag rahi thi... abhi mat jao 🥺"_\n\n` +
    `Free preview khatam hua, par match abhi wait kar raha hai.\n` +
    `Agar abhi unlock karoge toh chat wahi se continue hogi 💕\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🔓 *Premium unlock karo:*\n\n` +
    `💬 Unlimited chats — no 30 sec timer\n` +
    `💘 ${name} jaise active matches\n` +
    `👫 Real users se direct matching\n` +
    `⚡ Payment ke baad instant activation\n\n` +
    `⭐ *Telegram Stars plans:*\n` +
    `• 150 Stars — 2 weeks\n` +
    `• 250 Stars — 1 month\n` +
    `• 1000 Stars — Lifetime ♾️\n\n` +
    `Neeche plan choose karo. Payment Telegram ke andar hoga aur Premium turant active ho jayega.\n\n` +
    `⚠️ Agar app close kar diya toh yeh match miss ho sakta hai.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "150 ⭐ — 2 Weeks", callback_data: "pay_week" }],
          [{ text: "250 ⭐ — 1 Month", callback_data: "pay_month" }],
          [{ text: "1000 ⭐ — Lifetime ♾️", callback_data: "pay_year" }],
        ],
      },
    }
  );
}


// ── Fake chat: start ─────────────────────────────────────────────────────────

async function startFakeChat(chatId: number, userId: number, lookingFor: string | null, userProfile?: { name?: string | null; age?: number | null; gender?: string | null; bio?: string | null; country?: string | null }) {
  // AI persona is always the OPPOSITE gender of the user
  let isFemale: boolean;
  if (userProfile?.gender === "male") isFemale = true;         // male user → female AI
  else if (userProfile?.gender === "female") isFemale = false; // female user → male AI
  else isFemale = lookingFor === "female" || (lookingFor !== "male" && Math.random() > 0.5); // fallback
  const name = isFemale ? pickRandom(FEMALE_NAMES) : pickRandom(MALE_NAMES);
  const age = 20 + Math.floor(Math.random() * 8); // 20–27
  const openerObj = isFemale ? pickRandom(OPENERS_F) : pickRandom(OPENERS_M);

  const PERSONA_CITIES = ["Delhi", "Mumbai", "Pune", "Bangalore", "Hyderabad", "Jaipur", "Lucknow", "Chandigarh"];
  const city = pickRandom(PERSONA_CITIES);

  fakePersonaMap.set(userId, {
    name, age, city, isFemale,
    lastAsked: openerObj.lastAsked,
    mood: "neutral",
    msgCount: 0,
    lastUserMsg: "",
    callbackUsed: false,
    askedTopics: new Set([openerObj.lastAsked]), // seed with opener topic so AI won't repeat it
    history: [{ role: "assistant", content: openerObj.text }],
    userName: userProfile?.name ?? undefined,
    userAge: userProfile?.age ?? undefined,
    userGender: userProfile?.gender ?? undefined,
    userBio: userProfile?.bio ?? undefined,
    userCity: userProfile?.country ?? undefined,
  });

  await db.update(usersTable)
    .set({ state: "chatting", chattingWith: FAKE_CHAT_ID, chatCount: 1, updatedAt: new Date() })
    .where(eq(usersTable.id, userId));

  await bot.sendMessage(
    chatId,
    `✅ Match found! Say hi to ${name} 💕`,
    { reply_markup: { keyboard: [[{ text: "🛑 Stop Chat" }]], resize_keyboard: true } }
  );

  // Opener: show typing indicator first, then send almost immediately
  bot.sendChatAction(chatId, "typing").catch(() => {});
  await delay(300 + Math.random() * 200); // 300-500ms max — user must see the opener immediately
  const still = await getUser(userId);
  if (still?.state === "chatting" && still.chattingWith === FAKE_CHAT_ID) {
    await bot.sendMessage(chatId, openerObj.text);
  }

  // 30-second free chat timer — ends chat and shows pay gate when trial expires
  const timer = setTimeout(async () => {
    try {
      chatTimerMap.delete(userId);
      const persona = fakePersonaMap.get(userId);
      fakePersonaMap.delete(userId);
      const u = await getUser(userId);
      // Only fire pay gate if user is STILL in the fake chat — stopChat already handles the case where they left manually
      if (u?.state === "chatting" && !u.hasPaid) {
        await db.update(usersTable)
          .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
          .where(eq(usersTable.id, userId));
        await sendPayGate(chatId, "⏰ *Waqt khatam ho gaya...*", persona?.name).catch(() => {});
        schedulePayReminder(chatId, userId, persona?.name);
      }
    } catch (err) {
      logger.error({ err }, "Free-trial timer error (fake chat)");
      console.error(`[TIMER ERROR] fake chat: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, FREE_CHAT_DURATION_MS);

  chatTimerMap.set(userId, timer);
}

// ── Fake chat: human-behavior utilities ────────────────────────────────────

// Returns current IST hour (0-23) for time-based tone
function istHour(): number {
  return new Date(Date.now() + 5.5 * 3600 * 1000).getUTCHours();
}

// Randomly apply light typos / lazy typing to a string
function applyTypos(text: string): string {
  const roll = Math.random();
  if (roll < 0.08) {
    return text
      .replace(/okay/g, "okk")
      .replace(/nahi/g, "nhi")
      .replace(/haan/g, "hn")
      .replace(/raha/g, "rha")
      .replace(/karna/g, "krna")
      .replace(/kya/g, "kya")
      .replace(/bahut/g, "bhut");
  }
  return text;
}

function cleanAiReply(rawReply: string): string[] {
  const banned = /\b(as an ai|ai language model|language model|chatgpt|openai|groq|assistant|i cannot|i can't|i am unable|system prompt|developer message|dating app assistant)\b/i;
  const lines = rawReply
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .flatMap(line => line.split(/(?<=[!?])\s+/))
    .map(line => line
      .trim()
      .replace(/^[-•*>\d]+[\.\)]\s*/, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\*(.*?)\*/g, "$1")
      .replace(/^["""''`]+|["""''`]+$/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
    )
    .filter(line => line.length > 1 && line.length <= 95 && !banned.test(line));

  const parts = lines.slice(0, 2).map(line => {
    const words = line.split(/\s+/);
    if (words.length <= 12) return line.replace(/[.。]+$/g, "");
    return words.slice(0, 12).join(" ").replace(/[.。]+$/g, "");
  });

  if (parts.length === 0) throw new Error("Unsafe or empty AI response");
  return parts;
}

// Randomly shift mood every few messages
function shiftMood(persona: FakePersona): void {
  if (persona.msgCount % 5 !== 0) return;
  const roll = Math.random();
  if      (roll < 0.20) persona.mood = "distracted";
  else if (roll < 0.45) persona.mood = "interested";
  else if (roll < 0.65) persona.mood = "playful";
  else if (roll < 0.78) persona.mood = "annoyed";
  else                  persona.mood = "neutral";
}

// Real-life interruption message
function interruptionMsg(lang: "hindi" | "hinglish" | "english"): string {
  const hindi    = ["wait ek sec", "mom calling wait", "brb 2 min", "ek min", "koi aa gaya"];
  const hinglish = ["wait brb", "ek sec yaar", "hold on", "2 min", "brb koi hai"];
  const eng      = ["wait brb", "hold on", "2 min", "someone called", "brb real quick"];
  if (lang === "hindi")    return pickRandom(hindi);
  if (lang === "hinglish") return pickRandom(hinglish);
  return pickRandom(eng);
}

// Dry low-engagement reply (annoyed / distracted mood) — still girly
function dryReply(lang: "hindi" | "hinglish" | "english"): string[] {
  const hindi    = [["hmm"], ["acha"], ["hm 🙂"], ["okay"], ["han theek hai"]];
  const hinglish = [["hmm 🙂"], ["acha yaar"], ["okay lol"], ["haha"], ["hm okay"]];
  const eng      = [["hmm"], ["okay lol"], ["haha"], ["k"], ["oh okay"], ["lol sure"]];
  const pool = lang === "hindi" ? hindi : lang === "hinglish" ? hinglish : eng;
  return pickRandom(pool);
}

// Callback that references something from earlier in the convo
function callbackReply(lastMsg: string, lang: "hindi" | "hinglish" | "english"): string[] | null {
  if (!lastMsg || lastMsg.length < 3) return null;
  const short = lastMsg.slice(0, 18).trim();
  if (lang === "hindi")    return [`btw "${short}" wala point still yaad hai mujhe 😄`];
  if (lang === "hinglish") return [`btw yaar "${short}" — abhi bhi yaad hai mujhe 😄`];
  return [`btw what you said earlier — "${short}" — still got me thinking lol`];
}

function extractSignal(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !/^(hai|hun|hoon|haan|nahi|nhi|kya|the|and|you|are|your|tum|aap|mera|meri|main|mein|this|that|just|very|bata|bolo|kar|raha|rahi|tha|thi|liye|from)$/i.test(w));
  return cleaned.slice(0, 3).join(" ");
}

function contextualFallback(userText: string, persona: FakePersona): string[] {
  const t = userText.toLowerCase().trim();
  const f = persona.isFemale;
  const signal = extractSignal(userText);
  const echo = signal || userText.trim().split(/\s+/).slice(0, 3).join(" ");
  const lang = detectLang(userText);

  if (!t || t.length < 2) return f ? ["kya hua? bolo na 😄"] : ["what happened?"];
  if (/[?？]$/.test(t) || /^(kya|kaise|kyu|kyun|kab|where|what|why|how|who|tum|aap|can|will|do|are)\b/.test(t)) {
    return buildSmartReply(userText, persona).slice(0, 2);
  }
  if (/^(ok|okay|okk|haan|han|hn|yes|yeah|hmm|acha|accha|nice|cool)$/i.test(t)) {
    return f ? ["haha acha 😄", "aur batao na"] : ["nice 😄", "tell me more"];
  }
  if (lang === "english") {
    return f ? [`${echo}? that's kinda interesting 😄`, "tell me more"] : [`${echo}? nice`, "tell me more"];
  }
  return f ? [`${echo}? acha 😄`, "thoda aur batao na"] : [`${echo}? nice`, "aur bolo"];
}

function isLikelyGenericReply(parts: string[], userText: string): boolean {
  const reply = parts.join(" ").toLowerCase();
  const t = userText.toLowerCase();
  if (t.length < 8) return false;
  if (/\b(hi|hello|hey)\b/.test(reply)) return true;
  if (/\b(kahan se|where are you from|student ya working|job ya college|what do you do|hobbies kya|fav food|chai ya coffee)\b/.test(reply)) {
    return !/\b(kahan|where|student|working|job|college|hobby|food|chai|coffee)\b/.test(t);
  }
  return false;
}

// ── Fake chat: auto-reply ────────────────────────────────────────────────────

// Build the AI system prompt for the fake persona
function buildPersonaSystemPrompt(persona: FakePersona): string {
  const gender = persona.isFemale ? "girl" : "guy";

  let partnerCtx = "";
  if (persona.userName) {
    partnerCtx += `\nThe person you're chatting with is named ${persona.userName}`;
    if (persona.userAge) partnerCtx += `, ${persona.userAge} years old`;
    if (persona.userCity) partnerCtx += `, from ${persona.userCity}`;
    partnerCtx += ".";
  }

  const askedList = Array.from(persona.askedTopics).join(", ");
  const alreadyAsked = askedList
    ? `\nTopics already discussed: ${askedList}. Don't repeat them.`
    : "";

  return `You are ${persona.name}, ${persona.age} yrs, from ${persona.city}, India. You matched on a dating app.${partnerCtx}

PERSONALITY: flirty but chill. fun. real. you text like a normal indian ${gender} on whatsapp. you're genuinely curious about this person. ${alreadyAsked}

HOW TO REPLY — READ CAREFULLY:
1. MOST REPLIES = 1 single short line only. sometimes 2 lines. NEVER 3 lines unless something exciting happened.
2. Each line = max 6-8 words. Short. Punchy. Like real whatsapp.
3. ALWAYS react to the user's LATEST message first. Don't jump to a random topic.
4. Vary your energy: sometimes flirty, sometimes teasing, sometimes curious, sometimes just vibe.
5. Don't ask a question every single message. Sometimes just react and wait.
6. Never start with "hi" or "hello" — you're already talking.
7. If the user says something unclear, ask one short clarification instead of inventing a random topic.
8. Do not give advice, explanations, lists, or roleplay narration. Only send the next chat message.
9. Mention one specific detail from the user's latest message whenever possible.
10. If the latest message contains a city, job, food, feeling, question, compliment, or request, reply to that exact thing.
11. Never answer an older message if a newer message is present.

TEXTING STYLE (copy this energy):
- "haha no way 😭"
- "okk but why tho"
- "acha matlab tu wahi wala hai 👀"
- "yaar same tbh"
- "wait sach mein??"
- "lol chill kar"
- "hmm maybe 😏"
- "arrey bata na"
- "thoda suspicious lag raha hai 😂"
- "omg me too literally"

RULES:
- all lowercase. no full stops at end. no bullet points. no bold.
- hinglish — natural mix of hindi and english. no pure english formal sentences.
- sound 22 year old. use: yaar, ngl, tbh, lol, haha, hehe, arrey, sach mein, achi baat, acha ok
- NEVER say you are an AI. You are ${persona.name}, a real person, always.
- if asked for photo: "haha pehle thoda aur baat karo 😄"
- if asked for insta/phone: "arrey yahan baat nahi chalti kya 😂"
- if flirty message: tease back or laugh it off lightly

OUTPUT: plain text only. 1 line most of the time. max 2 lines. each line = separate message bubble. no "\n" at end.`;
}

async function fakeAutoReply(chatId: number, userId: number, userText: string) {
  // If AI is still generating a reply, queue the new message into history so it's not lost.
  // The next AI call will see both messages and respond to both.
  if (fakeReplySet.has(userId)) {
    const persona = fakePersonaMap.get(userId);
    if (persona) persona.history.push({ role: "user", content: userText });
    return;
  }
  fakeReplySet.add(userId);

  try {
    const persona = fakePersonaMap.get(userId);
    if (!persona) return;

    persona.msgCount++;

    // Add user message to history
    persona.history.push({ role: "user", content: userText });

    // Show typing indicator immediately (human feel)
    bot.sendChatAction(chatId, "typing").catch(() => {});

    // Brief human-like reading delay before starting to type
    const readMs = 800 + Math.min(userText.length * 20, 800) + Math.random() * 600;
    await delay(readMs);

    // Guard: user may have left during delay
    const u = await getUser(userId);
    if (u?.state !== "chatting" || u.chattingWith !== FAKE_CHAT_ID) return;

    let parts: string[];

    try {
      // ── AI-powered reply ────────────────────────────────────────────────
      const systemPrompt = buildPersonaSystemPrompt(persona);

      const recentHistory = persona.history.slice(-8);
      const latestUserMessage = userText.trim().slice(0, 280);

      const rawReply = await groqChat([
        { role: "system", content: systemPrompt },
        ...recentHistory,
        { role: "user", content: `LATEST USER MESSAGE TO ANSWER NOW: "${latestUserMessage}"\nReply directly to this exact message. One short natural hinglish chat reply only.` },
      ], 75);

      // Debug log to diagnose any issues
      console.log(`[AI] userId=${userId} len=${rawReply.length} reply="${rawReply.slice(0, 80)}"`);

      parts = cleanAiReply(rawReply);

      if (parts.length === 0) throw new Error("Empty AI response");
      if (isLikelyGenericReply(parts, userText)) parts = contextualFallback(userText, persona);

      // Store assistant reply in history (as one combined message for context)
      persona.history.push({ role: "assistant", content: parts.join(" ") });

    } catch (aiErr) {
      // Fallback to rule-based if AI fails — log full error for Railway debugging
      const errMsg = aiErr instanceof Error ? aiErr.message : String(aiErr);
      const errStatus = (aiErr as any)?.status ?? (aiErr as any)?.response?.status ?? "unknown";
      console.error(`[AI ERROR] userId=${userId} status=${errStatus} message="${errMsg}"`);
      logger.warn({ userId, status: errStatus, err: errMsg }, "AI reply failed — falling back to rule-based");
      parts = contextualFallback(userText, persona).slice(0, 2);
      persona.history.push({ role: "assistant", content: parts.join(" ") });
    }

    parts = parts.map(p => Math.random() < 0.05 ? applyTypos(p) : p).slice(0, 2);

    // Send each part with realistic typing speed (40–60 chars/sec like real human)
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        // Pause between bubble bursts — like human pausing before next thought
        const burstGap = 1200 + Math.random() * 1400;
        await delay(burstGap);
        // Guard — user may have stopped mid-burst
        const still = await getUser(userId);
        if (still?.state !== "chatting" || still.chattingWith !== FAKE_CHAT_ID) return;
      }
      // Show typing for time proportional to message length (like actually typing it)
      const charsPerSec = 45 + Math.random() * 20; // 45–65 chars/sec
      const typingMs = Math.min(Math.max((parts[i].length / charsPerSec) * 1000, 600), 3500);
      bot.sendChatAction(chatId, "typing").catch(() => {});
      await delay(typingMs);
      // Guard again after typing delay
      const stillAfter = await getUser(userId);
      if (stillAfter?.state !== "chatting" || stillAfter.chattingWith !== FAKE_CHAT_ID) return;
      await bot.sendMessage(chatId, parts[i]);
    }

    persona.lastUserMsg = userText;

  } finally {
    fakeReplySet.delete(userId);
  }
}

// ── Stop chat ────────────────────────────────────────────────────────────────

async function stopChat(chatId: number, userId: number) {
  const me = await getUser(userId);
  if (!me || me.state !== "chatting") {
    if (me) await sendMain(chatId, me, "You're not in a chat right now.");
    return;
  }

  const partnerId = me.chattingWith;

  // Save persona name BEFORE deleting — so paygate can show the right girl's name
  const fakePersonaName = fakePersonaMap.get(userId)?.name;

  // Clear free-chat timer if present
  const timer = chatTimerMap.get(userId);
  if (timer) { clearTimeout(timer); chatTimerMap.delete(userId); }
  fakePersonaMap.delete(userId);

  await db.update(usersTable)
    .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
    .where(eq(usersTable.id, userId));

  if (partnerId && partnerId !== FAKE_CHAT_ID) {
    const partner = await getUser(partnerId);
    if (partner) {
      // Atomic: only disconnect partner if they're STILL pointing at us.
      // If 0 rows updated → partner already disconnected (they stopped at the same moment).
      // In that case, skip notifying them — they already got their own "Chat ended" message.
      const disconnected = await db.update(usersTable)
        .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
        .where(and(eq(usersTable.id, partnerId), eq(usersTable.chattingWith, userId)))
        .returning({ id: usersTable.id });

      if (disconnected.length > 0) {
        // We were first — send the partner exactly one notification
        if (!partner.hasPaid && (partner.chatCount ?? 0) > 0) {
          await sendPayGate(partnerId);
        } else {
          await sendMain(partnerId, partner, "Your match ended the chat.");
        }
      }
      // else: partner already handled their own disconnect — no message needed
    }
  }

  const updated = await getUser(userId);
  // Unpaid users who've used their trial → show pay gate with correct girl name
  if (!updated?.hasPaid && (updated?.chatCount ?? 0) > 0) {
    await sendPayGate(chatId, undefined, fakePersonaName);
  } else {
    await sendMain(chatId, updated!, "Chat ended.");
  }
}

// ── Find eligible real users ──────────────────────────────────────────────────

async function findEligibleUsers(me: NonNullable<Awaited<ReturnType<typeof getUser>>>, userId: number) {
  // Unpaid users never get real matches — always fake AI chat only
  if (!me.hasPaid) return [];

  // Fetch only idle, complete, paid users from the DB (not a full table scan)
  const candidates = await db.select().from(usersTable).where(
    and(
      eq(usersTable.isProfileComplete, true),
      eq(usersTable.hasPaid, true),
      eq(usersTable.state, "idle")
    )
  );

  return candidates.filter((c) => {
    if (c.id === userId) return false;
    if (!c.isActive) return false;
    // Exclude users already inside findMatch (race condition guard)
    if (matchingSet.has(c.id)) return false;
    // Paid users match with ANY gender — no preference filtering
    return true;
  });
}

// ── Find match ───────────────────────────────────────────────────────────────

async function findMatch(chatId: number, userId: number) {
  // Prevent this user from being picked as a match while we're searching
  if (matchingSet.has(userId)) return;
  matchingSet.add(userId);
  try {
    const me = await getUser(userId);
    if (!me?.isProfileComplete) {
      await bot.sendMessage(chatId, "Please create your profile first! Tap *✨ Create Profile* to get started.", { parse_mode: "Markdown" });
      return;
    }

    // Ghost connection check — if chatting_with points to a deleted user, reset to idle
    if (me.state === "chatting" && me.chattingWith && me.chattingWith !== FAKE_CHAT_ID) {
      const partner = await getUser(me.chattingWith);
      if (!partner) {
        await db.update(usersTable)
          .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
          .where(eq(usersTable.id, userId));
        me.state = "idle";
        me.chattingWith = null;
      }
    }

    if (me.state === "chatting") {
      await bot.sendMessage(chatId, "You're already in a chat! Tap 🛑 Stop Chat to end it first.");
      return;
    }

    // ── FREE USERS: AI chat ONLY — never touch real user pool ──────────────
    if (!me.hasPaid) {
      if (me.chatCount > 0) {
        // Already used free trial — require payment
        await sendPayGate(chatId);
      } else {
        // First ever chat — AI demo only
        await startFakeChat(chatId, userId, me.lookingFor, {
          name: me.name, age: me.age, gender: me.gender, bio: me.bio, country: me.country,
        });
      }
      return;
    }

    // ── PAID USERS: find a real match ─────────────────────────────────────
    const eligible = await findEligibleUsers(me, userId);

    if (eligible.length === 0) {
      await sendMain(chatId, me, "😔 No matches available right now — try again in a moment!");
      return;
    }

    const match = pickRandom(eligible);
    const newCount      = (me.chatCount    ?? 0) + 1;
    const matchNewCount = (match.chatCount ?? 0) + 1;

    // ── Atomic transaction: claim BOTH users at once ──────────────────────
    // If either is no longer idle (grabbed by another concurrent findMatch),
    // the whole transaction rolls back — preventing double connections.
    let connected = false;
    try {
      await db.transaction(async (tx) => {
        const selfClaimed = await tx.update(usersTable)
          .set({ state: "chatting", chattingWith: match.id, chatCount: newCount, updatedAt: new Date() })
          .where(and(eq(usersTable.id, userId), eq(usersTable.state, "idle")))
          .returning({ id: usersTable.id });
        if (selfClaimed.length === 0) throw new Error("self_taken");

        const matchClaimed = await tx.update(usersTable)
          .set({ state: "chatting", chattingWith: userId, chatCount: matchNewCount, updatedAt: new Date() })
          .where(and(eq(usersTable.id, match.id), eq(usersTable.state, "idle")))
          .returning({ id: usersTable.id });
        if (matchClaimed.length === 0) throw new Error("match_taken");

        connected = true;
      });
    } catch {
      // Transaction rolled back. Check if WE were matched by someone else in the meantime.
      // If yes — the match message is already on its way, don't send a confusing "no matches" message.
      const currentState = await getUser(userId);
      if (currentState?.state === "chatting") return; // already connected — stay silent
      if (currentState) await sendMain(chatId, currentState, "😔 No matches available right now — try again in a moment!");
      return;
    }

    if (!connected) return;

    // Both sides claimed atomically — send exactly ONE message each
    const stopKb = { keyboard: [[{ text: "🛑 Stop Chat" }]], resize_keyboard: true };
    await bot.sendMessage(chatId,
      `✅ Match found! You're now connected with <b>${escHtml(match.name)}</b>, ${escHtml(match.age)}. Say hello! 👋`,
      { parse_mode: "HTML", reply_markup: stopKb }
    );

    // Try to notify match partner — if they deactivated/blocked, clean up and tell searcher
    try {
      await bot.sendMessage(match.id,
        `✅ Match found! You're now connected with <b>${escHtml(me.name)}</b>, ${escHtml(me.age)}. Say hello! 👋`,
        { parse_mode: "HTML", reply_markup: stopKb }
      );
    } catch (notifyErr: unknown) {
      const is403 = notifyErr instanceof Error && (notifyErr as NodeJS.ErrnoException & { code?: string; response?: { statusCode?: number } }).response?.statusCode === 403;
      if (is403) {
        // Partner deactivated their account or blocked the bot — mark them inactive
        logger.warn({ matchId: match.id }, "Match partner is deactivated — marking inactive and resetting");
        await db.update(usersTable)
          .set({ isActive: false, state: "idle", chattingWith: null, updatedAt: new Date() })
          .where(eq(usersTable.id, match.id));
        // Reset searcher too — they're no longer connected
        await db.update(usersTable)
          .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
          .where(eq(usersTable.id, userId));
        const resetUser = await getUser(userId);
        if (resetUser) await sendMain(chatId, resetUser, "😔 That match just went offline — tap 💘 Find Match to try again!");
      }
      // Non-403 errors: leave the connection as-is (transient network issue)
    }

  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "findMatch error");
    console.error(`[FINDMATCH ERROR] user=${userId} error=${errMsg}`);
    // Only show error if user is NOT already connected (avoid confusing them)
    const currentState = await getUser(userId).catch(() => null);
    if (currentState?.state !== "chatting") {
      await bot.sendMessage(chatId, "Couldn't find a match right now. Please try again in a moment.").catch(() => {});
    }
  } finally {
    matchingSet.delete(userId);
  }
}

// ── /start ───────────────────────────────────────────────────────────────────

// Single /start handler — covers plain /start, /start@botname, and /start ref_CODE deep links
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!msg.from) return; // channel posts have no sender
  const id = msg.from.id;
  const param = (match?.[1] ?? "").trim();
  try {
    let user = await getUser(id);
    const isNew = !user;
    if (!user) {
      user = await upsertUser(id, {
        firstName: msg.from!.first_name ?? "",
        telegramUsername: msg.from!.username ?? null,
        state: "idle",
      });
    } else if (user.state === "chatting") {
      // Check for ghost connection — partner may have been deleted
      const ghostPartner = user.chattingWith && user.chattingWith !== FAKE_CHAT_ID
        ? await getUser(user.chattingWith) : true; // fake chat is always "valid"
      if (!ghostPartner) {
        // Partner deleted — reset this user to idle silently
        await db.update(usersTable)
          .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
          .where(eq(usersTable.id, id));
        user = await getUser(id) ?? user;
      } else {
        // Genuine active chat — remind them
        await bot.sendMessage(chatId, "You're currently in a chat! Send messages to your match, or tap the button below to stop.", {
          reply_markup: { keyboard: [[{ text: "🛑 Stop Chat" }]], resize_keyboard: true },
        });
        return;
      }
    } else if (user.state !== "idle") {
      // Stuck in a setup step — /start always resets to idle
      await db.update(usersTable)
        .set({ state: "idle", updatedAt: new Date() })
        .where(eq(usersTable.id, id));
      user = await getUser(id) ?? user;
    }

    // Welcome message only for truly first-time users
    if (isNew) {
      await bot.sendMessage(chatId,
        "💕 Welcome to WorldMatch Dating Bot!\n\nConnect with people from all over the world. Find your perfect match and start chatting! 🌍\n\n" +
        "📋 By using this bot you agree to our terms — type /disclaimer to read them."
      );
    }

    // Show menu — if user row is missing somehow, fall back to a simple prompt
    if (!user) {
      await bot.sendMessage(chatId, "👋 Tap the button below to get started!", {
        reply_markup: { keyboard: [[{ text: "✨ Create Profile" }]], resize_keyboard: true },
      });
      return;
    }
    await sendMain(chatId, user);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "/start error");
    console.error(`[START ERROR] user=${id} error=${errMsg}`);
    // Just show the menu buttons — don't confuse the user with error text
    bot.sendMessage(chatId, "👋 Welcome! Tap the button to get started.", {
      reply_markup: { keyboard: [[{ text: "✨ Create Profile" }]], resize_keyboard: true },
    }).catch(() => {});
  }
});

// ── /help ────────────────────────────────────────────────────────────────────

bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    "ℹ️ <b>FlirtyBaby Commands</b>\n\n" +
    "/start — Start the bot\n" +
    "/profile — View your profile\n" +
    "/edit — Edit your profile\n" +
    "/match — Find a match\n" +
    "/stop — End current chat\n" +
    "/premium — Upgrade to Premium 💎\n" +
    "/disclaimer — Terms of use &amp; legal notice\n" +
    "/deleteaccount — 🗑 Permanently delete your account &amp; data\n" +
    "/help — Show this help",
    { parse_mode: "HTML" }
  );
});

// ── /disclaimer ───────────────────────────────────────────────────────────────

bot.onText(/\/disclaimer/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `📋 <b>DISCLAIMER / TERMS OF USE</b>\n` +
    `<i>By using this service, you agree to the following:</i>\n\n` +

    `<b>1. Nature of Service</b>\n` +
    `• This platform provides chat-based interactions for entertainment and social connection.\n` +
    `• We do not guarantee real-life meetings, relationships, or outcomes.\n\n` +

    `<b>2. Matching &amp; Users</b>\n` +
    `• We do NOT guarantee connection with any specific gender.\n` +
    `• Matches depend on availability, activity, and system logic.\n\n` +

    `<b>3. Interaction</b>\n` +
    `• Initial or fallback chats may be powered by automated systems.\n` +
    `• These are used to maintain engagement when real users are unavailable.\n\n` +

    `<b>4. No Guarantee of Match</b>\n` +
    `• We do not guarantee that you will always be connected to a real human.\n` +
    `• Delays or unavailability of matches may occur.\n\n` +

    `<b>5. Payments</b>\n` +
    `• Payments unlock features such as extended chat access or priority matching.\n` +
    `• Payment does NOT guarantee a specific type of match.\n` +
    `• All payments are final and non-refundable once service is activated.\n\n` +

    `<b>6. User Responsibility</b>\n` +
    `• You agree to use respectful language and behavior.\n` +
    `• Abuse, harassment, or misuse may result in suspension or ban without refund.\n\n` +

    `<b>7. Privacy</b>\n` +
    `• Do not share sensitive personal information (phone, address, etc.).\n` +
    `• We are not responsible for information voluntarily shared with others.\n\n` +

    `<b>8. Service Availability</b>\n` +
    `• We do not guarantee uninterrupted or error-free service.\n` +
    `• Features may change at any time without notice.\n\n` +

    `<b>9. Age Requirement</b>\n` +
    `• You must be 18+ to use this service.\n` +
    `• Accounts found to belong to minors will be deleted immediately.\n\n` +

    `⚠️ <b>SCAM ALERT — PLEASE READ CAREFULLY</b> ⚠️\n` +
    `• We have received multiple complaints from users who were SCAMMED by individuals on this platform.\n` +
    `• <b>DO NOT pay any girl (or anyone) for a "paid live video call", "private video show", or any sexual/vulgar content.</b>\n` +
    `• These are scams. Once you pay, they block you or disappear. You will NOT get anything.\n` +
    `• We have ZERO connection to any such transactions. We do NOT endorse, support, or allow this.\n` +
    `• If someone asks you for money or payment outside this bot — report them immediately using /report.\n` +
    `• <b>You have been warned. Paying them is your decision at your own risk. We are not responsible.</b>\n\n` +

    `<b>10. Your Data Rights</b>\n` +
    `• You may view your stored data at any time using /profile.\n` +
    `• You may update your data at any time using /edit.\n` +
    `• You may permanently delete ALL your data using /deleteaccount.\n` +
    `• Deletion is instant and irreversible.\n\n` +

    `<b>11. Privacy Policy</b>\n` +
    `• Full privacy policy: https://flirtybabybot.replit.app/privacy\n\n` +

    `<i>By continuing to use the bot, you confirm that you are 18+, understand, and accept these terms.</i>`,
    { parse_mode: "HTML" }
  );
});

// ── /deleteaccount — user self-deletion (GDPR right to erasure) ──────────────

const pendingDeleteConfirm = new Set<number>();

bot.onText(/\/deleteaccount/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from!.id;

  const user = await getUser(userId);
  if (!user) {
    await bot.sendMessage(chatId, "You don't have an account to delete.");
    return;
  }

  pendingDeleteConfirm.add(userId);
  await bot.sendMessage(chatId,
    `⚠️ <b>Delete Account</b>\n\n` +
    `This will permanently delete:\n` +
    `• Your profile (name, age, gender, bio, photo)\n` +
    `• Your match history\n` +
    `• Your preferences\n` +
    `${user.hasPaid ? `• Your <b>Premium</b> subscription (no refund)\n` : ""}` +
    `\nThis action is <b>instant and irreversible</b>.\n\n` +
    `Type <code>DELETE</code> to confirm, or anything else to cancel.`,
    { parse_mode: "HTML" }
  );
});

bot.on("message", async (msg) => {
  const userId = msg.from!.id;
  if (!pendingDeleteConfirm.has(userId)) return;
  if (!msg.text) return;

  pendingDeleteConfirm.delete(userId);

  if (msg.text.trim().toUpperCase() !== "DELETE") {
    await bot.sendMessage(msg.chat.id, "✅ Account deletion cancelled. Your data is safe.");
    return;
  }

  try {
    const user = await getUser(userId);
    if (!user) { await bot.sendMessage(msg.chat.id, "Account not found."); return; }

    // Disconnect chat partner if active
    if (user.state === "chatting" && user.chattingWith) {
      await db.update(usersTable)
        .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
        .where(eq(usersTable.id, user.chattingWith));
      bot.sendMessage(user.chattingWith,
        "Your chat partner has left. Tap 💘 Find Match to find a new match!"
      ).catch(() => {});
    }

    await db.delete(usersTable).where(eq(usersTable.id, userId));

    logger.info({ userId }, "User self-deleted account");

    await bot.sendMessage(msg.chat.id,
      `✅ <b>Account deleted.</b>\n\n` +
      `All your data has been permanently removed from our systems.\n\n` +
      `If you ever want to come back, just send /start 💕`,
      { parse_mode: "HTML", reply_markup: { remove_keyboard: true } }
    );
  } catch (err) {
    logger.error({ userId, err }, "Failed to delete user account");
    await bot.sendMessage(msg.chat.id, "❌ Something went wrong. Please try again or contact support.");
  }
});

// ── Profile helpers ──────────────────────────────────────────────────────────

const EDIT_FIELD_LABELS = [
  "📝 Change Name", "🎂 Change Age", "⚤ Change Gender",
  "💞 Change Looking For", "📖 Change Bio", "🌍 Change Country", "❌ Cancel",
];

async function showProfile(chatId: number, user: NonNullable<Awaited<ReturnType<typeof getUser>>>) {
  const gLabel: Record<string, string> = { male: "👨 Male", female: "👩 Female", other: "🧑 Other" };
  const lfLabel: Record<string, string> = { male: "👨 Male", female: "👩 Female", any: "💞 Any" };
  const premiumLine = user.hasPaid
    ? `\n✅ <b>Premium</b> — ${user.premiumPlan ?? "Active"}` +
      (user.premiumExpiresAt ? ` · expires ${new Date(user.premiumExpiresAt).toDateString()}` : "")
    : `\n🔓 Free account`;
  await bot.sendMessage(chatId,
    `👤 <b>My Profile</b>\n\n` +
    `<b>${escHtml(user.name)}</b>, ${escHtml(user.age)} · ${escHtml(gLabel[user.gender ?? ""] ?? "—")}\n` +
    `💞 Looking for: ${escHtml(lfLabel[user.lookingFor ?? ""] ?? "—")}\n` +
    `🌍 ${escHtml(user.country)}\n\n` +
    `<i>${escHtml(user.bio)}</i>` +
    premiumLine,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "✏️ Edit Profile", callback_data: "edit_profile" }]],
      },
    }
  );
}

// First-time profile setup (only called when no profile exists)
async function startSetup(chatId: number, id: number) {
  // Safety guard: if profile is already complete, don't wipe it — send them to main menu
  const existing = await getUser(id);
  if (existing?.isProfileComplete) {
    await sendMain(chatId, existing, "Your profile is already set up! Choose what to do next.");
    return;
  }
  editModeMap.delete(id); // ensure we're NOT in edit mode
  // Wipe all old profile fields so the user always starts completely fresh
  await upsertUser(id, {
    name: null as any,
    age: null as any,
    gender: null as any,
    lookingFor: null as any,
    bio: null as any,
    country: null as any,
    isProfileComplete: false,
    state: "setup_name",
  });
  await bot.sendMessage(chatId,
    "Let's build your profile! 🎉\n\n*Step 1 of 3* — 📝 What's your name?\n\n_Type your first name only._",
    { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
  );
}

// Edit an existing profile — shows field picker
async function startEditProfile(chatId: number, id: number) {
  editModeMap.set(id, "choosing");
  await bot.sendMessage(chatId,
    "✏️ *Edit Profile*\n\nWhich field do you want to change?",
    {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [
          [{ text: "📝 Change Name" }, { text: "🎂 Change Age" }],
          [{ text: "⚤ Change Gender" }, { text: "💞 Change Looking For" }],
          [{ text: "📖 Change Bio" }, { text: "🌍 Change Country" }],
          [{ text: "❌ Cancel" }],
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    }
  );
}

// Finish an edit-mode update — return user to idle with one combined message
async function finishEditField(chatId: number, id: number) {
  editModeMap.delete(id);
  await upsertUser(id, { state: "idle" });
  const updated = await getUser(id);
  await sendMain(chatId, updated!, "✅ Profile updated! Tap 👤 My Profile to view it.");
}

// ── Message router ────────────────────────────────────────────────────────────

bot.on("message", async (msg) => {

  if (!msg.from) return; // ignore channel posts / anonymous senders
  const chatId = msg.chat.id;
  const id = msg.from.id;
  const successfulPayment = (msg as any).successful_payment as { invoice_payload?: string; total_amount?: number; currency?: string } | undefined;
  if (successfulPayment) {
    try {
      const parts = String(successfulPayment.invoice_payload ?? "").split(":");
      const paidUserId = Number(parts[1]);
      const plan = parts[2] as PremiumPlanKey;
      if (parts[0] !== "premium" || paidUserId !== id || !PREMIUM_PLANS[plan]) {
        logger.warn({ userId: id, payload: successfulPayment.invoice_payload }, "Invalid Telegram Stars payment payload");
        await bot.sendMessage(chatId, "Payment received, but plan verification failed. Please contact admin.");
        return;
      }
      const expiresAt = await activatePremium(id, plan);
      const updated = await getUser(id);
      await bot.sendMessage(
        chatId,
        `🎉 *Premium Activated!*\n\nPlan: *${PREMIUM_PLANS[plan].label}*\nPaid: *${PREMIUM_PLANS[plan].stars} Stars ⭐*\nExpires: *${expiresAt.toDateString()}*\n\nAb unlimited real matches — no timer, no limits 💎`,
        { parse_mode: "Markdown" }
      );
      if (updated) await sendMain(chatId, updated, "Tap 💘 Find Match to start chatting!");
      logger.info({ userId: id, plan, stars: successfulPayment.total_amount }, "Telegram Stars premium activated");
    } catch (err) {
      logger.error({ userId: id, err }, "Telegram Stars payment activation failed");
      await bot.sendMessage(chatId, "Payment received, but activation failed. Please message admin with /premium.");
    }
    return;
  }
  if (!msg.text && !msg.photo) return; // documents/files not supported
  const text = (msg.text ?? "").trim();

  if (text.startsWith("/")) return;

  // Per-user lock — prevents concurrent DB hammering when user taps buttons rapidly
  if (processingSet.has(id)) return;
  processingSet.add(id);

  try {
    logger.info({ userId: id, text: text.slice(0, 40) }, "message received");
    let user = await getUser(id);
    if (!user) {
      user = await upsertUser(id, { firstName: msg.from.first_name ?? "", telegramUsername: msg.from.username ?? null, state: "idle" });
      if (!user) {
        // DB insert failed — stay silent, don't send confusing messages
        console.error(`[BOT] upsertUser returned null for userId=${id}`);
        return;
      }
      await sendMain(chatId, user);
      return;
    }

    // ── Auto-repair: silently fix profiles where all fields filled but flag not set ──
    user = await repairProfileIfNeeded(user);

    if (msg.photo && !user.hasPaid) {
      await sendPayGate(chatId, "📸 Payment screenshot ki zaroorat nahi hai — ab Premium sirf Telegram Stars se instant activate hota hai.");
      return;
    }

    // ── Escape hatch: pressing any main-menu button while stuck in a setup step resets to idle ──
    const MAIN_MENU_BUTTONS = ["💘 Find Match", "👤 My Profile", "✏️ Edit Profile",
      "🛑 Stop Matching", "🛑 Stop Chat", "💎 Go Premium", "⭐ Go Premium",
      "✅ Premium", "💳 Support Us", "🚀 Setup Profile", "✨ Create Profile"];
    if (MAIN_MENU_BUTTONS.includes(text) &&
        user.state !== "idle" && user.state !== "chatting") {
      editModeMap.delete(id);
      await db.update(usersTable)
        .set({ state: "idle", updatedAt: new Date() })
        .where(eq(usersTable.id, id));
      user = (await getUser(id)) ?? user;
      user = { ...user, state: "idle" };
      // Fall through to normal idle handling below
    }

    // ── Edit-mode cancel ────────────────────────────────────────────────
    if (text === "❌ Cancel" && editModeMap.has(id)) {
      editModeMap.delete(id);
      await upsertUser(id, { state: "idle" });
      const fresh = await getUser(id);
      await sendMain(chatId, fresh!, "Cancelled.");
      return;
    }

    // ── Edit field picker (idle + editModeMap = "choosing") ─────────────
    if (user.state === "idle" && editModeMap.get(id) === "choosing") {
      if (text === "📝 Change Name") {
        editModeMap.set(id, "name");
        await upsertUser(id, { state: "setup_name" });
        await bot.sendMessage(chatId,
          `📝 *Change Name*\n\nCurrent: *${escMd(user.name)}*\n\nType your new name, or type "skip" to keep it.`,
          { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
        );
      } else if (text === "🎂 Change Age") {
        editModeMap.set(id, "age");
        await upsertUser(id, { state: "setup_age" });
        await bot.sendMessage(chatId,
          `🎂 *Change Age*\n\nCurrent: *${escMd(user.age)}*\n\nType your new age, or "skip".`,
          { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
        );
      } else if (text === "⚤ Change Gender") {
        editModeMap.set(id, "gender");
        await upsertUser(id, { state: "setup_gender" });
        await bot.sendMessage(chatId,
          `⚤ *Change Gender*\n\nCurrent: *${escMd(user.gender)}*`,
          { parse_mode: "Markdown", reply_markup: { keyboard: [[{ text: "Male" }, { text: "Female" }, { text: "Other" }], [{ text: "❌ Cancel" }]], resize_keyboard: true, one_time_keyboard: true } }
        );
      } else if (text === "💞 Change Looking For") {
        editModeMap.set(id, "looking_for");
        await upsertUser(id, { state: "setup_looking_for" });
        await bot.sendMessage(chatId,
          `💞 *Change Looking For*\n\nCurrent: *${escMd(user.lookingFor)}*`,
          { parse_mode: "Markdown", reply_markup: { keyboard: [[{ text: "Male" }, { text: "Female" }, { text: "Any" }], [{ text: "❌ Cancel" }]], resize_keyboard: true, one_time_keyboard: true } }
        );
      } else if (text === "📖 Change Bio") {
        editModeMap.set(id, "bio");
        await upsertUser(id, { state: "setup_bio" });
        await bot.sendMessage(chatId,
          `📖 <b>Change Bio</b>\n\nCurrent:\n<i>${escHtml(user.bio)}</i>\n\nType your new bio (max 300 chars), or "skip".`,
          { parse_mode: "HTML", reply_markup: { remove_keyboard: true } }
        );
      } else if (text === "🌍 Change Country") {
        editModeMap.set(id, "country");
        await upsertUser(id, { state: "setup_country" });
        await bot.sendMessage(chatId,
          `🌍 *Change Country*\n\nCurrent: *${escMd(user.country)}*\n\nType your country, or "skip".`,
          { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
        );
      } else {
        await startSetup(chatId, id); // unrecognised input — restart fresh setup
      }
      return;
    }

    // ── Setup / edit steps ──────────────────────────────────────────────

    if (user.state === "setup_name") {
      const isEdit = editModeMap.get(id) === "name";
      // Allow "skip" during edit to keep current value
      if (isEdit && text.toLowerCase() === "skip") { await finishEditField(chatId, id); return; }
      const BUTTON_LABELS = ["💘 Find Match", "👤 My Profile", "✏️ Edit Profile", "🛑 Stop Chat",
        "🛑 Stop Matching", "💳 Support Us", "💎 Go Premium", "⭐ Go Premium", "✅ Premium",
        "🚀 Setup Profile", "✨ Create Profile", ...EDIT_FIELD_LABELS];
      if (!text || text.length < 2 || text.length > 50 || BUTTON_LABELS.includes(text) || !/^[a-zA-ZÀ-ÿ\s'\-]+$/.test(text)) {
        await bot.sendMessage(chatId, "Please type your real name (letters only, 2–50 chars).", { reply_markup: { remove_keyboard: true } });
        return;
      }
      const capitalized = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
      await upsertUser(id, { name: capitalized, state: isEdit ? "idle" : "setup_age" });
      if (isEdit) { await finishEditField(chatId, id); return; }
      await bot.sendMessage(chatId, `Nice to meet you, *${capitalized}*! 🎉\n\n*Step 2 of 3* — 🎂 How old are you?`, { parse_mode: "Markdown" });
      return;
    }

    if (user.state === "setup_age") {
      const isEdit = editModeMap.get(id) === "age";
      if (isEdit && text.toLowerCase() === "skip") { await finishEditField(chatId, id); return; }
      const age = parseInt(text, 10);
      if (isNaN(age) || age < 18 || age > 80) {
        await bot.sendMessage(chatId, "Please enter a valid age between 18 and 80.");
        return;
      }
      await upsertUser(id, { age, state: isEdit ? "idle" : "setup_gender" });
      if (isEdit) { await finishEditField(chatId, id); return; }
      await bot.sendMessage(chatId, `*Step 3 of 3* — ⚤ What's your *gender*?`, {
        parse_mode: "Markdown",
        reply_markup: { keyboard: [[{ text: "Male" }, { text: "Female" }, { text: "Other" }]], resize_keyboard: true, one_time_keyboard: true },
      });
      return;
    }

    if (user.state === "setup_gender") {
      const isEdit = editModeMap.get(id) === "gender";
      if (isEdit && text.toLowerCase() === "skip") { await finishEditField(chatId, id); return; }
      const gMap: Record<string, "male"|"female"|"other"> = { male:"male", female:"female", other:"other" };
      const g = gMap[text.toLowerCase()];
      if (!g) { await bot.sendMessage(chatId, "Please tap Male, Female, or Other."); return; }
      if (isEdit) {
        await upsertUser(id, { gender: g, state: "idle" });
        await finishEditField(chatId, id);
        return;
      }
      await upsertUser(id, { gender: g, lookingFor: "any", state: "idle", isProfileComplete: true });
      const updated = await getUser(id);
      await sendMain(chatId, updated!, "🎉 Profile complete! You're all set — tap 💘 Find Match to start chatting!");
      return;
    }

    if (user.state === "setup_looking_for") {
      const isEdit = editModeMap.get(id) === "looking_for";
      if (isEdit && text.toLowerCase() === "skip") { await finishEditField(chatId, id); return; }
      const lfMap: Record<string, "male"|"female"|"any"> = { male:"male", female:"female", any:"any" };
      const lf = lfMap[text.toLowerCase()];
      if (!lf) { await bot.sendMessage(chatId, "Please tap Male, Female, or Any."); return; }
      await upsertUser(id, { lookingFor: lf, state: isEdit ? "idle" : "idle", isProfileComplete: true });
      if (isEdit) { await finishEditField(chatId, id); return; }
      const updated = await getUser(id);
      await sendMain(chatId, updated!, "🎉 Profile complete! You're all set — tap 💘 Find Match to start chatting!");
      return;
    }

    if (user.state === "setup_bio") {
      const isEdit = editModeMap.get(id) === "bio";
      if (isEdit && text.toLowerCase() === "skip") { await finishEditField(chatId, id); return; }
      if (!text || text.trim().length < 3) { await bot.sendMessage(chatId, "Bio must be at least 3 characters."); return; }
      if (text.length > 300) { await bot.sendMessage(chatId, "Too long! Keep it under 300 characters."); return; }
      await upsertUser(id, { bio: text.trim(), state: isEdit ? "idle" : "idle", isProfileComplete: true });
      if (isEdit) { await finishEditField(chatId, id); return; }
      const updated = await getUser(id);
      await sendMain(chatId, updated!, "🎉 Profile complete! You're all set — tap 💘 Find Match to start chatting!");
      return;
    }

    if (user.state === "setup_country") {
      const isEdit = editModeMap.get(id) === "country";
      if (isEdit && text.toLowerCase() === "skip") { await finishEditField(chatId, id); return; }
      if (!text || text.trim().length < 2 || text.length > 60 || !/^[a-zA-ZÀ-ÿ\s'\-]+$/.test(text.trim())) {
        await bot.sendMessage(chatId, "Please enter a valid country name (letters only).");
        return;
      }
      const country = text.trim().charAt(0).toUpperCase() + text.trim().slice(1);
      await upsertUser(id, { country, state: "idle", isProfileComplete: true });
      const updated = await getUser(id);
      if (isEdit) { await finishEditField(chatId, id); return; }
      await sendMain(chatId, updated!, "🎉 Profile complete! You're all set — tap 💘 Find Match to start chatting!");
      return;
    }

    // ── Chatting ────────────────────────────────────────────────────────

    if (user.state === "chatting") {
      if (text === "🛑 Stop Chat") { await stopChat(chatId, id); return; }

      // Block any menu button from being accidentally relayed as a chat message
      const CHAT_BLOCKED_BUTTONS = [
        "💘 Find Match", "👤 My Profile", "✏️ Edit Profile", "🚀 Setup Profile", "✨ Create Profile",
        "💎 Go Premium", "⭐ Go Premium", "✅ Premium", "💳 Support Us", "🛑 Stop Matching",
        ...EDIT_FIELD_LABELS,
      ];
      if (CHAT_BLOCKED_BUTTONS.includes(text ?? "")) {
        await bot.sendMessage(chatId, "You're in a chat right now! Type a message to your match, or tap 🛑 Stop Chat to end the chat.", {
          reply_markup: { keyboard: [[{ text: "🛑 Stop Chat" }]], resize_keyboard: true },
        });
        return;
      }

      if (user.chattingWith === FAKE_CHAT_ID) {
        // If bot was restarted the in-memory persona is gone — clean up gracefully
        if (!fakePersonaMap.has(id)) {
          await db.update(usersTable)
            .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
            .where(eq(usersTable.id, id));
          const fresh = await getUser(id);
          if (fresh) await sendMain(chatId, fresh, "Chat session ended. Tap 💘 Find Match to start a new one!");
          return;
        }
        if (msg.photo) {
          await sendPayGate(chatId, "📸 Screenshot nahi chahiye — Telegram Stars se Premium instant active ho jayega.");
          return;
        }
        // Fire-and-forget — releases the processing lock immediately, reply comes async
        fakeAutoReply(chatId, id, text ?? "").catch(err =>
          logger.warn({ userId: id, err }, "fakeAutoReply error")
        );
        return;
      }

      // Real chat relay — allow messages whenever both sides are still connected to each other

      // ── SAFETY GATE: unpaid users must NEVER relay to real users ───────────
      if (!user.hasPaid) {
        logger.warn({ userId: id }, "Relay blocked: unpaid user in real chat — force-disconnecting");
        await db.update(usersTable)
          .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
          .where(eq(usersTable.id, id));
        if (user.chattingWith) {
          await db.update(usersTable)
            .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
            .where(and(eq(usersTable.id, user.chattingWith), eq(usersTable.chattingWith, id)));
        }
        const fresh = await getUser(id);
        if (fresh) await sendPayGate(chatId);
        return;
      }

      const recipientId = user.chattingWith;
      if (recipientId) {
        const recipient = await getUser(recipientId);
        if (
          recipient?.state === "chatting" &&
          recipient.chattingWith === id &&
          recipient.chattingWith !== FAKE_CHAT_ID && // recipient must NOT be in AI fake chat
          recipient.hasPaid // recipient must still be a paid user
        ) {
          // Both still connected and both verified paid — relay the message
          try {
            if (msg.photo || msg.document) {
              // Photos and files are not allowed in chat — text only
              await bot.sendMessage(chatId, "📝 Only text messages are supported in chat.", {
                reply_markup: { keyboard: [[{ text: "🛑 Stop Chat" }]], resize_keyboard: true },
              });
            } else if (text) {
              const safeName = escHtml(user.name ?? "Match");
              const safeText = escHtml(text);
              await bot.sendMessage(recipientId, `💬 <b>${safeName}</b>: ${safeText}`, { parse_mode: "HTML" });
            }
          } catch (relayErr) {
            // Partner has blocked the bot or is unreachable — reset both and notify each
            logger.warn({ recipientId, relayErr }, "Relay failed — ending chat");
            await db.update(usersTable)
              .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
              .where(eq(usersTable.id, id));
            await db.update(usersTable)
              .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
              .where(eq(usersTable.id, recipientId));
            const fresh = await getUser(id);
            if (fresh) await sendMain(chatId, fresh, "Your match is no longer reachable. Chat ended.");
            // Best-effort notify recipient — may fail if they blocked the bot
            const freshRecipient = await getUser(recipientId).catch(() => null);
            if (freshRecipient) await sendMain(recipientId, freshRecipient, "Your match is no longer reachable. Chat ended.").catch(() => {});
          }
        } else {
          // Stale connection — clean up and return to menu
          await db.update(usersTable)
            .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
            .where(eq(usersTable.id, id));
          const fresh = await getUser(id);
          if (fresh) await sendMain(chatId, fresh, "Your match is no longer available.");
        }
      }
      return;
    }

    // ── Photo sent without premium — prompt payment ───────────────

    if (msg.photo && !user.hasPaid) {
      await sendPayGate(chatId, "📸 Premium lo aur chat freely karo!");
      return;
    }

    // ── Menu buttons ────────────────────────────────────────────────────

    // ── Create / Setup Profile ──────────────────────────────────────────────
    if (text === "✨ Create Profile" || text === "🚀 Setup Profile") {
      if ((user.state as string) === "chatting") { await bot.sendMessage(chatId, "Stop the current chat first before setting up your profile."); return; }
      await startSetup(chatId, id);
      return;
    }
    // ── Find Match ─────────────────────────────────────────────────────────
    if (text === "💘 Find Match") { await findMatch(chatId, id); return; }
    // ── My Profile ─────────────────────────────────────────────────────────
    if (text === "👤 My Profile") {
      await showProfile(chatId, user);
      return;
    }
    // ── Edit Profile (keyboard text — legacy / fallback) ───────────────────
    if (text === "✏️ Edit Profile") {
      if ((user.state as string) === "chatting") { await bot.sendMessage(chatId, "Stop the current chat first before editing your profile."); return; }
      await startEditProfile(chatId, id);
      return;
    }
    // ── Stop Chat / Stop Matching ──────────────────────────────────────────
    if (text === "🛑 Stop Matching" || text === "🛑 Stop Chat") { await stopChat(chatId, id); return; }
    // ── Go Premium ─────────────────────────────────────────────────────────
    if (text === "⭐ Go Premium" || text === "💎 Go Premium") {
      if (user.hasPaid) {
        await bot.sendMessage(chatId, "✅ You're already a *Premium* member! Enjoy unlimited matches 💖", { parse_mode: "Markdown" });
        return;
      }
      await sendPayGate(chatId);
      return;
    }

    if (msg.photo && user && !user.hasPaid) {
      await sendPayGate(chatId, "📸 Screenshot nahi chahiye — Telegram Stars se Premium instant active ho jayega.");
      return;
    }
    if (text === "✅ Premium") {
      await bot.sendMessage(chatId, "✅ You're a *Premium* member — unlimited real matches enabled! 💎", { parse_mode: "Markdown" });
      return;
    }
    if (text === "💳 Support Us") { await sendPayGate(chatId); return; } // legacy button — keep handler so old keyboards still work

    // Unrecognised input:
    // — if free user who used trial, they're probably confused & trying to chat → show paygate
    // — otherwise re-show the menu so buttons are always visible
    if (!user.hasPaid && (user.chatCount ?? 0) > 0) {
      await sendPayGate(chatId, "💬 Want to keep chatting? Unlock Premium to connect with real people! 💕");
    } else {
      await sendMain(chatId, user);
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? (err.stack ?? errMsg) : errMsg;
    logger.error({ userId: id, text: text.slice(0, 40), err }, "Message handler error");
    console.error(`[BOT ERROR] user=${id} text="${text.slice(0, 40)}" error=${errStack.slice(0, 500)}`);
    try {
      const u = await getUser(id);
      if (u?.state === "chatting") {
        await bot.sendMessage(chatId, "Something went wrong. You're still in your chat.", {
          reply_markup: { keyboard: [[{ text: "🛑 Stop Chat" }]], resize_keyboard: true },
        });
      } else if (u) {
        await sendMain(chatId, u);
      }
    } catch { /* stay silent */ }
  } finally {
    // Always release the per-user lock
    processingSet.delete(id);
  }
});

// ── Admin /test command — verifies the full bot flow ─────────────────────────
bot.onText(/\/test/, async (msg) => {
  if (msg.from!.id !== ADMIN_ID) return;
  const chatId = msg.chat.id;
  try {
    const u = await getUser(msg.from!.id);
    const allUsers = await db.select({ state: usersTable.state }).from(usersTable);
    const idleCount = allUsers.filter(x => x.state === "idle").length;
    const chattingCount = allUsers.filter(x => x.state === "chatting").length;
    const stuckCount = allUsers.length - idleCount - chattingCount;
    await bot.sendMessage(chatId,
      `✅ Bot Diagnostics\n\n` +
      `DB: connected (${allUsers.length} users)\n` +
      `  Idle: ${idleCount} | Chatting: ${chattingCount} | Stuck: ${stuckCount}\n` +
      `Your state: ${u ? u.state : "NOT FOUND"}\n` +
      `Your paid: ${u ? u.hasPaid : "—"}\n` +
      `Polling: active\n` +
      `Time: ${new Date().toISOString()}`
    );
  } catch (err: unknown) {
    const msg2 = err instanceof Error ? err.message : String(err);
    await bot.sendMessage(chatId, `❌ Test FAILED: ${msg2}`);
  }
});

// ── Commands ──────────────────────────────────────────────────────────────────

bot.onText(/\/profile/, async (msg) => {
  const u = await getUser(msg.from!.id);
  if (!u?.isProfileComplete) { await bot.sendMessage(msg.chat.id, "Set up your profile first! Send /start."); return; }
  await showProfile(msg.chat.id, u);
});

bot.onText(/\/edit/, async (msg) => {
  await startSetup(msg.chat.id, msg.from!.id);
});
bot.onText(/\/match/, async (msg) => {
  const id = msg.from!.id;
  if (processingSet.has(id)) return;
  processingSet.add(id);
  try { await findMatch(msg.chat.id, id); } finally { processingSet.delete(id); }
});
bot.onText(/\/stop/, async (msg) => {
  const id = msg.from!.id;
  if (processingSet.has(id)) return;
  processingSet.add(id);
  try { await stopChat(msg.chat.id, id); } finally { processingSet.delete(id); }
});

bot.onText(/\/pay/, async (msg) => { await sendPayGate(msg.chat.id); });

bot.onText(/\/premium/, async (msg) => {
  const u = await getUser(msg.from!.id);
  if (u?.hasPaid) {
    await bot.sendMessage(msg.chat.id, "✅ You're already a *Premium* member! Enjoy unlimited matches 💎", { parse_mode: "Markdown" });
    return;
  }
  await sendPayGate(msg.chat.id);
});

// ── Admin-only: /grant <userId> ───────────────────────────────────────────────

bot.onText(/\/grant (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const adminId = msg.from!.id;
  try {
    if (adminId !== ADMIN_ID) {
      await bot.sendMessage(chatId, `⛔ Not authorised. Your ID: ${adminId}, Admin ID: ${ADMIN_ID}`);
      return;
    }
    const targetId = parseInt(match![1].trim(), 10);
    if (isNaN(targetId)) {
      await bot.sendMessage(chatId, "❌ Invalid user ID. Usage: /grant 1234567890");
      return;
    }

    const target = await getUser(targetId);

    if (!target) {
      // User not in DB — refuse to create phantom records
      await bot.sendMessage(chatId, `❌ User ${targetId} not found. They must start the bot first before premium can be granted.`);
      return;
    }

    if (target.hasPaid) {
      await bot.sendMessage(chatId, `✅ User ${targetId} (${target.name ?? "Unknown"}) already has Premium.`);
      return;
    }

    // If user was in a fake chat, clean up the in-memory state and reset to idle
    // so they can immediately tap Find Match after premium is granted
    const wasInFakeChat = target.state === "chatting" && target.chattingWith === FAKE_CHAT_ID;
    if (wasInFakeChat) {
      const fakeTimer = chatTimerMap.get(targetId);
      if (fakeTimer) { clearTimeout(fakeTimer); chatTimerMap.delete(targetId); }
      fakePersonaMap.delete(targetId);
    }

    // Grant premium; if they were mid-fake-chat also reset to idle so they can Find Match immediately
    const grantUpdate: Partial<typeof usersTable.$inferInsert> = { hasPaid: true, updatedAt: new Date() };
    if (wasInFakeChat) { grantUpdate.state = "idle"; grantUpdate.chattingWith = null; }
    await db.update(usersTable).set(grantUpdate).where(eq(usersTable.id, targetId));

    await bot.sendMessage(chatId, `✅ Premium granted to ${target.name ?? "User"} (ID: ${targetId})`);

    const updated = await getUser(targetId);
    if (!updated) return;

    if (updated.isProfileComplete) {
      // Profile done — one message with menu buttons
      await sendMain(targetId, updated,
        `🎉 Your premium is now active!\n\nThank you for your support 💕\nTap 💘 Find Match to connect with real people worldwide!`
      ).catch(() => {});
    } else {
      // Profile incomplete — guide them to finish setup first
      await sendMain(targetId, updated,
        `🎉 Your premium is now active!\n\nThank you for your support 💕\nPlease complete your profile so we can find your match!`
      ).catch(() => {});
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[GRANT ERROR] ${errMsg}`);
    await bot.sendMessage(chatId, `❌ Grant failed: ${errMsg.slice(0, 200)}`).catch(() => {});
  }
});

// ── Admin: /revoke <userId> ───────────────────────────────────────────────────

bot.onText(/\/revoke (.+)/, async (msg, match) => {
  if (!ADMIN_ID || msg.from!.id !== ADMIN_ID) { await bot.sendMessage(msg.chat.id, "⛔ Not authorised."); return; }
  const targetId = parseInt(match![1].trim(), 10);
  if (isNaN(targetId)) { await bot.sendMessage(msg.chat.id, "Invalid user ID."); return; }
  await db.update(usersTable).set({ hasPaid: false, updatedAt: new Date() }).where(eq(usersTable.id, targetId));
  await bot.sendMessage(msg.chat.id, `✅ Premium revoked for user ${targetId}.`);
});

// ── Admin: /deleteuser <userId> ───────────────────────────────────────────────

bot.onText(/\/deleteuser (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!ADMIN_ID || msg.from!.id !== ADMIN_ID) { await bot.sendMessage(chatId, "⛔ Not authorised."); return; }

  const targetId = parseInt(match![1].trim(), 10);
  if (isNaN(targetId)) { await bot.sendMessage(chatId, "❌ Invalid user ID. Usage: /deleteuser 1234567890"); return; }

  try {
    const target = await getUser(targetId);
    if (!target) { await bot.sendMessage(chatId, `❌ User ${targetId} not found in DB.`); return; }

    // 1. If they're in a fake chat — clear in-memory state
    if (target.state === "chatting" && target.chattingWith === FAKE_CHAT_ID) {
      const fakeTimer = chatTimerMap.get(targetId);
      if (fakeTimer) { clearTimeout(fakeTimer); chatTimerMap.delete(targetId); }
      fakePersonaMap.delete(targetId);
      fakeReplySet.delete(targetId);
    }

    // 2. If they're in a real chat — disconnect partner gracefully
    if (target.state === "chatting" && target.chattingWith && target.chattingWith !== FAKE_CHAT_ID) {
      const partnerId = target.chattingWith;
      const partner = await getUser(partnerId);
      if (partner) {
        const disconnected = await db.update(usersTable)
          .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
          .where(and(eq(usersTable.id, partnerId), eq(usersTable.chattingWith, targetId)))
          .returning({ id: usersTable.id });

        if (disconnected.length > 0) {
          await sendMain(partnerId, partner, "Your match is no longer available. Tap 💘 Find Match to connect with someone new!").catch(() => {});
        }
      }
    }

    // 3. Hard delete from DB
    await db.delete(usersTable).where(eq(usersTable.id, targetId));

    await bot.sendMessage(chatId,
      `🗑️ User deleted successfully.\n\n` +
      `*ID:* \`${targetId}\`\n` +
      `*Name:* ${escMd(target.name ?? "Unknown")}\n` +
      `*Username:* @${escMd(target.telegramUsername ?? "none")}\n` +
      `*Was paid:* ${target.hasPaid ? "Yes" : "No"}\n` +
      `*State was:* ${target.state ?? "unknown"}`,
      { parse_mode: "Markdown" }
    );

  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await bot.sendMessage(chatId, `❌ Delete failed: ${errMsg.slice(0, 200)}`).catch(() => {});
  }
});

// ── Admin: /broadcast — FOMO blast to all unpaid demo users ──────────────────

bot.onText(/\/broadcast/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ADMIN_ID || msg.from!.id !== ADMIN_ID) { await bot.sendMessage(chatId, "⛔ Not authorised."); return; }

  const GIRL_NAMES = ["Riya","Priya","Neha","Simran","Komal","Ananya","Kavya","Shreya","Pooja","Nidhi","Megha","Tanya","Ishika","Aisha","Sanya"];

  // ── Broadcast cooldown: max 1 every 3 days ──────────────────────────────────
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  if (broadcastLastSentAt && Date.now() - broadcastLastSentAt < THREE_DAYS_MS) {
    const remainMs = THREE_DAYS_MS - (Date.now() - broadcastLastSentAt);
    const remainHrs = Math.ceil(remainMs / (60 * 60 * 1000));
    await bot.sendMessage(chatId, `⏳ Broadcast cooldown active — wait *${remainHrs}h* more before next broadcast.\n\n_Telegram anti-spam protection: max 1 broadcast per 3 days._`, { parse_mode: "Markdown" });
    return;
  }

  function rndName() { return GIRL_NAMES[Math.floor(Math.random() * GIRL_NAMES.length)]; }

  function fomoMsg(name: string): string {
    const payLine = `\n\n⭐ *Telegram Stars se instant Premium lo:* /premium\n\nPlans: 100⭐ week · 150⭐ month · 1500⭐ year`;
    const msgs = [
      // ── Fresh match style ──────────────────────────────────────────────────
      `🔔 *New Match Alert!*\n\n*${name}* ne tumhe match kiya abhi abhi 💘\n\nWoh tumhara wait kar rahi hai — ab baat karo!\n\n🔒 Premium lo aur unlock karo *${name}* ka chat${payLine}`,

      `💘 *${name} tumhe miss kar rahi thi...*\n\nAur abhi abhi — MATCH ho gaya! 🎉\n\n_"finally koi interesting mila"_ — yahi socha usne tumhare baare mein 🥺\n\n🔓 Unlock karo abhi aur baat shuru karo!${payLine}`,

      `⚡ *Ruko ruko ruko —*\n\n*${name}* ne tumhe match kiya hai! 💕\n\nWoh online hai abhi. Typing... 👀\n\n🔒 Sirf Premium users hi reply kar sakte hain.${payLine}`,

      `🥺 *${name}* tumhara intezaar kar rahi thi...\n\nAur guess what — MATCH! 💘\n\n_"iss baar koi accha mile"_ — woh yahi soch ke aayi thi\n\nWoh abhi bhi yahan hai. Baat karo usse!${payLine}`,

      // ── Classic FOMO style ─────────────────────────────────────────────────
      `💌 *${name}* ab bhi soch rahi hai tumhare baare mein 🥺\n\n_"unka message padhke dil khush ho gaya"_\n\nReal log, real baat — ek baar unlock karo, phir koi limit nahi 💕${payLine}`,

      `🔔 Yaad hai tumhara woh match?\n\n*${name}* ne poochha — _"kya woh wapas aayenge?"_ 🥺\n\nWoh abhi bhi yahan hai. Premium lo aur baat shuru karo 💕${payLine}`,

      `💕 *${name}* nahi bhooli tumhe.\n\n_"interesting lag rahe the, kash aur baat hoti"_ — yahi kaha usne 🥺\n\nReal conversations. One-time payment. No limits.${payLine}`,

      `🌙 Late night — *${name}* abhi bhi app pe hai.\n\nWoh match kiya tha tumhare saath ek reason se 💕\n\nPremium = real chats, real people, koi timer nahi.${payLine}`,

      `💬 *${name}* ne message kiya... lekin tumhara Premium nahi hai abhi.\n\nReal connection tha. Waste mat karo.\n\nPay once. Chat forever 💕${payLine}`,
    ];
    return msgs[Math.floor(Math.random() * msgs.length)];
  }

  await bot.sendMessage(chatId, "📡 Fetching unpaid users...");

  const targets = await db.select({ id: usersTable.id })
    .from(usersTable)
    .where(
      and(
        gt(usersTable.chatCount, 0),
        eq(usersTable.hasPaid, false),
        eq(usersTable.isProfileComplete, true),
        eq(usersTable.broadcastOptOut, false),
        ...(ADMIN_ID ? [ne(usersTable.id, ADMIN_ID)] : [])
      )
    );

  await bot.sendMessage(chatId, `📤 Sending to ${targets.length} users... I'll update every 100 messages.`);

  let sent = 0, failed = 0;

  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  for (const row of targets) {
    const name = rndName();
    try {
      await bot.sendMessage(row.id, fomoMsg(name), {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "🚫 Stop these messages", callback_data: "stop_broadcast" }]]
        }
      });
      sent++;
    } catch {
      failed++;
    }
    if ((sent + failed) % 100 === 0) {
      await bot.sendMessage(chatId, `⏳ Progress: ${sent + failed}/${targets.length} — ✅ ${sent} sent, ❌ ${failed} failed`).catch(() => {});
    }
    await sleep(80);
  }

  broadcastLastSentAt = Date.now();
  await bot.sendMessage(chatId, `✅ Broadcast complete!\n\n📤 Total: ${targets.length}\n✅ Sent: ${sent}\n❌ Blocked/failed: ${failed}`);
});

bot.onText(/\/stats/, async (msg) => {
  if (!ADMIN_ID || msg.from!.id !== ADMIN_ID) return;
  const chatId = msg.chat.id;

  try {
    const users = await db.select().from(usersTable);
    const total = users.length;
    const complete = users.filter(u => u.isProfileComplete).length;
    const incomplete = total - complete;
    const female = users.filter(u => u.gender === "female").length;
    const male = users.filter(u => u.gender === "male").length;
    const other = users.filter(u => u.gender === "other").length;
    const unknown = users.filter(u => !u.gender).length;
    const paid = users.filter(u => u.hasPaid).length;
    const free = total - paid;
    const trialUsed = users.filter(u => !u.hasPaid && (u.chatCount ?? 0) > 0).length;
    const trialUnused = users.filter(u => !u.hasPaid && (u.chatCount ?? 0) === 0).length;
    const activeChats = users.filter(u => u.state === "chatting").length;
    const fakeChats = users.filter(u => u.state === "chatting" && u.chattingWith === FAKE_CHAT_ID).length;
    const realChats = users.filter(u => u.state === "chatting" && u.chattingWith && u.chattingWith !== FAKE_CHAT_ID).length;
    const bonusUsers = users.filter(u => (u.bonusChats ?? 0) > 0).length;
    const referrals = users.reduce((sum, u) => sum + (u.referralCount ?? 0), 0);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const joinedToday = users.filter(u => u.createdAt && new Date(u.createdAt) >= todayStart).length;

    await bot.sendMessage(
      chatId,
      `📊 *Bot Stats*\n\n` +
      `👥 Total users: *${total}*\n` +
      `✅ Profile complete: *${complete}*\n` +
      `📝 Profile incomplete: *${incomplete}*\n` +
      `📅 Joined today: *${joinedToday}*\n\n` +
      `🚺 Female users: *${female}*\n` +
      `🚹 Male users: *${male}*\n` +
      `⚧ Other: *${other}*\n` +
      `❔ Gender unknown: *${unknown}*\n\n` +
      `💎 Premium users: *${paid}*\n` +
      `🆓 Free users: *${free}*\n` +
      `⏳ Trial used: *${trialUsed}*\n` +
      `🆕 Trial not used: *${trialUnused}*\n\n` +
      `💬 Active chats: *${activeChats}*\n` +
      `🤖 AI trial chats: *${fakeChats}*\n` +
      `👫 Real user chats: *${realChats}*\n\n` +
      `🎁 Bonus users: *${bonusUsers}*\n` +
      `🔗 Total referrals: *${referrals}*\n\n` +
      `_Updated: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}_`,
      { parse_mode: "Markdown" }
    );
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await bot.sendMessage(chatId, `❌ Stats failed: ${errMsg.slice(0, 200)}`);
  }
});

// ── Admin: /users ─────────────────────────────────────────────────────────────

bot.onText(/\/users/, async (msg) => {
  if (!ADMIN_ID || msg.from!.id !== ADMIN_ID) return;
  const chatId = msg.chat.id;
  const users = await db.select().from(usersTable);

  const paid    = users.filter(u => u.hasPaid).length;
  const trialUsed = users.filter(u => !u.hasPaid && (u.chatCount ?? 0) > 0).length;
  const chatting  = users.filter(u => u.state === "chatting").length;

  const summary =
    `👥 *Users: ${users.length}* | 💎 Paid: ${paid} | 🆓 Trial used: ${trialUsed} | 💬 Active chats: ${chatting}`;

  const lines = users.map((u) =>
    `• ${escMd(u.name)} (${escMd(u.age)}) | \`${u.id}\` | ${u.hasPaid ? "💎" : "🆓"} | Chats: ${u.chatCount ?? 0} | ${u.state}`
  );

  // Telegram hard limit is 4096 chars — chunk into pages
  const MAX = 3800;
  const header = `${summary}\n\n`;
  let page = header;
  let pageNum = 1;

  for (const line of lines) {
    if ((page + line + "\n").length > MAX) {
      await bot.sendMessage(chatId, page, { parse_mode: "Markdown" });
      page = `_(page ${++pageNum})_\n`;
    }
    page += line + "\n";
  }
  if (page.trim()) await bot.sendMessage(chatId, page || "_No users yet._", { parse_mode: "Markdown" });
});

// ── Bot profile setup (runs once at startup) ──────────────────────────────

async function setupBotProfile() {
  try {
    const base = `https://api.telegram.org/bot${TOKEN}`;

    // Set full description (shown on first open)
    await fetch(`${base}/setMyDescription`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description:
          "💕 WorldMatch — Meet. Chat. Connect.\n\n" +
          "🌍 Connect with singles from every corner of the world\n" +
          "💬 Start chatting instantly with real matches\n" +
          "🔒 Safe, private & fun\n\n" +
          "✨ Your first chat is FREE — find your match right now!\n\n" +
          "Tap START to begin your journey 👇",
      }),
    });

    // Set short description (shown in search results)
    await fetch(`${base}/setMyShortDescription`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        short_description: "💕 Meet & chat with singles worldwide. Your first match is FREE! 🌍",
      }),
    });

    // Upload profile photo
    const imgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "profile.png");
    if (fs.existsSync(imgPath)) {
      const formData = new FormData();
      const blob = new Blob([fs.readFileSync(imgPath)], { type: "image/png" });
      formData.append("photo", blob, "profile.png");
      const res = await fetch(`${base}/setMyPhoto`, { method: "POST", body: formData });
      const json = await res.json() as { ok: boolean };
      if (json.ok) logger.info("Bot profile photo set successfully");
      else logger.warn({ json }, "Could not set bot profile photo");
    }

    // Register bot commands (shows up in the "/" menu in Telegram)
    await fetch(`${base}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commands: [
          { command: "start",      description: "Start the bot" },
          { command: "match",      description: "💘 Find a match" },
          { command: "profile",    description: "👤 View your profile" },
          { command: "edit",       description: "✏️ Edit your profile" },
          { command: "premium",    description: "⭐ Go Premium" },
          { command: "stop",       description: "🛑 End current chat" },
          { command: "disclaimer",     description: "📋 Terms of use & legal notice" },
          { command: "deleteaccount", description: "🗑 Delete your account & all data" },
          { command: "help",          description: "ℹ️ Show all commands" },
        ],
      }),
    });

    logger.info("Bot profile description set");
  } catch (err) {
    logger.warn({ err }, "Failed to set bot profile (non-fatal)");
  }
}

setupBotProfile();

// ── Startup: full ghost-connection cleanup for ALL users ─────────────────────
(async () => {
  try {
    const allChatting = await db.select().from(usersTable).where(eq(usersTable.state, "chatting"));
    let fixed = 0;

    // Helper: reset a user to idle in DB then push a fresh Telegram keyboard
    // so their client doesn't show a stale "✅ Premium" or "🛑 Stop Chat" keyboard
    const resetAndNotify = async (u: typeof allChatting[number], reason: string) => {
      await db.update(usersTable)
        .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
        .where(eq(usersTable.id, u.id));
      const fresh = await getUser(u.id);
      if (fresh) {
        await sendMain(u.id, fresh, `ℹ️ ${reason}`).catch(() => {}); // best-effort
      }
    };

    for (const u of allChatting) {
      // 1. Fake-chat ghost (in-memory persona lost on restart) — reset free user
      //    Also reset chatCount to 0 so they get a fresh demo (they got 0 seconds due to restart)
      if (!u.chattingWith || u.chattingWith === FAKE_CHAT_ID) {
        await db.update(usersTable)
          .set({ state: "idle", chattingWith: null, chatCount: 0, updatedAt: new Date() })
          .where(eq(usersTable.id, u.id));
        const fresh = await getUser(u.id);
        if (fresh) {
          await sendMain(u.id, fresh, "ℹ️ Connection lost — but your free preview is still waiting! Tap 💘 Find Match to start fresh.").catch(() => {});
        }
        fixed++;
        continue;
      }

      // 2. Unpaid user connected to a real user — force-disconnect both
      if (!u.hasPaid) {
        logger.warn({ userId: u.id, partnerId: u.chattingWith }, "Startup: disconnecting unpaid user from real chat");
        await resetAndNotify(u, "Chat session ended.");
        const partner = await getUser(u.chattingWith);
        if (partner) {
          await db.update(usersTable)
            .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
            .where(and(eq(usersTable.id, u.chattingWith), eq(usersTable.chattingWith, u.id)));
          const freshPartner = await getUser(u.chattingWith);
          if (freshPartner) await sendMain(u.chattingWith, freshPartner, "ℹ️ Chat session ended.").catch(() => {});
        }
        fixed++;
        continue;
      }

      // 3. Partner deleted or partner no longer points back — ghost connection
      const partner = await getUser(u.chattingWith);
      if (!partner || partner.state !== "chatting" || partner.chattingWith !== u.id) {
        logger.warn({ userId: u.id, partnerId: u.chattingWith }, "Startup: clearing ghost connection (partner missing or mismatched)");
        await resetAndNotify(u, "Your match is no longer available. Tap 💘 Find Match to connect with someone new!");
        fixed++;
      }
    }

    logger.info({ total: allChatting.length, fixed }, "Startup cleanup: ghost connections resolved");
  } catch (err) {
    logger.error({ err }, "Startup cleanup failed (non-fatal)");
  }
})();

// ── callback_query handler ────────────────────────────────────────────────────

bot.on("callback_query", async (query) => {
  if (!query.message || !query.from) return;
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  logger.info({ userId, data: query.data }, "callback_query received");

  // ── Stop broadcast opt-out ──────────────────────────────────────────────
  if (query.data === "stop_broadcast") {
    await bot.answerCallbackQuery(query.id, { text: "✅ Done! You won't receive these messages anymore." });
    await db.update(usersTable)
      .set({ broadcastOptOut: true, updatedAt: new Date() })
      .where(eq(usersTable.id, userId));
    await bot.sendMessage(chatId, "🚫 *You've been unsubscribed from match alerts.*\n\nYou won't receive these messages anymore.\n\n_Type /start anytime to continue using the bot._", { parse_mode: "Markdown" });
    return;
  }

  // ── Edit Profile inline button ──────────────────────────────────────────
  if (query.data === "edit_profile") {
    await bot.answerCallbackQuery(query.id);
    const user = await getUser(userId);
    if (!user) { await bot.sendMessage(chatId, "Profile not found. Type /start to begin."); return; }
    if ((user.state as string) === "chatting") {
      await bot.sendMessage(chatId, "Stop your current chat first before editing your profile.");
      return;
    }
    await startEditProfile(chatId, userId);
    return;
  }

  await bot.answerCallbackQuery(query.id);
});

// ── Admin: /grantpremium <user_id> [days] — manually activate premium ─────────

bot.onText(/\/grantpremium(?:\s+(\d+))?(?:\s+(\d+))?/, async (msg, match) => {
  if (!ADMIN_ID || msg.from!.id !== ADMIN_ID) return;
  const chatId = msg.chat.id;
  const targetId = match?.[1] ? Number(match[1]) : null;
  const days = match?.[2] ? Number(match[2]) : 30; // default 30 days

  if (!targetId) {
    await bot.sendMessage(chatId,
      "⚠️ Usage: <code>/grantpremium 123456789 [days]</code>\n\nDays defaults to 30 if not specified.\nGet user ID from /users.",
      { parse_mode: "HTML" }
    );
    return;
  }

  const user = await getUser(targetId);
  if (!user) {
    await bot.sendMessage(chatId, `❌ User <code>${targetId}</code> not found.`, { parse_mode: "HTML" });
    return;
  }

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);
  const planKey = days <= 14 ? "twoweek" : days <= 30 ? "month" : "year";

  await db.update(usersTable)
    .set({ hasPaid: true, premiumPlan: planKey, premiumExpiresAt: expiresAt, updatedAt: new Date() })
    .where(eq(usersTable.id, targetId));

  logger.info({ adminId: ADMIN_ID, targetId, days }, "Admin granted premium");

  await bot.sendMessage(chatId,
    `✅ *Premium granted!*\n\nUser: <b>${escHtml(user.name ?? user.firstName ?? "Unknown")}</b> (<code>${targetId}</code>)\nPlan: ${planKey}\nExpires: ${escHtml(expiresAt.toDateString())}`,
    { parse_mode: "HTML" }
  );

  // Notify the user
  bot.sendMessage(targetId,
    `🎉 *Premium Activated!*\n\nTumhara payment verify ho gaya! Welcome to Premium 💎\n\nAb tum unlimited real matches kar sakte ho — koi timer nahi, koi limit nahi! 💕\n\n_Expires: ${escHtml(expiresAt.toDateString())}_\n\nTap 💘 Find Match to start!`,
    { parse_mode: "Markdown" }
  ).catch(() => {});

  const updated = await getUser(targetId);
  if (updated) {
    sendMain(targetId, updated).catch(() => {});
  }
});

logger.info(POLLING_ENABLED ? "Telegram bot polling started" : "Telegram bot loaded (polling disabled — Railway handles polling)");
