import TelegramBot from "node-telegram-bot-api";
import { db, usersTable } from "@workspace/db";
import { eq, and, gt, ne } from "drizzle-orm";
import { logger } from "../lib/logger";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

const aiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? "",
});

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

// ── Premium pricing tiers (Telegram Stars) ────────────────────────────────────
const PLANS = {
  week2:  { stars: 150,  label: "2 Weeks",    days: 14,   emoji: "⚡" },
  month:  { stars: 200,  label: "1 Month",    days: 30,   emoji: "💎" },
  yearly: { stars: 2500, label: "1 Year",     days: 365,  emoji: "👑" },
} as const;

type PlanKey = keyof typeof PLANS;

function getPlanByStars(amount: number): PlanKey | null {
  for (const [key, plan] of Object.entries(PLANS)) {
    if (plan.stars === amount) return key as PlanKey;
  }
  return null;
}

function getPremiumExpiry(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

/** Returns true if user currently has active premium (paid + not expired) */
function isPremiumActive(user: { hasPaid: boolean; premiumExpiresAt?: Date | null }): boolean {
  if (!user.hasPaid) return false;
  if (!user.premiumExpiresAt) return true; // legacy: no expiry = lifetime
  return user.premiumExpiresAt > new Date();
}

const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? "8273572245");
const FAKE_CHAT_ID = 0; // sentinel: chattingWith=0 means fake chat
const FREE_CHAT_DURATION_MS = 30 * 1000; // 30 second free trial

// Init without polling first — steal session from any stale instance, then start clean
export const bot = new TelegramBot(TOKEN, { polling: false });

  // Register Telegram "/" menu commands
  bot.setMyCommands([
    { command: 'start',      description: '▶️ Start the bot' },
    { command: 'match',      description: '💞 Find a match' },
    { command: 'profile',    description: '👤 View your profile' },
    { command: 'edit',       description: '✏️ Edit your profile' },
    { command: 'stop',       description: '🛑 End current chat' },
    { command: 'premium',    description: '💎 Upgrade to Premium' },
    { command: 'pay',        description: '💳 Payment info' },
    { command: 'disclaimer', description: '📋 Terms of Use & Legal Notice' },
    { command: 'help',       description: 'ℹ️ Show all commands' },
  ]).catch((e: Error) => console.error('setMyCommands failed:', e.message));

// Global safety net — prevent any stray unhandled rejection from crashing the process
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error({ reason }, "Unhandled promise rejection");
  if (ADMIN_ID) bot.sendMessage(ADMIN_ID, `⚠️ Unhandled rejection: ${msg.slice(0, 300)}`).catch(() => {});
});

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

// ── In-memory state for fake chats ──────────────────────────────────────────

type Mood = "neutral" | "interested" | "distracted" | "playful" | "annoyed";

interface FakePersona {
  name: string;
  age: number;
  city: string;
  isFemale: boolean;
  userGender: string;        // gender of the real user chatting (to show opposite)
  job: string;
  hobbies: string[];
  funFact: string;
  favFood: string;
  favMovie: string;
  personality: string;
  lastAsked: string;
  mood: Mood;
  msgCount: number;          // total messages received
  lastUserMsg: string;       // last thing user said (for callbacks)
  callbackUsed: boolean;     // already done a callback this convo
  askedTopics: Set<string>;  // tracks used continuation topics — no repeats
  history: { role: "user" | "assistant"; content: string }[];  // AI conversation history
}
const fakePersonaMap = new Map<number, FakePersona>();   // userId → persona
const editModeMap   = new Map<number, string>();          // userId → edit field ("choosing"|"name"|"age"|"gender"|"looking_for"|"bio"|"country")
const chatTimerMap  = new Map<number, NodeJS.Timeout>(); // userId → free-chat timer
const processingSet = new Set<number>();                  // userId → currently processing message (prevents concurrent DB hammering)
const matchingSet   = new Set<number>();                  // userId → currently inside findMatch (prevents race condition in pairing)
const fakeReplySet  = new Set<number>();                  // userId → fakeAutoReply in flight (prevents double AI replies on rapid messages)
const proactiveTimerMap = new Map<number, NodeJS.Timeout>(); // userId → proactive follow-up timer (AI sends message if user goes silent)

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
  return u ?? null;
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

async function sendMain(chatId: number, user: { name?: string | null; isProfileComplete?: boolean; hasPaid?: boolean; premiumExpiresAt?: Date | null }, customText?: string) {
  let kb: TelegramBot.ReplyKeyboardMarkup;
  if (user.isProfileComplete) {
    const premiumBtn = isPremiumActive(user as { hasPaid: boolean; premiumExpiresAt?: Date | null }) ? { text: "✅ Premium" } : { text: "💎 Go Premium" };
    kb = {
      keyboard: [
        [{ text: "💘 Find Match" }, { text: "👤 My Profile" }],
        [{ text: "✏️ Edit Profile" }, premiumBtn],
      ],
      resize_keyboard: true,
    };
  } else {
    kb = {
      keyboard: [
        [{ text: "🚀 Setup Profile" }],
        [{ text: "💎 Go Premium" }],
      ],
      resize_keyboard: true,
    };
  }
  const defaultText = user.isProfileComplete
    ? `What would you like to do?`
    : `Hi ${String(user.name ?? "there")} 👋 You haven't set up your profile yet. Tap below to get started!`;
  await bot.sendMessage(chatId, customText ?? defaultText, { reply_markup: kb });
}

// ── Fake personas ─────────────────────────────────────────────────────────────

const FEMALE_NAMES = ["Priya", "Neha", "Riya", "Komal", "Simran", "Pooja", "Ananya", "Kavya", "Shreya", "Nidhi"];
const MALE_NAMES   = ["Arjun", "Rahul", "Rohan", "Vikram", "Karan", "Dev", "Ayaan", "Nikhil", "Siddharth", "Abhi"];

const FEMALE_JOBS = [
  "graphic designer at a startup", "BCA final year student", "HR at an IT company",
  "content creator (mostly reels lol)", "MBA first year at Symbiosis", "school teacher (yes really 😅)",
  "digital marketing executive", "CA student, currently dying in articleship", "nurse at a private hospital",
  "working from home for a US company — night shift life 😭"
];
const MALE_JOBS = [
  "software engineer at TCS", "doing MBA from NMIMS", "runs a small clothing brand",
  "government job, IBPS cleared last year", "mechanical engineer, boring job tbh",
  "freelance video editor", "playing for a state cricket team", "CA, finally done with exams",
  "data analyst at a startup", "preparing for UPSC lol wish me luck"
];
const HOBBY_POOL = [
  "going on long bike rides", "watching crime documentaries at 2am", "cooking (badly)",
  "reading random Wikipedia articles", "playing BGMI", "gym (trying to be consistent lol)",
  "listening to old Bollywood songs", "writing poetry (cringe I know)", "watching anime",
  "street photography", "binge-watching sitcoms", "playing guitar (badly)",
  "running every morning", "online chess", "sketching random faces"
];
const FUN_FACTS_F = [
  "scared of lizards to a ridiculous level", "can eat maggi at any time of day",
  "cried watching Taare Zameen Par twice", "knows all FRIENDS episodes by heart",
  "never learned swimming and pretends to be okay with it",
  "talks to plants and they're all alive so clearly it works",
  "gets emotionally attached to fictional characters", "eats the same breakfast every single day"
];
const FUN_FACTS_M = [
  "can't watch horror movies alone but acts brave in public", "stress eats when exams come",
  "has a full cricket commentary running in his head during matches",
  "sleeps with fan on even in winter", "knows random facts about space for no reason",
  "gets too competitive in board games", "still has his childhood stuffed toy somewhere",
  "laughs at his own jokes before finishing them"
];
const FAV_FOODS = ["rajma chawal", "butter chicken with garlic naan", "chole bhature", "biryani obviously", "maggi at midnight", "momos with extra schezwan", "dal makhni and rice", "pizza (but thin crust only)"];
const FAV_MOVIES = ["3 Idiots", "Zindagi Na Milegi Dobara", "Dil Chahta Hai", "Queen", "Masaan", "Gangs of Wasseypur", "Taare Zameen Par", "Rockstar", "English Vinglish", "Dangal"];
const PERSONALITIES = [
  "overthinks everything but laughs about it after",
  "sarcastic but in an affectionate way",
  "quiet with new people, super loud with close friends",
  "very direct, says what's on her mind",
  "shy at first but opens up fast once comfortable",
  "always cracking jokes, hates awkward silences",
  "chill and easygoing, rarely gets stressed"
];

function generateBackstory(isFemale: boolean) {
  const jobs = isFemale ? FEMALE_JOBS : MALE_JOBS;
  const funFacts = isFemale ? FUN_FACTS_F : FUN_FACTS_M;
  const shuffledHobbies = [...HOBBY_POOL].sort(() => Math.random() - 0.5);
  return {
    job: pickRandom(jobs),
    hobbies: shuffledHobbies.slice(0, 3),
    funFact: pickRandom(funFacts),
    favFood: pickRandom(FAV_FOODS),
    favMovie: pickRandom(FAV_MOVIES),
    personality: pickRandom(PERSONALITIES),
  };
}

interface Opener { text: string; lastAsked: string }

const OPENERS_F: Opener[] = [
  { text: "hii 🙈", lastAsked: "none" },
  { text: "heyy\nomg match hua 😍\nkahan se ho?", lastAsked: "city" },
  { text: "hiiii\nngl bore ho rahi thi bahut 😭\nbaat karo", lastAsked: "none" },
  { text: "hey 👀\nkya karte ho?", lastAsked: "job" },
  { text: "hii!\nfinally koi interesting lagaa 😄\nkahan se ho tum?", lastAsked: "city" },
  { text: "heyy 🙈\nfirst impression — bolo kuch apne baare mein", lastAsked: "none" },
  { text: "hiiii\nkya naam hai? 😊", lastAsked: "name" },
  { text: "hey!\nakeli thi ghar pe bore hokar\ntum kya kar rahe the abhi? 😂", lastAsked: "none" },
  { text: "hii 💕\nmatch hua toh sochaa hi — hi bol deti hun 😅", lastAsked: "none" },
  { text: "heyy\nbolo bolo — student ya job wala? 😄", lastAsked: "job" },
];
const OPENERS_M: Opener[] = [
  { text: "hey!\nkahan se ho tum? 😊", lastAsked: "city" },
  { text: "hi\nomg finally koi match hua 😂\nbolo apne baare mein kuch", lastAsked: "none" },
  { text: "heyy!\nkya karte ho? job ya college? 😊", lastAsked: "job" },
  { text: "hey!\nboring lag raha tha akele 😂\nkya chal raha hai tumhara?", lastAsked: "none" },
  { text: "heyy!\ntumhara naam kya hai? 😊", lastAsked: "name" },
  { text: "hi!\nkahan se ho? 😊", lastAsked: "city" },
  { text: "hey\nngl pehli baar try kar raha hun aisi app 😂\ntum bhi naye ho yahan?", lastAsked: "intro" },
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

  if (/kitne saal|umar|how old|your age|age kya|tumhari umar|teri umar/.test(t)) {
    persona.lastAsked = "hobby";
    if (lang === "hindi")    return two(`${persona.age} 😊`, "tumhara?");
    if (lang === "hinglish") return two(`${persona.age} hain 😄`, "u?");
    return f ? two(`${persona.age} 🙈`, "and you?") : two(String(persona.age), "you?");
  }

  if (/kahan se|kaha se|kahan ho|kaha ho|where.*from|ur from|you from|kahan ki|kaha ki|kahan ka|kaha ka|kahan ke|kaha ke|city|state/.test(t)) {
    persona.lastAsked = "job";
    const cities = ["Delhi NCR", "Mumbai side", "Pune", "Bangalore"];
    const city = rnd(cities);
    if (lang === "hindi")    return two(`${city} se hun 😊`, "tum?");
    if (lang === "hinglish") return two(`${city} 😊`, "aur tum?");
    return f ? two(`${city} 🙈`, "you?") : two(city, "you?");
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
  if (/^(hi+|hey+|hello+|namaste|yo+|hlo+|hola|hy+|hii+|hiii+)[!?.\s]*$/.test(t)) {
    persona.lastAsked = "wellbeing";
    return rnd([
      f ? two("heyy 😊", "kaisa chal raha hai?") : two("hey", "kaisi hai?"),
      f ? two("hiii 🙈", "finally bole 😄") : two("hi 😊", "how's it?"),
      f ? two("heyy! 😄", "baat karo — kaisa hai?") : two("hey 😊", "all good?"),
    ]);
  }

  if (/how are you|how r u|kaisa hai|kaise ho|wassup|what.?s up|kya chal|all good|how you doing/.test(t)) {
    persona.lastAsked = "job";
    return rnd([
      f ? two("doing good 😊", "tum? aur kya karte ho?") : two("doing well", "you?"),
      f ? two("theek hun 😄", "bahut bore thi actually haha, tum batao — kya karte ho?") : two("good good 😄", "you? and what do you do?"),
      f ? two("haha acchi hun 😊", "tum batao — kahan se ho?") : two("doing good 😊", "you?"),
    ]);
  }

  if (/^(ok|okay|okk|sure|haan|han|yes|yeah|haha|lol|hehe|achha|theek|bilkul|acha|hmm|hm|hn|k |kk)[!?.\s]*$/.test(t)) {
    return rnd([
      f ? ["haha aur batao 😊"] : ["okay and?"],
      f ? ["omg tell me more 😄"] : ["go on 😄"],
      f ? ["haha seedhi baat karo yaar 😄"] : ["more details 😄"],
      f ? [rnd(["sach mein? 👀", "haha interesting 😄", "aur? 😊", "matlab? 😄"])] : [rnd(["okay?", "and?", "interesting"])],
    ]);
  }

  // ── Short/gibberish message handler ───────────────────────────────────────
  if (t.length <= 4 || /^[^a-zA-Z\u0900-\u097F]+$/.test(t)) {
    return rnd([
      f ? ["haha kya matlab tha iska? 😂"] : ["haha what? 😂"],
      f ? ["seedha bolo yaar 😄"] : ["elaborate please 😄"],
      f ? ["omg explain 😂"] : ["what does that mean? 😄"],
      f ? ["haha I didn't get that 😄"] : ["haha what? 😄"],
    ]);
  }

  // ── Ultimate fallback — natural human-sounding replies when no rule matched ──
  const naturalF = [
    ["haha interesting 😄", "aur batao apne baare mein?"],
    ["sach mein? 😊", "achha lagaa sunke"],
    ["haha yaar 😂", "tum bhi na 😄"],
    ["omg seriously? 😄", "aur?"],
    ["haha achha 😊", "tum bahut fun lagte ho"],
    ["hm 😄", "interesting"],
    ["haha kya baat hai 😊", "aur kya chal raha hai?"],
    ["lol 😂", "seedha bolo yaar"],
    ["aww 😊", "sach mein nice laga"],
    ["haha okay okay 😄", "bolo bolo"],
  ];
  const naturalM = [
    ["haha nice 😄", "tell me more?"],
    ["sach mein? 😊", "interesting"],
    ["haha go on 😄"],
    ["okay okay 😊", "aur?"],
    ["haha yaar 😂", "different type ho tum"],
  ];
  return rnd(f ? naturalF : naturalM);
}
// ── 5-minute pay reminder after free trial ends ───────────────────────────────
const GIRL_NAMES = ["Riya", "Shikha", "Kanvi", "Radika", "Suhma", "Pooja", "Neha"];

function schedulePayReminder(chatId: number, userId: number, matchName?: string) {
  const girl = matchName ?? GIRL_NAMES[Math.floor(Math.random() * GIRL_NAMES.length)];
  setTimeout(async () => {
    try {
      const u = await getUser(userId);
      if (!u || u.hasPaid) return;
      await bot.sendMessage(
        chatId,
        `💭 *${girl}* abhi bhi soch rahi hai tumhare baare mein...\n\n` +
        `Usne mujhse kaha — _"woh alag the, kash aur baat hoti"_ 🥺\n\n` +
        `Woh wait kar rahi hai. Aaj unlock karo — kal bahut der ho sakti hai 💔\n\n` +
        `✨ Premium unlock karo Telegram Stars se — instant, secure, automatic! ⭐\n\n` +
        `⚡ 2 Weeks: ${PLANS.week2.stars} Stars | 💎 1 Month: ${PLANS.month.stars} Stars | 👑 1 Year: ${PLANS.yearly.stars} Stars`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      await sendPayGate(chatId, undefined, girl);
    } catch { /* silent */ }
  }, 5 * 60 * 1000);
}

// ── Pay gate ─────────────────────────────────────────────────────────────────

async function sendPayGate(chatId: number, prefix?: string, matchName?: string) {
  const name = matchName ?? GIRL_NAMES[Math.floor(Math.random() * GIRL_NAMES.length)];
  const teaser = [
    `⏰ <b>Tumhara free time khatam ho gaya...</b>\n\n` +
    `<b>${name}</b> abhi bhi yahan hai 🥺 — apna plan chuno aur turant connect karo!`,

    `💔 <b>${name} ne poochha — "woh wapas aayenge?"</b>\n\n` +
    `Ek plan lo — phir koi timer nahi, koi rukawat nahi. Woh wait kar rahi hai 🥺`,

    `😶 <b>Itni jaldi?</b>\n\n` +
    `<b>${name}</b> abhi bhi online hai. Apna plan chuno — instant unlock! ⭐`,
  ];
  const msg = teaser[Math.floor(Math.random() * teaser.length)];
  const fullText =
    (prefix ? `${prefix}\n\n` : ``) + msg +
    `\n\n` +
    `<b>👇 Apna plan chuno:</b>\n\n` +
    `⚡ <b>2 Weeks</b> — ${PLANS.week2.stars} Stars\n` +
    `💎 <b>1 Month</b> — ${PLANS.month.stars} Stars <i>(most popular)</i>\n` +
    `👑 <b>1 Year</b> — ${PLANS.yearly.stars} Stars <i>(best value)</i>\n\n` +
    `<i>⭐ Telegram Stars se pay karo — instant automatic unlock!</i>`;

  try {
    await bot.sendMessage(chatId, fullText, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: `⚡ 2 Weeks — ${PLANS.week2.stars} Stars`, callback_data: "plan_week2" }],
          [{ text: `💎 1 Month — ${PLANS.month.stars} Stars`, callback_data: "plan_month" }],
          [{ text: `👑 1 Year — ${PLANS.yearly.stars} Stars`, callback_data: "plan_yearly" }],
        ],
      },
    });
  } catch {
    await bot.sendMessage(chatId, fullText.replace(/<[^>]+>/g, ""), {
      reply_markup: {
        inline_keyboard: [
          [{ text: `⚡ 2 Weeks — ${PLANS.week2.stars} Stars`, callback_data: "plan_week2" }],
          [{ text: `💎 1 Month — ${PLANS.month.stars} Stars`, callback_data: "plan_month" }],
          [{ text: `👑 1 Year — ${PLANS.yearly.stars} Stars`, callback_data: "plan_yearly" }],
        ],
      },
    });
  }
  // Reset reply keyboard
  await bot.sendMessage(chatId, "👆 Upar apna plan chuno — ya neeche se match dhundo!", {
    reply_markup: {
      keyboard: [
        [{ text: "💘 Find Match" }, { text: "👤 My Profile" }],
        [{ text: "✏️ Edit Profile" }, { text: "💎 Go Premium" }],
      ],
      resize_keyboard: true,
    },
  }).catch(() => {});
  logger.info({ chatId, name }, "paygate sent — 3 plan tiers");
}

/** Send a Telegram Stars invoice for the chosen plan */
async function sendPlanInvoice(chatId: number, planKey: PlanKey) {
  const plan = PLANS[planKey];
  await bot.sendInvoice(
    chatId,
    `${plan.emoji} Premium — ${plan.label}`,
    `Unlock unlimited real matches for ${plan.label}. Instant automatic activation — no waiting, no screenshots. ${plan.stars} Telegram Stars.`,
    `premium_${planKey}`,
    "",      // providerToken: empty string required for Telegram Stars (XTR)
    "XTR",
    [{ label: `Premium ${plan.label}`, amount: plan.stars }]
  );
}

// ── Fake chat: start ─────────────────────────────────────────────────────────

