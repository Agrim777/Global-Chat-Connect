import TelegramBot from "node-telegram-bot-api";
import { db, usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

const PAY_LINK = "https://rzp.io/rzp/lx0R52O7";
const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? "8273572245");
const FAKE_CHAT_ID = 0; // sentinel: chattingWith=0 means fake chat
const FREE_CHAT_DURATION_MS = 60 * 1000; // 60 seconds free for all users

// Init without polling first — steal session from any stale instance, then start clean
export const bot = new TelegramBot(TOKEN, { polling: false });

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
  isFemale: boolean;
  lastAsked: string;
  mood: Mood;
  msgCount: number;          // total messages received
  lastUserMsg: string;       // last thing user said (for callbacks)
  callbackUsed: boolean;     // already done a callback this convo
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

async function sendMain(chatId: number, user: { name?: string | null; isProfileComplete?: boolean; hasPaid?: boolean }, customText?: string) {
  let kb: TelegramBot.ReplyKeyboardMarkup;
  if (user.isProfileComplete) {
    const premiumBtn = user.hasPaid ? { text: "✅ Premium" } : { text: "💎 Go Premium" };
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

const FEMALE_NAMES = ["Priya", "Neha", "Riya", "Komal", "Simran", "Pooja", "Ananya", "Kavya"];
const MALE_NAMES   = ["Arjun", "Rahul", "Rohan", "Vikram", "Karan", "Dev", "Ayaan", "Nikhil"];

interface Opener { text: string; lastAsked: string }

const OPENERS_F: Opener[] = [
  { text: "heyy 😊\nkahan se ho tum?", lastAsked: "location" },
  { text: "hii 🙈\nomg finally match hua haha\nokay bolo — student ho ya job?", lastAsked: "job" },
  { text: "heyy!!\nngl bahut bore ho rahi thi 😭\nkuch interesting batao apne baare mein", lastAsked: "job" },
  { text: "hi 💕\nquick question — job hai ya still college?", lastAsked: "job" },
  { text: "heyy 😄\nkahan se ho? delhi wale toh nahi ho na 😂", lastAsked: "location" },
  { text: "hii\nomg match hua toh laga koi acha milega 😅\nbata — kya karte ho?", lastAsked: "job" },
  { text: "heyy\nfirst time is app pe? 😂\nkya karte ho waise?", lastAsked: "job" },
];
const OPENERS_M: Opener[] = [
  { text: "hey\nkaisi hai?", lastAsked: "wellbeing" },
  { text: "hi\nkahan se ho?", lastAsked: "location" },
  { text: "hey\nstudent or working?", lastAsked: "job" },
  { text: "hi\nkya chal raha hai life mein?", lastAsked: "job" },
  { text: "hey\nbata kuch interesting apne baare mein", lastAsked: "job" },
];

// ── Language detection ────────────────────────────────────────────────────────

function detectLang(text: string): "hindi" | "hinglish" | "english" {
  if (/[\u0900-\u097F]/.test(text)) return "hindi";
  if (/\b(kya|hai|hoon|hain|mein|tum|aap|kar|raha|rahi|tha|thi|nahi|kuch|bahut|accha|theek|bhai|yaar|suno|bolo|kaise|abhi|thoda|bas|baat|pyaar|haha|lol|ngl|btw|karo|bol|chal|aga|acha|achi|thik|bilkul|matlab|pata|wala|wali|laga|mila|mili)\b/i.test(text)) return "hinglish";
  return "english";
}

// ── Conversational reply engine ────────────────────────────────────────────────
// Returns array of short WhatsApp-style burst messages

function buildSmartReply(userText: string, persona: FakePersona): string[] {
  const t = userText.toLowerCase().trim();
  const f = persona.isFemale;
  const lang = detectLang(userText);

  const one   = (a: string): string[]                     => [a];
  const two   = (a: string, b: string): string[]          => [a, b];
  const three = (a: string, b: string, c: string): string[] => [a, b, c];
  const rnd   = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

  // ── Special topic overrides ───────────────────────────────────────────────

  if (/tera naam|tumhara naam|your name|naam kya|who are you|what.?s your name|call you/.test(t)) {
    persona.lastAsked = "job";
    if (lang === "hindi")    return two(persona.name + " hun 😊", "tum batao?");
    if (lang === "hinglish") return two(persona.name + " 😊", "tum?");
    return f ? two(persona.name + " 🙈", "you?") : two(persona.name, "yours?");
  }

  if (/kitne saal|umar|how old|your age|age kya/.test(t)) {
    persona.lastAsked = "hobby";
    if (lang === "hindi")    return two(String(persona.age) + " 😊", "tumhara?");
    if (lang === "hinglish") return two(String(persona.age), "u?");
    return f ? two(String(persona.age) + " 🙈", "and you?") : two(String(persona.age), "you?");
  }

  if (/kahan se|kahan ho|where.*from|ur from|you from|kahan ki/.test(t)) {
    persona.lastAsked = "job";
    const city = rnd(["delhi", "mumbai side", "pune", "delhi ncr"]);
    if (lang === "hindi")    return two(city + " se hun", "tum?");
    if (lang === "hinglish") return two(city + " 😊", "you?");
    return f ? two(city + " 🙈", "you?") : two(city, "you?");
  }

  if (/photo|pic|selfie|dikhao|dikha|send photo/.test(t)) {
    if (lang === "hindi")    return two("haha abhi nahi 😂", "pehle thoda toh baat karo na");
    if (lang === "hinglish") return three("haha yaar 😂", "abhi nahi", "thoda baat karo pehle");
    return f ? three("haha noo 😂", "not yet lol", "talk first") : two("haha earn it", "talk first");
  }

  if (/sexy|hot|figure|body|boobs|sex|naughty|nude|naked|chut|lund/.test(t)) {
    if (lang === "hindi")    return two("haha 😂😂", "seedha wahan chale gaye");
    if (lang === "hinglish") return two("arre yaar 😂", "slow down haha");
    return f ? two("omg haha 😂", "easy there lol") : two("haha bold move", "talk first buddy");
  }

  if (/number de|whatsapp|insta|instagram|meet|video call|milna/.test(t)) {
    if (lang === "hindi")    return two("haha abhi nahi yaar 😅", "pehle yahan baat karte hain");
    if (lang === "hinglish") return two("haha slow down 😅", "yahan baat karo pehle na");
    return f ? three("omg haha 😅", "slow down", "talk here first lol") : two("easy lol", "here first");
  }

  if (/bye|goodbye|gtg|gotta go|alvida|chalta|chalti/.test(t)) {
    if (lang === "hindi")    return one(rnd(["arre itni jaldi? 😕", "ek min ruko na 🥺", "already? nooo 😭"]));
    if (lang === "hinglish") return one(rnd(["already? 😕 tc", "noo 🥺 okay bye", "itni jaldi kya hai 😭"]));
    return f ? one(rnd(["already?? 🥺", "nooo don't go 😭", "okay fine tc 😕"])) : one("okay tc");
  }

  if (/pyaar|love you|miss you|i love|mohabbat|ishq/.test(t)) {
    if (lang === "hindi")    return two("haha arre 😂😂", "abhi se? pehle baat toh karo");
    if (lang === "hinglish") return two("omg haha 😂", "itni jaldi?? thoda baat karo pehle");
    return f ? two("omg hahaha 😂", "we literally just met lol") : two("haha slow down 😂", "talk first");
  }

  if (/(tum|you|ur).*(cute|hot|beautiful|pretty|gorgeous|sundar|acchi|mast)/.test(t)) {
    if (lang === "hindi")    return two("haha shukriya 🙈😊", "tum bhi theek theek ho");
    if (lang === "hinglish") return two("haha thanks 🙈", "you're not bad either ngl");
    return f ? two("omg haha thanks 🙈", "not bad yourself ngl") : two("haha thanks 😄", "you seem decent");
  }

  if (/thanks|thank you|shukriya|ty|tq/.test(t)) {
    if (lang === "hindi")    return one(rnd(["haha koi baat nahi 😄", "arre yaar 😄"]));
    if (lang === "hinglish") return one(rnd(["haha ofcourse 😄", "koi baat nahi yaar"]));
    return f ? one(rnd(["haha ofc 😄", "no problem 💕", "of course lol"])) : one("haha no problem");
  }

  if (/sad|bored|akela|lonely|bore|dukhi|depressed/.test(t)) {
    if (lang === "hindi")    return two("arre yaar 🥺", "kya hua? baat karo na");
    if (lang === "hinglish") return two("aww 🥺", "kya hua? bolo na");
    return f ? two("aww noo 🥺", "what happened?? tell me") : two("hmm 😟", "what's up?");
  }

  // ── Context-aware replies ─────────────────────────────────────────────────

  switch (persona.lastAsked) {

    case "wellbeing": {
      persona.lastAsked = "job";
      if (/good|great|amazing|mast|badhiya|accha|theek|sahi/.test(t)) {
        if (lang === "hindi")    return two("nice nice 😊", "kya karte ho? job ya student?");
        if (lang === "hinglish") return two("aww nice 😊", "so student or working?");
        return f ? two("aww same 😊", "so student or job?") : two("nice", "working or student?");
      }
      if (/bad|sad|tired|thaka|pareshan|bura/.test(t)) {
        if (lang === "hindi")    return two("arre kya hua 🥺", "theek ho? baat karo");
        if (lang === "hinglish") return two("aww 🥺", "kya hua? bolo");
        return f ? two("aww 🥺", "what happened? tell me") : two("hmm", "what's wrong?");
      }
      if (lang === "hindi")    return one("kya karte ho? student ya job?");
      if (lang === "hinglish") return one("student or working?");
      return f ? one("student or working?") : one("student or job?");
    }

    case "location": {
      persona.lastAsked = "job";
      if (/delhi|ncr|gurgaon|noida/.test(t)) {
        if (lang === "hindi")    return two("omg delhi 😄", "kya karte ho wahan?");
        if (lang === "hinglish") return two("oh delhi wale 😄", "student or job?");
        return f ? two("omg delhi 😄", "student or job?") : two("oh delhi nice", "student or job?");
      }
      if (/mumbai|bombay|pune|maharashtra/.test(t)) {
        if (lang === "hindi")    return two("mumbai? waah 😮", "kya karte ho?");
        if (lang === "hinglish") return two("oh mumbai side 😮", "student or working?");
        return f ? two("oh mumbai 😮", "student or working?") : two("oh mumbai", "working or student?");
      }
      if (/bangalore|bengaluru|hyderabad|chennai/.test(t)) {
        if (lang === "hinglish") return two("south side 😮", "student or working?");
        return f ? two("oh south side 😮", "student or job?") : two("south India nice", "student or job?");
      }
      if (/usa|uk|canada|dubai|abroad|australia/.test(t)) {
        if (lang === "hindi")    return two("abroad ho?? 😮", "wow kya karte ho wahan?");
        if (lang === "hinglish") return two("omg abroad 😮", "student or working there?");
        return f ? two("omg abroad 😮✨", "studying or working?") : two("oh abroad", "studying or working?");
      }
      if (lang === "hindi") return one("kya karte ho? student ya job?");
      return one("student or job?");
    }

    case "job": {
      persona.lastAsked = "hobby";
      if (/student|college|university|btech|engineering|mbbs|padhai|padhta|padhti/.test(t)) {
        if (lang === "hindi")    return two("student life 😄", "kya padhte ho exactly?");
        if (lang === "hinglish") return two("oh student life 😄", "which course?");
        return f ? two("oh student nice 😊", "what course?") : two("student nice", "which course?");
      }
      if (/engineer|software|developer|tech|it|coding|programmer/.test(t)) {
        if (lang === "hindi")    return two("oh techie ho 😄", "wfh ya office jaate ho?");
        if (lang === "hinglish") return two("oh tech person 😄", "wfh or office?");
        return f ? two("oh tech 😄", "wfh or office?") : two("oh tech", "wfh or office?");
      }
      if (/doctor|nurse|medical|mbbs|hospital/.test(t)) {
        if (lang === "hindi")    return three("doctor? 😮", "respect hai seriously", "bahut mushkil hota hai");
        if (lang === "hinglish") return two("omg doctor 😮", "respect yaar genuinely");
        return f ? two("omg doctor 😮", "respect honestly that's so cool") : two("whoa doctor", "respect honestly");
      }
      if (/business|entrepreneur|startup|self|apna kaam/.test(t)) {
        if (lang === "hindi")    return two("apna kaam? wow 👏", "kya business hai?");
        if (lang === "hinglish") return two("own business waah 👏", "what kind?");
        return f ? two("oh own business 😍", "what kind?") : two("own business nice", "what kind?");
      }
      if (lang === "hindi")    return one("free time mein kya karte ho? koi hobby?");
      if (lang === "hinglish") return one("hobbies kya hain?");
      return f ? one("what do you do for fun?") : one("hobbies?");
    }

    case "hobby": {
      persona.lastAsked = "flirt";
      if (/travel|trip|explore|ghoomna|trek|ghumna/.test(t)) {
        if (lang === "hindi")    return two("travel person ho 😍", "best jagah kahan gaye?");
        if (lang === "hinglish") return two("omg traveller 😍", "best place bolo");
        return f ? two("omg traveller 😍", "best place so far?") : two("oh traveller", "best place?");
      }
      if (/music|sing|guitar|rap|gaana|song/.test(t)) {
        if (lang === "hindi")    return two("music 🎵", "sirf sunna ya play bhi karte ho?");
        if (lang === "hinglish") return two("music person 🎵", "play anything?");
        return f ? two("ooh music 🎵", "you play anything?") : two("music nice 🎵", "play anything?");
      }
      if (/gym|workout|fitness|sport|cricket|football|yoga/.test(t)) {
        if (lang === "hindi")    return two("fitness person 💪", "daily jaate ho?");
        if (lang === "hinglish") return two("oh fitness 💪", "daily workout?");
        return f ? two("oh fitness 💪", "gym daily?") : two("fitness nice 💪", "daily?");
      }
      if (/game|gaming|pubg|cod|valorant|ps5|xbox/.test(t)) {
        if (lang === "hindi")    return two("gamer ho 🎮", "kaunse games mostly?");
        if (lang === "hinglish") return two("oh gamer 🎮", "which games?");
        return f ? two("omg gamer 🎮", "which games?") : two("oh gamer 🎮", "what games?");
      }
      if (/movie|netflix|series|show|web series|ott/.test(t)) {
        if (lang === "hindi")    return two("shows/movies person 🍿", "last kya dekha?");
        if (lang === "hinglish") return two("netflix person 🍿", "last show konsa?");
        return f ? two("omg same 🍿", "last thing you watched?") : two("movies nice 🍿", "last one?");
      }
      if (/read|book|novel|padhna/.test(t)) {
        if (lang === "hinglish") return two("oh reader 📚", "kaunsi genre?");
        return f ? two("ooh reader 📚", "what genre?") : two("reader nice 📚", "what genre?");
      }
      if (lang === "hindi")    return one("khana ya bahar ghoomna — kya zyada pasand hai?");
      if (lang === "hinglish") return one("foodie ho? fav food kya hai?");
      return f ? one("foodie? fav food?") : one("into food? fav?");
    }

    case "flirt": {
      persona.lastAsked = "done";
      if (/biryani|pizza|burger|momo|chai|coffee|food|khana|maggi/.test(t)) {
        if (lang === "hindi")    return two("haha sahi choice 😄", "kabhi saath khaate hain pakka");
        if (lang === "hinglish") return two("haha nice taste 😄", "saath eat karte hain kisi din");
        return f ? three("haha good taste 😄", "okay noted", "maybe we grab food sometime 🙈") : two("haha solid 😄", "maybe eat together sometime");
      }
      if (/chill|relax|home|ghar|aram|lazy|netflix|movie/.test(t)) {
        if (lang === "hindi")    return two("homebody types ho 😄", "mujhe aisa hi pasand hai honestly");
        if (lang === "hinglish") return two("homebody vibes 😄", "that's actually cute ngl");
        return f ? two("omg homebody 😄", "cozy energy i love it") : two("chill type", "underrated honestly");
      }
      if (/party|bahar|outing|friends|hangout|ghoomna/.test(t)) {
        if (lang === "hindi")    return two("outing types ho 😄", "adventurous lagta/lagti ho");
        if (lang === "hinglish") return two("outgoing type 😄", "nice yaar");
        return f ? two("oh outgoing 😄", "fun people are rare fr") : two("outgoing nice 😄", "love that");
      }
      if (lang === "hindi")    return one(rnd(["sach mein acha lag raha hai baat karke 😊", "interesting ho tum 😄", "haha maza aa raha hai"]));
      if (lang === "hinglish") return one(rnd(["honestly yaar nice chat hai ye 😊", "you're interesting ngl 😄", "haha this is fun"]));
      return f ? one(rnd(["honestly this is going well 😊", "you're actually interesting lol", "ngl fun talking to u 😄"])) : one(rnd(["decent convo ngl", "easy to talk to", "this is good actually"]));
    }

    case "done": {
      if (lang === "hindi")    return one(rnd(["yaar baat karke acha laga 😊", "different ho tum 😄", "hum phir baat karenge pakka 🤞"]));
      if (lang === "hinglish") return one(rnd(f
        ? ["honestly nice hai ye chat 😊", "don't disappear okay 🥺", "you're different, i like it 😄"]
        : ["honestly great chat 😊", "easy to talk to yaar", "different from the rest"]));
      return one(rnd(f
        ? ["honestly this was so nice 😊", "you're different in a good way 🙈", "don't disappear okay? 🥺", "ngl this was fun 😄"]
        : ["honestly great chat 😊", "easy to talk to", "different from usual crowd"]));
    }
  }

  // ── Greeting fallback ─────────────────────────────────────────────────────
  if (/^(hi+|hey+|hello|namaste|yo|hlo|hola|hy)[!?.s]*$/.test(t)) {
    persona.lastAsked = "wellbeing";
    if (lang === "hindi")    return two("haan bol 😊", "kaisa chal raha hai?");
    if (lang === "hinglish") return two("heyy 😊", "kaisa hai tu?");
    return f ? two("heyy 😊", "how's it going?") : two("hey", "how's it?");
  }

  if (/how are you|how r u|kaisa hai|kaise ho|wassup|what.?s up|kya chal/.test(t)) {
    persona.lastAsked = "job";
    if (lang === "hindi")    return two("theek hun 😊", "tum batao — kya karte ho?");
    if (lang === "hinglish") return two("doing good 😊", "u? and what do u do?");
    return f ? two("doing good 😊", "you? what do you do?") : two("doing well", "you?");
  }

  if (/ok(ay)?|sure|haan|han|yes|yeah|haha|lol|hehe|achha|theek|bilkul|acha/.test(t)) {
    if (lang === "hindi")    return one(rnd(["haha achha 😄", "arey sach mein?", "okay okay bolo aur"]));
    if (lang === "hinglish") return one(rnd(["haha okay yaar 😄", "sach me?", "aur batao 😊"]));
    return one(rnd(f
      ? ["haha okay 😄", "wait really? 👀", "go on then 😄", "lol okay aur?"]
      : ["haha okay 😄", "wait really?", "okay go on"]));
  }

  // ── Ultimate fallback ─────────────────────────────────────────────────────
  if (lang === "hindi")    return one(rnd(["hmm 🤔", "arey sach mein?", "haha aur batao", "interesting 👀"]));
  if (lang === "hinglish") return one(rnd(["hmm 🤔", "sach me? 👀", "haha okay aur?", "interesting yaar"]));
  return one(rnd(f
    ? ["hmm 🤔", "wait really? 👀", "haha go on", "interesting lol", "tell me more 😄"]
    : ["hmm 🤔", "wait really?", "okay and?", "interesting"]));
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
        `💌 *${girl}* is still thinking about your chat...\n\n` +
        `She told me — and I quote — "he was actually different 🥺"\n\n` +
        `Don't let her wait too long. Unlock *Premium* and keep the conversation going! 💕\n\n` +
        `👉 ${PAY_LINK}`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    } catch { /* silent */ }
  }, 5 * 60 * 1000); // 5 minutes
}

