import TelegramBot from "node-telegram-bot-api";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

const PAY_LINK = "https://rzp.io/rzp/lx0R52O7";
const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? "0");
const FAKE_CHAT_ID = 0; // sentinel: chattingWith=0 means fake chat
const FREE_CHAT_DURATION_MS = 60 * 1000; // 60 seconds free for all users

// Init without polling first — steal session from any stale instance, then start clean
export const bot = new TelegramBot(TOKEN, { polling: false });

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
  isFemale: boolean;
  lastAsked: string;
  mood: Mood;
  msgCount: number;          // total messages received
  pendingSkip: boolean;      // if we skipped the last message
  lastUserMsg: string;       // last thing user said (for callbacks)
  callbackUsed: boolean;     // already done a callback this convo
}
const fakePersonaMap = new Map<number, FakePersona>();   // userId → persona
const editModeMap   = new Map<number, string>();          // userId → edit field ("choosing"|"name"|"age"|"gender"|"looking_for"|"bio"|"country")
const chatTimerMap  = new Map<number, NodeJS.Timeout>(); // userId → free-chat timer

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  const existing = await getUser(id);
  if (existing) {
    await db.update(usersTable).set({ ...data, updatedAt: new Date() }).where(eq(usersTable.id, id));
  } else {
    await db.insert(usersTable).values({ id, ...data } as typeof usersTable.$inferInsert);
  }
  return getUser(id);
}

// Generate a unique 6-char alphanumeric referral code for a user
function makeCode(userId: number): string {
  // Base36 of userId + timestamp salt, padded to 6 chars, uppercased
  const raw = (userId % 46656).toString(36).toUpperCase().padStart(4, '0');
  const salt = Math.floor(Math.random() * 36 * 36).toString(36).toUpperCase().padStart(2, '0');
  return (raw + salt).slice(0, 6);
}

async function ensureReferralCode(userId: number): Promise<string> {
  const u = await getUser(userId);
  if (u?.referralCode) return u.referralCode;
  // Generate until unique (extremely rare collision at this scale)
  let code = makeCode(userId);
  let attempts = 0;
  while (attempts < 10) {
    const existing = await db.select().from(usersTable)
      .where(eq(usersTable.referralCode, code));
    if (existing.length === 0) break;
    code = makeCode(userId + attempts + Date.now());
    attempts++;
  }
  await db.update(usersTable).set({ referralCode: code, updatedAt: new Date() })
    .where(eq(usersTable.id, userId));
  return code;
}

async function showReferralStats(chatId: number, userId: number) {
  const u = await getUser(userId);
  if (!u) return;
  const code = await ensureReferralCode(userId);
  const BOT_USERNAME = "Mydatingbabybot";
  const link = `https://t.me/${BOT_USERNAME}?start=ref_${code}`;
  const referred = u.referralCount ?? 0;
  const bonus    = u.bonusChats    ?? 0;
  const progress = referred % 10;
  const bar = "🟩".repeat(progress) + "⬜".repeat(10 - progress);
  await bot.sendMessage(chatId,
    `📨 *Refer Friends — Get Free Chats*

` +
    `Share your link with friends. When *10 friends join*, you earn *1 free chat* with a real person! No payment needed.

` +
    `🔗 *Your link:*
` + `\`${link}\`

` +
    `📊 Progress: ${progress}/10
${bar}

` +
    `👥 Total friends referred: *${referred}*
` +
    `🎁 Free chats available: *${bonus}*`,
    { parse_mode: "Markdown" }
  );
}

async function sendMain(chatId: number, user: { name?: string | null; isProfileComplete?: boolean; hasPaid?: boolean }) {
  let kb: TelegramBot.ReplyKeyboardMarkup;
  if (user.isProfileComplete) {
    const premiumBtn = user.hasPaid ? { text: "✅ Premium" } : { text: "💎 Go Premium" };
    kb = {
      keyboard: [
        [{ text: "💘 Find Match" }, { text: "👤 My Profile" }],
        [{ text: "✏️ Edit Profile" }, { text: "🛑 Stop Matching" }],
        [{ text: "📨 Refer Friends" }, premiumBtn],
      ],
      resize_keyboard: true,
    };
  } else {
    kb = {
      keyboard: [
        [{ text: "🚀 Setup Profile" }],
        [{ text: "📨 Refer Friends" }, { text: "💎 Go Premium" }],
      ],
      resize_keyboard: true,
    };
  }
  await bot.sendMessage(
    chatId,
    user.isProfileComplete
      ? `Welcome back, *${user.name ?? "there"}* 💖\nWhat would you like to do?`
      : `Hi *${user.name ?? "there"}*! 👋\nYou haven't set up your profile yet.\nTap below to get started!`,
    { parse_mode: "Markdown", reply_markup: kb }
  );
}

// ── Fake personas ─────────────────────────────────────────────────────────────

const FEMALE_NAMES = ["Priya", "Neha", "Riya", "Komal", "Simran", "Pooja", "Ananya", "Kavya"];
const MALE_NAMES   = ["Arjun", "Rahul", "Rohan", "Vikram", "Karan", "Dev", "Ayaan", "Nikhil"];

interface Opener { text: string; lastAsked: string }

const OPENERS_F: Opener[] = [
  { text: "heyy", lastAsked: "wellbeing" },
  { text: "hi 😊\nkahan se ho?", lastAsked: "location" },
  { text: "heyy\nstudent ho ya job?", lastAsked: "job" },
  { text: "hii\nngl bore ho rahi thi. achha hua match hua 😄", lastAsked: "job" },
  { text: "hey\nokay bata kuch apne baare mein. boring intro mat dena", lastAsked: "job" },
];
const OPENERS_M: Opener[] = [
  { text: "hey\nkaisi hai?", lastAsked: "wellbeing" },
  { text: "hi\nkahan se ho?", lastAsked: "location" },
  { text: "hey\nstudent or working?", lastAsked: "job" },
  { text: "hi\nnahi socha itni jaldi match hoga. kya chal raha hai?", lastAsked: "job" },
  { text: "hey\nbata kuch interesting apne baare mein", lastAsked: "job" },
];

// ── Language detection ────────────────────────────────────────────────────────

function detectLang(text: string): "hindi" | "hinglish" | "english" {
  if (/[\u0900-\u097F]/.test(text)) return "hindi";
  if (/\b(kya|hai|hoon|hain|mein|tum|aap|kar|raha|rahi|tha|thi|nahi|kuch|bahut|accha|theek|bhai|yaar|suno|bolo|kaise|abhi|thoda|bas|baat|pyaar|haha|lol|ngl|btw|karo|bol|chal|aga|acha|achi|thik|bilkul|matlab|pata|wala|wali|laga|mila|mili)\b/i.test(text)) return "hinglish";
  return "english";
}

// ── Conversational reply engine ────────────────────────────────────────────────
// Returns array of short messages (sent one by one like WhatsApp)