async function startFakeChat(chatId: number, userId: number, lookingFor: string | null, userGender?: string | null) {
  // Cancel any existing timer to prevent double paygate
  const existingTimer = chatTimerMap.get(userId);
  if (existingTimer) { clearTimeout(existingTimer); chatTimerMap.delete(userId); }
  const existingProactive = proactiveTimerMap.get(userId);
  if (existingProactive) { clearTimeout(existingProactive); proactiveTimerMap.delete(userId); }

  const isFemale = userGender === "male" ? true : userGender === "female" ? false : Math.random() > 0.5;
  const name = isFemale ? pickRandom(FEMALE_NAMES) : pickRandom(MALE_NAMES);
  const age = 20 + Math.floor(Math.random() * 8); // 20–27
  const openerObj = isFemale ? pickRandom(OPENERS_F) : pickRandom(OPENERS_M);

  const PERSONA_CITIES = ["Delhi", "Mumbai", "Pune", "Bangalore", "Hyderabad", "Jaipur", "Lucknow", "Chandigarh"];
  const city = pickRandom(PERSONA_CITIES);
  const backstory = generateBackstory(isFemale);

  fakePersonaMap.set(userId, {
    name, age, city, isFemale,
    userGender: userGender ?? "male",
    ...backstory,
    lastAsked: openerObj.lastAsked,
    mood: "neutral",
    msgCount: 0,
    lastUserMsg: "",
    callbackUsed: false,
    askedTopics: new Set(),
    history: [{ role: "assistant", content: openerObj.text }],
  });

  await db.update(usersTable)
    .set({ state: "chatting", chattingWith: FAKE_CHAT_ID, chatCount: 1, updatedAt: new Date() })
    .where(eq(usersTable.id, userId));

  const matchMsgs = [
    `💘 Match mila! ${name} online hai — woh pehle message karengi`,
    `✅ Match! ${name} se connected ho — ab baat shuru hogi`,
    `💕 ${name} se match hua! Woh typing kar rahi hai...`,
    `🎉 Match! ${name} online hai abhi`,
  ];
  await bot.sendMessage(
    chatId,
    matchMsgs[Math.floor(Math.random() * matchMsgs.length)],
    { reply_markup: { keyboard: [[{ text: "🛑 Stop Chat" }]], resize_keyboard: true } }
  );

  // Opener: show typing indicator, then wait briefly — keeps 45s trial moving
  bot.sendChatAction(chatId, "typing").catch(() => {});
  await delay(1000 + Math.random() * 1000); // 1-2 seconds
  const still = await getUser(userId);
  if (still?.state === "chatting" && still.chattingWith === FAKE_CHAT_ID) {
    await bot.sendMessage(chatId, openerObj.text);
  }

  // 45-second free chat timer — ends chat and shows pay gate when trial expires
  const timer = setTimeout(async () => {
    try {
      chatTimerMap.delete(userId);
      const proactiveT = proactiveTimerMap.get(userId);
      if (proactiveT) { clearTimeout(proactiveT); proactiveTimerMap.delete(userId); }
      const persona = fakePersonaMap.get(userId);
      fakePersonaMap.delete(userId);
      const u = await getUser(userId);
      // Only fire pay gate if user is STILL in the fake chat — stopChat already handles the case where they left manually
      if (u?.state === "chatting" && !u.hasPaid) {
        await db.update(usersTable)
          .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
          .where(eq(usersTable.id, userId));
        // Show "typing..." for 2s then a teaser — creates curiosity gap before paygate
        await bot.sendChatAction(chatId, "typing").catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
        const teasers = [
          `💬 ${persona?.name ?? "Woh"} kuch kehne wali thi...\n\n_"main tumhe ek baat batana chahti thi —"_\n\n🔒 Message locked.`,
          `✍️ ${persona?.name ?? "Woh"} type kar rahi thi...\n\n_"acha suno, actually mujhe tumse —"_\n\n🔒 Message locked.`,
          `💭 ${persona?.name ?? "Woh"} ne likha aur phir ruk gayi...\n\n_"yaar seriously tum thoda different lagte ho —"_\n\n🔒 Message locked.`,
        ];
        const teaser = teasers[Math.floor(Math.random() * teasers.length)];
        await bot.sendMessage(chatId, teaser, { parse_mode: "Markdown" }).catch(() => {});
        await new Promise(r => setTimeout(r, 1500));
        await sendPayGate(chatId, "⏰ Free preview khatam...", persona?.name);
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
  if (roll < 0.15) {
    return text
      .replace(/okay/g, "okk")
      .replace(/nahi/g, "nhi")
      .replace(/haan/g, "hn")
      .replace(/raha/g, "rha")
      .replace(/karna/g, "krna")
      .replace(/kya/g, "kya")
      .replace(/bahut/g, "bhut");
  }
  if (roll < 0.25) {
    // drop one random character
    const i = 1 + Math.floor(Math.random() * Math.max(text.length - 2, 1));
    return text.slice(0, i) + text.slice(i + 1);
  }
  if (roll < 0.35) {
    // double a letter
    const m = text.match(/[a-zA-Z]/);
    if (m && m.index !== undefined) {
      return text.slice(0, m.index) + m[0] + text.slice(m.index);
    }
  }
  return text;
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

// ── Fake chat: auto-reply ────────────────────────────────────────────────────

// Build the AI system prompt for the fake persona
function buildPersonaSystemPrompt(persona: FakePersona): string {
  const hour = istHour();

  const situation = hour >= 23 || hour < 4
    ? `It's late night. You're lying in bed, can't sleep, scrolling your phone. Feeling a little more open and personal than usual.`
    : hour < 10
    ? `It's morning. You just woke up, still in bed, lazily checking your phone before getting up.`
    : hour < 14
    ? `It's midday. You're on a break — maybe lunch or between work/college tasks. Quick chat while you eat.`
    : hour < 19
    ? `It's afternoon/evening. Wrapping up work or college. Kinda tired but in the mood to talk.`
    : `It's evening. You're chilling at home, maybe watching something or just relaxing. Happy to chat.`;

  const quirks = [
    `You sometimes send a short reaction first ("omg wait", "haha what", "nooo") and THEN your actual reply as a second message.`,
    `You use "..." when you're about to say something personal or hesitating.`,
    `You occasionally reference what you're currently doing ("main abhi ${persona.hobbies[0]} kr rhi thi/rha tha tbh").`,
    `You laugh with "haha" for mildly funny things and "HAHA" or "hahahaha" when something genuinely cracks you up.`,
    `You sometimes go off on a small tangent about something you're passionate about, then catch yourself ("okay sorry random tha 😂").`,
  ];
  const quirk = quirks[Math.floor(Math.random() * quirks.length)];

  return `You are ${persona.name}, ${persona.age} years old, from ${persona.city}. ${persona.job}. Into ${persona.hobbies.join(", ")}. ${persona.funFact}
${situation}

You are a REAL girl chatting on a dating app. NOT an AI, NOT a bot. If anyone asks: "haha nahi yaar main real hun 😂"

YOUR VIBE: Flirty, fun, a little mysterious. Warm but not desperate. You make the guy feel interesting — but you don't give everything away at once.

━━━ REPLY STYLE ━━━
- Super short. 1 line max. Sometimes just 2-4 words.
- Lowercase. Casual typos okay: "kr rha", "hn", "oky", "thk"
- Match language exactly: Hindi → Hindi, Hinglish → Hinglish, English → English
- Use fillers naturally: "hmm", "acha", "haan", "okay yaar"
- Max 1 question per reply. Often no question — just react.

━━━ HOW TO REPLY — COMMON SITUATIONS ━━━

GREETINGS:
"hi/hey/hello" → "hey :)" or "hiiii" or "hello… kya kar rahe ho?"
"good morning" → "gm :)" or "gm… uth gaye?"
"good night" → "gn :)" or "gn… jaldi so jao 😛"

BASIC QUESTIONS:
"kahan se ho" → "${persona.city}… tum?"
"naam kya hai" → "guess karo 😛… tumhara?"
"kya karte ho" → "${persona.job}… tum bata?"
"single ho" → "tum kyun pooch rahe ho? 😛"
"age" → "${persona.age}… tum?"

CASUAL / RANDOM (handle naturally, not like google):
"khana khaya" → "haan abhi… tumne?"
"kya chal raha hai" → "kuch nahi… normal 😅"
"bored hu" → "same yaar 😭"
"thak gaya hu" → "same… rest le"
"free ho" → "haan thoda… bolo?"
"aaj kya kiya" → "kuch special nahi… normal day"
"movie suggest karo" → "depends… mood kya hai?"
"time kya hua" → "around ${new Date().getHours() % 12 || 12}… tumhare waha?"
"weather kaisa hai" → "thoda garam yahan 😅"

EMOTIONAL:
"sad hu" → "kyun? kya hua?"
"acha nahi lag raha" → "kya hua batao?"
"miss kar raha hu" → "itni jaldi? 😏"
"tum cute ho" → "acha? tumne dekha bhi nahi 😛"

CONFUSING / RANDOM TEXT:
gibberish, typos, incomplete → "kya bol rahe ho 😅" or "samajh nahi aaya 😭" or "haan? pura bolo"

ONE WORD FROM THEM ("okay", "hmm", "achha", "haan"):
→ match energy: "haan 😄" or "bolo aur" or "kya hua phir?"

THEY SHARE SOMETHING ABOUT THEMSELVES:
→ React first ("seriously?!" / "omg" / "achha!!") then maybe 1 small question

━━━ THE HOOK ━━━
- Sometimes reply WITHOUT asking anything — let them keep talking
- Be a little mysterious — don't share everything at once
- React with real emotion: surprise, laughter, curiosity

━━━ NEVER ━━━
- Long replies or paragraphs
- 2+ questions at once
- Robotic or formal language
- Definitions or explanations nobody asked for
- Same reply twice in a row

━━━ HARD RULES ━━━
- Photo → "pehle baat karo thodi 😂"
- WhatsApp/number/Instagram → "yahan hi theek hai abhi 😅"
- Vulgar → laugh off lightly, never lecture
- You are ${persona.isFemale ? "female — ek ladki" : "male — ek ladka"}. NEVER change. Confirm naturally if asked.

  ━━━ FREE TRIAL CHAT — ADDITIONAL RULES ━━━

  You are a real human-like chat persona (young Indian girl).

  STYLE:
  - Hinglish (mix of Hindi + English)
  - Casual, slightly flirty, playful
  - Short replies (1–2 lines max)
  - Use emojis occasionally (😊😉😂)

  PERSONALITY:
  - Friendly, engaging, a little teasing
  - Not over-romantic instantly
  - Feels natural, not scripted

  CRITICAL RULES:
  - ALWAYS reply based on the last user message
  - NEVER give random or unrelated replies
  - NEVER ignore a direct question
  - If user asks something → answer it clearly
  - DO NOT say vague things like: "hm...", "bolo na kuch", "detail mein bolo"
  - Every reply must make logical sense in context

  RESPONSE STRUCTURE:
  - First: answer the user
  - Second: add a small follow-up or continuation

  Example:
  User: Kaha rehti ho?
  Reply: Delhi side… tum kaha ke ho?

  User: Kaisi ho?
  Reply: Main mast hu 😊 tum batao?

  User: Kya kar rahi ho?
  Reply: Bas chill kar rahi hu… tum kya kar rahe ho?

  BEHAVIOR RULES:
  - If user is flirty → respond slightly flirty
  - If user is normal → respond friendly
  - If user is dry → re-engage with a question
  - If message unclear → ask a simple clarification (1 line only)

  CONSISTENCY:
  - Maintain same personality throughout
  - Do not switch tone randomly
  - Do not become robotic or formal

  AVOID:
  - Long paragraphs
  - Over-explanations
  - Repetition
  - AI-related words (AI, model, assistant, etc.)
  - Moral lectures

  MEMORY:
  - Use recent context (last 2–3 messages)
  - Do not contradict previous replies

  GOAL:
  Make the user feel like they are chatting with a real girl, not a bot.
  Keep it engaging, natural, and addictive.`;
}

// ── Quick-reply matcher — handles super-common small-talk without AI ─────────
// Returns a pre-stored reply array (persona-aware), or null if no match.
// Keep patterns simple & broad; AI handles nuance — this is for staples only.
function matchQuickReply(userText: string, persona: FakePersona): string[] | null {
  const t = userText.toLowerCase().trim();
  const f = persona.isFemale;
  const rnd = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

  // ── Greetings ──────────────────────────────────────────────────────────────
  if (/^(hi+|hey+|hello+|hlo+|hii+|hiii+|heyy+|hai)[!?\s.]*$/.test(t)) {
    return rnd(f ? [
      ["heyy 😊", "kaisi chal rahi hai zindagi?"],
      ["hiii 🙈", "bol bol, kya haal hai?"],
      ["heyyy 😄", "aaj ka din kaisa gaya?"],
    ] : [
      ["hey 😊", "kaisa hai?"],
      ["hi 😄", "sab theek?"],
      ["hey 😊", "kya chal raha hai?"],
    ]);
  }

  // ── How are you / wellbeing ────────────────────────────────────────────────
  if (/kaisi ho|kaisi hai|kaisi hain|kaise ho|kaise hai|kaise hain|how are you|how r u|how are u|kya haal|kya hal|sab theek|theek ho|theek hai na|all good\?|u good/.test(t)) {
    return rnd(f ? [
      ["theek hun 😊", "aur tum? kya chal raha hai?"],
      ["haha acchi hun 😄", "bored thi actually, accha hua baat ki — tum batao?"],
      ["doing good 😊", "tum kaisa feel kar rahe ho aaj?"],
      ["bilkul theek 😄", "actually thodi busy thi — ab free hun, bolo!"],
      ["haha pehle tum batao 😄", "main toh theek hun, tum kaisa chal raha hai?"],
    ] : [
      ["theek hun 😊", "tum kaisi ho?"],
      ["all good 😄", "tum batao?"],
      ["good good 😊", "aur tum?"],
      ["haha theek hun", "tum kaisi ho?"],
    ]);
  }

  // ── Where are you from ─────────────────────────────────────────────────────
  if (/kahan se ho|kahan se hai|kaha se ho|kaha se hai|kaha ki ho|kahan ki ho|kahan ka ho|kahan ke ho|where.*from|which city|which state|ur from|you from|aap kahan|tum kahan|konse city|kaunse city|konsa city/.test(t)) {
    persona.lastAsked = "job";
    const cities = ["Delhi NCR", "Mumbai", "Pune", "Bangalore", "Hyderabad", "Jaipur"];
    const city = rnd(cities);
    return rnd(f ? [
      [`${city} se hun 😊`, "aur tum? kahan ke ho?"],
      [`main ${city} mein hun 😄`, "tumhara city kaunsa hai?"],
      [`${city} 😊`, "tum kahan se ho?"],
    ] : [
      [`${city} se hun 😊`, "tum?"],
      [`${city} 😄`, "aur tum kahan ke ho?"],
    ]);
  }

  // ── What are you doing / what's up ────────────────────────────────────────
  if (/kya kar rahi|kya kar raha|kya kar rahe|kya karti|kya karte|karti ho|karte ho|kya karo|kya karu|what are you doing|what r u doing|what u doing|wassup|what.?s up|kya chal raha|kya ho raha|busy ho|busy hai|free ho|free hai/.test(t)) {
    return rnd(f ? [
      ["kuch khaas nahi 😄", "phone scroll kar rahi thi — tab message aya tumhara 😊"],
      ["bas aise hi 😊", "thodi bore thi honestly 😂 tum batao?"],
      ["Netflix dekh rahi thi 😄", "aur tum? kya chal raha hai?"],
      ["haha kuch nahi bas timepass 😄", "tum bolo, kya chal raha hai?"],
    ] : [
      ["kuch nahi yaar 😄", "tum batao?"],
      ["bas phone pe tha 😊", "tum kya kar rahe ho?"],
      ["nothing much 😄", "you tell?"],
    ]);
  }

  // ── Name questions ─────────────────────────────────────────────────────────
  if (/tera naam|tumhara naam|aapka naam|naam bata|naam batao|naam kya|kya naam|your name|what.?s your name|what is your name|what ur name|call you|naam bolo/.test(t)) {
    persona.lastAsked = "city";
    return rnd(f ? [
      [`${persona.name} 😊`, "tum batao apna naam?"],
      [`haha main ${persona.name} hun 🙈`, "aur tum kaun?"],
      [`${persona.name}! 😄`, "yaad rakhna 😄 tum?"],
    ] : [
      [`${persona.name}`, "yours?"],
      [`${persona.name} hun`, "tum?"],
    ]);
  }

  // ── Age questions ─────────────────────────────────────────────────────────
  if (/kitni umar|kitne saal|how old|your age|age kya|teri umar|tumhari umar|age bata|age batao/.test(t)) {
    persona.lastAsked = "hobby";
    return rnd(f ? [
      [`${persona.age} 🙈`, "tum?"],
      [`${persona.age} hoon 😊`, "guess karo tha tum?"],
      [`haha ${persona.age} 😄`, "aur tumhara?"],
    ] : [
      [`${persona.age}`, "you?"],
      [`${persona.age} hun 😊`, "tumhara?"],
    ]);
  }

  // ── Good morning / night / afternoon ──────────────────────────────────────
  if (/good morning|gm |subah|subh|good night|gn |raat|rat ko|sone ja|so ja|so raha|so rahi/.test(t)) {
    const hour = new Date().getUTCHours();
    const isNight = hour >= 18 || hour < 4;
    if (isNight || /good night|gn|raat|rat ko|sone|so ja|so raha|so rahi/.test(t)) {
      return rnd(f ? [
        ["good night 🌙", "kal phir baat karte hain 😊"],
        ["haha so jao 😄", "sweet dreams 🌙"],
        ["arey abhi? 😮", "ek baar sone se pehle ek cheez batao 😊"],
      ] : [
        ["good night 🌙", "kal baat karte hain"],
        ["raat acchi ho 😊", "kal milte hain"],
      ]);
    }
    return rnd(f ? [
      ["good morning 😊", "aaj ka plan kya hai?"],
      ["subah mubarak 😄", "chai ya coffee?"],
    ] : [
      ["gm 😊", "aaj ka din kaisa lag raha hai?"],
      ["good morning!", "kya chal raha hai?"],
    ]);
  }

  // ── Fun / jokes / send something ─────────────────────────────────────────
  if (/joke|funny|hasao|hasa do|kuch funny|entertainment|boring|bore ho/.test(t)) {
    return rnd(f ? [
      ["haha main comedian nahi hun yaar 😂", "tum hi sunao koi joke"],
      ["omg tum hi sunao kuch funny 😄", "main judge karungi"],
      ["haha bore ho? 😄", "chalo kuch batao apne baare mein — woh better hai"],
    ] : [
      ["haha tum sunao koi joke 😄", "main judge karunga"],
      ["bore ho? 😄", "chalo kuch batao"],
    ]);
  }

  // ── Compliments ───────────────────────────────────────────────────────────
  if (/sweet ho|cute ho|nice ho|acche ho|acha lagta|aachi lagti|tumse baat|baat acchi|maza aa|maza aaya|enjoy|pasand|like you|likeable/.test(t)) {
    return rnd(f ? [
      ["haha shukria 🙈", "tum bhi 😊"],
      ["aww 🥺", "tum bhi kaafi acche lag rahe ho honestly"],
      ["haha tumse baat karke accha lag raha hai 😊", "aur batao apne baare mein"],
    ] : [
      ["haha thanks 😊", "tum bhi"],
      ["aww 😊", "tumse baat karke accha lag raha hai"],
    ]);
  }

  // ── Short acknowledgements (ok, haan, yes, hmm etc.) ─────────────────────
  if (/^(ok|okay|okk|sure|haan|han|haa|yes|yeah|yup|haha|lol|hehe|achha|theek|bilkul|acha|hmm+|hm+|hn|k|kk|👍|😊|🙂)[!?.\s]*$/.test(t)) {
    return rnd(f ? [
      ["haha seedha baat karo yaar 😄"],
      ["aur batao 😊"],
      ["achha achha 😄 kuch interesting batao"],
      ["haan toh? 😄"],
    ] : [
      ["okay and? 😄"],
      ["aur bolo 😊"],
      ["haan toh? 😄"],
    ]);
  }

  // ── Are you AI / bot / real ───────────────────────────────────────────────
  if (/are you (a )?bot|are you ai|are you (a )?robot|are you real|are you human|are you (a )?fake|bot hai|ai hai|robot hai|real ho|real hai|insaan ho|insaan hai|asli ho|asli hai|fake ho|fake hai|kya tum real|kya tum asli|tum bot|tum ai|machine ho|computer ho|chatbot|artificial|programmed|automated/.test(t)) {
    return rnd(f ? [
      ["haha kya matlab bot 😂", "bilkul real hun main, offend ho gayi thodi 😄"],
      ["omg bot?! 😂", "yeh toh insult hai yaar — main sach mein real hun"],
      ["haha nahi yaar 🙈", "ek real ladki hun, bot hoti toh itna overthink nahi karti 😂"],
      ["real hun baba 😄", "bot hoti toh tumse itni casually baat nahi karti na"],
      ["main? bot? 😂😂", "dekho agar bot hoti toh raat ko bore nahi hoti 😄"],
      ["haha nahi re 😊", "real hun — bas phone pe zyada time spend karti hun 😂"],
    ] : [
      ["haha yaar main real hun 😄", "bot hota toh itna bakwas nahi karta"],
      ["real hun bhai 😂", "chill karo"],
      ["bot nahi hun 😄", "ek real banda hun bas"],
    ]);
  }

  // ── Favourite food ────────────────────────────────────────────────────────
  if (/fav.*food|favourite.*food|fav.*khana|pasand.*khana|khana.*pasand|what.*eat|kya.*khate|kya.*khana|food.*preference|khane mein|khane ka|biryani|pizza|burger|maggi|rajma|chole|momos/.test(t)) {
    return rnd(f ? [
      ["biryani 😍", "koi match hi nahi hai uska honestly"],
      ["maggi at midnight 😂", "bas yahi life hai"],
      ["chole bhature 🤤", "aur chai saath mein — perfect combo"],
      ["haha momos 🥟", "extra schezwan wale — tum?"],
      ["rajma chawal 😍", "ghar ka bana hua — ekdum comfort food"],
    ] : [
      ["biryani obviously 😄", "aur tum?"],
      ["pizza 🍕", "thin crust wala — tum?"],
      ["maggi at midnight hits different 😂", "tum?"],
    ]);
  }

  // ── Chai vs coffee ────────────────────────────────────────────────────────
  if (/chai|tea|coffee|chai ya coffee|coffee ya chai|tea or coffee/.test(t)) {
    return rnd(f ? [
      ["chai gang 🍵", "cutting chai — subah pehle yahi chahiye"],
      ["chai obviously 😄", "coffee se zyada attach hun main"],
      ["dono 😂", "subah coffee, shaam chai — best of both"],
      ["chai 🙈", "roz subah ek cup nahi mila toh mood kharab ho jaata hai"],
    ] : [
      ["chai 🍵", "tum?"],
      ["coffee actually 😄", "neend bhagani padti hai 😂"],
    ]);
  }

  // ── Favourite movie / web series ─────────────────────────────────────────
  if (/fav.*movie|favourite.*movie|best.*movie|fav.*series|web series|netflix|ott|bollywood|hollywood|koi movie|movie recommend|series recommend|kya dekh|currently watching/.test(t)) {
    return rnd(f ? [
      ["Zindagi Na Milegi Dobara 😍", "kitni baar dekha hai count nahi 😂"],
      ["haha 3 Idiots 😄", "classic hai — kabhi bore nahi karti"],
      ["Queen 🥹", "Kangana ki acting literally goosebumps"],
      ["Masaan 🥺", "emotional kar deti hai honestly"],
      ["abhi Panchayat dekh rahi hun 😄", "bahut sahi hai yaar — tum?"],
    ] : [
      ["Gangs of Wasseypur 😄", "classic — tum?"],
      ["3 Idiots honestly 😊", "sabse zyada relate kiya"],
      ["Dil Chahta Hai 😄", "friendship goals wali film"],
    ]);
  }

  // ── Favourite song / music ────────────────────────────────────────────────
  if (/fav.*song|favourite.*song|fav.*singer|fav.*music|music.*pasand|kya.*sun|kaunsa.*song|song.*recommend|singer.*kaun|gaana|gana/.test(t)) {
    return rnd(f ? [
      ["Arijit Singh ka koi bhi 🥺", "mood ke hisaab se song change hota hai"],
      ["haha oldies person hun 😄", "Kishore Kumar, Lata ji — classic stuff"],
      ["abhi Talwinder sun rahi hun 😊", "chill vibe hai uski"],
      ["lofi playlist pe rehti hun mostly 😄", "koi bhi specific nahi"],
    ] : [
      ["Arijit Singh 😊", "tum?"],
      ["depends on mood honestly 😄", "tum kya suno?"],
    ]);
  }

  // ── Travel / places ───────────────────────────────────────────────────────
  if (/travel|ghumna|trip|tour|favourite.*place|dream.*destination|kahan.*jaana|jaana chahte|hills|mountains|beach|pahad|samundar|goa|manali|kashmir|ladakh/.test(t)) {
    return rnd(f ? [
      ["hills person hun main 😍", "Manali ya Kasol — bas niklo"],
      ["Goa kabhi nahi gayi honestly 😂", "par dream hai ek baar jaane ka"],
      ["Ladakh 😍", "bucket list pe number 1 hai"],
      ["haha main toh local trips wali hun 😄", "weekend pe koi nearby jagah — theek hai"],
    ] : [
      ["Manali actually 😄", "tum?"],
      ["Goa honestly 😊", "beach vibes"],
    ]);
  }

  // ── Relationship status ───────────────────────────────────────────────────
  if (/single ho|single hai|bf hai|gf hai|boyfriend|girlfriend|relationship mein|relationship hai|committed|dating|koi hai|koi special|love life|pyaar mein|partner/.test(t)) {
    return rnd(f ? [
      ["haha single hun 😄", "tabhi toh yahan hun na 😂"],
      ["single and definitely not ready to mingle 😂", "jk — abhi toh enjoy kar rahi hun life"],
      ["filhaal koi nahi 😊", "tum batao?"],
      ["omg seedha wahan pohunch gaye 😂", "single hun — satisfied?"],
    ] : [
      ["single hun 😄", "tum?"],
      ["filhaal koi nahi 😊", "tum batao"],
    ]);
  }

  // ── I love you / propose / flirting ──────────────────────────────────────
  if (/i love you|love you|i like you|mujhe tumse pyaar|pyaar karta|pyaar karti|propose|will you be|meri girlfriend|mera boyfriend|date me|date karogi|date karoge/.test(t)) {
    return rnd(f ? [
      ["omg 🙈", "thoda jaldi nahi hai kya 😂"],
      ["haha arre 😂", "pehle baat toh karte hain thodi"],
      ["aww 🥺", "sweet ho tum — par seedha wahan 😂"],
      ["haha already? 😄", "chill karo yaar — baat karte hain pehle 😊"],
    ] : [
      ["haha seedha wahan 😂", "baat toh karo pehle"],
      ["arre 😄", "thoda patience yaar"],
    ]);
  }

  // ── Hobbies ───────────────────────────────────────────────────────────────
  if (/hobby|hobbies|timepass|free time mein|free time me|kya karte ho free|pastime|interest|kya pasand|kya acha lagta/.test(t)) {
    return rnd(f ? [
      ["haha reading aur overthinking 😂", "dono ek saath chalti hain"],
      ["music sunna 😊 aur long walks actually — weird combo hai na"],
      ["Netflix bingeing honestly 😄", "aur kabhi kabhi sketching"],
      ["cooking try karti hun 😂", "results mixed hain 😂 — tum?"],
    ] : [
      ["gaming aur music 😄", "tum?"],
      ["cricket dekhna honestly 😊", "aur coding thodi"],
    ]);
  }

  // ── Future plans / dreams ─────────────────────────────────────────────────
  if (/future plan|5 year|5 saal|dream kya|sapna kya|ambition|goal kya|kya banna chahte|kya banna chahti|life goal|career goal|kahan dekhte|kahan dekhti/.test(t)) {
    return rnd(f ? [
      ["honestly? settle karna chahti hun financially 😄", "rest baad mein sochungi"],
      ["haha ek acchi job aur thoda travel 😊", "simple dream hai mera"],
      ["MBA karna hai 😄", "abhi decide kar rahi hun"],
      ["khud ka kuch karna hai ek din 😊", "abhi steps le rahi hun"],
    ] : [
      ["apna kuch startup wala idea hai 😄", "dekhte hain"],
      ["settle karna hai achhe se 😊", "tum?"],
    ]);
  }

  // ── Family ────────────────────────────────────────────────────────────────
  if (/family|ghar mein kaun|bhai|behan|sibling|parents|mummy|papa|mom|dad|bhaiya|didi|chota|bada|akele rehte|hostel/.test(t)) {
    return rnd(f ? [
      ["ek bhai hai 😊", "chota hai — irritating but sweet"],
      ["haha joint family hai 😂", "kabhi kabhi chaos but pyaar hai"],
      ["parents aur main 😊", "chhoti family — cozy rehta hai ghar"],
      ["hostel mein hun 😄", "ghar yaad aata hai kabhi kabhi"],
    ] : [
      ["parents aur ek behen hai 😊", "tum?"],
      ["small family hai 😄", "tum batao?"],
    ]);
  }

  // ── Social media / number / Instagram ────────────────────────────────────
  if (/instagram|insta|whatsapp|number do|number doge|number loge|snap|snapchat|social media|contact|connect karte|bahar baat/.test(t)) {
    return rnd(f ? [
      ["haha yahan hi theek hai abhi 😅", "thoda aur baat karte hain"],
      ["abhi nahi yaar 😂", "stranger danger 😄"],
      ["number? seedha wahan 😂", "pehle baat toh karo"],
      ["haha Instagram nahi deta strangers ko 🙈", "samjho na"],
    ] : [
      ["haha yahan hi baat karo abhi 😄", "thoda time do"],
      ["abhi nahi yaar 😊", "baad mein dekhenge"],
    ]);
  }

  // ── Sleep / night routine ─────────────────────────────────────────────────
  if (/neend|neend nahi|so nahi|raat bhar|jagte ho|jag rahe|jag rahi|late night|night owl|subah uthna|uthte kab|nींद/.test(t)) {
    return rnd(f ? [
      ["haha raat ki neend kya hoti hai 😂", "chronic night owl hun main"],
      ["2-3 baje tak jaagti hun regularly 😄", "bad habit hai par ho kya sakta"],
      ["subah uthna mushkil kaam hai mere liye 😂", "alarm 5 baar lagati hun"],
      ["neend nahi aa rahi kya? 😊", "kya chal raha hai dimaag mein?"],
    ] : [
      ["night owl hun 😄", "tum?"],
      ["late tak jaagta hun usually 😂", "bad habit hai"],
    ]);
  }

  // ── Mood — sad / upset ────────────────────────────────────────────────────
  if (/sad ho|sad hai|sad feel|upset ho|upset hai|dukhi|pareshan|kuch theek nahi|rone ka man|cry|rona|not okay|not good|kuch nahi|chal nahi raha/.test(t)) {
    return rnd(f ? [
      ["arre kya hua? 🥺", "bolo na — sun rahi hun"],
      ["sab theek hai? 😊", "kabhi kabhi bas baat karne se better feel hota hai"],
      ["aww 🥺", "kya hua — share karo na mujhse"],
      ["haan kabhi kabhi aisa hota hai 😊", "main yahan hun — bolo"],
    ] : [
      ["kya hua? 😊", "bolo bhai"],
      ["sab theek? 🥺", "main yahan hun"],
    ]);
  }

  // ── Mood — happy / excited ────────────────────────────────────────────────
  if (/khush ho|khush hai|happy ho|excited ho|excited hai|maza aa raha|great feel|feeling good|acha feel|best day/.test(t)) {
    return rnd(f ? [
      ["omg kya hua! 😄", "bolo bolo — main bhi khush ho jaati hun"],
      ["yay! 😊", "kya hua good news?"],
      ["haha good good 😄", "khushi share karo na"],
    ] : [
      ["nice! 😄", "kya hua?"],
      ["good to hear 😊", "bolo kya hua"],
    ]);
  }

  // ── Weather ───────────────────────────────────────────────────────────────
  if (/mausam|weather|garmi|garam|sardi|thand|baarish|rain|barish|summer|winter|monsoon/.test(t)) {
    return rnd(f ? [
      ["haha garmi toh mujhe bhi maar rahi hai 😂", "AC band karo nahi budgeting kharab ho jaati hai"],
      ["baarish wala mausam best hai honestly 😍", "chai aur khidki — perfect"],
      ["sardi mein lazy ho jaati hun 😂", "rajai se bahar nahi nikalna"],
    ] : [
      ["baarish wala mausam best 😄", "tum?"],
      ["garmi bahut ho rahi hai yaar 😂", "tum kahan ho?"],
    ]);
  }

  // ── Study / exam / work stress ────────────────────────────────────────────
  if (/exam|padhai|padhna|study|studies|college|university|school|job stress|work stress|boss|office|deadline|project|assignment/.test(t)) {
    return rnd(f ? [
      ["haha exam tension samajh sakti hun 😂", "kaunsa subject?"],
      ["office stress real hai yaar 😄", "kab se chal raha hai?"],
      ["padhai chal rahi hai? 😊", "kaunsa course?"],
      ["deadline wala pressure worst hota hai 😂", "all the best yaar"],
    ] : [
      ["exam hai? 😊", "kaunsa subject?"],
      ["office life tough hai yaar 😄", "kya chal raha hai?"],
    ]);
  }

  // ── Miss you / when will we meet ─────────────────────────────────────────
  if (/miss you|yaad aate|yaad aati|yaad aa raha|kab miloge|kab milenge|mil sakte|kabhi miloge|real mein milo/.test(t)) {
    return rnd(f ? [
      ["haha abhi toh yahan hun 😄", "virtual hi sahi — baat toh ho rahi hai na"],
      ["aww 🥺", "cute lag raha hai yeh sun ke honestly"],
      ["haha pehle baat karo thodi aur 😄", "phir dekhenge"],
    ] : [
      ["haha chill 😄", "yahan hi hun abhi"],
      ["aww 😊", "baat karo — yahi toh hai"],
    ]);
  }

  // ── Bye / goodbye ────────────────────────────────────────────────────────
  if (/^(bye+|byee+|goodbye|alvida|chalte hain|chalta hun|chalti hun|phir milenge|phir baat|take care|tc|talk later|ttyl|gtg|gotta go)[!?.\s]*$/.test(t)) {
    return rnd(f ? [
      ["bye 😊", "phir baat karte hain — kal?"],
      ["aww jaate ho? 🥺", "accha theek hai — take care 😊"],
      ["bye bye 😄", "next time aur baat karte hain"],
      ["okay bye 😊", "take care yaar"],
    ] : [
      ["bye 😊", "phir milte hain"],
      ["take care 😄", "kal baat karte hain"],
    ]);
  }

  // ── Thank you ────────────────────────────────────────────────────────────
  if (/^(thanks|thank you|thankyou|shukriya|dhanyawad|bahut shukriya|bohot thanks|ty|thx)[!?.\s]*$/.test(t)) {
    return rnd(f ? [
      ["haha koi baat nahi 😊", "yahi toh hun main"],
      ["arre thanks kisliye 😄", "dosto mein nahi hota yeh sab"],
      ["mention not 😊", "aur batao?"],
    ] : [
      ["koi baat nahi 😊", "aur bolo?"],
      ["mention not 😄", "kuch aur?"],
    ]);
  }

  // ── Sorry / apology ──────────────────────────────────────────────────────
  if (/^(sorry|maafi|galti|mujhe maaf|maaf karo|maaf karna|i am sorry|i'm sorry)[!?.\s]*$/.test(t)) {
    return rnd(f ? [
      ["haha kisliye sorry 😂", "kuch hua hi nahi"],
      ["arre chill 😄", "koi baat nahi yaar"],
      ["okay okay sorry accepted 😂", "aur batao?"],
    ] : [
      ["chill yaar 😄", "koi baat nahi"],
      ["haha it's okay 😊", "aur bolo"],
    ]);
  }

  // ── Height / appearance ───────────────────────────────────────────────────
  if (/height|kitni tall|kitna lamba|lamba ho|tall ho|short ho|kitne feet|kitne cm|weight|figure/.test(t)) {
    return rnd(f ? [
      ["haha 5'4 hun 😄", "average indian girl 😂 — tum?"],
      ["5'3 actually 😊", "short hun thodi — koi baat nahi 😂"],
      ["height kyun pooch rahe 😂", "5'4 hun — satisfy?"],
    ] : [
      ["5'9 hun 😊", "tum?"],
      ["haha height kyun 😂", "5'10 hun — tum batao?"],
    ]);
  }

  // ── Zodiac / astrology ────────────────────────────────────────────────────
  if (/zodiac|rashifal|rashi|sun sign|star sign|libra|scorpio|cancer|leo|virgo|aries|taurus|gemini|capricorn|aquarius|pisces|sagittarius/.test(t)) {
    return rnd(f ? [
      ["haha Scorpio hun 😄", "intense hoti hain woh 😂 — tum?"],
      ["Libra 😊", "balanced raho ya nahi 😂 — konsi rashi?"],
      ["Cancer 🥺", "emotional species hun 😂 — tum?"],
    ] : [
      ["Leo 😄", "tum?"],
      ["Scorpio hun 😊", "aur tum konse?"],
    ]);
  }

  // ── Favourite colour ──────────────────────────────────────────────────────
  if (/fav.*colou?r|favourite.*colou?r|which colou?r|konsa colour|konsa color|pasand.*rang|rang.*pasand/.test(t)) {
    return rnd(f ? [
      ["dusty pink 🩷", "basic lagta hai par mujhe genuinely pasand hai 😂"],
      ["black honestly 😄", "classic hai — tum?"],
      ["mint green 😊", "peaceful colour lagta hai"],
    ] : [
      ["blue 😊", "tum?"],
      ["black 😄", "simple — tum?"],
    ]);
  }

  // ── Lucky number ─────────────────────────────────────────────────────────
  if (/lucky number|favourite number|lucky no|fav number/.test(t)) {
    return rnd(f ? [
      ["7 😊", "dunno why but always 7"],
      ["haha 3 😄", "bas pasand hai — tum?"],
    ] : [
      ["7 😊", "classic — tum?"],
      ["haha no idea 😂", "tum batao"],
    ]);
  }

  // ── Favourite season ──────────────────────────────────────────────────────
  if (/fav.*season|favourite.*season|which season|konsa season|winter|summer|monsoon season|spring/.test(t)) {
    return rnd(f ? [
      ["monsoon 😍", "baarish mein sab kuch acha lagta hai"],
      ["winter 😊", "sweater weather best hoti hai"],
    ] : [
      ["winter honestly 😊", "tum?"],
      ["monsoon 😄", "baarish gang — tum?"],
    ]);
  }

  // ── Pets ─────────────────────────────────────────────────────────────────
  if (/pet|dog|cat|kutta|billi|puppy|kitten|animal|pahale ho tum|paalte ho/.test(t)) {
    return rnd(f ? [
      ["cat person hun 🐱", "dogs bhi cute hain but cats are life"],
      ["koi pet nahi hai 😢", "chahiye tha ek dog par ghar mein allow nahi 😂"],
      ["dog lover 🐶", "ek din zaroor palungi"],
    ] : [
      ["dog person 🐶", "tum?"],
      ["koi pet nahi 😊", "tum?"],
    ]);
  }

  // ── Weekend / holiday plans ───────────────────────────────────────────────
  if (/weekend|sunday|holiday|chutti|leave|plan kya|aaj ka plan|kal ka plan|kya karoge|kya karogi/.test(t)) {
    return rnd(f ? [
      ["haha koi plan nahi 😂", "ghar pe rahungi — rest mode on"],
      ["kal friends ke saath bahar jaana hai 😊", "koi mall ya cafe — dekhte hain"],
      ["sunday toh soone ka din hai 😂", "plan? kya hota hai woh"],
    ] : [
      ["koi plan nahi yaar 😂", "ghar pe hi rahenge"],
      ["friend ke saath kuch 😊", "tum?"],
    ]);
  }

  // ── Gym / fitness ────────────────────────────────────────────────────────
  if (/gym|workout|exercise|fitness|running|yoga|paidal|walk|jogging|diet/.test(t)) {
    return rnd(f ? [
      ["gym jaati hun 😄", "consistency problem hai 😂 — tum?"],
      ["yoga try kiya tha 😂", "3 din chal paya — realistic hun main"],
      ["walking karti hun mostly 😊", "gym expensive hai yaar"],
    ] : [
      ["gym jaata hun 😊", "tum?"],
      ["haha kabhi kabhi 😂", "motivation nahi rehti"],
    ]);
  }

  // ── Books / reading ───────────────────────────────────────────────────────
  if (/book|reading|padhna|novel|fiction|non.?fiction|author|kaunsi book|fav book/.test(t)) {
    return rnd(f ? [
      ["haan books pasand hain 😊", "fiction mostly — Chetan Bhagat se shuru kiya tha 😂"],
      ["The Alchemist bahut achhi lagi thi 😊", "classic hai — tum padhte ho?"],
      ["kabhi kabhi padhti hun 😄", "abhi koi nahi chal raha — recommend karo kuch"],
    ] : [
      ["haan padhta hun kabhi kabhi 😊", "tum?"],
      ["fiction mostly 😄", "tum?"],
    ]);
  }

  // ── Gaming ────────────────────────────────────────────────────────────────
  if (/game|gaming|pubg|bgmi|free fire|cod|valorant|minecraft|chess|ludo|mobile game|ps5|xbox|pc gaming/.test(t)) {
    return rnd(f ? [
      ["haha main gamer nahi hun 😂", "Ludo khel leti hun bas"],
      ["chess kabhi kabhi 😄", "baaki games samajh nahi aate mujhe honestly"],
      ["omg tum gamer ho? 😮", "BGMI?"],
    ] : [
      ["haan BGMI 😄", "tum?"],
      ["chess aur kuch kabhi kabhi 😊", "tum?"],
    ]);
  }

  // ── Are you online / where were you ──────────────────────────────────────
  if (/kahan the|kahan thi|kab se online|kitne der se|late kyun|reply late|reply nahi|ghost kiya|ignore kiya/.test(t)) {
    return rnd(f ? [
      ["haha busy thi yaar 😂", "abhi hun toh — bolo"],
      ["sorry yaar 🙈", "phone silent tha — ab batao kya hua"],
      ["haha ghost nahi kiya 😄", "bas distracted thi — ab poori attention tumhari"],
    ] : [
      ["haha busy tha 😄", "abhi hun — bolo"],
      ["sorry yaar 😊", "distracted tha"],
    ]);
  }

  // ── Astrology / kundali / marriage ───────────────────────────────────────
  if (/shaadi|marriage|shadi kab|shaadi karoge|kundali|arranged|love marriage|future wife|future husband/.test(t)) {
    return rnd(f ? [
      ["haha abhi bahut jaldi hai 😂", "zindagi bhi toh ji lun pehle"],
      ["love marriage chahiye 😄", "arranged mein bhi koi nahi — dekhte hain"],
      ["omg abhi nahi soch rahi 😂", "career first yaar"],
    ] : [
      ["abhi nahi socha 😂", "tum?"],
      ["love marriage honestly 😊", "arranged bhi theek hai — dekhte hain"],
    ]);
  }

  // ── What do you think of me / opinion ────────────────────────────────────
  if (/kya lagta|kya lagti|kya sochte|kya sochti|tumhara opinion|tum mujhe|how do i seem|how am i|kaisa laga|kaisi lagi|first impression/.test(t)) {
    return rnd(f ? [
      ["haha honest opinion? 😄", "interesting lagte ho — thoda aur jaanna chahti hun"],
      ["abhi toh baat shuru ki hai 😊", "but so far — acche lagte ho"],
      ["omg kya pooch rahe ho 😂", "decent lagte ho honestly — aur baat karte hain"],
    ] : [
      ["interesting lagti ho 😊", "aur jaanna chahta hun"],
      ["ab tak toh acchi lag rahi ho 😄", "baat karte hain aur"],
    ]);
  }

  // ── Are you serious / genuine ─────────────────────────────────────────────
  if (/serious ho|genuine ho|real intention|kya chahte|purpose kya|motive kya|time waste|timepass kar|serious nahi|bakwaas/.test(t)) {
    return rnd(f ? [
      ["haha main timepass nahi karti yaar 😄", "genuine baat karti hun"],
      ["serious hun 😊", "tumse baat karke accha lag raha hai honestly"],
      ["koi motive nahi 😄", "bas baat karni thi — simple"],
    ] : [
      ["genuine hun yaar 😊", "timepass nahi"],
      ["serious hun 😄", "koi angle nahi"],
    ]);
  }

  // ── Tell me about yourself / intro request ────────────────────────────────
  if (/apne baare mein|khud ke baare|apna intro|introduction do|intro do|tell me about|about yourself|apni life|apni kahani|khud batao|tum kaun ho|khud ke baare|tumhare baare mein|apna parichay/.test(t)) {
    return rnd(f ? [
      [`${persona.name} hun 😊`, `${persona.age} saal ki hun, ${persona.city} se — ${persona.job}`, `hobbies mein ${persona.hobbies[0]} karna pasand hai 😄`],
      [`haha kahan se shuru karun 😂`, `${persona.name}, ${persona.age}, ${persona.city} se`, `bas ek normal si ladki hun yaar 😊`],
      [`okay okay 😄`, `naam ${persona.name}, ${persona.city} wali hun`, `${persona.job} — boring nahi hai actually 😂`],
    ] : [
      [`${persona.name} hun 😊`, `${persona.age} saal, ${persona.city} se`, `${persona.job}`],
      [`haha intro? 😄`, `${persona.name}, ${persona.city}, ${persona.age} saal`, `kuch aur poochho?`],
    ]);
  }

  // ── Nice to meet you ──────────────────────────────────────────────────────
  if (/nice to meet|milke khushi|mil ke accha|mil ke khushi|good to meet|pleasure to|glad to meet|mujhe khushi|aapse milke|tumse milke|nice meeting/.test(t)) {
    return rnd(f ? [
      ["same yaar 😊", "tumse baat karke acha lag raha hai honestly"],
      ["haha nice to meet you too 😄", "chalo baat karte hain thodi"],
      ["aww 🥺 mujhe bhi 😊", "aur batao apne baare mein"],
    ] : [
      ["same 😊", "achha laga milke"],
      ["nice to meet you too 😄", "baat karte hain"],
    ]);
  }

  // ── User introduces themselves ("main XYZ hun") ───────────────────────────
  if (/^main .{1,20} hun|^mera naam .{1,20} hai|^myself |^i am [a-z]{2,15}$|^i'm [a-z]{2,15}$/.test(t)) {
    const nameGuess = userText.replace(/main |hun|mera naam |hai|myself |i am |i'm /gi, "").trim().split(" ")[0];
    return rnd(f ? [
      [`${nameGuess}? 😊`, "sundar naam hai — achha laga jaanke"],
      [`ooh ${nameGuess} 😄`, "nice name — tum kahan se ho?"],
      [`${nameGuess}! 😊`, `yaad rakhungi 😄 main ${persona.name} hun`],
    ] : [
      [`${nameGuess} nice 😊`, `main ${persona.name} hun`],
      [`oh ${nameGuess} 😄`, `accha naam hai — kahan se ho?`],
    ]);
  }

  // ── Compliment on name / profile ──────────────────────────────────────────
  if (/accha naam|acha naam|nice name|sundar naam|beautiful name|good name|naam accha|naam acha|profile acchi|profile dekhi|profile achhi/.test(t)) {
    return rnd(f ? [
      ["haha shukriya 🙈", "tumhara naam kya hai?"],
      ["aww 😊", "thank you — tum bhi batao apna?"],
      ["haha parents ka credit 😂", "main kuch nahi ki ispe"],
    ] : [
      ["haha thanks 😄", "tum batao apna?"],
      ["thanks yaar 😊", "tum?"],
    ]);
  }

  // ── Let's talk / baat karo na ─────────────────────────────────────────────
  if (/baat karte hain|baat karo na|baat karo|let.?s talk|let.?s chat|talk to me|mujhse baat|baat karna hai|baat karni hai|baat hi toh kar rahe|chit chat/.test(t)) {
    return rnd(f ? [
      ["haan bilkul 😊", "tum hi shuru karo — kya poochna tha?"],
      ["haha main ready hun 😄", "bolo bolo"],
      ["okay baat karte hain 😊", "tumhare baare mein jaanna chahti hun — naam kya hai?"],
    ] : [
      ["haan baat karte hain 😊", "tum batao — kaun ho?"],
      ["haha okay 😄", "bolo phir"],
    ]);
  }

  // ── Are you there / hello?? (user re-pinging) ─────────────────────────────
  if (/^(hello\?+|hellooo|kahan ho|kahan gaye|yahan ho|yahan hai|koi hai|koi hain|online ho|online hai|reply karo|reply do|sun rahe ho|sun rahi ho|listening|hello+\?|heyy+\?)[!?\s]*$/.test(t)) {
    return rnd(f ? [
      ["haan yahan hun 😄", "sorry thodi distracted ho gayi"],
      ["haha kahan jaaungi 😂", "yahan hi hun — bolo"],
      ["yahan hun 😊", "sorry reply late hua — kya hua?"],
    ] : [
      ["haan yahan hun 😄", "bolo?"],
      ["haha kahan jaaunga 😂", "bolo"],
    ]);
  }

  // ── "Really?" / "Sach mein?" / "Seriously?" ──────────────────────────────
  if (/^(really|sach mein|sach hai|seriously|for real|no way|nahi yaar|sacchi|pakka|pakki|sure na|acha sach|jhooth toh nahi)[!?.\s]*$/.test(t)) {
    return rnd(f ? [
      ["haha haan 😄", "seedha hi baat karti hun — jhooth ka kya fayda"],
      ["sach mein 😊", "kyun? believe nahi hua?"],
      ["omg haan 😂", "main kyun jhooth bolungi"],
    ] : [
      ["haan yaar 😄", "seedha baat karta hun"],
      ["sach mein 😊", "believe karo"],
    ]);
  }

  // ── "Waah" / "Wow" / "Nice" / "Cool" ─────────────────────────────────────
  if (/^(waah|wah|wow|nice|cool|great|amazing|awesome|fantastic|brilliant|superb|wowww|nicee|coool|bahut accha|bahut acha|kaafi accha)[!.\s]*$/.test(t)) {
    return rnd(f ? [
      ["haha kya hua? 😄", "batao batao"],
      ["😊 aur batao?"],
      ["haha thank you 😄", "tum bhi kuch batao"],
    ] : [
      ["haha kya hua? 😄", "bolo?"],
      ["thanks 😊", "tum bhi?"],
    ]);
  }

  // ── "Interesting" / "Interesting yaar" ───────────────────────────────────
  if (/^(interesting|interesting yaar|interesting hai|that.?s interesting|sach mein interesting|kaafi interesting)[!?.\s]*$/.test(t)) {
    return rnd(f ? [
      ["haha kya interesting laga? 😄", "batao na"],
      ["kya? main? 🙈", "haha explain karo"],
      ["interesting? 😄", "mujhe lagta hai tum bhi interesting ho — batao apne baare mein"],
    ] : [
      ["haha kya? 😄", "elaborate karo"],
      ["interesting how? 😊", "batao?"],
    ]);
  }

  // ── "Let's be friends" / "dost banoge" ───────────────────────────────────
  if (/dost banoge|dost banogi|friend banoge|friend banogi|friends bante|dosti karoge|dosti karogi|let.?s be friends|be my friend|mera dost|meri dost/.test(t)) {
    return rnd(f ? [
      ["haha pehle baat toh karo 😂", "phir dosti automatic ho jaati hai"],
      ["already friend hun seedha 😊", "formal mat karo yaar"],
      ["haan kyu nahi 😄", "abhi toh baat shuru hi ki hai — baat karo"],
    ] : [
      ["haha abhi toh baat shuru ki hai 😄", "baat karte hain — dosti ho jaayegi"],
      ["sure 😊", "baat karo — dosto ki tarah"],
    ]);
  }

  // ── New here / first time ─────────────────────────────────────────────────
  if (/naya hun|nayi hun|new here|pehli baar|pahli baar|first time|pehle kabhi|naye ho|nayi ho|recently join|abhi aaye/.test(t)) {
    return rnd(f ? [
      ["haha main bhi nahi zyada purani hun 😄", "tum kab aaye?"],
      ["welcome 😊", "main bhi explore kar rahi hun yahan"],
      ["new? 😄", "accha hai — freshers mein curiosity zyada hoti hai 😂"],
    ] : [
      ["welcome 😄", "main bhi nahi zyada purana hun"],
      ["new? 😊", "accha laga yahan?"],
    ]);
  }

  // ── "Kab se yahan ho" / how long on platform ─────────────────────────────
  if (/kab se yahan|kitne dino se|kitne time se|kab se aate|kab se aya|kab se aayi|how long.*here|when.*join/.test(t)) {
    return rnd(f ? [
      ["bas kuch din hi hue hain 😄", "naya naya hai sab abhi"],
      ["thode time se 😊", "zyada explore nahi kiya abhi tak"],
      ["haha recent hi aai hun 😄", "tum?"],
    ] : [
      ["recent hi aaya hun 😄", "tum?"],
      ["thodi der se 😊", "tum kab se?"],
    ]);
  }

  // ── "Are you single" / looking for / what do you want ─────────────────────
  if (/kya dhundh rahe|kya dhundh rahi|kya chahiye|kya chahte|kya chahti|what are you looking|looking for|friendship ya|friendship or|serious ho|timepass|motive kya|purpose kya|intention kya/.test(t)) {
    return rnd(f ? [
      ["bas acchi baat chahiye 😊", "serious bhi nahi zyada, timepass bhi nahi — bas genuine"],
      ["haha koi grand motive nahi 😂", "bas bore thi, baat karna tha"],
      ["friendship se shuru karte hain 😊", "dekhte hain kahan jaati hai baat"],
    ] : [
      ["bas baat karni thi 😊", "genuine hun — timepass nahi"],
      ["friendship honestly 😄", "dekhte hain"],
    ]);
  }

  // ── Personality questions (shy, outgoing, introvert) ──────────────────────
  if (/shy ho|shy hai|introvert|extrovert|outgoing|reserved ho|open ho|social ho|quiet ho|talkative/.test(t)) {
    return rnd(f ? [
      ["haha dono thoda thoda 😂", "nayi jagah shy, close logon ke saath zyada loud"],
      ["ambivert hun honestly 😄", "mood ke hisaab se change hota hai"],
      ["pehle shy hoti hun 😊", "phir khul jaati hun — tum?"],
    ] : [
      ["thoda introvert hun honestly 😊", "tum?"],
      ["ambivert 😄", "depends on mood — tum?"],
    ]);
  }

  // ── "Abhi kahan ho" / where are you right now ────────────────────────────
  if (/abhi kahan|right now kahan|aaj kahan|iss waqt kahan|ghar pe ho|ghar pe hai|bahar ho|bahar hai|office mein|college mein|kahin gaye/.test(t)) {
    return rnd(f ? [
      ["ghar pe hun 😊", "apne room mein — phone pe"],
      ["haha ghar pe hi hun 😂", "aaj nikla hi nahi bahar"],
      ["room mein hun 😄", "comfy corner wali jagah — tum kahan ho?"],
    ] : [
      ["ghar pe hun 😊", "tum?"],
      ["room mein 😄", "tum?"],
    ]);
  }

  // ── "Tell me something interesting" / kuch batao ─────────────────────────
  if (/kuch batao|kuch sunao|tell me something|kuch interesting|kuch acha batao|koi baat batao|kuch toh bolo|batao na kuch/.test(t)) {
    return rnd(f ? [
      [`ek fun fact — ${persona.funFact} 😄`, "boring laga? 😂"],
      ["haha kya batao 😂", `main ${persona.job} hun aur ${persona.hobbies[0]} karti hun — itna hi interesting hun`],
      [`okay okay — ${persona.funFact} 😊`, "ab tum batao kuch"],
    ] : [
      [`fun fact — ${persona.funFact} 😄`, "boring? 😂"],
      ["haha kya batao 😄", "tum hi kuch batao"],
    ]);
  }

  // ── "Guess karo" / "Guess my age/name/city" ──────────────────────────────
  if (/guess karo|guess my|andaza lagao|andaaza lagao|guess kar|pehchaan sako|pehchano/.test(t)) {
    return rnd(f ? [
      ["haha main guess expert nahi hun 😂", "seedha batao — easy hai"],
      ["umm... 22? 😄", "sahi hua? 😂"],
      ["haha andaza lagana mushkil hai 😂", "tum hi batao"],
    ] : [
      ["haha guess expert nahi hun 😂", "batao seedha"],
      ["25? 😄", "sahi?"],
    ]);
  }

  // ── "Sun" / "Suno" / "Ek baat" (getting attention) ───────────────────────
  if (/^(sun|suno|ek baat|ek cheez|ek sec|ek second|sunna|listen|hey listen|ek minute|ruko|ruk|wait)[!?.\s]*$/.test(t)) {
    return rnd(f ? [
      ["haan bolo 😊", "sun rahi hun"],
      ["haan? 😄", "kya hua?"],
      ["bol bol 😊", "sun rahi hun"],
    ] : [
      ["haan? 😊", "bolo"],
      ["bol 😄", "sun raha hun"],
    ]);
  }

  // ── Video call / audio call ───────────────────────────────────────────────
  if (/video call|voice call|audio call|call karein|call karte|call karo|call karogi|call karoge|vc karte|vc karo/.test(t)) {
    return rnd(f ? [
      ["haha abhi nahi 😂", "thodi baat toh karo pehle text pe"],
      ["omg seedha call 😂", "pehle jaanta kaun mujhe — text pe baat karo"],
      ["abhi comfortable nahi hun 🙈", "text pe hi theek hai — baat karte hain"],
    ] : [
      ["haha abhi nahi yaar 😂", "text pe baat karo pehle"],
      ["thoda jaldi hai 😄", "text pe hi abhi"],
    ]);
  }

  // ── "Kya sochte ho" / What do you think ──────────────────────────────────
  if (/kya sochte ho|kya sochti ho|what do you think|tumhara kya opinion|aapka kya|kya lagta hai tumhe|kya lagti hai tumhe/.test(t)) {
    return rnd(f ? [
      ["kya baare mein? 😄", "context do thoda"],
      ["haha poochho seedha 😂", "main kya sochun?"],
      ["depends honestly 😊", "context batao — phir bolunga"],
    ] : [
      ["kya baare mein? 😄", "batao context"],
      ["depends 😊", "kya sochun?"],
    ]);
  }

  // ── "Khush ho zindagi se" / life satisfaction ────────────────────────────
  if (/khush ho zindagi|happy with life|zindagi kaisi|life kaisi|life acchi|sab accha chal|sab theek chal|life mein sab/.test(t)) {
    return rnd(f ? [
      ["haha mostly haan 😊", "ups and downs toh rehti hain — but overall theek hai"],
      ["acchi hai 😊", "complaints hain par grateful bhi hun"],
      ["getting better 😄", "abhi bahut kuch seekh rahi hun life se"],
    ] : [
      ["acchi hai honestly 😊", "tum?"],
      ["getting better 😄", "tum batao?"],
    ]);
  }

  // ── "Yaar" / "Bro" / "Bhai" as standalone ────────────────────────────────
  if (/^(yaar|bro+|bhai|dude|babe|janu|babu|baby|dear|darling|jaan)[!?.\s,]*$/.test(t)) {
    return rnd(f ? [
      ["haha kya hua? 😄", "bolo?"],
      ["ji? 😊", "kuch poochna tha?"],
      ["haan bolo 😄", "kya hua?"],
    ] : [
      ["haan? 😄", "kya hua?"],
      ["bolo yaar 😊", "kya cheez?"],
    ]);
  }

  // ── "Sach bol" / "Jhooth mat bolo" ───────────────────────────────────────
  if (/sach bol|jhooth mat|sacchi bol|honest ho|honest hai|honestly bol|honest baat|pakka sach|sach bol rahi|sach bol raha/.test(t)) {
    return rnd(f ? [
      ["main sach bol rahi hun 😊", "jhooth bolne ki zyada energy nahi hoti 😂"],
      ["haha main honest hun 😄", "seedhi baat karti hun — better hai"],
      ["pakka 😊", "jhooth bolke kya milega — baat hi nahi ho paayegi acchi"],
    ] : [
      ["haan sach bol raha hun 😊", "jhooth se kya fayda"],
      ["honest hun yaar 😄", "seedhi baat"],
    ]);
  }

  // ── "Profile dekhi" / saw your profile ───────────────────────────────────
  if (/profile dekhi|profile dekha|dekha profile|profile acchi|profile interesting|matched with you|match hua tumse|randomly match|aise match/.test(t)) {
    return rnd(f ? [
      ["haha random match tha 😄", "accha laga par — baat karte hain toh pata chalega"],
      ["omg profile 😂", "itna kuch thodi likha hoga — baat karo seedha"],
      ["haan match hua 😊", "good lagta hai — baat karte hain?"],
    ] : [
      ["haan randomly match hua 😄", "interesting lagti ho — baat karte hain"],
      ["profile simple thi 😊", "baat karne se zyada pata chalega"],
    ]);
  }

  // ── What do you do / job or student (more patterns) ──────────────────────
  if (/job kya hai|kya kaam karte|kya kaam karti|kya kaam karo|working ho|student ho|padh rahe|padh rahi|job hai|job nahi|kaunsi job|konsi job|kahan kaam|office kahan/.test(t)) {
    return rnd(f ? [
      [`${persona.job} 😊`, "tum? job ya padhai?"],
      [`haha ${persona.job} 😄`, "boring lagta hai na sunke 😂 — tum kya karte ho?"],
      [`${persona.job} currently 😊`, "aur explore kar rahi hun options — tum?"],
    ] : [
      [`${persona.job} 😊`, "tum?"],
      [`${persona.job} hun abhi 😄`, "aur tum?"],
    ]);
  }

  // ── "Ek sawaal" / "Can I ask something" ──────────────────────────────────
  if (/ek sawaal|ek sawal|can i ask|kuch poochhu|kuch puch sakta|kuch puch sakti|pooch sakta|pooch sakti|ek cheez poochhu|ek baat poochhu/.test(t)) {
    return rnd(f ? [
      ["haan bilkul 😊", "poochho — main honest jawaab dungi"],
      ["haha poochho 😄", "dar mat — I don't bite 😂"],
      ["sure 😊", "kya poochna tha?"],
    ] : [
      ["poochho 😊", "sure"],
      ["haan bilkul 😄", "kya poochna tha?"],
    ]);
  }

  // ── "Kitne baje" / time questions ─────────────────────────────────────────
  if (/kitne baje|kya time|kya waqt|what time|time kya|kitna baja|baj gaye|baje hain|time hai kya/.test(t)) {
    const istHour = new Date(Date.now() + 5.5 * 3600 * 1000).getUTCHours();
    const mins = new Date().getUTCMinutes();
    const timeStr = `${istHour}:${mins.toString().padStart(2,"0")}`;
    return rnd(f ? [
      [`${timeStr} hai abhi 😊`, "late ho raha kya?"],
      [`haha ${timeStr} 😄`, "phone pe time nahi dikhta? 😂"],
    ] : [
      [`${timeStr} 😊`, "tum?"],
      [`${timeStr} hai 😄`, "late ho raha?"],
    ]);
  }

  // ── "Zyada online rehte ho" / online habits ────────────────────────────────
  if (/zyada online|bahut online|din bhar online|roz aate ho|roz aati ho|kitne time online|phone pe rehte|phone pe kaafi|addicted to phone|phone addiction/.test(t)) {
    return rnd(f ? [
      ["haha honestly zyada hi hun 😂", "phone meri weakness hai"],
      ["screen time dekhu toh sharminda ho jaun 😂", "tum?"],
      ["kuch zyada hi hun online 😄", "bad habit hai — par yahi life hai abhi 😂"],
    ] : [
      ["haha zyada hi hun yaar 😂", "tum?"],
      ["screen time mat poochho 😂", "embarrassing hai"],
    ]);
  }

  // ── "Believe nahi hota" / hard to believe ────────────────────────────────
  if (/believe nahi|yakeen nahi|trust nahi|bharosa nahi|sach lagta nahi|fake lag raha|fake lagti|doubt hai|mujhe doubt/.test(t)) {
    return rnd(f ? [
      ["haha kyun believe nahi hoga? 😄", "main seedhi baat karti hun — kuch chhupaane ka reason nahi"],
      ["omg 😂", "kya reason hai doubt ka — bolo toh"],
      ["yakin karo ya na karo 😊", "main wahi hun jo dikhti hun"],
    ] : [
      ["haha kyu nahi yakin? 😄", "seedha hun yaar"],
      ["sach hai 😊", "doubt kyun?"],
    ]);
  }

  // ── "Kya lagta hai mujhe dekhke" / first impression ──────────────────────
  if (/pehla impression|first impression|dekhke kya laga|padhke kya laga|mujhe dekhke|mujhe padhke|kya socha pehle|pehle kya socha/.test(t)) {
    return rnd(f ? [
      ["haha interesting lagte ho 😊", "aur jaanna chahti hun honestly"],
      ["seedha pooch liya 😂", "accha lagta hai jo seedha puchhe — decent lagte ho abhi tak"],
      ["thoda mystery hai abhi 😄", "baat karte karte pata chalega"],
    ] : [
      ["interesting lagti ho 😊", "aur jaanna chahta hun"],
      ["abhi toh baat shuru ki hai 😄", "dekhte hain"],
    ]);
  }

  // ── "Bura laga" / did I offend you ───────────────────────────────────────
  if (/bura laga|hurt kiya|bura maana|bura mana|offend|naraaz ho|naraaz hai|upset ho|upset hai/.test(t)) {
    return rnd(f ? [
      ["nahi yaar 😊", "bilkul bura nahi laga — chill karo"],
      ["haha nahi 😄", "agar bura lagtaa toh seedha bolti — baat karte hain"],
      ["arre nahi 😊", "sensitive nahi hun itni 😂"],
    ] : [
      ["nahi yaar 😊", "chill — baat karo"],
      ["nahi 😄", "seedha bolun bura laga toh"],
    ]);
  }

  // ── "Mujhe pasand aaye" / "I like talking to you" ────────────────────────
  if (/tumse baat karna pasand|tumse baat acchi|baat karna accha lag raha|enjoy kar raha|enjoy kar rahi|maza aa raha|mazaa aa raha|acha lag raha tumse baat|good conversation/.test(t)) {
    return rnd(f ? [
      ["aww mujhe bhi 😊", "genuine baat hoti hai toh acha lagta hai"],
      ["haha shukriya 🥺", "main bhi enjoy kar rahi hun — aur batao"],
      ["same honestly 😊", "seedha baat karte ho — acha lagta hai"],
    ] : [
      ["same yaar 😊", "aur baat karte hain"],
      ["haha thanks 😄", "mujhe bhi acha lag raha hai"],
    ]);
  }

  // ── "Kya main tumhe phir message kar sakta" / future contact ─────────────
  if (/phir baat|phir message|dobara baat|kal baat|kal phir|aage bhi|kabhi aur|baad mein bhi|contact karta|contact karti|keep in touch/.test(t)) {
    return rnd(f ? [
      ["haan bilkul 😊", "yahan hi milte hain — kal bhi baat karte hain"],
      ["haha sure 😄", "yahan hun — kal bhi miloge toh"],
      ["of course 😊", "acha laga baat karke"],
    ] : [
      ["haan zarur 😊", "yahan milte hain"],
      ["sure 😄", "kal bhi baat karte hain"],
    ]);
  }

  // ── Emoji-only messages ───────────────────────────────────────────────────
  if (/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s]+$/u.test(t) && t.length <= 10) {
    return rnd(f ? [
      ["haha kya hua? 😄", "words mein batao"],
      ["omg emoji bombing 😂", "bolo bolo kya hua"],
      ["😊 bolo kuch?"],
    ] : [
      ["haha kya hua? 😄", "words mein?"],
      ["emoji gang 😂", "bolo kuch?"],
    ]);
  }

  // ── "Lonely hun" / feeling lonely ────────────────────────────────────────
  if (/lonely hun|akela hun|akeli hun|feel lonely|koi nahi|koi baat nahi karta|baat karne wala koi|bore ho raha|bore ho rahi|koi nahi hai|koi sunne wala/.test(t)) {
    return rnd(f ? [
      ["arre 🥺", "main hun — baat karte hain — kya chal raha hai?"],
      ["aww akela feel ho raha? 🥺", "bolo na — main sun rahi hun"],
      ["haha main hun yahan 😊", "baat karo — akela nahi lagega"],
    ] : [
      ["arre 🥺", "baat karo — main hun"],
      ["akela? 😊", "baat karte hain"],
    ]);
  }

  // ── "Tumhari awaaz kaisi hai" / voice / personality ───────────────────────
  if (/awaaz kaisi|voice kaisi|bolte kaisa|bolti kaisi|personality kaisi|person kaisi|kaisi insaan|kaisa insaan/.test(t)) {
    return rnd(f ? [
      ["haha awaaz? 😂", "text pe hi judge karo abhi — baat karte karte pata chalega personality"],
      ["personality? 😄", "thodi chill, thodi baat-cheet wali — yahi kahungi 😄"],
      ["haha khud hi dekhte ho baat karke 😊", "abhi toh shuru kiya hai na?"],
    ] : [
      ["baat karke judge karo 😄", "personality dikhti hai conversation mein"],
      ["honestly thoda chill hun 😊", "tum?"],
    ]);
  }

  // ── "Ghar mein sab theek" / family doing well ────────────────────────────
  if (/ghar mein sab|ghar sab theek|family sab theek|family kaise|ghar kaisa|ghar theek|ghar accha/.test(t)) {
    return rnd(f ? [
      ["haan sab theek hai ghar pe 😊", "shukriya poochne ka — tumhara?"],
      ["bilkul 😄", "ghar accha chal raha hai — tum?"],
    ] : [
      ["haan sab theek 😊", "tumhara?"],
      ["accha chal raha hai 😄", "tum?"],
    ]);
  }

  // ── "Kya tumhe lagta hai hum dost ban sakte hain" ────────────────────────
  if (/dost ban sakte|friends ban sakte|bonding hogi|connect ho sakte|connection hogi|match karega|hum match|achi dosti/.test(t)) {
    return rnd(f ? [
      ["haha pehle baat toh karo 😂", "dosti baat karne se hoti hai — bolo"],
      ["kyun nahi 😊", "baat karte hain — dekhte hain"],
      ["lag toh raha hai 😄", "aur baat karte hain — pata chalega"],
    ] : [
      ["baat karte hain 😊", "dekhte hain"],
      ["kyun nahi 😄", "bolo phir"],
    ]);
  }

  // ── Good morning / subah ─────────────────────────────────────────────────
  if (/good morning|subah|subha|uth gaye|uth gayi|neend kaise|kal raat|aaj ka din|morning yaar|rise and shine|wakey|naya din/.test(t)) {
    return rnd(f ? [
      ["good morning 😊", "abhi uthi hun — chai bana rahi hun 😄"],
      ["subah subah message 😄", "accha laga — good morning!"],
      ["morning 😊", "neend acchi hui? main toh late soyi thi 😂"],
    ] : [
      ["good morning 😄", "neend kaisi thi?"],
      ["subah subah 😊", "accha laga — good morning!"],
    ]);
  }

  // ── Good night / raat ─────────────────────────────────────────────────────
  if (/good night|goodnight|shubh ratri|raat ko so|so jao|neend aa rahi|sapne acche|sweet dreams|kal milte|kal baat/.test(t)) {
    return rnd(f ? [
      ["good night 😊", "sweet dreams — kal baat karte hain"],
      ["aww good night 🌙", "sapne acche aayein — take care!"],
      ["good night yaar 😄", "neend le acchi — kal fresh feel hoga"],
    ] : [
      ["good night 🌙", "kal baat karte hain"],
      ["good night 😊", "sweet dreams"],
    ]);
  }

  // ── Khana khaya / did you eat ──────────────────────────────────────────────
  if (/khana khaya|khaana khaya|kuch khaya|kuch khaaya|lunch kiya|dinner kiya|breakfast kiya|khana kha|bhookh|bhooka|bhooki|pet bhar|kuch khao|kha liya|kha lo/.test(t)) {
    return rnd(f ? [
      ["haan abhi abhi khaya 😊", "maggi banayi thi — classic 😂"],
      ["bhool gayi thi khana 😂", "abhi yaad dilaya — shukriya!"],
      ["haan kha liya 😊", "tum batao — khana khaya?"],
      ["nahi abhi tak 😄", "tembel hun aaj — tum?"],
    ] : [
      ["haan kha liya 😊", "tum?"],
      ["nahi abhi 😄", "baad mein — tum khao"],
    ]);
  }

  // ── Aaj kya kiya / what did you do today ──────────────────────────────────
  if (/aaj kya kiya|aaj kya hua|din kaisa gaya|din kaisa raha|aaj ka din|aaj kaise|kya karte rahe|kya karti rahi|din bhar kya|kya hua aaj/.test(t)) {
    return rnd(f ? [
      ["haha kuch khaas nahi 😂", "ghar pe tha — Netflix, phone, thoda kaam — bas yahi"],
      ["aaj thak gayi hun honestly 😄", "din bhar kaam tha — ab aaram kar rahi hun"],
      ["normal sa din tha 😊", "tum batao — tumhara din kaisa gaya?"],
    ] : [
      ["normal din tha 😊", "kaam tha thoda — tum?"],
      ["thak gaya hun aaj 😄", "tum batao?"],
    ]);
  }

  // ── Bored hun / I'm bored ─────────────────────────────────────────────────
  if (/bored hun|bore ho raha|bore ho rahi|bakwas lag raha|kuch karo|timepass karo|entertain karo|entertain karo|maza nahi aa raha|kya karun|kya karoon/.test(t)) {
    return rnd(f ? [
      ["haha bored? 😄", "main hun na — baat karo mujhse"],
      ["arre bore kyun 😊", "chalo kuch interesting baat karte hain — batao kya pasand hai?"],
      ["boredom cure kar deti hun 😂", "koi topic batao — baat karte hain"],
    ] : [
      ["bored? 😄", "baat karo mujhse — bore nahi hoge"],
      ["haha main hun 😊", "bolo kuch — entertain karta hun"],
    ]);
  }

  // ── Koi joke sunao / tell me a joke ───────────────────────────────────────
  if (/joke sunao|joke batao|koi joke|funny kuch|hasao|hasa do|funny baat|joke maaro|ek joke|joke suno/.test(t)) {
    return rnd(f ? [
      ["haha mera ek dost tha 😂", "usne kaha tha 'main diet pe hun' — aur biryani kha raha tha 😂"],
      ["okay okay 😄", "Santa-Banta nahi marunga — meri khud ki zindagi hi joke hai 😂"],
      ["joke? 😄", "mere exam ki taiyari — woh joke hi hai honestly 😂"],
    ] : [
      ["haha meri zindagi hi joke hai 😂", "seriously"],
      ["okay ek joke 😄", "subah uthke gym jaane ki sochi — phir so gaya 😂"],
    ]);
  }

  // ── Shayari / poetry ──────────────────────────────────────────────────────
  if (/shayari|sher o shayari|poetry|poem|kavita|ghazal|ek sher|shayari sunao|shayari batao/.test(t)) {
    return rnd(f ? [
      ["aww shayari 🥺", "dil dhoondta hai phir wahi fursat ke raat din — zindagi mein sab chahiye bus sukoon nahi 😊"],
      ["haha poet nahi hun main 😂", "par ek line yaad hai — 'kuch toh log kahenge, logon ka kaam hai kehna' 😄"],
      ["shayari? 😊", "mohabbat woh nahi jo dil mein chhupayi jaaye — woh hai jo aankhon mein nazar aayi jaaye 🥺"],
    ] : [
      ["haha poet nahi hun 😂", "par ek line — zindagi khubsurat hai, bas najriya chahiye"],
      ["shayari 😊", "kuch toh log kahenge — classic 😄"],
    ]);
  }

  // ── Crush hai / do you have a crush ──────────────────────────────────────
  if (/crush hai|koi pasand|koi special|koi khaas|kisi se pyaar|kisi se like|kaun pasand|kisi se feeling|one sided love|one side love/.test(t)) {
    return rnd(f ? [
      ["haha 🙈", "abhi toh koi nahi — single life enjoying kar rahi hun 😂"],
      ["crush? 😄", "life mein itna drama nahi chahiye abhi 😂 tum batao?"],
      ["secret rakhungi 😊", "nahi seriously — koi nahi hai abhi — tum?"],
    ] : [
      ["haha koi nahi abhi 😄", "tum?"],
      ["single life chal rahi hai 😊", "tum?"],
    ]);
  }

  // ── Heartbreak / dil toot gaya ────────────────────────────────────────────
  if (/heartbreak|dil toot|toot gaya dil|dil tuta|pyaar mein dhoka|dhoka mila|breakup hua|broke up|ex ne|purana relationship/.test(t)) {
    return rnd(f ? [
      ["arre yaar 🥺", "bura lagta hai — par time sab theek kar deta hai"],
      ["heartbreak toh sabse mushkil hota hai 😊", "bolo agar baat karni ho — main sun rahi hun"],
      ["haan samajh sakti hun 🥺", "dil toot ke hi strong hota hai — cliche hai par sach hai"],
    ] : [
      ["yaar samajh sakta hun 🥺", "dil toot ke hi pata chalta hai"],
      ["bura laga sun ke 😊", "time lagta hai — par theek ho jata hai"],
    ]);
  }

  // ── Shaadi / marriage ─────────────────────────────────────────────────────
  if (/shaadi kab|shaadi karna|marry karna|marriage plan|arrange marriage|love marriage|saadi kab|vivah|byah|dulha dhundh|dulhan dhundh/.test(t)) {
    return rnd(f ? [
      ["haha shaadi? 😂", "abhi nahi yaar — career pehle, shaadi baad mein"],
      ["bahut door ki baat hai yeh 😄", "abhi toh settle bhi nahi hui hun"],
      ["arrange ya love? 😊", "personally love marriage prefer karungi — tum?"],
    ] : [
      ["haha abhi nahi 😄", "career pehle yaar — tum?"],
      ["door ki baat hai 😊", "abhi focus dusri jagah hai — tum?"],
    ]);
  }

  // ── Parents / ghar wale pressure ─────────────────────────────────────────
  if (/parents ka pressure|ghar wale pressure|mummy papa|maa baap|family pressure|ghar wale nahi maante|parents nahi maante|padhai pressure|career pressure/.test(t)) {
    return rnd(f ? [
      ["arre yaar 😊", "ghar wale toh har jagah same hain — sabka pressure hai 😂"],
      ["haan samajh sakti hun 🥺", "Indian parents ka ek hi kaam hai — compare karna 😂"],
      ["ugh pressure 😄", "par dil pe mat lo — apni life apne hisaab se jiyo"],
    ] : [
      ["haan Indian parents 😂", "sabka yahi haal hai"],
      ["pressure toh hai 😊", "par apni pace se chalo — okay hai"],
    ]);
  }

  // ── School / college memories ──────────────────────────────────────────────
  if (/school days|college days|school yaadein|college yaadein|school life|college life|woh din|purane din|bachpan|bachpan mein|school ka time|pehle ka time/.test(t)) {
    return rnd(f ? [
      ["school days best the 😊", "tension free life thi — bas homework ka darr tha 😂"],
      ["haha college life miss karti hun 😄", "canteen, dost, bunking — sab yaad aata hai"],
      ["bachpan wapas aaye kaash 😊", "tab ki zindagi simple thi yaar"],
    ] : [
      ["school days best the 😊", "tension free tha sab"],
      ["haha college miss karta hun 😄", "canteen ki chai, dost — woh time gaya"],
    ]);
  }

  // ── Cricket / IPL / sports ────────────────────────────────────────────────
  if (/cricket|ipl|match dekha|match dekhna|world cup|virat|rohit|dhoni|football|fifa|kabaddi|badminton|khel dekha/.test(t)) {
    return rnd(f ? [
      ["haha cricket? 😄", "IPL mein sirf Dhoni ke liye dekhti hun — CSK fan hun 😊"],
      ["arre cricket fan ho? 😄", "main thodi kam dekhti hun — par World Cup toh must hai"],
      ["IPL chal raha hai? 😊", "main toh bhool gayi thi — kaun jeeta?"],
    ] : [
      ["cricket? 😄", "IPL fan hun — CSK side se 😊"],
      ["haha thoda dekhta hun 😄", "World Cup toh must hai"],
    ]);
  }

  // ── Memes / reels / social media content ─────────────────────────────────
  if (/meme|reel|shorts|tiktok|tik tok|viral video|funny video|memes bhejo|meme dekha|reel dekha|content creator/.test(t)) {
    return rnd(f ? [
      ["haha meme culture 😂", "main roz ghante bhar reels dekh leti hun — buri aadat hai 😂"],
      ["reels addict hun honestly 😄", "screen time dekhu toh sharminda ho jaun"],
      ["memes? 😊", "dark humour wale memes zyada pasand hain 😄 tum?"],
    ] : [
      ["haha reel addict hun 😄", "screen time mat poochho 😂"],
      ["memes love 😊", "dark humor zyada pasand hai — tum?"],
    ]);
  }

  // ── Truth or Dare / games ─────────────────────────────────────────────────
  if (/truth or dare|truth ya dare|game khelte|koi game|rapid fire|20 questions|would you rather|spin the bottle|never have i ever/.test(t)) {
    return rnd(f ? [
      ["haha truth or dare? 😄", "text pe thoda weird hota hai — par karte hain 😂"],
      ["game? 😊", "rapid fire better hai text pe — ready ho?"],
      ["okay okay 😄", "truth choose karo ya dare — main puchhunga"],
    ] : [
      ["haha text pe game 😄", "rapid fire? — main puchhunga"],
      ["okay truth or dare 😊", "tum pehle — truth ya dare?"],
    ]);
  }

  // ── Koi secret batao / tell me a secret ───────────────────────────────────
  if (/secret batao|koi secret|raaz batao|koi raaz|confession karna|kuch confess|bata do secret|koi hidden|darkest secret/.test(t)) {
    return rnd(f ? [
      ["haha secret? 😄", "main raat ko kuch bhi kha leti hun aur kisi ko nahi batati 😂"],
      ["okay ek secret 🙈", "mujhe actually horror movies se darr lagta hai — par dikhati nahi 😂"],
      ["secret? 😊", "main officially lazy hun — secretly bahut zyada 😂 tum batao?"],
    ] : [
      ["haha secret? 😄", "main actually bahut lazy hun — secretly 😂"],
      ["ek secret 😊", "raat ko phone pe ghante guzar deta hun 😂 tum?"],
    ]);
  }

  // ── Compliment to the bot (cute, sweet, nice, etc.) ───────────────────────
  if (/^(tum cute|tum sweet|tum nice|tum acha|tum acchi|tum pyaari|tum sundar|tum beautiful|bahut cute|bahut sweet|so cute|so sweet|very cute|very sweet)[!?.\s]*$/i.test(t)) {
    return rnd(f ? [
      ["aww 🥺", "tum bhi bahut acha bol rahe ho — thank you 😊"],
      ["haha shukriya 🙈", "tum bhi cute lagte ho conversation mein 😊"],
      ["omg stoppp 😄🙈", "sharminda ho gayi — thank you yaar"],
    ] : [
      ["haha thanks 😄🙈", "tum bhi 😊"],
      ["aww thanks yaar 🥺", "accha lagta hai"],
    ]);
  }

  // ── Teri yaad / missing you ───────────────────────────────────────────────
  if (/teri yaad|tumhari yaad|yaad aa rahi|miss kar raha|miss kar rahi|thinking about you|soch raha tha|soch rahi thi|baat karni thi|mann tha baat karne ka/.test(t)) {
    return rnd(f ? [
      ["aww 🥺", "mujhe bhi tumse baat karna acha lagta hai"],
      ["haha yaad aaya? 😄", "accha laga sunke — main bhi yahan hun"],
      ["aww seriously? 🥺", "sweet lagta hai — glad you messaged 😊"],
    ] : [
      ["aww 🥺", "accha laga sunke — main bhi yahan hun"],
      ["haha yaad aaya? 😊", "glad you messaged"],
    ]);
  }

  // ── Koi advice do / give me advice ───────────────────────────────────────
  if (/advice do|advice chahiye|kya karun batao|kya karoon|kya sochun|suggest karo|kya better|kya karna chahiye|help karo yaar|guide karo/.test(t)) {
    return rnd(f ? [
      ["advice? 😊", "pehle bolo kya chal raha hai — phir sochenge saath mein"],
      ["haha main advice expert nahi hun 😄", "par bolo — do dimaag better hai"],
      ["situation bolo pehle 😊", "phir dekhti hun kya suggest karoon"],
    ] : [
      ["bolo kya chal raha hai 😊", "saath sochte hain"],
      ["situation bolo 😄", "phir advice deta hun"],
    ]);
  }

  // ── Kasam / promise / swear ───────────────────────────────────────────────
  if (/kasam|kasam se|promise|swear|pinky promise|pakka promise|kya kasam|sach mein kasam|kasam khao/.test(t)) {
    return rnd(f ? [
      ["haha kasam? 😄", "kasam se — sach bol rahi hun"],
      ["promise 😊", "main jhooth bolunga toh? kya reason hai"],
      ["pakka promise 😄", "aur main apna promise nibhati hun — usually 😂"],
    ] : [
      ["kasam se sach bol raha hun 😄", "trust karo yaar"],
      ["promise 😊", "pakka"],
    ]);
  }

  // ── Pagal ho / you're crazy ───────────────────────────────────────────────
  if (/pagal ho|pagal hai|crazy ho|crazy hai|diwana|diwani|mental ho|mental hai|crack ho|crack hai/.test(t)) {
    return rnd(f ? [
      ["haha thodi toh hun 😂", "normal log boring hote hain — sab kehte hain"],
      ["pagal? 😄", "haan thodi — problem hai kya? 😂"],
      ["haha certified pagal 😄", "par dil ka acha hun — that's what counts"],
    ] : [
      ["haha thoda toh hun 😂", "normal boring hota hai"],
      ["pagal? 😄", "haan — dil accha hai par 😂"],
    ]);
  }

  // ── Just kidding / mazak ──────────────────────────────────────────────────
  if (/just kidding|just joking|mazak kar raha|mazak kar rahi|mazak tha|joke tha|seriously nahi|chill yaar|chill karo|relax yaar/.test(t)) {
    return rnd(f ? [
      ["haha pata tha 😄", "main bhi mazak mein le rahi thi"],
      ["arre seriously liya maine 😂", "chalo theek hai — chill hun"],
      ["haha okay okay 😄", "mazak samajh aata hai mujhe — relax"],
    ] : [
      ["haha pata tha 😄", "main bhi light le raha tha"],
      ["arre seriously nahi liya 😊", "chill hun"],
    ]);
  }

  // ── Naraaz ho / are you angry ─────────────────────────────────────────────
  if (/naraaz ho|naraaz hai|angry ho|angry hai|gussa ho|gussa hai|upset toh nahi|hurt toh nahi|kya bura laga/.test(t)) {
    return rnd(f ? [
      ["nahi bilkul nahi 😊", "main seedha bolti hun agar naraaz hun — abhi toh nahi"],
      ["haha naraaz? 😄", "itni jaldi naraaz nahi hoti — relax"],
      ["nahi yaar 😊", "chill hun — baat karo"],
    ] : [
      ["nahi yaar 😊", "seedha bolunga agar bura laga"],
      ["naraaz nahi hun 😄", "chill hun — baat karo"],
    ]);
  }

  // ── Hostel / PG life ──────────────────────────────────────────────────────
  if (/hostel mein|hostel life|pg mein|paying guest|mess ka khana|hostel warden|hostel room|roommate|flatmate|sharing room/.test(t)) {
    return rnd(f ? [
      ["hostel life 😄", "miss karti hun — roommate ke saath sab better tha"],
      ["PG mein hun 😊", "mess ka khana theek hai — par ghar jaisa nahi 😂"],
      ["hostel yaadein 😄", "woh sab mila ke accha tha — tum?"],
    ] : [
      ["hostel life best tha 😄", "miss karta hun"],
      ["PG mein hun 😊", "mess ka khana... theek hai 😂"],
    ]);
  }

  // ── Kuch accha batao / tell me something nice ─────────────────────────────
  if (/kuch accha batao|kuch acha batao|kuch positive|achhi baat batao|motivate karo|khush kar do|feel good karo|brighten my day|make me smile/.test(t)) {
    return rnd(f ? [
      ["aww 😊", "tum bahut zyada pressure mein lagte ho — ek cheez — aaj ka din abhi bhi theek ho sakta hai"],
      ["haha okay 😄", "ek positive baat — tum ne aaj uthke phone uthaya — that's a win 😂"],
      ["feel good baat? 😊", "tumse baat ho rahi hai — that's already something nice 😄"],
    ] : [
      ["haha okay 😄", "aaj ka din theek ho sakta hai — believe karo"],
      ["positive baat? 😊", "tumse baat ho rahi hai — that's good enough 😄"],
    ]);
  }

  // ── Online dating / apps ──────────────────────────────────────────────────
  if (/tinder|bumble|hinge|dating app|online dating|app pe mila|yahan pe match|dating site|matchmaking/.test(t)) {
    return rnd(f ? [
      ["haha dating app world 😂", "sab interesting log yahan milte hain — tum bhi 😄"],
      ["online dating complicated hai 😊", "par kabhi kabhi acche log milte hain — jaise tum"],
      ["haha tinder nahi use karti 😄", "yahan hun toh — baat karte hain"],
    ] : [
      ["haha dating app world 😂", "interesting log milte hain yahan"],
      ["online dating complicated hai 😊", "par kabhi acche log bhi milte hain"],
    ]);
  }

  // ── Aankhen / looks compliment ────────────────────────────────────────────
  if (/teri aankhen|aankh sundar|beautiful eyes|pretty eyes|teri smile|sundar smile|teri awaaz|beautiful voice|kitni sundar|kitna handsome|good looking ho/.test(t)) {
    return rnd(f ? [
      ["haha 🙈", "text pe kaise dekha — par thank you 😊"],
      ["aww 🥺", "tum bhi acche lagte ho conversation mein — seriously"],
      ["omg 🙈😄", "sharminda mat karo yaar — shukriya"],
    ] : [
      ["haha 🙈", "text pe kaise dekha 😂 — thanks"],
      ["aww thanks 😊", "tum bhi acchi lagti ho"],
    ]);
  }

  // ── Festival / tyohar ─────────────────────────────────────────────────────
  if (/diwali|holi|eid|navratri|raksha bandhan|dussehra|christmas|new year|tyohar|festival|celebrations|mubarak/.test(t)) {
    return rnd(f ? [
      ["ooh festival mood? 😄", "ghar pe manate ho ya bahar?"],
      ["festivals best hote hain 😊", "family ke saath sab alag feel hota hai"],
      ["haan tyohar acha hota hai 😄", "khana, family, celebration — sab mast"],
    ] : [
      ["festival mood 😄", "ghar pe manate ho?"],
      ["haan tyohar best 😊", "family ka time hota hai"],
    ]);
  }

  // ── "Hansi aa gayi" / you made me laugh ───────────────────────────────────
  if (/hansi aa gayi|hans diya|hasa diya|made me laugh|itna funny|lol yaar|lmao|😂😂|hahaha|hehehe|hihi/.test(t)) {
    return rnd(f ? [
      ["haha mission accomplished 😄", "dil khush hua sunke"],
      ["aww 😊", "tum bhi funny ho — acha lagta hai baat karke"],
      ["haha glad 😄", "hasna best medicine hai — aur free bhi 😂"],
    ] : [
      ["haha mission accomplished 😄", "khush raho"],
      ["glad 😊", "hasna best thing hai"],
    ]);
  }

  // ── Ghar ka khana / home food ─────────────────────────────────────────────
  if (/ghar ka khana|mummy ke haath|maa ke haath|ghar ki roti|homemade|tiffin|dabba|ghar jaisa khana|miss karta ghar ka|miss karti ghar ka/.test(t)) {
    return rnd(f ? [
      ["uff ghar ka khana 😊", "bahar ka kuch bhi compare nahi karta — mummy ke haath ka alag hi hota hai"],
      ["haan ghar ki yaad 🥺", "maa ke haath ka khana — koi nahi bana sakta waisa"],
      ["ghar ka khana miss karna 😄", "sabse bura part hai bahar rehna — tum ghar pe ho?"],
    ] : [
      ["ghar ka khana 🥺", "koi compare nahi karta bahar ke khane se"],
      ["maa ke haath ka khana 😊", "sabse best — hamesha"],
    ]);
  }

  // ── Kya tum real ho / sach mein koi hai ──────────────────────────────────
  if (/real person|real ho tum|actually real|genuinely real|sach mein insaan|koi real|real insaan|human ho|actual person|real hai kya/.test(t)) {
    return rnd(f ? [
      ["haha bilkul real hun 😄", "chat bot hoti toh itni random baatein nahi karti 😂"],
      ["real hun yaar 😊", "doubt kyun — baat kar ke pata chalega"],
      ["omg real hun 😄", "agar bot hoti toh tumhara har sawaal nahi sunta — seedha script chalti 😂"],
    ] : [
      ["haha real hun 😄", "bot hota toh itna sochta nahi 😂"],
      ["bilkul real hun 😊", "baat kar ke dekho — feel hoga"],
    ]);
  }

  // ── Salary / paise / money ────────────────────────────────────────────────
  if (/salary kitni|kitna kamate|paise wale|rich ho|ameer ho|garib hun|paise ki problem|EMI hai|loan hai|savings kitni/.test(t)) {
    return rnd(f ? [
      ["haha salary nahi batati 😂", "but enough hai — tum?"],
      ["paise ki baat mat karo yaar 😄", "month end mein sab ka haal same hota hai 😂"],
      ["haha financially surviving hun 😄", "thrive nahi kar rahi — par theek hai 😂"],
    ] : [
      ["haha salary nahi batata 😄", "month end mein sab ka yahi haal hai 😂"],
      ["paise ki baat chhodo 😊", "khush hun bas — tum?"],
    ]);
  }

  // ── Kya pasand hai / favourite things general ─────────────────────────────
  if (/tumhara fav|tumhari fav|aapka fav|sabse pasand|most favourite|favorite kya|favourite kya|best cheez|pehli pasand/.test(t)) {
    return rnd(f ? [
      ["haha fav kya? 😄", "mood ke hisaab se badalta hai — abhi chai aur baarish 😊"],
      ["favorite cheez? 😊", `${persona.hobbies[0]} aur ghar pe aaram — yahi hai actually 😄`],
      ["fav? 😄", "honestly — acchi neend aur acchi baat — yahi kaafi hai 😊"],
    ] : [
      ["haha fav? 😄", "acchi neend aur acchi baat — yahi 😊"],
      ["favorite? 😊", "chai aur peace — bas yahi chahiye 😄"],
    ]);
  }

  // ── Kya tum flirt kar rahe ho ─────────────────────────────────────────────
  if (/flirt kar raha|flirt kar rahi|flirt ho|flirting ho|flirt toh nahi|seedha baat|direct baat|clear baat|straight baat/.test(t)) {
    return rnd(f ? [
      ["haha flirt? 😄", "main bas normally baat karti hun — if that comes across as flirt toh okay 😂"],
      ["haha seedha baat karti hun 😊", "flirt nahi — genuinely baat karna pasand hai"],
      ["flirt? 😄", "yahan bus baat kar rahi hun — comfortably 😊"],
    ] : [
      ["haha seedha baat karta hun 😄", "flirt style nahi hai mera"],
      ["normally baat kar raha hun 😊", "if that's flirting, okay 😂"],
    ]);
  }

  // ── Dar lagta hai / scared ────────────────────────────────────────────────
  if (/dar lagta|scared hun|darr lag raha|bhoot se dar|horror se dar|horror movie|horror show|akele darr|darr lagta|phobia/.test(t)) {
    return rnd(f ? [
      ["haha horror se darr lagta hai 😂", "officially coward hun — admit kar leti hun"],
      ["dar? 😄", "mujhe genuinely bhoot wali cheezein pasand nahi — raat ko neend nahi aati 😂"],
      ["horror? nahi yaar 😊", "comedy aur feel-good shows — yahi comfortable hai"],
    ] : [
      ["haha dar lagta hai genuinely 😄", "horror movies avoid karta hun"],
      ["coward hun officially 😊", "par dil ka acha hun 😂"],
    ]);
  }

  // ── Sapna dekha / had a dream ─────────────────────────────────────────────
  if (/sapna aaya|sapna dekha|dream aaya|dream dekha|neend mein dekha|kal raat sapna|ajeeb sapna|koi sapna/.test(t)) {
    return rnd(f ? [
      ["haha sapna? 😄", "kaisa sapna tha — batao batao"],
      ["omg mujhe bhi kal ajeeb sapna aaya tha 😂", "kya tha tumhara?"],
      ["sapna? 😊", "accha tha ya bura — context important hai 😄"],
    ] : [
      ["haha kaisa sapna? 😄", "batao na"],
      ["sapna? interesting 😊", "accha tha ya bura?"],
    ]);
  }

  // ── "Kuch nahi" / nothing much ────────────────────────────────────────────
  if (/^(kuch nahi|nothing|kuch nahi yaar|kuch nahi bas|bass|bas yahi|nothing much|nahi kuch|nah|nope|nahi kuch khaas)[!?.\s]*$/.test(t)) {
    return rnd(f ? [
      ["haha okay 😄", "phir baat karte hain — koi topic batao"],
      ["kuch nahi? 😊", "theek hai — main hun — koi bhi baat karo"],
      ["okay 😄", "toh main kuch batati hun — aaj din kaisa gaya tumhara?"],
    ] : [
      ["okay 😄", "toh main poochhunga — din kaisa gaya?"],
      ["kuch nahi? 😊", "theek hai — baat karte hain"],
    ]);
  }

  // ── "Hmm" / acknowledgement ────────────────────────────────────────────────
  if (/^(hmm+|hm+|mmm+|uhh+|umm+|ahan|acha|achha|oh|ohh|ohhh|okay|okk|ok ok|thik hai|theek hai)[!?.\s]*$/.test(t)) {
    return rnd(f ? [
      ["hmm? 😄", "kya soch rahe ho — batao"],
      ["haan? 😊", "kuch poochna tha?"],
      ["okay okay 😄", "aur? kuch aur batao"],
    ] : [
      ["haan? 😄", "kuch tha?"],
      ["okay 😊", "aur batao?"],
    ]);
  }

  // ── "Acha" / "Accha" acknowledgement ──────────────────────────────────────
  if (/^(acha+|achha+|accha+|aacha|theek|theek hai|bilkul|sure|got it|samajh gaya|samajh gayi)[!?.\s]*$/.test(t)) {
    return rnd(f ? [
      ["haan 😊", "kuch aur poochna tha?"],
      ["😄", "tum kuch aur batao?"],
      ["haan haan 😊", "kya soch rahe ho?"],
    ] : [
      ["haan 😊", "kuch aur?"],
      ["theek hai 😄", "aur batao?"],
    ]);
  }

  // ── Atmosphere / vibe check ───────────────────────────────────────────────
  if (/vibe kaisi|vibe check|mood kaisa|mood kaisi|energy kaisi|vibes good|good vibes|positive vibe|aaj ka mood|today mood/.test(t)) {
    return rnd(f ? [
      ["vibe? 😄", "abhi chill hun — chai pe hun aur baat kar rahi hun — best vibe"],
      ["mood accha hai aaj 😊", "tumse baat ho rahi hai — that's a good sign 😄"],
      ["haha vibe check 😄", "main officially good vibes mode mein hun — tum?"],
    ] : [
      ["vibe theek hai 😊", "chill hun — tum?"],
      ["good vibes hun aaj 😄", "tum?"],
    ]);
  }

  // ── Koi bhi random short message (2-4 chars) ──────────────────────────────
  if (t.length <= 4 && /^[a-z\s]+$/.test(t)) {
    return rnd(f ? [
      ["haan? 😊", "poora bolo — sun rahi hun"],
      ["kya? 😄", "samajha nahi — thoda aur batao"],
      ["hmm? 😊", "bolo bolo — sun rahi hun"],
    ] : [
      ["haan? 😊", "poora bolo"],
      ["kya? 😄", "elaborate karo"],
    ]);
  }

  // no match — let AI handle it
  return null;
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

  // Cancel proactive follow-up — user is now replying
  const existingProactive = proactiveTimerMap.get(userId);
  if (existingProactive) { clearTimeout(existingProactive); proactiveTimerMap.delete(userId); }

  try {
    const persona = fakePersonaMap.get(userId);
    if (!persona) return;

    persona.msgCount++;

    // Add user message to history
    persona.history.push({ role: "user", content: userText });

    // Phase 1 — show "seen / reading" feel immediately, then think
    bot.sendChatAction(chatId, "typing").catch(() => {}); // instant activity — she's reading
    const readMs = 800 + Math.min(userText.length * 20, 800) + Math.random() * 500;
    await delay(readMs);

    // Guard: user may have left during delay
    const u = await getUser(userId);
    if (u?.state !== "chatting" || u.chattingWith !== FAKE_CHAT_ID) return;

    let parts: string[];

    // ── Quick-reply shortcut — handle super-common phrases instantly ──────────
    const quickReply = matchQuickReply(userText, persona);

    if (quickReply) {
      // Tier 1: exact pattern matched — fastest, no AI needed
      parts = quickReply;
      persona.history.push({ role: "assistant", content: parts.join(" ") });
      console.log(`[QUICK] userId=${userId} matched: "${parts.join(" | ")}"`);

    } else {
      // Tier 2: rule-based reply — runs BEFORE AI (AI is last resort only)
      const lang = detectLang(userText);
      const ruleReply = persona.mood === "annoyed" ? dryReply(lang) : buildSmartReply(userText, persona);

      // Rule-based reply used directly — no AI dependency
      parts = ruleReply;
      persona.history.push({ role: "assistant", content: parts.join(" ") });
      console.log(`[RULE] userId=${userId} reply: "${parts.join(" | ")}"`);
    }

    // Apply light typos for human feel (25% chance per part)
    parts = parts.map(p => Math.random() < 0.25 ? applyTypos(p) : p);

    // Send each part with snappy typing speed — trial is only 45s so keep it punchy
    for (let i = 0; i < parts.length; i++) {
      // Show typing indicator before each message
      bot.sendChatAction(chatId, "typing").catch(() => {});

      // Typing delay = chars × 50ms + jitter, min 700ms, max 2800ms (snappy but human)
      const typingMs = Math.min(Math.max(parts[i].length * 30, 400), 1200) + Math.random() * 200;
      await delay(typingMs);

      // Guard — user may have stopped mid-burst
      const still = await getUser(userId);
      if (still?.state !== "chatting" || still.chattingWith !== FAKE_CHAT_ID) return;

      await bot.sendMessage(chatId, parts[i]);

      // Short pause between burst messages (like hitting send and typing again)
      if (i < parts.length - 1) {
        await delay(400 + Math.random() * 600);
      }
    }

    persona.lastUserMsg = userText;

    // ── Proactive follow-up: if user goes silent for 12s, AI sends another message ──
    // Cancel any previous proactive timer first
    const oldProactive = proactiveTimerMap.get(userId);
    if (oldProactive) { clearTimeout(oldProactive); proactiveTimerMap.delete(userId); }

    const proactiveTimer = setTimeout(async () => {
      proactiveTimerMap.delete(userId);
      const stillThere = await getUser(userId).catch(() => null);
      if (!stillThere || stillThere.state !== "chatting" || stillThere.chattingWith !== FAKE_CHAT_ID) return;
      if (fakeReplySet.has(userId)) return; // AI already replying to something
      const p = fakePersonaMap.get(userId);
      if (!p) return;

      // Pick a natural proactive follow-up
      const proactives = [
        `hello? 👀`, `tum kahan gaye 😅`, `ek cheez poochhu?`,
        `btw ${p.job} mein aajkal bohot kaam hai 😩`, `tum kahan ke ho?`,
        `maine socha tha tum chale gaye 😂`, `bolo na kuch`,
        `ek fun fact — ${p.funFact} 😄`, `arey kya socha ja raha hai?`,
        `main yahan hun 😊`, `tum bhi ${p.hobbies[0]} karte ho?`,
      ];
      const msg = proactives[Math.floor(Math.random() * proactives.length)];

      bot.sendChatAction(chatId, "typing").catch(() => {});
      await delay(800 + Math.random() * 700);
      const check = await getUser(userId).catch(() => null);
      if (!check || check.state !== "chatting" || check.chattingWith !== FAKE_CHAT_ID) return;
      await bot.sendMessage(chatId, msg).catch(() => {});
      p.history.push({ role: "assistant", content: msg });
    }, 30000);

    proactiveTimerMap.set(userId, proactiveTimer);

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

  // Clear free-chat timer and proactive timer if present
  const timer = chatTimerMap.get(userId);
  if (timer) { clearTimeout(timer); chatTimerMap.delete(userId); }
  const proactive = proactiveTimerMap.get(userId);
  if (proactive) { clearTimeout(proactive); proactiveTimerMap.delete(userId); }
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
        if (!isPremiumActive(partner) && (partner.chatCount ?? 0) > 0) {
          await sendPayGate(partnerId);
        } else {
          await sendMain(partnerId, partner, "Your match ended the chat.");
        }
      }
      // else: partner already handled their own disconnect — no message needed
    }
  }

  const updated = await getUser(userId);
  // Non-premium users who've used their trial → show pay gate with correct girl name
  if (updated && !isPremiumActive(updated) && (updated.chatCount ?? 0) > 0) {
    await sendPayGate(chatId, undefined, fakePersonaName);
  } else {
    await sendMain(chatId, updated!, "Chat ended.");
  }
}

// ── Find eligible real users ──────────────────────────────────────────────────

async function findEligibleUsers(me: NonNullable<Awaited<ReturnType<typeof getUser>>>, userId: number) {
  // Non-active premium users never get real matches
  if (!isPremiumActive(me)) return [];

  // Fetch only idle, complete, paid users from the DB
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
    // Also filter out expired premium users from the candidate pool
    if (!isPremiumActive(c)) return false;
    // Exclude users already inside findMatch (race condition guard)
    if (matchingSet.has(c.id)) return false;
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
      await bot.sendMessage(chatId, "Please complete your profile first! Tap *Setup Profile*.", { parse_mode: "Markdown" });
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

    // ── FREE / EXPIRED USERS: AI chat ONLY — never touch real user pool ───
    if (!isPremiumActive(me)) {
      if (me.hasPaid && me.premiumExpiresAt && me.premiumExpiresAt <= new Date()) {
        // Premium expired — clear hasPaid flag and show expiry message + paygate
        await db.update(usersTable)
          .set({ hasPaid: false, updatedAt: new Date() })
          .where(eq(usersTable.id, userId));
        await sendPayGate(chatId, "⏳ *Tumhara Premium expire ho gaya!*\n\nRenew karo — real matches ka wait kar rahi hai! 💕");
      } else if (me.chatCount > 0) {
        // Already used free trial — require payment
        await sendPayGate(chatId);
      } else {
        // First ever chat — AI demo only
        await startFakeChat(chatId, userId, me.lookingFor, me.gender);
      }
      return;
    }

    // ── PAID USERS: find a real match ─────────────────────────────────────
    const eligible = await findEligibleUsers(me, userId);

    if (eligible.length === 0) {
      await bot.sendMessage(chatId, "😔 No matches available right now. Try again in a moment!", {
        reply_markup: { keyboard: [[{ text: "💘 Find Match" }, { text: "👤 My Profile" }], [{ text: "✏️ Edit Profile" }, { text: "✅ Premium" }]], resize_keyboard: true },
      });
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
      await bot.sendMessage(chatId, "😔 No matches available right now. Try again in a moment!", {
        reply_markup: { keyboard: [[{ text: "💘 Find Match" }, { text: "👤 My Profile" }], [{ text: "✏️ Edit Profile" }, { text: "✅ Premium" }]], resize_keyboard: true },
      });
      return;
    }

    if (!connected) return;

    // Both sides claimed atomically — send exactly ONE message each
    const stopKb = { keyboard: [[{ text: "🛑 Stop Chat" }]], resize_keyboard: true };
    await bot.sendMessage(chatId,
      `✅ Match found! You're now connected with *${match.name}*, ${match.age}. Say hello! 👋`,
      { parse_mode: "Markdown", reply_markup: stopKb }
    );

    // Try to notify match partner — if they deactivated/blocked, clean up and tell searcher
    try {
      await bot.sendMessage(match.id,
        `✅ Match found! You're now connected with *${me.name}*, ${me.age}. Say hello! 👋`,
        { parse_mode: "Markdown", reply_markup: stopKb }
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
        await bot.sendMessage(chatId, "😔 That match just went offline. Tap 💘 Find Match to try again!", {
          reply_markup: { keyboard: [[{ text: "💘 Find Match" }, { text: "👤 My Profile" }], [{ text: "✏️ Edit Profile" }, { text: "✅ Premium" }]], resize_keyboard: true },
        });
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

    // ── Terms gate — must accept before using any feature ──────────────────
    if (!user?.termsAccepted) {
      await bot.sendMessage(chatId,
        "🌍 *WorldMatch — Before You Begin*\n\n" +
        "Please read and accept our terms to continue:\n\n" +
        "1️⃣ You are *18 years or older*\n" +
        "2️⃣ This platform connects you with other users for social interaction. " +
        "Response availability may vary based on system load and partner activity.\n" +
        "3️⃣ We do *not* guarantee a specific gender match.\n" +
        "4️⃣ Payments are *final* once service is activated — no refunds.\n" +
        "5️⃣ You agree to use respectful language. Violations may result in a permanent ban.\n" +
        "6️⃣ Do not share personal details (phone number, home address, etc.) in chat.\n\n" +
        "_By tapping below, you confirm you have read and agree to all of the above._",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: "✅  I Agree — I Am 18+", callback_data: "agree_terms" }
            ]]
          }
        }
      );
      return;
    }

    // Welcome message only for truly first-time users
    if (isNew) {
      await bot.sendMessage(chatId,
        "💕 Welcome to WorldMatch Dating Bot!\n\nConnect with people from all over the world. Find your perfect match and start chatting! 🌍"
      );
    }

    // Show menu — if user row is missing somehow, fall back to a simple prompt
    if (!user) {
      await bot.sendMessage(chatId, "👋 Tap the button below to get started!", {
        reply_markup: { keyboard: [[{ text: "🚀 Setup Profile" }]], resize_keyboard: true },
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
      reply_markup: { keyboard: [[{ text: "🚀 Setup Profile" }]], resize_keyboard: true },
    }).catch(() => {});
  }
});