// ── Pay gate ─────────────────────────────────────────────────────────────────

async function sendPayGate(chatId: number, prefix?: string) {
  await bot.sendMessage(
    chatId,
    (prefix ? `${prefix}\n\n` : ``) +
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
    try {
      chatTimerMap.delete(userId);
      const persona = fakePersonaMap.get(userId);
      fakePersonaMap.delete(userId);
      const u = await getUser(userId);
      // End chat if still active (check state, don't rely on chattingWith === 0)
      if (u?.state === "chatting" && !u.hasPaid) {
        await db.update(usersTable)
          .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
          .where(eq(usersTable.id, userId));
        await sendPayGate(chatId, "⏰ Your free trial has ended!").catch(() => {});
        schedulePayReminder(chatId, userId, persona?.name);
      } else if (u && !u.hasPaid) {
        await sendPayGate(chatId).catch(() => {});
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

async function fakeAutoReply(chatId: number, userId: number, userText: string) {
  // Prevent double AI replies when user types faster than reply arrives
  if (fakeReplySet.has(userId)) return;
  fakeReplySet.add(userId);

  try {
  const persona = fakePersonaMap.get(userId);
  if (!persona) return;

  const lang = detectLang(userText);

  // Update persona state
  persona.msgCount++;
  shiftMood(persona);

  // ── 1. Fast, natural typing delay (0.4 – 1.6s) ───────────────────────────
  // Keep it snappy — free trial is only 60 seconds
  const baseMs = 400 + Math.min(userText.length * 8, 600) + Math.random() * 600;
  await delay(baseMs);

  // Guard: user may have left during delay
  const u = await getUser(userId);
  if (u?.state !== "chatting" || u.chattingWith !== FAKE_CHAT_ID) return;

  // ── 2. Callback to earlier message (5% chance, once per convo) ───────────
  if (!persona.callbackUsed && persona.msgCount > 3 && Math.random() < 0.05) {
    const cb = callbackReply(persona.lastUserMsg, lang);
    if (cb) {
      persona.callbackUsed = true;
      await bot.sendMessage(chatId, cb[0]);
      await delay(300 + Math.random() * 300);
    }
  }

  // ── 3. Build main reply ───────────────────────────────────────────────────
  let parts: string[];

  if (persona.mood === "annoyed") {
    parts = dryReply(lang);
  } else {
    parts = buildSmartReply(userText, persona);
  }

  // ── 4. Soft typos (casual feel, no self-correction) ──────────────────────
  parts = parts.map(p => Math.random() < 0.18 ? applyTypos(p) : p);

  // ── 5. Send parts quickly one by one ─────────────────────────────────────
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await delay(300 + Math.random() * 400);
    await bot.sendMessage(chatId, parts[i]);
  }

  // Remember last message for future callbacks
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
  // Unpaid users who've used their trial → show pay gate only (no menu)
  if (!updated?.hasPaid && (updated?.chatCount ?? 0) > 0) {
    await sendPayGate(chatId);
  } else {
    await sendMain(chatId, updated!, "Chat ended.");
  }
}

// ── Find eligible real users ──────────────────────────────────────────────────

async function findEligibleUsers(me: NonNullable<Awaited<ReturnType<typeof getUser>>>, userId: number) {
  // Unpaid users never get real matches — always fake chat only
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

    // ── FREE USERS: AI chat ONLY — never touch real user pool ──────────────
    if (!me.hasPaid) {
      if (me.chatCount > 0) {
        // Already used free trial — require payment
        await sendPayGate(chatId);
      } else {
        // First ever chat — AI demo only
        await startFakeChat(chatId, userId, me.lookingFor);
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
    await bot.sendMessage(match.id,
      `✅ Match found! You're now connected with *${me.name}*, ${me.age}. Say hello! 👋`,
      { parse_mode: "Markdown", reply_markup: stopKb }
    );

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
    `👤 <b>Your Profile</b>\n\n` +
    `🏷 Name: <b>${escHtml(user.name)}</b>\n` +
    `🎂 Age: <b>${escHtml(user.age)}</b>\n` +
    `⚤ Gender: <b>${escHtml(gLabel[user.gender ?? ""] ?? "—")}</b>\n` +
    `💞 Looking for: <b>${escHtml(lfLabel[user.lookingFor ?? ""] ?? "—")}</b>\n` +
    `🌍 Country: <b>${escHtml(user.country)}</b>\n` +
    `📖 Bio: <i>${escHtml(user.bio)}</i>\n\n` +
    (user.hasPaid ? `✅ <b>Premium member</b>` : `🔒 Free account — tap 💳 Support Us to unlock`),
    { parse_mode: "HTML" }
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

// Finish an edit-mode update — return user to idle with one combined message
async function finishEditField(chatId: number, id: number) {
  editModeMap.delete(id);
  await upsertUser(id, { state: "idle" });
  const updated = await getUser(id);
  await sendMain(chatId, updated!, "✅ Profile updated! Tap 👤 My Profile to view it.");
}

// ── Message router ────────────────────────────────────────────────────────────

bot.on("message", async (msg) => {
  if (!msg.text && !msg.photo && !msg.document) return;
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
        "🛑 Stop Matching", "💳 Support Us", "💎 Go Premium", "✅ Premium", "🚀 Setup Profile", ...EDIT_FIELD_LABELS];
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
        // Screenshot during fake chat → forward to admin + acknowledge user
        if (msg.photo) {
          await bot.sendMessage(chatId, "✅ Payment screenshot received! Our team will verify and unlock your account within a few minutes 🔓💕");
          if (ADMIN_ID) {
            const caption =
              `💰 *Payment screenshot received!*\n\n` +
              `User: *${escMd(user.name)}* (${escMd(user.age)})\n` +
              `ID: \`${id}\`\nUsername: @${escMd(user.telegramUsername ?? "none")}\n\n` +
              `Run: /grant ${id}`;
            await bot.sendPhoto(ADMIN_ID, msg.photo[msg.photo.length - 1].file_id, { caption, parse_mode: "Markdown" });
          }
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
          recipient.chattingWith === id
        ) {
          // Both still connected — relay the message
          try {
            if (msg.photo) {
              // Forward photo directly to partner
              await bot.forwardMessage(recipientId, chatId, msg.message_id);
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

    // ── Handle screenshot sent after pay gate (idle state) ──────────────

    if (msg.photo && !user.hasPaid) {
      if (ADMIN_ID) {
        const caption = `💰 *Payment screenshot received!*\n\nUser: *${escMd(user.name)}* (${escMd(user.age)})\nID: \`${id}\`\nUsername: @${escMd(user.telegramUsername ?? "none")}\n\nRun: /grant ${id}`;
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
    if (text === "👤 My Profile") {
      await showProfile(chatId, user);
      return;
    }
    if (text === "🛑 Stop Matching" || text === "🛑 Stop Chat") { await stopChat(chatId, id); return; }
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

    // Unrecognised input — re-show the menu so buttons are always visible
    await sendMain(chatId, user);
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
  const u = await getUser(msg.from!.id);
  if (u?.isProfileComplete) { await startEditProfile(msg.chat.id, msg.from!.id); return; }
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

    let target = await getUser(targetId);

    if (!target) {
      // User hasn't started the bot yet — pre-create them as paid
      await db.insert(usersTable).values({ id: targetId, hasPaid: true, state: "idle", isProfileComplete: false })
        .onConflictDoUpdate({ target: usersTable.id, set: { hasPaid: true, updatedAt: new Date() } });
      await bot.sendMessage(chatId, `✅ Premium pre-granted to user ${targetId}. They'll have access when they start the bot.`);
      return;
    }

    if (target.hasPaid) {
      await bot.sendMessage(chatId, `✅ User ${targetId} (${target.name ?? "Unknown"}) already has Premium.`);
      return;
    }

    await db.update(usersTable).set({ hasPaid: true, updatedAt: new Date() }).where(eq(usersTable.id, targetId));
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

// ── Admin: /users ─────────────────────────────────────────────────────────────

bot.onText(/\/users/, async (msg) => {
  if (!ADMIN_ID || msg.from!.id !== ADMIN_ID) return;
  const users = await db.select().from(usersTable);
  const lines = users.map((u) => `• ${escMd(u.name)} (${escMd(u.age)}) | ID: ${u.id} | Paid: ${u.hasPaid ? "✅" : "❌"} | Chats: ${u.chatCount}`);
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

// ── Startup: disconnect any unpaid users from real chats ─────────────────────
// Handles stale DB state from before payment checks were enforced.
(async () => {
  try {
    const allChatting = await db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.state, "chatting"), eq(usersTable.hasPaid, false)));

    for (const u of allChatting) {
      if (!u.chattingWith || u.chattingWith === FAKE_CHAT_ID) {
        // Stuck in fake-chat state but no in-memory persona (bot restarted) — reset
        await db.update(usersTable)
          .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
          .where(eq(usersTable.id, u.id));
        continue;
      }
      // Unpaid user connected to a REAL user — disconnect both
      logger.warn({ userId: u.id, partnerId: u.chattingWith }, "Startup: disconnecting unpaid user from real chat");
      await db.update(usersTable)
        .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
        .where(eq(usersTable.id, u.id));
      await db.update(usersTable)
        .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
        .where(and(eq(usersTable.id, u.chattingWith), eq(usersTable.chattingWith, u.id)));
    }

    if (allChatting.length > 0) {
      logger.info({ count: allChatting.length }, "Startup cleanup: unpaid users reset");
    }
  } catch (err) {
    logger.error({ err }, "Startup cleanup failed (non-fatal)");
  }
})();

logger.info("Telegram bot polling started");