function buildSmartReply(userText: string, persona: FakePersona): string[] {
  const t = userText.toLowerCase().trim();
  const f = persona.isFemale;
  const lang = detectLang(userText);

  // Helper: split a reply into 1-3 WhatsApp-style short parts
  const one  = (a: string): string[]          => [a];
  const two  = (a: string, b: string): string[] => [a, b];
  const three = (a: string, b: string, c: string): string[] => [a, b, c];

  // ── Direct questions about the persona ────────────────────────────────
  if (/tera naam|tumhara naam|aapka naam|your name|who are you|what.?s your name|call you|naam kya/.test(t)) {
    persona.lastAsked = "job";
    if (lang === "hindi") return two(persona.name, "tum?");
    if (lang === "hinglish") return two(persona.name + " 😊", "tum batao");
    return f ? two(persona.name, "you?") : two(persona.name, "yours?");
  }
  if (/kitne saal|teri umar|tumhari umar|how old|your age|age kya|umar/.test(t)) {
    persona.lastAsked = "hobby";
    if (lang === "hindi") return two(String(persona.age), "tumhara?");
    if (lang === "hinglish") return two(String(persona.age), "you?");
    return f ? two(String(persona.age), "why lol") : two(String(persona.age), "you?");
  }
  if (/kahan se|kahan ho|kahaan rehti|kahaan rehte|where.*you.*live|ur from|you from|kahan ki/.test(t)) {
    persona.lastAsked = "job";
    if (lang === "hindi") return two("delhi", "tum?");
    if (lang === "hinglish") return two("delhi side", "you?");
    return two("delhi", "you?");
  }
  if (/photo|pic|selfie|dikhao|dikha|send photo/.test(t)) {
    if (lang === "hindi") return two("haha abhi nahi 😂", "pehle thoda baat toh karo");
    if (lang === "hinglish") return two("haha not yet yaar 😄", "thoda baat karo pehle");
    return f ? two("haha not yet 😄", "let's talk first") : two("haha earn it first", "talk to me");
  }
  if (/sexy|hot|figure|body|boobs|lund|chut|sex|naughty|nude|naked/.test(t)) {
    if (lang === "hindi") return two("haha 😂", "thoda toh baat karo bhai");
    if (lang === "hinglish") return two("arre yaar 😂", "seedha wahan mat jao");
    return f ? two("haha easy 😄", "talk first") : two("haha bold", "earn it first");
  }
  if (/meet|milna|mil sakte|video call|number de|whatsapp|insta|instagram/.test(t)) {
    if (lang === "hindi") return two("arre abhi nahi yaar 😅", "thoda aur baat karte hain");
    if (lang === "hinglish") return two("haha slow down 😄", "yahan pe baat karo pehle");
    return f ? two("haha slow down 😄", "let's talk here first") : two("easy lol", "talk here first");
  }
  if (/bye|goodbye|gtg|gotta go|alvida|chalta|chalti|nikalta|niklati/.test(t)) {
    if (lang === "hindi") return one("arre itni jaldi 😕");
    if (lang === "hinglish") return one("already? 😕 okay tc");
    return f ? one("already? 😕 okay bye") : one("okay tc");
  }

  // ── Context-aware replies ────────────────────────────────────────────
  switch (persona.lastAsked) {

    case "wellbeing": {
      persona.lastAsked = "job";
      if (/good|great|fine|well|amazing|sahi|badhiya|accha|theek|mast|badiya/.test(t)) {
        if (lang === "hindi") return two("accha nice", "kya karte ho? student ya job?");
        if (lang === "hinglish") return two("nice 😊", "student or working?");
        return f ? two("same 😊", "student or job?") : two("nice", "student or working?");
      }
      if (/bad|sad|tired|bored|stressed|bura|thaka|pareshan|bore/.test(t)) {
        if (lang === "hindi") return two("arre yaar 😟", "kya hua? baat karo");
        if (lang === "hinglish") return two("hmm 😟", "kya hua?");
        return f ? two("aww 😟", "what happened?") : two("hmm 😟", "what's wrong?");
      }
      if (lang === "hindi") return one("kya karte ho? student ya job?");
      if (lang === "hinglish") return one("student or working?");
      return f ? one("student or job?") : one("student or working?");
    }

    case "location": {
      persona.lastAsked = "job";
      if (/delhi|ncr|gurgaon|noida/.test(t)) {
        if (lang === "hindi") return two("oh delhi wale ho 😄", "kya karte ho wahan?");
        if (lang === "hinglish") return two("oh delhi 😄", "student or job?");
        return two("oh delhi nice", "student or job?");
      }
      if (/mumbai|bombay|pune/.test(t)) {
        if (lang === "hindi") return two("mumbai 😮", "kya karte ho?");
        if (lang === "hinglish") return two("oh mumbai", "student or job?");
        return two("oh mumbai", "student or job?");
      }
      if (/usa|uk|canada|dubai|abroad|australia|germany/.test(t)) {
        if (lang === "hindi") return two("abroad ho 😮", "kya karte ho wahan?");
        if (lang === "hinglish") return two("oh abroad 😮", "student or working?");
        return two("oh abroad", "studying or working?");
      }
      if (lang === "hindi") return one("kya karte ho wahan?");
      return one("student or job?");
    }

    case "job": {
      persona.lastAsked = "hobby";
      if (/student|college|university|btech|mtech|engineering|mbbs|padhai|padhta|padhti/.test(t)) {
        if (lang === "hindi") return two("nice student life 😄", "kya padhte ho?");
        if (lang === "hinglish") return two("student life 😄", "what course?");
        return f ? two("oh student nice 😊", "what course?") : two("student nice", "what course?");
      }
      if (/engineer|software|developer|tech|it|coding|programmer/.test(t)) {
        if (lang === "hindi") return two("oh techie ho 😄", "wfh ya office?");
        if (lang === "hinglish") return two("oh techie 😄", "wfh or office?");
        return two("oh tech", "wfh or office?");
      }
      if (/doctor|nurse|medical|hospital/.test(t)) {
        if (lang === "hindi") return two("doctor? 😮", "respect hai yaar");
        if (lang === "hinglish") return two("whoa doctor 😮", "respect yaar");
        return two("whoa doctor", "respect honestly");
      }
      if (/business|entrepreneur|startup|self|apna kaam/.test(t)) {
        if (lang === "hindi") return two("apna kaam 👍", "kya business hai?");
        if (lang === "hinglish") return two("own business 👍", "what kind?");
        return two("own business nice", "what kind?");
      }
      if (/job nahi|unemployed|break|gap|abhi nahi/.test(t)) {
        if (lang === "hindi") return two("koi baat nahi 😊", "kya scene chal raha hai?");
        if (lang === "hinglish") return two("no worries 😊", "kya kar rahe ho these days?");
        return two("no worries 😊", "what are you into?");
      }
      if (lang === "hindi") return one("free time mein kya karte ho?");
      if (lang === "hinglish") return one("hobbies kya hain?");
      return one(f ? "what do you do for fun?" : "hobbies?");
    }

    case "hobby": {
      persona.lastAsked = "flirt";
      if (/travel|trip|explore|ghoomna|trek/.test(t)) {
        if (lang === "hindi") return two("travel person ho 😍", "best jagah kahan gayi/gaye?");
        if (lang === "hinglish") return two("oh traveller 😍", "best place?");
        return two("oh traveller 😍", "best place?");
      }
      if (/music|sing|guitar|rap|gaana|songs/.test(t)) {
        if (lang === "hindi") return two("music 🎵 nice", "sirf sunna ya play bhi?");
        if (lang === "hinglish") return two("music person 🎵", "play anything?");
        return two("music nice 🎵", "play anything?");
      }
      if (/gym|workout|fitness|sport|cricket|football|yoga/.test(t)) {
        if (lang === "hindi") return two("fitness person 💪", "kya karte ho exactly?");
        if (lang === "hinglish") return two("oh fitness 💪", "what workout?");
        return two("fitness nice 💪", "what workout?");
      }
      if (/game|gaming|pubg|cod|valorant|xbox|ps5/.test(t)) {
        if (lang === "hindi") return two("gamer ho 🎮", "kaunse games?");
        if (lang === "hinglish") return two("oh gamer 🎮", "which games?");
        return two("oh gamer 🎮", "what games?");
      }
      if (/movie|netflix|series|show|web series|dekhna/.test(t)) {
        if (lang === "hindi") return two("movies/shows 🍿", "last mein kya dekha?");
        if (lang === "hinglish") return two("netflix person 🍿", "last show?");
        return two("movies nice 🍿", "last thing you watched?");
      }
      if (lang === "hindi") return one("khaane ka kya scene hai? kya pasand hai?");
      if (lang === "hinglish") return one("foodie ho? fav food?");
      return one(f ? "foodie? fav food?" : "into food? fav?");
    }

    case "flirt": {
      persona.lastAsked = "done";
      if (/biryani|pizza|burger|momo|chai|coffee|khana|food/.test(t)) {
        if (lang === "hindi") return two("haha sahi choice 😄", "kabhi saath khaate hain");
        if (lang === "hinglish") return two("haha nice taste 😄", "maybe saath eat karen kisi din");
        return f ? two("haha good taste 😄", "maybe we grab food sometime") : two("haha solid 😄", "maybe eat together sometime");
      }
      if (/chill|relax|home|ghar|aram|lazy|netflix/.test(t)) {
        if (lang === "hindi") return two("homebody types ho 😄", "mujhe aisa pasand hai");
        if (lang === "hinglish") return two("homebody ho tum 😄", "that's cute honestly");
        return f ? two("homebody 😄", "cozy energy") : two("chill type", "underrated honestly");
      }
      if (/party|bahar|outing|friends|hangout/.test(t)) {
        if (lang === "hindi") return two("outing person ho 😄", "adventurous lagta/lagti ho");
        if (lang === "hinglish") return two("outgoing type 😄", "nice yaar");
        return f ? two("outgoing 😄", "fun people are rare") : two("outgoing nice 😄", "people who go out actually live");
      }
      if (lang === "hindi") return one(pickRandom(["sach mein achhi baat ho rahi hai 😊", "haha tum interesting nikle 😄"]));
      if (lang === "hinglish") return one(pickRandom(["honestly yaar this is good 😊", "you're interesting ngl 😄"]));
      return one(pickRandom(f
        ? ["honestly this is going well 😊", "you're actually interesting lol"]
        : ["decent convo ngl 😊", "you're easy to talk to"]));
    }

    case "done": {
      if (lang === "hindi") return one(pickRandom(["sach mein acha lag raha hai baat karke 😊", "yaar hum phir baat karenge pakka", "different ho tum 😄"]));
      if (lang === "hinglish") return one(pickRandom(f
        ? ["honestly nice chat yaar 😊", "don't disappear okay 😄", "you're different, i like it"]
        : ["honestly great chat 😊", "easy to talk to yaar", "different from the rest"]));
      return one(pickRandom(f
        ? ["honestly this was nice 😊", "you're different in a good way", "don't disappear okay?"]
        : ["honestly great chat 😊", "easy to talk to", "different from the usual crowd"]));
    }
  }

  // ── Greeting fallbacks ───────────────────────────────────────────────
  if (/^(hi|hey|hello|hii+|heyy+|namaste|yo|hlo|hola|hy)[s!?.]*$/.test(t)) {
    persona.lastAsked = "wellbeing";
    if (lang === "hindi") return two("haan bol 😊", "kaisa chal raha hai?");
    if (lang === "hinglish") return two("hey 😊", "kaisa hai?");
    return f ? two("hey 😊", "how's it going?") : two("hey", "how's it going?");
  }
  if (/how are you|how r u|kaisa hai|kaise ho|kya haal|wassup|what.?s up|kya chal/.test(t)) {
    persona.lastAsked = "job";
    if (lang === "hindi") return two("theek hun 😊", "tum batao kya karte ho?");
    if (lang === "hinglish") return two("doing good 😊", "you? what do you do?");
    return f ? two("doing good 😊", "you? and what do you do?") : two("doing well", "you?");
  }
  if (/thanks|thank you|shukriya|ty|tq/.test(t)) {
    if (lang === "hindi") return one("haha koi baat nahi 😄");
    return one(f ? "haha of course 😄" : "haha no problem");
  }
  if (/pyaar|love you|miss you|kiss|hug|mohabbat|ishq/.test(t)) {
    if (lang === "hindi") return two("haha arre 😂", "pehle thoda baat toh karo");
    if (lang === "hinglish") return two("haha slow down yaar 😂", "thoda baat karo pehle");
    return f ? two("haha easy 😂", "talk first") : two("haha slow down 😂", "let's talk first");
  }
  if (/(tum|you).*(cute|hot|beautiful|pretty|sexy|gorgeous|acchi|sundar|mast)/.test(t)) {
    if (lang === "hindi") return two("haha shukriya 😄", "confident log pasand hain mujhe");
    if (lang === "hinglish") return two("haha thanks 😄", "you're not bad either");
    return f ? two("haha thanks 😄", "not bad yourself from what i know") : two("haha thanks 😄", "you seem alright too");
  }
  if (/sad|bored|akela|lonely|bore|dukhi/.test(t)) {
    if (lang === "hindi") return two("arre yaar 😟", "kya hua? baat karo");
    if (lang === "hinglish") return two("aww 😟", "what happened?");
    return f ? two("aww 😟", "what's going on?") : two("hmm 😟", "what's up?");
  }
  if (/ok(ay)?|sure|haan|han|yes|yeah|haha|lol|hehe|achha|theek|bilkul|acha/.test(t)) {
    if (lang === "hindi") return one(pickRandom(["haha achha 😄", "okay okay", "arey sach mein?"]));
    if (lang === "hinglish") return one(pickRandom(["haha okay yaar 😄", "arey sach me?", "okay got it 👍"]));
    return one(pickRandom(f
      ? ["haha okay 😄", "wait really?", "go on 😄"]
      : ["haha okay 😄", "wait really?", "okay got it 👍"]));
  }

  // ── Ultimate fallback ────────────────────────────────────────────────
  if (lang === "hindi") return one(pickRandom(["hmm 🤔", "arey sach mein?", "haha aur batao"]));
  if (lang === "hinglish") return one(pickRandom(["hmm 🤔", "arey sach me?", "haha okay aur?"]));
  return one(pickRandom(f
    ? ["hmm 🤔", "wait really?", "haha go on"]
    : ["hmm 🤔", "wait really?", "okay and?"]));
}
// ── Pay gate ─────────────────────────────────────────────────────────────────