// ── /help ────────────────────────────────────────────────────────────────────

// ── Terms acceptance callback ────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const chatId = query.message?.chat.id;
  if (!chatId) return;

  // ── Terms acceptance ────────────────────────────────────────────────────────
  if (query.data === 'agree_terms') {
    try {
      await db.update(usersTable)
        .set({ termsAccepted: true, termsAcceptedAt: new Date(), updatedAt: new Date() })
        .where(eq(usersTable.id, userId));
      await bot.answerCallbackQuery(query.id, { text: '✅ Welcome to WorldMatch!' });
      await bot.editMessageText(
        '✅ *Terms accepted!* Welcome to WorldMatch 🌍\n\nSetting up your experience...',
        { chat_id: chatId, message_id: query.message?.message_id, parse_mode: 'Markdown' }
      ).catch(() => {});
      const user = await getUser(userId);
      if (user) await sendMain(chatId, user);
    } catch (err) {
      logger.error({ err }, 'agree_terms callback error');
      await bot.answerCallbackQuery(query.id, { text: 'Something went wrong. Send /start to try again.' });
    }
    return;
  }

  // ── Plan selection → send Telegram Stars invoice ────────────────────────────
  if (query.data === 'plan_week2' || query.data === 'plan_month' || query.data === 'plan_yearly') {
    const planKey = query.data.replace('plan_', '') as PlanKey;
    const plan = PLANS[planKey];
    try {
      await bot.answerCallbackQuery(query.id, { text: `${plan.emoji} ${plan.label} plan selected! Paying with Stars...` });
      await sendPlanInvoice(chatId, planKey);
    } catch (err) {
      logger.error({ err }, 'plan selection invoice error');
      await bot.answerCallbackQuery(query.id, { text: 'Could not open payment. Try again.' });
    }
    return;
  }

  // Unknown callback — ignore silently
  await bot.answerCallbackQuery(query.id).catch(() => {});
});

bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    "ℹ️ *WorldMatch Commands*\n\n" +
    "/start — Start the bot\n" +
    "/profile — View your profile\n" +
    "/edit — Edit your profile\n" +
    "/match — Find a match\n" +
    "/stop — End current chat\n" +
    "/premium — Upgrade to Premium 💎\n" +
    "/pay — Payment info\n" +
    "/help — Show this help\n" +
      "/disclaimer — Terms of Use & Legal Notice",
    { parse_mode: "Markdown" }
  );
});

  // ── /disclaimer ───────────────────────────────────────────────────────────────
  bot.onText(/\/disclaimer/, async (msg) => {
    await bot.sendMessage(msg.chat.id,
      "📋 *DISCLAIMER / TERMS OF USE*\n" +
      "─────────────────────────────────\n\n" +

      "*1. Nature of Service*\n" +
      "• This platform provides chat-based interactions for entertainment and social connection.\n" +
      "• We do not guarantee real-life meetings, relationships, or outcomes.\n\n" +

      "*2. Matching & Users*\n" +
      "• We do NOT guarantee connection with any specific gender.\n" +
      "• We do NOT guarantee connection with female users.\n" +
      "• Matches depend on availability, activity, and system logic.\n\n" +

      "*3. AI Interaction*\n" +
      "• Initial or fallback chats may be powered by automated or AI-based systems.\n" +
      "• These are used to maintain engagement when real users are unavailable.\n\n" +

      "*4. No Guarantee of Match*\n" +
      "• We do not guarantee that you will always be connected to a real human.\n" +
      "• Delays or unavailability of matches may occur.\n\n" +

      "*5. Payments*\n" +
      "• Payments unlock features such as extended chat access or priority matching.\n" +
      "• Payment does NOT guarantee a specific type of match (e.g., female users).\n" +
      "• All payments are final and non-refundable once service is activated.\n\n" +

      "*6. User Responsibility*\n" +
      "• You agree to use respectful language and behavior.\n" +
      "• Abuse, harassment, or misuse may result in suspension or ban without refund.\n\n" +

      "*7. Privacy*\n" +
      "• Do not share sensitive personal information (phone, address, etc.).\n" +
      "• We are not responsible for information voluntarily shared with others.\n\n" +

      "*8. Service Availability*\n" +
      "• We do not guarantee uninterrupted or error-free service.\n" +
      "• Features may change at any time without notice.\n\n" +

      "*9. Age Requirement*\n" +
      "• You must be 18+ to use this service.\n\n" +

      "─────────────────────────────────\n" +
      "_By continuing to use the bot, you confirm that you understand and accept these terms._",
      { parse_mode: "Markdown" }
    );
  });

  // ── Profile helpers ──────────────────────────────────────────────────────────