async function sendPayGate(chatId: number) {
  await bot.sendMessage(
    chatId,
    `💎 *Go Premium — Unlock Full Access*\n\n` +
    `What you get:\n` +
    `✅ Unlimited real matches\n` +
    `✅ Chat with real people, not AI\n` +
    `✅ Your profile shown to more users\n` +
    `✅ Priority in matching queue\n` +
    `✅ One-time payment — no subscription\n\n` +
    `*How to upgrade:*\n` +
    `1️⃣ Tap the button below to pay\n` +
    `2️⃣ Take a screenshot of the payment confirmation\n` +
    `3️⃣ Send the screenshot here\n` +
    `4️⃣ We'll unlock your account within minutes 🔓\n\n` +
    `_Your free trial lets you try one AI chat. Premium unlocks real connections._`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "💎 Pay & Upgrade Now", url: PAY_LINK }]],
      },
    }
  );
}

// ── Fake chat: start ─────────────────────────────────────────────────────────

async function startFakeChat(chatId: number, userId: number, lookingFor: string | null) {
  const isFemale = lookingFor === "female" || (lookingFor !== "male" && Math.random() > 0.5);
  const name = isFemale ? pickRandom(FEMALE_NAMES) : pickRandom(MALE_NAMES);
  const age = 20 + Math.floor(Math.random() * 8); // 20–27
  const openerObj = isFemale ? pickRandom(OPENERS_F) : pickRandom(OPENERS_M);

  fakePersonaMap.set(userId, {
    name, age, isFemale,
    lastAsked: openerObj.lastAsked,
    mood: "neutral",
    msgCount: 0,
    pendingSkip: false,
    lastUserMsg: "",
    callbackUsed: false,
  });

  await db.update(usersTable)
    .set({ state: "chatting", chattingWith: FAKE_CHAT_ID, chatCount: 1, updatedAt: new Date() })
    .where(eq(usersTable.id, userId));

  await bot.sendMessage(
    chatId,
    `Match found. Say hello — you have a short free trial to chat.`,
    { reply_markup: { keyboard: [[{ text: "🛑 Stop Chat" }]], resize_keyboard: true } }
  );

  // Opener after natural "typing" delay (shorter for 15s window)
  await delay(1200 + Math.random() * 800);
  const still = await getUser(userId);
  if (still?.state === "chatting" && still.chattingWith === FAKE_CHAT_ID) {
    await bot.sendMessage(chatId, openerObj.text);
  }

  // 15-second free chat timer — fires regardless, ends chat and shows pay gate
  const timer = setTimeout(async () => {
    chatTimerMap.delete(userId);
    fakePersonaMap.delete(userId);
    const u = await getUser(userId);
    // End chat if still active (check state, don't rely on chattingWith === 0)
    if (u?.state === "chatting" && !u.hasPaid) {
      await db.update(usersTable)
        .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
        .where(eq(usersTable.id, userId));
      await bot.sendMessage(chatId, "That's the end of your free trial.");
      await sendPayGate(chatId);
    } else if (u && !u.hasPaid) {
      await sendPayGate(chatId);
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

// Dry low-engagement reply (annoyed / distracted mood)
function dryReply(lang: "hindi" | "hinglish" | "english"): string[] {
  const hindi    = [["hmm"], ["acha"], ["hm"], ["okay"], ["han"]];
  const hinglish = [["hmm"], ["acha yaar"], ["okay"], ["lol"], ["hm okay"]];
  const eng      = [["hmm"], ["okay"], ["lol"], ["haha"], ["k"]];
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

async function fakeAutoReply(chatId: number, userId: number, userText: string) {
  const persona = fakePersonaMap.get(userId);
  if (!persona) return;

  const lang = detectLang(userText);
  const hour = istHour();
  const isLateNight = hour >= 23 || hour < 5; // 11pm–5am IST

  // Update persona state
  persona.msgCount++;
  shiftMood(persona);

  // ── 1. Skip this message silently (8% chance, never twice in a row) ──────
  if (!persona.pendingSkip && Math.random() < 0.08) {
    persona.pendingSkip = true;
    persona.lastUserMsg = userText;
    return; // "seen" but no reply yet
  }

  const wasSkipped = persona.pendingSkip;
  persona.pendingSkip = false;

  // ── 2. Compute realistic typing delay ────────────────────────────────────
  let baseMs: number;
  if (persona.mood === "distracted") {
    baseMs = 18000 + Math.random() * 42000;   // 18–60s (busy / away)
  } else if (wasSkipped) {
    baseMs = 25000 + Math.random() * 65000;   // 25s–90s (finally saw it)
  } else if (isLateNight) {
    baseMs = 6000 + Math.random() * 10000;    // 6–16s (sleepy, slow)
  } else {
    baseMs = 2000 + Math.min(userText.length * 20, 2000) + Math.random() * 3000; // 2–7s
  }

  await delay(baseMs);

  // Guard: user may have left during delay
  const u = await getUser(userId);
  if (u?.state !== "chatting" || u.chattingWith !== FAKE_CHAT_ID) return;

  // ── 3. Real-life interruption prefix (10% chance) ─────────────────────────
  if (Math.random() < 0.10) {
    await bot.sendMessage(chatId, interruptionMsg(lang));
    await delay(5000 + Math.random() * 7000); // 5–12s "away"
    const u2 = await getUser(userId);
    if (u2?.state !== "chatting" || u2.chattingWith !== FAKE_CHAT_ID) return;
  }

  // ── 4. Callback to earlier message (5% chance, once per convo) ───────────
  if (!persona.callbackUsed && persona.msgCount > 4 && Math.random() < 0.05) {
    const cb = callbackReply(persona.lastUserMsg, lang);
    if (cb) {
      persona.callbackUsed = true;
      await bot.sendMessage(chatId, cb[0]);
      await delay(800 + Math.random() * 700);
    }
  }

  // ── 5. Build main reply ───────────────────────────────────────────────────
  let parts: string[];

  if (persona.mood === "annoyed" || (persona.mood === "distracted" && Math.random() < 0.55)) {
    // Low-engagement dry reply
    parts = dryReply(lang);
  } else {
    parts = buildSmartReply(userText, persona);
  }

  // ── 6. Late-night: collapse to single short reply ─────────────────────────
  if (isLateNight && parts.length > 1 && Math.random() < 0.55) {
    parts = [parts[0]];
  }

  // ── 7. Typo + self-correction sequence (12% chance) ──────────────────────
  if (parts.length > 0 && Math.random() < 0.12) {
    const typoVer = applyTypos(parts[0]);
    if (typoVer !== parts[0]) {
      await bot.sendMessage(chatId, typoVer);
      await delay(900 + Math.random() * 700);
      await bot.sendMessage(chatId, "*" + parts[0]); // WA-style correction
      parts = parts.slice(1);
    }
  } else {
    // Apply soft typos to any part (no correction, just casual)
    parts = parts.map(p => Math.random() < 0.20 ? applyTypos(p) : p);
  }

  // ── 8. Send parts one by one with realistic inter-message gap ────────────
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await delay(600 + Math.random() * 1000);
    await bot.sendMessage(chatId, parts[i]);
  }

  // Remember last message for future callbacks
  persona.lastUserMsg = userText;
}

// ── Stop chat ────────────────────────────────────────────────────────────────

async function stopChat(chatId: number, userId: number) {
  const me = await getUser(userId);
  if (!me || me.state !== "chatting") {
    await bot.sendMessage(chatId, "You're not in a chat right now.");
    if (me) await sendMain(chatId, me);
    return;
  }

  const partnerId = me.chattingWith;

  // Clear free-chat timer if present
  const timer = chatTimerMap.get(userId);
  if (timer) { clearTimeout(timer); chatTimerMap.delete(userId); }
  fakePersonaMap.delete(userId);

  await db.update(usersTable)
    .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
    .where(eq(usersTable.id, userId));

  if (partnerId && partnerId !== FAKE_CHAT_ID) {
    const partner = await getUser(partnerId);
    if (partner?.state === "chatting") {
      await db.update(usersTable)
        .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
        .where(eq(usersTable.id, partnerId));
      await bot.sendMessage(partnerId, "Your match ended the chat.");
      await sendMain(partnerId, partner);
      // Show pay gate to partner too if they're unpaid and used their trial
      if (!partner.hasPaid && (partner.chatCount ?? 0) > 0) {
        await delay(600);
        await sendPayGate(partnerId);
      }
    }
  }

  const updated = await getUser(userId);
  await bot.sendMessage(chatId, "Chat ended.");
  await sendMain(chatId, updated!);

  // Show pay gate to unpaid users who have used their free trial (fake or real)
  if (!updated?.hasPaid && (updated?.chatCount ?? 0) > 0) {
    await delay(600);
    await sendPayGate(chatId);
  }
}

// ── Find eligible real users ──────────────────────────────────────────────────

async function findEligibleUsers(me: NonNullable<Awaited<ReturnType<typeof getUser>>>, userId: number) {
  // Unpaid users never get real matches — always fake chat only
  if (!me.hasPaid) return [];
  const candidates = await db.select().from(usersTable).where(eq(usersTable.isProfileComplete, true));
  return candidates.filter((c) => {
    if (c.id === userId || !c.isActive || c.state === "chatting") return false;
    // Only paid users can be matched with paid users
    if (!c.hasPaid) return false;
    return (me.lookingFor === "any" || me.lookingFor === c.gender) &&
           (c.lookingFor === "any" || c.lookingFor === me.gender);
  });
}

// ── Find match ───────────────────────────────────────────────────────────────

async function findMatch(chatId: number, userId: number) {
  const me = await getUser(userId);
  if (!me?.isProfileComplete) {
    await bot.sendMessage(chatId, "Please complete your profile first! Tap *Setup Profile*.", { parse_mode: "Markdown" });
    return;
  }
  if (me.state === "chatting") {
    await bot.sendMessage(chatId, "You're already in a chat! Send /stop to end it first.");
    return;
  }

  // After first free trial, check for bonus chats before paywall
  const hasBonusChat = (me.bonusChats ?? 0) > 0;
  if (me.chatCount > 0 && !me.hasPaid && !hasBonusChat) {
    await sendPayGate(chatId);
    return;
  }

  // Decrement bonus chat before starting (consume it now)
  if (me.chatCount > 0 && !me.hasPaid && hasBonusChat) {
    await db.update(usersTable)
      .set({ bonusChats: (me.bonusChats ?? 1) - 1, updatedAt: new Date() })
      .where(eq(usersTable.id, userId));
    await bot.sendMessage(chatId,
      `🎁 Using 1 referral bonus chat! ${((me.bonusChats ?? 1) - 1)} remaining after this.`
    );
  }

  // ── First-ever chat OR paid user OR bonus chat: try real match first ───────
  const eligible = await findEligibleUsers(me, userId);

  if (eligible.length > 0) {
    // Real human available — connect them
    const match = pickRandom(eligible);
    const newCount = (me.chatCount ?? 0) + 1;

    const matchNewCount = (match.chatCount ?? 0) + 1;
    await db.update(usersTable)
      .set({ state: "chatting", chattingWith: match.id, chatCount: newCount, updatedAt: new Date() })
      .where(eq(usersTable.id, userId));
    await db.update(usersTable)
      .set({ state: "chatting", chattingWith: userId, chatCount: matchNewCount, updatedAt: new Date() })
      .where(eq(usersTable.id, match.id));

    const stopKb = { keyboard: [[{ text: "🛑 Stop Chat" }]], resize_keyboard: true };
    await bot.sendMessage(chatId,
      me.hasPaid
        ? `Match found. You're now connected with ${match.name}, ${match.age}. Say hello.`
        : `Match found. You're connected with ${match.name}, ${match.age}. You have a short free trial to chat.`,
      { reply_markup: stopKb }
    );
    await bot.sendMessage(match.id,
      `Match found. You're now connected with ${me.name}, ${me.age}. Say hello.`,
      { reply_markup: stopKb }
    );

    // If either side is unpaid, enforce the free trial timer
    const unpaidUserId   = !me.hasPaid    ? userId   : (!match.hasPaid ? match.id : null);
    const unpaidChatId   = !me.hasPaid    ? chatId   : (!match.hasPaid ? match.id : null);
    const paidPartnerId  = !me.hasPaid    ? match.id : (!match.hasPaid ? userId   : null);

    if (unpaidUserId !== null && unpaidChatId !== null) {
      const timer = setTimeout(async () => {
        chatTimerMap.delete(unpaidUserId);
        const u = await getUser(unpaidUserId);
        if (u?.state === "chatting" && !u.hasPaid) {
          // Disconnect both users
          await db.update(usersTable)
            .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
            .where(eq(usersTable.id, unpaidUserId));
          if (paidPartnerId) {
            await db.update(usersTable)
              .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
              .where(eq(usersTable.id, paidPartnerId));
            await bot.sendMessage(paidPartnerId, "Your match's free trial ended. Finding you a new match soon.");
            const paidPartnerUpdated = await getUser(paidPartnerId);
            if (paidPartnerUpdated) await sendMain(paidPartnerId, paidPartnerUpdated);
          }
          await bot.sendMessage(unpaidChatId, "That's the end of your free trial.");
          await sendPayGate(unpaidChatId);
        } else if (u && !u.hasPaid) {
          await sendPayGate(unpaidChatId);
        }
      }, FREE_CHAT_DURATION_MS);
      chatTimerMap.set(unpaidUserId, timer);
    }
    return;
  }

  // ── No real users available ───────────────────────────────────────────────
  if (me.hasPaid) {
    // Paid user — no one online right now
    await bot.sendMessage(chatId, "😔 No matches available right now. Try again in a moment!", {
      reply_markup: { keyboard: [[{ text: "💘 Find Match" }, { text: "👤 My Profile" }], [{ text: "✏️ Edit Profile" }, { text: "🛑 Stop Matching" }], [{ text: "✅ Premium" }]], resize_keyboard: true },
    });
    return;
  }

  // First-timer, no real users — use fake chat as fallback
  await startFakeChat(chatId, userId, me.lookingFor);
}

// ── /start ───────────────────────────────────────────────────────────────────

bot.onText(/\/start (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const id = msg.from!.id;
  const param = (match?.[1] ?? "").trim();
  try {
    let user = await getUser(id);
    const isNew = !user;
    if (!user) user = await upsertUser(id, { firstName: msg.from!.first_name ?? "", telegramUsername: msg.from!.username ?? null, state: "idle" });

    // Handle referral deep link: /start ref_XXXXXX
    if (param.startsWith("ref_") && isNew) {
      const refCode = param.slice(4).toUpperCase();
      const referrers = await db.select().from(usersTable)
        .where(eq(usersTable.referralCode, refCode));
      const referrer = referrers[0];
      if (referrer && referrer.id !== id) {
        // Mark this user as referred
        await db.update(usersTable)
          .set({ referredBy: referrer.id, updatedAt: new Date() })
          .where(eq(usersTable.id, id));

        // Increment referrer's count and award bonus chat every 10 referrals
        const newCount = (referrer.referralCount ?? 0) + 1;
        const bonusEarned = newCount % 10 === 0 ? 1 : 0;
        await db.update(usersTable)
          .set({
            referralCount: newCount,
            bonusChats: (referrer.bonusChats ?? 0) + bonusEarned,
            updatedAt: new Date(),
          })
          .where(eq(usersTable.id, referrer.id));

        // Notify referrer
        if (bonusEarned > 0) {
          await bot.sendMessage(referrer.id,
            `🎉 You referred 10 friends! You've earned *1 free chat*. Keep inviting to earn more! 🎁`,
            { parse_mode: "Markdown" }
          ).catch(() => {});
        } else {
          await bot.sendMessage(referrer.id,
            `👋 A friend joined using your referral link! (${newCount % 10}/10 towards your next free chat)`,
            { parse_mode: "Markdown" }
          ).catch(() => {});
        }
      }
    }

    await bot.sendMessage(chatId, "💕 *Welcome to WorldMatch Dating Bot!*\n\nConnect with people from all over the world.\nFind your perfect match and start chatting! 🌍", { parse_mode: "Markdown" });
    await sendMain(chatId, user!);
  } catch (err) { logger.error({ err }, "/start referral error"); }
});

bot.onText(/\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  const id = msg.from!.id;
  try {
    let user = await getUser(id);
    if (!user) user = await upsertUser(id, { firstName: msg.from!.first_name ?? "", telegramUsername: msg.from!.username ?? null, state: "idle" });
    await bot.sendMessage(chatId, "💕 *Welcome to WorldMatch Dating Bot!*\n\nConnect with people from all over the world.\nFind your perfect match and start chatting! 🌍", { parse_mode: "Markdown" });
    await sendMain(chatId, user!);
  } catch (err) { logger.error({ err }, "/start error"); }
});

// ── /help ────────────────────────────────────────────────────────────────────

bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    "ℹ️ *WorldMatch Commands*\n\n" +
    "/start — Start the bot\n" +
    "/profile — View your profile\n" +
    "/edit — Edit your profile\n" +
    "/match — Find a match\n" +
    "/stop — End current chat\n" +
    "/premium — Upgrade to Premium 💎\n" +
    "/refer — Referral link & stats\n" +
    "/pay — Payment info\n" +
    "/help — Show this help",
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
    `👤 *Your Profile*\n\n` +
    `🏷 Name: *${user.name ?? "—"}*\n` +
    `🎂 Age: *${user.age ?? "—"}*\n` +
    `⚤ Gender: *${gLabel[user.gender ?? ""] ?? "—"}*\n` +
    `💞 Looking for: *${lfLabel[user.lookingFor ?? ""] ?? "—"}*\n` +
    `🌍 Country: *${user.country ?? "—"}*\n` +
    `📖 Bio: _${(user.bio ?? "—").replace(/_/g, "\\_")}_\n\n` +
    (user.hasPaid ? `✅ *Premium member*` : `🔒 Free account — tap 💳 Support Us to unlock`),
    { parse_mode: "Markdown" }
  );
}

// First-time profile setup (only called when no profile exists)
async function startSetup(chatId: number, id: number) {
  editModeMap.delete(id); // ensure we're NOT in edit mode
  await upsertUser(id, { state: "setup_name" });
  await bot.sendMessage(chatId,
    "Let's build your profile! 🎉\n\n*Step 1 of 6* — 📝 What should we call you?\n\n_Type your first name only._",
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

// Finish an edit-mode update — return user to idle with their profile shown
async function finishEditField(chatId: number, id: number) {
  editModeMap.delete(id);
  await upsertUser(id, { state: "idle" });
  const updated = await getUser(id);
  await bot.sendMessage(chatId, "✅ Updated!", { reply_markup: { remove_keyboard: true } });
  await showProfile(chatId, updated!);
  await sendMain(chatId, updated!);
}

// ── Message router ────────────────────────────────────────────────────────────

bot.on("message", async (msg) => {
  if (!msg.text && !msg.photo && !msg.document) return;
  const chatId = msg.chat.id;
  const id = msg.from!.id;
  const text = (msg.text ?? "").trim();

  if (text.startsWith("/")) return;

  try {
    let user = await getUser(id);
    if (!user) {
      user = await upsertUser(id, { firstName: msg.from!.first_name ?? "", telegramUsername: msg.from!.username ?? null, state: "idle" });
      await sendMain(chatId, user!);
      return;
    }

    // ── Edit-mode cancel ────────────────────────────────────────────────
    if (text === "❌ Cancel" && editModeMap.has(id)) {
      editModeMap.delete(id);
      await upsertUser(id, { state: "idle" });
      const fresh = await getUser(id);
      await bot.sendMessage(chatId, "Cancelled.", { reply_markup: { remove_keyboard: true } });
      await sendMain(chatId, fresh!);
      return;
    }

    // ── Edit field picker (idle + editModeMap = "choosing") ─────────────
    if (user.state === "idle" && editModeMap.get(id) === "choosing") {
      if (text === "📝 Change Name") {
        editModeMap.set(id, "name");
        await upsertUser(id, { state: "setup_name" });
        await bot.sendMessage(chatId,
          `📝 *Change Name*\n\nCurrent: *${user.name ?? "—"}*\n\nType your new name, or type "skip" to keep it.`,
          { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
        );
      } else if (text === "🎂 Change Age") {
        editModeMap.set(id, "age");
        await upsertUser(id, { state: "setup_age" });
        await bot.sendMessage(chatId,
          `🎂 *Change Age*\n\nCurrent: *${user.age ?? "—"}*\n\nType your new age, or "skip".`,
          { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
        );
      } else if (text === "⚤ Change Gender") {
        editModeMap.set(id, "gender");
        await upsertUser(id, { state: "setup_gender" });
        await bot.sendMessage(chatId,
          `⚤ *Change Gender*\n\nCurrent: *${user.gender ?? "—"}*`,
          { parse_mode: "Markdown", reply_markup: { keyboard: [[{ text: "Male" }, { text: "Female" }, { text: "Other" }], [{ text: "❌ Cancel" }]], resize_keyboard: true, one_time_keyboard: true } }
        );
      } else if (text === "💞 Change Looking For") {
        editModeMap.set(id, "looking_for");
        await upsertUser(id, { state: "setup_looking_for" });
        await bot.sendMessage(chatId,
          `💞 *Change Looking For*\n\nCurrent: *${user.lookingFor ?? "—"}*`,
          { parse_mode: "Markdown", reply_markup: { keyboard: [[{ text: "Male" }, { text: "Female" }, { text: "Any" }], [{ text: "❌ Cancel" }]], resize_keyboard: true, one_time_keyboard: true } }
        );
      } else if (text === "📖 Change Bio") {
        editModeMap.set(id, "bio");
        await upsertUser(id, { state: "setup_bio" });
        await bot.sendMessage(chatId,
          `📖 *Change Bio*\n\nCurrent: _${user.bio ?? "—"}_\n\nType your new bio (max 300 chars), or "skip".`,
          { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
        );
      } else if (text === "🌍 Change Country") {
        editModeMap.set(id, "country");
        await upsertUser(id, { state: "setup_country" });
        await bot.sendMessage(chatId,
          `🌍 *Change Country*\n\nCurrent: *${user.country ?? "—"}*\n\nType your country, or "skip".`,
          { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
        );
      } else {
        await startEditProfile(chatId, id); // unrecognised input — show picker again
      }
      return;
    }

    // ── Setup / edit steps ──────────────────────────────────────────────

    if (user.state === "setup_name") {
      const isEdit = editModeMap.get(id) === "name";
      // Allow "skip" during edit to keep current value
      if (isEdit && text.toLowerCase() === "skip") { await finishEditField(chatId, id); return; }
      const BUTTON_LABELS = ["💘 Find Match", "👤 My Profile", "✏️ Edit Profile", "🛑 Stop Chat",
        "🛑 Stop Matching", "💳 Support Us", "💎 Go Premium", "✅ Premium", "📨 Refer Friends", "🚀 Setup Profile", ...EDIT_FIELD_LABELS];
      if (!text || text.length < 2 || text.length > 50 || BUTTON_LABELS.includes(text) || !/^[a-zA-ZÀ-ÿ\s'\-]+$/.test(text)) {
        await bot.sendMessage(chatId, "Please type your real name (letters only, 2–50 chars).", { reply_markup: { remove_keyboard: true } });
        return;
      }
      const capitalized = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
      await upsertUser(id, { name: capitalized, state: isEdit ? "idle" : "setup_age" });
      if (isEdit) { await finishEditField(chatId, id); return; }
      await bot.sendMessage(chatId, `Nice to meet you, *${capitalized}*! 🎉\n\n*Step 2 of 6* — 🎂 How old are you?`, { parse_mode: "Markdown" });
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
      await bot.sendMessage(chatId, `*Step 3 of 6* — ⚤ What's your *gender*?`, {
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
      await upsertUser(id, { gender: g, state: isEdit ? "idle" : "setup_looking_for" });
      if (isEdit) { await finishEditField(chatId, id); return; }
      await bot.sendMessage(chatId, `*Step 4 of 6* — 💞 Who are you *looking for*?`, {
        parse_mode: "Markdown",
        reply_markup: { keyboard: [[{ text: "Male" }, { text: "Female" }, { text: "Any" }]], resize_keyboard: true, one_time_keyboard: true },
      });
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
      await bot.sendMessage(chatId, "🎉 *Profile complete!* You're all set!", { parse_mode: "Markdown" });
      await showProfile(chatId, updated!);
      await sendMain(chatId, updated!);
      return;
    }

    // ── Chatting ────────────────────────────────────────────────────────

    if (user.state === "chatting") {
      if (text === "🛑 Stop Chat") { await stopChat(chatId, id); return; }

      if (user.chattingWith === FAKE_CHAT_ID) {
        // Screenshot during fake chat → forward to admin + acknowledge user
        if (msg.photo) {
          await bot.sendMessage(chatId, "✅ Payment screenshot received! Our team will verify and unlock your account within a few minutes 🔓💕");
          if (ADMIN_ID) {
            const caption =
              `💰 *Payment screenshot received!*\n\n` +
              `User: *${user.name ?? "Unknown"}* (${user.age ?? "?"})\n` +
              `ID: \`${id}\`\nUsername: @${user.telegramUsername ?? "none"}\n\n` +
              `Run: /grant ${id}`;
            await bot.sendPhoto(ADMIN_ID, msg.photo[msg.photo.length - 1].file_id, { caption, parse_mode: "Markdown" });
          }
          return;
        }
        await fakeAutoReply(chatId, id, text ?? "");
        return;
      }

      // Real chat relay — verify recipient is still connected and both users are paid
      const recipientId = user.chattingWith;
      if (recipientId) {
        const recipient = await getUser(recipientId);
        // Only forward if recipient is still in a chat with this exact user AND both are paid
        if (
          recipient?.state === "chatting" &&
          recipient.chattingWith === id &&
          user.hasPaid &&
          recipient.hasPaid
        ) {
          if (msg.photo) {
            await bot.forwardMessage(recipientId, chatId, msg.message_id);
            return;
          }
          if (text) {
            await bot.sendMessage(recipientId, `💬 *${user.name ?? "Match"}*: ${text}`, { parse_mode: "Markdown" });
          }
        } else if (!recipient || recipient.state !== "chatting" || recipient.chattingWith !== id) {
          // Stale connection — clean it up silently
          await db.update(usersTable)
            .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
            .where(eq(usersTable.id, id));
          const fresh = await getUser(id);
          await bot.sendMessage(chatId, "Your match is no longer available.");
          if (fresh) await sendMain(chatId, fresh);
        }
      }
      return;
    }

    // ── Handle screenshot sent after pay gate (idle state) ──────────────

    if (msg.photo && !user.hasPaid) {
      if (ADMIN_ID) {
        const caption = `💰 *Payment screenshot received!*\n\nUser: *${user.name ?? "Unknown"}* (${user.age ?? "?"})\nID: \`${id}\`\nUsername: @${user.telegramUsername ?? "none"}\n\nRun: /grant ${id}`;
        await bot.sendPhoto(ADMIN_ID, msg.photo[msg.photo.length - 1].file_id, { caption, parse_mode: "Markdown" });
      }
      await bot.sendMessage(chatId, "📸 *Screenshot received!* ✅\n\nOur team will verify and unlock your account shortly.\nUsually takes just a few minutes! 💕", { parse_mode: "Markdown" });
      return;
    }

    // ── Menu buttons ────────────────────────────────────────────────────

    if (text === "🚀 Setup Profile") {
      if (user.isProfileComplete) {
        // Profile already exists — send them to edit instead
        await startEditProfile(chatId, id);
      } else {
        await startSetup(chatId, id);
      }
      return;
    }
    if (text === "✏️ Edit Profile") {
      if ((user.state as string) === "chatting") { await bot.sendMessage(chatId, "Stop the current chat first before editing your profile."); return; }
      if (!user.isProfileComplete) { await startSetup(chatId, id); return; }
      await startEditProfile(chatId, id);
      return;
    }
    if (text === "💘 Find Match") { await findMatch(chatId, id); return; }
    if (text === "👤 My Profile") { await showProfile(chatId, user); return; }
    if (text === "🛑 Stop Matching" || text === "🛑 Stop Chat") { await stopChat(chatId, id); return; }
    if (text === "📨 Refer Friends") {
      await showReferralStats(chatId, id);
      return;
    }
        if (text === "💎 Go Premium") {
      if (user.hasPaid) {
        await bot.sendMessage(chatId, "✅ You're already a *Premium* member! Enjoy unlimited matches 💖", { parse_mode: "Markdown" });
        return;
      }
      await sendPayGate(chatId);
      return;
    }
    if (text === "✅ Premium") {
      await bot.sendMessage(chatId, "✅ You're a *Premium* member — unlimited real matches enabled! 💎", { parse_mode: "Markdown" });
      return;
    }
    if (text === "💳 Support Us") { await sendPayGate(chatId); return; }

    await sendMain(chatId, user);
  } catch (err) {
    logger.error({ err }, "Message handler error");
    await bot.sendMessage(chatId, "Something went wrong. Try /start again.");
  }
});

// ── Commands ──────────────────────────────────────────────────────────────────

bot.onText(/\/profile/, async (msg) => {
  const u = await getUser(msg.from!.id);
  if (!u?.isProfileComplete) { await bot.sendMessage(msg.chat.id, "Set up your profile first! Send /start."); return; }
  await showProfile(msg.chat.id, u);
});

bot.onText(/\/edit/, async (msg) => {
  const u = await getUser(msg.from!.id);
  if (u?.isProfileComplete) { await startEditProfile(msg.chat.id, msg.from!.id); return; }
  await startSetup(msg.chat.id, msg.from!.id);
});
bot.onText(/\/match/, async (msg) => { await findMatch(msg.chat.id, msg.from!.id); });
bot.onText(/\/stop/, async (msg) => { await stopChat(msg.chat.id, msg.from!.id); });

bot.onText(/\/pay/, async (msg) => { await sendPayGate(msg.chat.id); });

bot.onText(/\/(refer|referral|invite)/, async (msg) => {
  await showReferralStats(msg.chat.id, msg.from!.id);
});

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
  const adminId = msg.from!.id;
  if (!ADMIN_ID || adminId !== ADMIN_ID) {
    await bot.sendMessage(msg.chat.id, "⛔ You are not authorised to use this command.");
    return;
  }
  const targetId = parseInt(match![1].trim(), 10);
  if (isNaN(targetId)) { await bot.sendMessage(msg.chat.id, "Invalid user ID."); return; }
  const target = await getUser(targetId);
  if (!target) { await bot.sendMessage(msg.chat.id, `User ${targetId} not found.`); return; }
  if (target.hasPaid) { await bot.sendMessage(msg.chat.id, `✅ User ${targetId} already has premium.`); return; }

  await db.update(usersTable).set({ hasPaid: true, updatedAt: new Date() }).where(eq(usersTable.id, targetId));

  await bot.sendMessage(msg.chat.id, `✅ *Premium granted* to user ${targetId} (${target.name ?? "Unknown"})!`, { parse_mode: "Markdown" });
  await bot.sendMessage(
    targetId,
    `🎉 *Your premium is now unlocked!*\n\nThank you for your support 💕\nYou can now connect with people worldwide! Tap *Find Match* to get started.`,
    { parse_mode: "Markdown" }
  );
  const updated = await getUser(targetId);
  if (updated) await sendMain(targetId, updated);
});

// ── Admin: /revoke <userId> ───────────────────────────────────────────────────

bot.onText(/\/revoke (.+)/, async (msg, match) => {
  if (!ADMIN_ID || msg.from!.id !== ADMIN_ID) { await bot.sendMessage(msg.chat.id, "⛔ Not authorised."); return; }
  const targetId = parseInt(match![1].trim(), 10);
  if (isNaN(targetId)) { await bot.sendMessage(msg.chat.id, "Invalid user ID."); return; }
  await db.update(usersTable).set({ hasPaid: false, updatedAt: new Date() }).where(eq(usersTable.id, targetId));
  await bot.sendMessage(msg.chat.id, `✅ Premium revoked for user ${targetId}.`);
});

// ── Admin: /users ─────────────────────────────────────────────────────────────

bot.onText(/\/users/, async (msg) => {
  if (!ADMIN_ID || msg.from!.id !== ADMIN_ID) return;
  const users = await db.select().from(usersTable);
  const lines = users.map((u) => `• ${u.name ?? "?"} (${u.age ?? "?"}) | ID: ${u.id} | Paid: ${u.hasPaid ? "✅" : "❌"} | Chats: ${u.chatCount}`);
  await bot.sendMessage(msg.chat.id, `👥 *All Users (${users.length})*\n\n${lines.join("\n") || "None"}`, { parse_mode: "Markdown" });
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

logger.info("Telegram bot polling started");