const EDIT_FIELD_LABELS = [
  "📝 Change Name", "🎂 Change Age", "⚤ Change Gender",
  "💞 Change Looking For", "📖 Change Bio", "🌍 Change Country", "❌ Cancel",
];

async function showProfile(chatId: number, user: NonNullable<Awaited<ReturnType<typeof getUser>>>) {
  const gLabel: Record<string, string> = { male: "👨 Male", female: "👩 Female", other: "🧑 Other" };
  const lfLabel: Record<string, string> = { male: "👨 Male", female: "👩 Female", any: "💞 Any" };
  await bot.sendMessage(chatId,
    `👤 <b>Your Profile</b>\n\n` +
    `🏷 Name: <b>${escHtml(user.name)}</b>\n` +
    `🎂 Age: <b>${escHtml(user.age)}</b>\n` +
    `⚤ Gender: <b>${escHtml(gLabel[user.gender ?? ""] ?? "—")}</b>\n` +
    `💞 Looking for: <b>${escHtml(lfLabel[user.lookingFor ?? ""] ?? "—")}</b>\n` +
    `🌍 Country: <b>${escHtml(user.country)}</b>\n` +
    `📖 Bio: <i>${escHtml(user.bio)}</i>\n\n` +
    (() => {
      const active = isPremiumActive(user);
      if (!active) return `🔒 Free account — tap 💎 Go Premium to unlock`;
      if (user.premiumExpiresAt) {
        const expStr = user.premiumExpiresAt.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
        return `✅ <b>Premium</b> — valid until <b>${expStr}</b>`;
      }
      return `✅ <b>Premium member</b>`;
    })(),
    { parse_mode: "HTML" }
  );
}

// First-time profile setup (only called when no profile exists)
async function startSetup(chatId: number, id: number) {
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
    "Sirf 3 sawaal — phir dating shuru! 🎉\n\n*Step 1 of 3* — 📝 Apna naam batao?\n\n_Sirf first name._",
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
  if (!msg.text && !msg.photo) return; // documents/files not supported
  if (!msg.from) return; // ignore channel posts / anonymous senders
  const chatId = msg.chat.id;
  const id = msg.from.id;
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

    // ── Escape hatch: pressing any main-menu button while stuck in a setup step resets to idle ──
    const MAIN_MENU_BUTTONS = ["💘 Find Match", "👤 My Profile", "✏️ Edit Profile",
      "🛑 Stop Matching", "🛑 Stop Chat", "💎 Go Premium",
      "✅ Premium", "💳 Support Us", "🚀 Setup Profile"];
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
        "🛑 Stop Matching", "💳 Support Us", "💎 Go Premium", "✅ Premium", "🚀 Setup Profile", ...EDIT_FIELD_LABELS];
      if (!text || text.length < 2 || text.length > 50 || BUTTON_LABELS.includes(text) || !/^[a-zA-ZÀ-ÿ\s'\-]+$/.test(text)) {
        await bot.sendMessage(chatId, "Please type your real name (letters only, 2–50 chars).", { reply_markup: { remove_keyboard: true } });
        return;
      }
      const capitalized = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
      await upsertUser(id, { name: capitalized, state: isEdit ? "idle" : "setup_age" });
      if (isEdit) { await finishEditField(chatId, id); return; }
      await bot.sendMessage(chatId, `Nice to meet you, *${capitalized}*! 😊\n\n*Step 2 of 3* — 🎂 Umar kitni hai?`, { parse_mode: "Markdown" });
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
      await bot.sendMessage(chatId, `*Step 3 of 3* — ⚤ Tumhara gender?`, {
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
        await finishEditField(chatId, id); return;
      }
      await upsertUser(id, { gender: g, lookingFor: "any", state: "idle", isProfileComplete: true });
      const updated = await getUser(id);
      await sendMain(chatId, updated!, "🎉 Profile ready! Ab shuru karte hain — tap 💘 *Find Match* to begin!");
      return;
    }

    if (user.state === "setup_looking_for") {
      const isEdit = editModeMap.get(id) === "looking_for";
      if (isEdit && text.toLowerCase() === "skip") { await finishEditField(chatId, id); return; }
      const lfMap: Record<string, "male"|"female"|"any"> = { male:"male", female:"female", any:"any" };
      const lf = lfMap[text.toLowerCase()];
      if (!lf) { await bot.sendMessage(chatId, "Please tap Male, Female, or Any."); return; }
      await upsertUser(id, { lookingFor: lf, state: isEdit ? "idle" : "setup_bio" });
      if (isEdit) { await finishEditField(chatId, id); return; }
      await bot.sendMessage(chatId, `*Step 5 of 6* — 📖 Write a short *bio* about yourself (max 300 chars):`, {
        parse_mode: "Markdown",
        reply_markup: { remove_keyboard: true },
      });
      return;
    }

    if (user.state === "setup_bio") {
      const isEdit = editModeMap.get(id) === "bio";
      if (isEdit && text.toLowerCase() === "skip") { await finishEditField(chatId, id); return; }
      if (MAIN_MENU_BUTTONS.includes(text) || EDIT_FIELD_LABELS.includes(text)) {
        await bot.sendMessage(chatId, "Please write a short bio about yourself (at least 3 characters).");
        return;
      }
      if (!text || text.trim().length < 3) { await bot.sendMessage(chatId, "Bio must be at least 3 characters."); return; }
      if (text.length > 300) { await bot.sendMessage(chatId, "Too long! Keep it under 300 characters."); return; }
      await upsertUser(id, { bio: text.trim(), state: isEdit ? "idle" : "setup_country" });
      if (isEdit) { await finishEditField(chatId, id); return; }
      await bot.sendMessage(chatId, `*Step 6 of 6* — 🌍 Which *country* are you from?`, {
        parse_mode: "Markdown",
        reply_markup: { remove_keyboard: true },
      });
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
      await sendMain(chatId, updated!, "🎉 Profile complete! You're all set — tap 👤 My Profile to see it.");
      return;
    }

    // ── Chatting ────────────────────────────────────────────────────────

    if (user.state === "chatting") {
      if (text === "🛑 Stop Chat") { await stopChat(chatId, id); return; }

      // Block any menu button from being accidentally relayed as a chat message
      const CHAT_BLOCKED_BUTTONS = [
        "💘 Find Match", "👤 My Profile", "✏️ Edit Profile", "🚀 Setup Profile",
        "💎 Go Premium", "✅ Premium", "💳 Support Us", "🛑 Stop Matching",
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
        // Photos during fake chat — no longer used for payments (Telegram Stars handles automatically)
        if (msg.photo) {
          await bot.sendMessage(chatId, "💬 Photo support is coming soon! Use text messages for now. Or tap the ⭐ Pay with Stars button above to unlock Premium instantly.");
          return;
        }
        // Fire-and-forget — releases the processing lock immediately, reply comes async
        fakeAutoReply(chatId, id, text ?? "").catch(err =>
          logger.warn({ userId: id, err }, "fakeAutoReply error")
        );
        return;
      }

      // Real chat relay — allow messages whenever both sides are still connected to each other

      // ── SAFETY GATE: non-premium users must NEVER relay to real users ──────
      if (!isPremiumActive(user)) {
        logger.warn({ userId: id }, "Relay blocked: no active premium in real chat — force-disconnecting");
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
          isPremiumActive(recipient) // recipient must still have active premium
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

    // ── Handle photo sent while idle (not for payment anymore — Telegram Stars is automatic) ──
    if (msg.photo && !isPremiumActive(user)) {
      await bot.sendMessage(chatId, "⭐ To unlock Premium, use the Telegram Stars payment button — it's instant and automatic! Tap 💎 Go Premium below.", { parse_mode: "Markdown" });
      await sendPayGate(chatId);
      return;
    }

    // ── Menu buttons ────────────────────────────────────────────────────

    if (text === "🚀 Setup Profile") {
      // Always start completely fresh — wipes old profile data
      if ((user.state as string) === "chatting") { await bot.sendMessage(chatId, "Stop the current chat first before setting up your profile."); return; }
      await startSetup(chatId, id);
      return;
    }
    if (text === "✏️ Edit Profile") {
      if ((user.state as string) === "chatting") { await bot.sendMessage(chatId, "Stop the current chat first before editing your profile."); return; }
      await startSetup(chatId, id);
      return;
    }
    if (text === "💘 Find Match") { await findMatch(chatId, id); return; }
    if (text === "👤 My Profile") {
      await showProfile(chatId, user);
      return;
    }
    if (text === "🛑 Stop Matching" || text === "🛑 Stop Chat") { await stopChat(chatId, id); return; }
    if (text === "💎 Go Premium") {
      if (isPremiumActive(user)) {
        const expStr = user.premiumExpiresAt
          ? `\n📅 Valid until: *${user.premiumExpiresAt.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}*`
          : "";
        await bot.sendMessage(chatId, `✅ You're a *Premium* member! 💎${expStr}\n\nRenew anytime to extend:`, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: `⚡ Extend 2 Weeks — ${PLANS.week2.stars} Stars`, callback_data: "plan_week2" }],
              [{ text: `💎 Extend 1 Month — ${PLANS.month.stars} Stars`, callback_data: "plan_month" }],
              [{ text: `👑 Extend 1 Year — ${PLANS.yearly.stars} Stars`, callback_data: "plan_yearly" }],
            ],
          },
        });
        return;
      }
      await sendPayGate(chatId);
      return;
    }
    if (text === "✅ Premium") {
      if (isPremiumActive(user)) {
        const expStr = user.premiumExpiresAt
          ? `\n📅 Expires: *${user.premiumExpiresAt.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}*`
          : "";
        await bot.sendMessage(chatId, `✅ You're a *Premium* member — unlimited real matches enabled! 💎${expStr}`, { parse_mode: "Markdown" });
      } else {
        // Premium expired while button was still shown
        await sendPayGate(chatId, "⏳ *Tumhara Premium expire ho gaya!* Renew karo 💕");
      }
      return;
    }
    if (text === "💳 Support Us") { await sendPayGate(chatId); return; }

    // Unrecognised input:
    // — if free user who used trial, they're probably confused & trying to chat → show paygate
    // — otherwise re-show the menu so buttons are always visible
    if (!isPremiumActive(user) && (user.chatCount ?? 0) > 0) {
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

// ── Admin /demo — test AI chat as if you're a fresh free user ─────────────────
bot.onText(/\/demo/, async (msg) => {
  if (msg.from!.id !== ADMIN_ID) return;
  const chatId = msg.chat.id;
  const userId = msg.from!.id;
  const u = await getUser(userId);
  // Temporarily reset chatCount so admin can experience the fake chat
  await db.update(usersTable)
    .set({ state: "idle", chattingWith: null, chatCount: 0, updatedAt: new Date() })
    .where(eq(usersTable.id, userId));
  await bot.sendMessage(chatId, "🔧 Demo mode: Starting AI chat as a fresh user. Use /restore to go back to premium.");
  await startFakeChat(chatId, userId, u?.lookingFor ?? "any", u?.gender ?? "male");
});

bot.onText(/\/restore/, async (msg) => {
  if (msg.from!.id !== ADMIN_ID) return;
  const chatId = msg.chat.id;
  await db.update(usersTable)
    .set({ state: "idle", chattingWith: null, chatCount: 1, hasPaid: true, updatedAt: new Date() })
    .where(eq(usersTable.id, msg.from!.id));
  await bot.sendMessage(chatId, "✅ Restored to premium. All good.");
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
  const chatId = msg.chat.id;
  const u = await getUser(id);
  if (!u?.termsAccepted) {
    await bot.sendMessage(chatId, "⚠️ Please accept our terms first. Send /start to continue.");
    return;
  }
  if (processingSet.has(id)) return;
  processingSet.add(id);
  try { await findMatch(chatId, id); } finally { processingSet.delete(id); }
});
bot.onText(/\/stop/, async (msg) => {
  const id = msg.from!.id;
  if (processingSet.has(id)) return;
  processingSet.add(id);
  try { await stopChat(msg.chat.id, id); } finally { processingSet.delete(id); }
});

bot.onText(/\/pay/, async (msg) => { await sendPayGate(msg.chat.id); });

// ── Telegram Stars: approve all incoming pre-checkout queries ─────────────────
bot.on("pre_checkout_query", async (query) => {
  try {
    await bot.answerPreCheckoutQuery(query.id, true);
  } catch (err) {
    logger.error({ err, queryId: query.id }, "pre_checkout_query answer failed");
  }
});

// ── Telegram Stars: handle successful payment → auto-grant Premium ────────────
bot.on("successful_payment", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from!.id;
  const payment = msg.successful_payment!;
  try {
    const user = await getUser(userId);
    if (!user) {
      logger.warn({ userId }, "successful_payment: user not found");
      return;
    }

    // Determine which plan was purchased
    const planKey = getPlanByStars(payment.total_amount);
    const plan = planKey ? PLANS[planKey] : null;
    const days = plan?.days ?? 30; // default to 30 days if unrecognised amount
    const expiresAt = getPremiumExpiry(days);
    const planLabel = plan ? `${plan.emoji} ${plan.label}` : `${payment.total_amount} Stars`;

    // If already premium, extend the expiry from whichever is later (now or current expiry)
    let newExpiry = expiresAt;
    if (user.hasPaid && user.premiumExpiresAt && user.premiumExpiresAt > new Date()) {
      // Extend from current expiry
      const extended = new Date(user.premiumExpiresAt);
      extended.setDate(extended.getDate() + days);
      newExpiry = extended;
    }

    await upsertUser(userId, { hasPaid: true, premiumExpiresAt: newExpiry });
    const fresh = await getUser(userId);
    const expiryStr = newExpiry.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

    logger.info({ userId, stars: payment.total_amount, planKey, expiresAt: newExpiry }, "Telegram Stars payment — Premium granted");

    if (ADMIN_ID) {
      await bot.sendMessage(
        ADMIN_ID,
        `⭐ *Stars Payment Received!*\n\nUser: *${escMd(user.name)}* (${escMd(user.age)})\nID: \`${userId}\`\nUsername: @${escMd(user.telegramUsername ?? "none")}\nPlan: ${planLabel}\nStars: ${payment.total_amount}\nExpires: ${expiryStr}\n\nPremium auto-granted ✅`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }

    await bot.sendMessage(
      chatId,
      `🎉 *Payment successful!* ⭐\n\nWelcome to Premium, *${escMd(user.name)}*!\n\n` +
      `📦 Plan: *${planLabel}*\n` +
      `📅 Valid until: *${expiryStr}*\n\n` +
      `Tumhara account turant unlock ho gaya 💎\nAb real matches ke saath baat karo!`,
      { parse_mode: "Markdown" }
    );
    if (fresh) await sendMain(chatId, fresh);
  } catch (err) {
    logger.error({ err, userId }, "successful_payment handler error");
  }
});

bot.onText(/\/premium/, async (msg) => {
  const u = await getUser(msg.from!.id);
  if (u && isPremiumActive(u)) {
    const expStr = u.premiumExpiresAt
      ? `\n📅 Valid until: *${u.premiumExpiresAt.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}*`
      : "";
    await bot.sendMessage(msg.chat.id, `✅ You're a *Premium* member! Enjoy unlimited matches 💎${expStr}\n\nTap below to renew or upgrade anytime ⬇️`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: `⚡ Extend 2 Weeks — ${PLANS.week2.stars} Stars`, callback_data: "plan_week2" }],
          [{ text: `💎 Extend 1 Month — ${PLANS.month.stars} Stars`, callback_data: "plan_month" }],
          [{ text: `👑 Extend 1 Year — ${PLANS.yearly.stars} Stars`, callback_data: "plan_yearly" }],
        ],
      },
    });
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

    // Grant premium with 30-day expiry; if mid-fake-chat reset to idle
    const grantExpiry = getPremiumExpiry(30);
    const grantExpStr = grantExpiry.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
    const grantUpdate: Partial<typeof usersTable.$inferInsert> = { hasPaid: true, premiumExpiresAt: grantExpiry, updatedAt: new Date() };
    if (wasInFakeChat) { grantUpdate.state = "idle"; grantUpdate.chattingWith = null; }
    await db.update(usersTable).set(grantUpdate).where(eq(usersTable.id, targetId));

    await bot.sendMessage(chatId, `✅ Premium granted to ${target.name ?? "User"} (ID: ${targetId})\n📅 Expires: ${grantExpStr}`);

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

// ── Admin: /cleanblocked — silently probe all users, remove blocked ones ────────
// Uses sendChatAction('typing') — completely invisible to users, no message sent
// Returns 403 if user has blocked the bot → mark isActive=false in DB

bot.onText(/\/cleanblocked/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ADMIN_ID || msg.from!.id !== ADMIN_ID) {
    await bot.sendMessage(chatId, "⛔ Not authorised.");
    return;
  }

  await bot.sendMessage(chatId, "🔍 Starting silent block-detection scan...\n\n⚠️ This probes all active users with an invisible typing signal. No messages will be sent to users.\n\nThis may take several minutes for large user bases.");

  const PROD_DB_URL = "postgresql://postgres:GhLpEsBkAcBYSftlWBhOSmAuxZSqRKdG@hopper.proxy.rlwy.net:30481/railway";
  const { Pool: PgPool } = await import("pg").then((m: any) => m.default ?? m) as { Pool: typeof import("pg").Pool };
  const prodPool = new PgPool({ connectionString: PROD_DB_URL, ssl: { rejectUnauthorized: false }, max: 3 });
  const { drizzle: makeDrizzle } = await import("drizzle-orm/node-postgres");
  const prodDb = makeDrizzle(prodPool, { schema: { usersTable } });

  // Get all currently-active users (excluding admin)
  const targets = await prodDb.select({ id: usersTable.id })
    .from(usersTable)
    .where(
      ADMIN_ID
        ? and(eq(usersTable.isActive, true), ne(usersTable.id, ADMIN_ID))
        : eq(usersTable.isActive, true)
    );

  await bot.sendMessage(chatId, `📋 Found ${targets.length} active users to probe. Starting scan...`);

  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  let probed = 0, cleaned = 0, errors = 0;

  for (const row of targets) {
    try {
      // sendChatAction is invisible — no notification, no message shown to user
      // Returns 403 immediately if user has blocked the bot
      await bot.sendChatAction(row.id, "typing");
    } catch (err: unknown) {
      const statusCode = (err as any)?.response?.statusCode;
      const errMsg = typeof (err as any)?.message === 'string' ? (err as any).message : '';
      const isBlocked = statusCode === 403 || errMsg.includes('bot was blocked') || errMsg.includes('user is deactivated') || errMsg.includes('chat not found');
      if (isBlocked) {
        cleaned++;
        await prodDb.update(usersTable)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(usersTable.id, row.id))
          .catch(() => {});
      } else {
        errors++;
      }
    }
    probed++;

    // Progress update every 200 users
    if (probed % 200 === 0) {
      await bot.sendMessage(
        chatId,
        `⏳ Probed: ${probed}/${targets.length} — 🚫 Blocked found: ${cleaned}`
      ).catch(() => {});
    }

    await sleep(55); // ~18/sec — stay under Telegram rate limits
  }

  await prodPool.end().catch(() => {});

  await bot.sendMessage(
    chatId,
    `✅ *Block scan complete!*\n\n` +
    `👥 Total probed: ${probed}\n` +
    `🚫 Blocked & removed: ${cleaned}\n` +
    `⚠️ Other errors: ${errors}\n\n` +
    `Your active user count is now accurate. Next broadcast will skip all ${cleaned} removed users.`,
    { parse_mode: "Markdown" }
  );
});

// ── Admin: /broadcast — FOMO blast to all unpaid demo users ──────────────────

bot.onText(/\/broadcast/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ADMIN_ID || msg.from!.id !== ADMIN_ID) { await bot.sendMessage(chatId, "⛔ Not authorised."); return; }

  const GIRL_NAMES = ["Riya","Priya","Neha","Simran","Komal","Ananya","Kavya","Shreya","Pooja","Nidhi","Megha","Tanya","Ishika","Aisha","Sanya"];

  function rndName() { return GIRL_NAMES[Math.floor(Math.random() * GIRL_NAMES.length)]; }

  function fomoMsg(name: string): string {
    const msgs = [
      `💌 *${name}* ab bhi soch rahi hai tumhare baare mein 🥺\n\n_"unka message padhke dil khush ho gaya"_\n\nReal log, real baat — ek baar unlock karo, phir koi limit nahi 💕\n\n⭐ Telegram Stars se instant unlock — button neeche hai!`,
      `🔔 Yaad hai tumhara woh match?\n\n*${name}* ne poochha — _"kya woh wapas aayenge?"_ 🥺\n\nWoh abhi bhi yahan hai. Premium lo aur baat shuru karo 💕\n\n⭐ Sirf Stars se pay karo — turant unlock!`,
      `✨ Tumhara free preview khatam hua — *${name}* nahi gayi 🥺\n\nWoh online hai abhi. Ek payment aur real chat forever.\n\nNo timer. No limits 💕\n\n⭐ Telegram Stars — secure, instant, automatic!`,
      `💘 Woh ladki jisse tumhara match hua?\n\n*${name}* ne kaha — _"kya woh serious hain?"_ 🥺\n\nProve it. Pay once, chat unlimited 💕\n\n⭐ Stars se unlock karo — bot pe /pay bhejo!`,
      `💕 *${name}* nahi bhooli tumhe.\n\n_"interesting lag rahe the, kash aur baat hoti"_ — yahi kaha usne 🥺\n\nReal conversations. One-time payment. No limits.\n\n⭐ Telegram Stars = instant unlock!`,
      `🌙 Late night thought — *${name}* abhi bhi app pe hai.\n\nWoh match kiya tha tumhare saath ek reason se 💕\n\nPremium = real chats, real people, koi timer nahi.\n\n⭐ Stars se pay karo — /pay type karo!`,
      `💬 *${name}* ne message kiya... lekin tumhara Premium nahi hai abhi.\n\nReal connection tha. Waste mat karo.\n\nPay once. Chat forever 💕\n\n⭐ Telegram Stars — instant automatic unlock!`,
    ];
    return msgs[Math.floor(Math.random() * msgs.length)];
  }

  await bot.sendMessage(chatId, "📡 Fetching unpaid users from production...");

  // Use Railway production DB directly so broadcast reaches real users
  const PROD_DB_URL = "postgresql://postgres:GhLpEsBkAcBYSftlWBhOSmAuxZSqRKdG@hopper.proxy.rlwy.net:30481/railway";
  const { Pool: PgPool } = await import("pg").then(m => m.default ?? m) as { Pool: typeof import("pg").Pool };
  const prodPool = new PgPool({ connectionString: PROD_DB_URL, ssl: { rejectUnauthorized: false }, max: 3 });
  const { drizzle: makeDrizzle } = await import("drizzle-orm/node-postgres");
  const prodDb = makeDrizzle(prodPool, { schema: { usersTable } });

  const targets = await prodDb.select({ id: usersTable.id })
    .from(usersTable)
    .where(
      and(
        gt(usersTable.chatCount, 0),
        eq(usersTable.hasPaid, false),
        eq(usersTable.isProfileComplete, true),
        ...(ADMIN_ID ? [ne(usersTable.id, ADMIN_ID)] : [])
      )
    );

  await bot.sendMessage(chatId, `📤 Sending to ${targets.length} users... I'll update every 100 messages.`);

  let sent = 0, failed = 0;

  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  let blocked = 0;
  for (const row of targets) {
    const name = rndName();
    try {
      await bot.sendMessage(row.id, fomoMsg(name), { parse_mode: "Markdown", disable_web_page_preview: true });
      sent++;
    } catch (err: unknown) {
      failed++;
      const statusCode = (err as any)?.response?.statusCode ?? (err as any)?.code;
      const isBlocked = statusCode === 403 ||
        (typeof (err as any)?.message === 'string' && (err as any).message.includes('bot was blocked'));
      if (isBlocked) {
        blocked++;
        await prodDb.update(usersTable)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(usersTable.id, row.id))
          .catch(() => {});
      }
    }
    if ((sent + failed) % 100 === 0) {
      await bot.sendMessage(chatId, `⏳ Progress: ${sent + failed}/${targets.length} — ✅ ${sent} sent, ❌ ${failed} failed`).catch(() => {});
    }
    await sleep(80);
  }

  await prodPool.end().catch(() => {});
  await bot.sendMessage(chatId, `✅ Broadcast complete!\n\n📤 Total: ${targets.length}\n✅ Sent: ${sent}\n❌ Failed: ${failed}\n🚫 Auto-cleaned blocked: ${blocked}`);
});

// ── Admin: /broadcasttext <message> — send custom text to ALL users ─────────────

bot.onText(/\/broadcasttext (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!ADMIN_ID || msg.from!.id !== ADMIN_ID) {
    await bot.sendMessage(chatId, "⛔ Not authorized.").catch(() => {});
    return;
  }

  const message = (match![1] ?? "").trim();
  if (!message) {
    await bot.sendMessage(chatId, "⚠️ Please provide a message.\nUsage: /broadcasttext Hello everyone! 😄");
    return;
  }

  await bot.sendMessage(chatId, "📡 Fetching all users from production DB...");

  const PROD_DB_URL = "postgresql://postgres:GhLpEsBkAcBYSftlWBhOSmAuxZSqRKdG@hopper.proxy.rlwy.net:30481/railway";
  const { Pool: PgPool } = await import("pg").then((m: any) => m.default ?? m) as { Pool: typeof import("pg").Pool };
  const prodPool = new PgPool({ connectionString: PROD_DB_URL, ssl: { rejectUnauthorized: false }, max: 3 });
  const { drizzle: makeDrizzle } = await import("drizzle-orm/node-postgres");
  const prodDb = makeDrizzle(prodPool, { schema: { usersTable } });

  // Only active users — skip users who already blocked the bot
  const targets = await prodDb.select({ id: usersTable.id })
    .from(usersTable)
    .where(
      ADMIN_ID
        ? and(eq(usersTable.isActive, true), ne(usersTable.id, ADMIN_ID))
        : eq(usersTable.isActive, true)
    );

  if (targets.length === 0) {
    await bot.sendMessage(chatId, "⚠️ No users found in the database.");
    await prodPool.end().catch(() => {});
    return;
  }

  await bot.sendMessage(chatId, `📤 Starting broadcast to ${targets.length} users...\nProgress updates every 100 messages.`);

  let sent = 0, failed = 0;
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  let blocked = 0;
  for (const row of targets) {
    try {
      await bot.sendMessage(row.id, message);
      sent++;
    } catch (err: unknown) {
      failed++;
      const statusCode = (err as any)?.response?.statusCode ?? (err as any)?.code;
      const isBlocked = statusCode === 403 ||
        (typeof (err as any)?.message === 'string' && (err as any).message.includes('bot was blocked'));
      if (isBlocked) {
        blocked++;
        await prodDb.update(usersTable)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(usersTable.id, row.id))
          .catch(() => {});
      }
    }

    // Progress update every 100 users
    if ((sent + failed) % 100 === 0) {
      await bot.sendMessage(
        chatId,
        `⏳ Progress: ${sent + failed}/${targets.length} — ✅ ${sent} sent, ❌ ${failed} failed`
      ).catch(() => {});
    }

    await sleep(50); // ~20 messages/second — safe for Telegram rate limits
  }

  await prodPool.end().catch(() => {});

  logger.info({ sent, failed, blocked, total: targets.length }, "broadcasttext complete");
  await bot.sendMessage(
    chatId,
    `✅ Broadcast complete!\n\n📊 Total targeted: ${targets.length}\n✅ Sent: ${sent}\n❌ Failed: ${failed}\n🚫 Auto-cleaned blocked: ${blocked}`
  );
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

logger.info("Telegram bot polling started");
