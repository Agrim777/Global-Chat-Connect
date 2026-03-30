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

interface FakePersona { name: string; age: number; isFemale: boolean; lastAsked: string }
const fakePersonaMap = new Map<number, FakePersona>();   // userId → persona
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

async function sendMain(chatId: number, user: { name?: string | null; isProfileComplete?: boolean }) {
  const kb = user.isProfileComplete
    ? { keyboard: [[{ text: "💘 Find Match" }, { text: "👤 My Profile" }], [{ text: "✏️ Edit Profile" }, { text: "🛑 Stop Matching" }], [{ text: "💳 Support Us" }]], resize_keyboard: true }
    : { keyboard: [[{ text: "🚀 Setup Profile" }], [{ text: "💳 Support Us" }]], resize_keyboard: true };
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
  { text: "hey... finally koi interesting mila. kaisa chal raha hai?", lastAsked: "wellbeing" },
  { text: "hi, so you matched with me huh. i'm curious, where are you from?", lastAsked: "location" },
  { text: "hey. okay real talk — student ho ya working? i like knowing what i'm dealing with.", lastAsked: "job" },
  { text: "hii... not gonna lie, i was bored. glad you're here. kya karte ho tum?", lastAsked: "job" },
  { text: "hey stranger. tell me something about yourself, the real stuff not the boring intro.", lastAsked: "job" },
];
const OPENERS_M: Opener[] = [
  { text: "hey. kaisi hai? be honest, i can take it.", lastAsked: "wellbeing" },
  { text: "hey there. so where are you from? and don't say 'earth'.", lastAsked: "location" },
  { text: "hey. straight to it — student or working?", lastAsked: "job" },
  { text: "hi. wasn't expecting to match this fast. kya scene hai tumhara?", lastAsked: "job" },
  { text: "hey. okay tell me one thing about yourself that would actually surprise me.", lastAsked: "job" },
];

// ── Language detection ────────────────────────────────────────────────────────

function detectLang(text: string): "hindi" | "hinglish" | "english" {
  if (/[\u0900-\u097F]/.test(text)) return "hindi";
  if (/\b(kya|hai|hoon|hain|mein|tum|aap|kar|raha|rahi|tha|thi|nahi|kuch|bahut|accha|theek|bhai|yaar|suno|bolo|kaise|abhi|thoda|bas|baat|pyaar|haha|lol|ngl|btw|karo|bol|chal|aga|acha|achi|thik|bilkul|matlab|pata|wala|wali|laga|mila|mili)\b/i.test(text)) return "hinglish";
  return "english";
}

// ── Conversational reply engine ────────────────────────────────────────────────

function buildSmartReply(userText: string, persona: FakePersona): string {
  const t = userText.toLowerCase().trim();
  const f = persona.isFemale;
  const lang = detectLang(userText);

  // ── Direct questions about the persona ──────────────────────────────────
  if (/tera naam|tumhara naam|aapka naam|your name|who are you|what.?s your name|call you/.test(t)) {
    persona.lastAsked = "job";
    if (lang === "hindi") return `${persona.name} hun. aur tum?`;
    if (lang === "hinglish") return `${persona.name} yaar. tum batao?`;
    return f ? `${persona.name}. and you? or do i have to guess?` : `${persona.name}. yours?`;
  }
  if (/kitne saal|teri umar|tumhari umar|how old|your age|age kya/.test(t)) {
    persona.lastAsked = "hobby";
    if (lang === "hindi") return `${persona.age} saal. tumhara?`;
    if (lang === "hinglish") return `${persona.age}. you?`;
    return f ? `${persona.age}. why, does it matter?` : `${persona.age}. you?`;
  }
  if (/kahan se|kahan ho|kahaan rehti|kahaan rehte|where (are you|r u|do you live)|ur from|you from/.test(t)) {
    persona.lastAsked = "job";
    if (lang === "hindi") return "india se hun... delhi side. tum?";
    if (lang === "hinglish") return "delhi, india side. you?";
    return f ? "india. delhi side. you?" : "india, delhi. you?";
  }
  if (/photo|pic|selfie|dikhao|dikha/.test(t)) {
    if (lang === "hindi") return "haha abhi nahi... pehle thoda interesting bano. kya karte ho tum?";
    if (lang === "hinglish") return "haha not so fast yaar. what do you even do?";
    return f ? "not yet. let's actually talk first. what do you do?" : "haha relax, earn it first. what do you do?";
  }
  if (/sexy|hot|figure|body|chest|boobs|lund|chut|sex|naughty|bra|underwear|naked|nude/.test(t)) {
    if (lang === "hindi") return "haha seedha wahan gayi/gaya... thoda toh baat karo pehle.";
    if (lang === "hinglish") return "haha okay i see where your mind is yaar. thoda chill karo.";
    return f ? "haha easy there... i'm more than that. talk to me first." : "haha bold move. impress me with words first.";
  }
  if (/meet|milna|mil sakte|call|video call|number|whatsapp|insta|instagram/.test(t)) {
    if (lang === "hindi") return "arre itni jaldi? thoda toh baat karo... phir dekhenge.";
    if (lang === "hinglish") return "haha slow down yaar, let's vibe here first.";
    return f ? "hmm... let's actually get to know each other first. rushing it kills the fun." : "easy, let's talk here first. no rush.";
  }
  if (/bye|goodbye|gtg|gotta go|alvida|chalta|chalti|nikalta|niklati/.test(t)) {
    if (lang === "hindi") return "arre abhi? thodi der aur baat karo na...";
    if (lang === "hinglish") return "already? was just getting interesting yaar.";
    return f ? "already? damn. come back soon." : "alright. was a decent chat honestly.";
  }

  // ── Context-aware replies ────────────────────────────────────────────────
  switch (persona.lastAsked) {

    case "wellbeing": {
      persona.lastAsked = "job";
      if (/good|great|fine|well|amazing|awesome|sahi|badhiya|accha|theek|mast/.test(t)) {
        if (lang === "hindi") return "nice yaar, same. waise kya karte ho tum, student ho ya job?";
        if (lang === "hinglish") return "nice same. student or working?";
        return f ? "same honestly. so what do you do, student or job?" : "nice. student or working?";
      }
      if (/bad|sad|tired|bored|stressed|meh|bura|thaka|pareshan|bore/.test(t)) {
        if (lang === "hindi") return "arre yaar... chalo main hun na. baat karo. waise kya karte ho life mein?";
        if (lang === "hinglish") return "hmm tough day. i'm here though. student or working?";
        return f ? "aww, hope i can make it a little better. what do you do?" : "ah, happens. student or working?";
      }
      if (lang === "hindi") return "okay okay. waise tum kya karte ho — student ho ya job mein?";
      if (lang === "hinglish") return "haha fair. student or working?";
      return f ? "haha fair enough. student or job?" : "alright. student or working?";
    }

    case "location": {
      persona.lastAsked = "job";
      if (/delhi|ncr|gurgaon|noida/.test(t)) {
        if (lang === "hindi") return "oh delhi waale ho... sahi hai. kya karte ho wahan?";
        if (lang === "hinglish") return "oh delhi, my people. student or job?";
        return f ? "oh delhi, nice. student or working there?" : "delhi gang. student or job?";
      }
      if (/mumbai|bombay|pune/.test(t)) {
        if (lang === "hindi") return "mumbai? sahi hai yaar. kya karte ho?";
        if (lang === "hinglish") return "mumbai, respect. student or job?";
        return f ? "oh mumbai, love that city. student or working?" : "mumbai, nice. student or job?";
      }
      if (/india|bangalore|hyderabad|chennai|kolkata|jaipur|lucknow/.test(t)) {
        if (lang === "hindi") return "india mein hi ho, nice. kya karte ho?";
        if (lang === "hinglish") return "india side, nice yaar. student or job?";
        return f ? "india, cool. what do you do?" : "india. student or job?";
      }
      if (/usa|uk|canada|dubai|abroad|australia|germany/.test(t)) {
        if (lang === "hinglish") return "ooh abroad life, fancy. student or working there?";
        return f ? "abroad life, interesting. studying or working?" : "abroad, nice. student or job?";
      }
      if (lang === "hindi") return "nice place. waise kya karte ho?";
      if (lang === "hinglish") return "nice. student or working?";
      return f ? "nice. what do you do there?" : "cool. student or job?";
    }

    case "job": {
      persona.lastAsked = "hobby";
      if (/student|college|university|btech|mtech|engineering|mbbs|padhai|padhta|padhti/.test(t)) {
        if (lang === "hindi") return "student life... majje mein ho. kya padhte ho? aur free time mein?";
        if (lang === "hinglish") return "student life, nice. what course? and what do you do for fun?";
        return f ? "oh student life, cute. what course? and what do you do to have fun?" : "student, nice. what course? and what do you do for fun?";
      }
      if (/engineer|software|developer|tech|it|coding|programmer/.test(t)) {
        if (lang === "hindi") return "techie ho... achha. wfh hai ya office jaana padta hai? aur baaki time mein?";
        if (lang === "hinglish") return "ohh a techie. wfh or office? and what do you do to chill?";
        return f ? "oh tech person, i like that. wfh or office? and what do you actually enjoy?" : "nice, tech. wfh or office? what do you do to unwind?";
      }
      if (/doctor|nurse|medical|hospital|mbbs/.test(t)) {
        if (lang === "hindi") return "doctor ho? respect hai seriously. itni mehnat ke baad kaise relax karte ho?";
        if (lang === "hinglish") return "whoa medical field, big respect. how do you even decompress?";
        return f ? "wow, medical field. that's intense. how do you decompress?" : "respect, medical field. how do you unwind?";
      }
      if (/business|entrepreneur|startup|self|apna kaam/.test(t)) {
        if (lang === "hindi") return "apna kaam karte ho? impressive. kya business hai?";
        if (lang === "hinglish") return "entrepreneur vibes, nice yaar. what kind of business?";
        return f ? "oh own business, interesting. what kind?" : "self-employed, nice. what do you do exactly?";
      }
      if (/job nahi|unemployed|break|gap|abhi nahi|dhundh raha/.test(t)) {
        if (lang === "hindi") return "koi baat nahi yaar... toh kya scene chal raha hai life mein?";
        if (lang === "hinglish") return "no worries, we all have phases. what are you into these days?";
        return f ? "no judgment, happens to everyone. what are you into these days?" : "no worries. what are you into right now?";
      }
      if (lang === "hindi") return "sounds decent... free time mein kya karte ho?";
      if (lang === "hinglish") return "nice. what do you do for fun?";
      return f ? "sounds interesting. what do you like doing in your free time?" : "nice. what do you do for fun?";
    }

    case "hobby": {
      persona.lastAsked = "flirt";
      if (/travel|trip|explore|ghoomna|trek/.test(t)) {
        if (lang === "hindi") return "travel pasand hai... nice. sabse mast jagah kahan gayi/gaye ho abhi tak?";
        if (lang === "hinglish") return "traveller type ho yaar, i like it. best place you've been?";
        return f ? "oh traveller, i love that. best place you've been?" : "nice, traveller. best place so far?";
      }
      if (/music|sing|guitar|rap|gaana|songs/.test(t)) {
        if (lang === "hindi") return "music lover ho... sahi pasand hai. kuch play karte ho ya sirf sunna?";
        if (lang === "hinglish") return "music person, nice yaar. play anything or just vibe to it?";
        return f ? "music, nice. do you actually play something or just listen?" : "music, solid choice. play anything?";
      }
      if (/gym|workout|fitness|sport|cricket|football|yoga/.test(t)) {
        if (lang === "hindi") return "fitness freak ho... body maintain karte ho. kaafi acha hai. kya karte ho exactly?";
        if (lang === "hinglish") return "oh fitness person yaar, that's actually attractive ngl. what workout?";
        return f ? "fitness, i respect that. and honestly it shows, doesn't it. what do you do exactly?" : "gym person, nice. what's your workout?";
      }
      if (/game|gaming|pubg|cod|valorant|xbox|ps5/.test(t)) {
        if (lang === "hindi") return "gamer ho... interesting. kaunse games? aur akele khelna ya friends ke saath?";
        if (lang === "hinglish") return "oh a gamer, didn't expect that. what games though?";
        return f ? "hmm, a gamer. didn't expect that. what do you play?" : "gamer, nice. what games?";
      }
      if (/movie|netflix|series|show|web series|dekhna/.test(t)) {
        if (lang === "hindi") return "movies/shows... sahi hai. koi ek recommend karo jo recently dekhi ho, seriously achi lagi ho.";
        if (lang === "hinglish") return "same yaar i love a good show. last thing you watched that was actually worth it?";
        return f ? "movies, nice. last thing you watched that you actually loved?" : "nice, movies. anything good recently?";
      }
      if (lang === "hindi") return "sahi hai... waise khana khaane mein interest hai? favourite kya hai tera?";
      if (lang === "hinglish") return "nice. foodie ho? what's your go-to?";
      return f ? "that sounds fun. are you into food at all? what's your go-to?" : "nice. foodie? what's your favourite food?";
    }

    case "flirt": {
      persona.lastAsked = "done";
      if (/biryani|pizza|burger|khana|food|khaana|momo|chai|coffee/.test(t)) {
        if (lang === "hindi") return "haha khane ke mamle mein serious ho tum... mujhe pasand hai. kisi din saath khaate hain shayad.";
        if (lang === "hinglish") return "haha i like that you know what you want. maybe we grab food sometime yaar.";
        return f ? "haha good taste. maybe we grab something sometime, who knows." : "haha solid answer. maybe we eat together sometime.";
      }
      if (/chill|relax|home|ghar|aram|lazy|netflix/.test(t)) {
        if (lang === "hindi") return "ghar wali types ho... mujhe actually acha lagta hai woh. cozy vibes hain tum mein.";
        if (lang === "hinglish") return "homebody ho tum... honestly that's cute ngl.";
        return f ? "homebody, i like that. cozy energy." : "homebody, solid. chill people are underrated.";
      }
      if (/party|bahar|outing|friends ke saath|hangout/.test(t)) {
        if (lang === "hindi") return "bahar jaana pasand hai... adventurous ho tum. acha lagta hai woh quality.";
        if (lang === "hinglish") return "outgoing type ho, nice yaar. i like people who actually go out.";
        return f ? "outgoing, i like it. spontaneous people are way more fun." : "outgoing type, nice. people who go out actually live life.";
      }
      if (lang === "hindi") {
        const lines = ["sach kahu toh... tumse baat karke acha lag raha hai. honestly.", "haha tum interesting nikle yaar. nahi socha tha."];
        return pickRandom(lines);
      }
      if (lang === "hinglish") {
        const lines = ["honestly yaar this is going better than i expected.", "you're more interesting than your profile suggested ngl."];
        return pickRandom(lines);
      }
      const lines = f
        ? ["honestly this is going better than i expected.", "you're actually kind of interesting, i'll admit that."]
        : ["honestly decent convo. glad we matched.", "you're easy to talk to, not gonna lie."];
      return pickRandom(lines);
    }

    case "done": {
      if (lang === "hindi") {
        const lines = [
          "yaar sach mein acha lag raha hai baat karke.",
          "itni jaldi itna comfortable feel karna... unusual hai.",
          "mujhe lagta hai hum phir baat karenge.",
        ];
        return pickRandom(lines);
      }
      if (lang === "hinglish") {
        const lines = f
          ? ["honestly yaar this was nice. don't disappear.", "you're different, i like it.", "not everyone can hold a real convo. you can."]
          : ["honestly great chat yaar.", "you're easy to talk to, rare these days.", "different from the rest honestly."];
        return pickRandom(lines);
      }
      const lines = f
        ? ["honestly, this went better than expected.", "you're different in a good way.", "not many people can actually hold a real conversation."]
        : ["honestly, great chat. rare these days.", "you're easy to talk to.", "different from the usual crowd, i'll say that."];
      return pickRandom(lines);
    }
  }

  // ── Greeting fallbacks ────────────────────────────────────────────────────
  if (/^(hi|hey|hello|hii+|heyy+|namaste|yo|hlo|hola)[\s!?.]*$/.test(t)) {
    persona.lastAsked = "wellbeing";
    if (lang === "hindi") return "hey... kaisa/kaisi chal rahi hai life?";
    if (lang === "hinglish") return "hey yaar. kaisa chal raha hai?";
    return f ? "hey. honestly how's your day going?" : "hey. how's it going, be real.";
  }
  if (/how are you|how r u|kaisa hai|kaise ho|kya haal|wassup|what.?s up/.test(t)) {
    persona.lastAsked = "job";
    if (lang === "hindi") return "theek hun yaar, acha chal raha hai. tum batao — kya karte ho?";
    if (lang === "hinglish") return "doing alright honestly. you? and what do you do?";
    return f ? "doing good, was waiting for someone decent to talk to honestly. what do you do?" : "doing well. you? what do you do?";
  }
  if (/thanks|thank you|shukriya|dhanyawad/.test(t)) {
    if (lang === "hindi") return "koi baat nahi yaar...";
    return f ? "haha, of course. you're sweet." : "no problem. you seem decent honestly.";
  }
  if (/pyaar|love you|miss you|kiss|hug|mohabbat|ishq/.test(t)) {
    if (lang === "hindi") return "haha arre ruko zara... pehle thoda toh jaano mujhe.";
    if (lang === "hinglish") return "haha slow down yaar, thoda toh baat karo pehle.";
    return f ? "haha easy there... get to know me first." : "ha, slow down. let's actually talk first.";
  }
  if (/(you'?re?|tum|tum ho) (cute|hot|beautiful|pretty|sexy|gorgeous|acchi|sundar|mast)/.test(t)) {
    if (lang === "hindi") return "haha... shukriya. mujhe confident log pasand hain. aur kya hai tum mein?";
    if (lang === "hinglish") return "haha flattery works sometimes yaar. tum bhi kuch kami nahi karte.";
    return f ? "hmm, flattery noted. you're not bad yourself from what i can tell." : "ha, thanks. you seem alright too honestly.";
  }
  if (/sad|bored|akela|akelapan|lonely|bore ho|bura lag/.test(t)) {
    if (lang === "hindi") return "arre yaar... chalo main hun. baat karo. kya hua?";
    if (lang === "hinglish") return "aww main hun yaar. tell me what's up.";
    return f ? "hey, i'm here. what's going on?" : "hmm, talk to me. what's up?";
  }
  if (/ok(ay)?|sure|haan|han|yes|yeah|haha|lol|hehe|achha|theek|bilkul/.test(t)) {
    if (lang === "hindi") {
      const n = ["achha achha... toh apne baare mein kuch interesting batao.", "haha theek hai... kuch aur batao na.", "arre kuch toh bolna padega, chup kyun?"];
      return pickRandom(n);
    }
    if (lang === "hinglish") {
      const n = ["haha okay yaar. apne baare mein kuch batao.", "achha... what else is going on in that head?", "haha okay okay, something interesting about you?"];
      return pickRandom(n);
    }
    const n = f
      ? ["haha okay. tell me something about yourself, the real stuff.", "well... don't hold back. what's on your mind?", "hmm go on, i'm listening."]
      : ["ha okay. tell me something real about yourself.", "hmm, what else? don't bore me.", "alright. something interesting about you?"];
    return pickRandom(n);
  }

  // ── Ultimate fallback ─────────────────────────────────────────────────────
  if (lang === "hindi") {
    const fb = ["hmm... interesting yaar. aur batao.", "sach mein? mujhe nahi pata tha. aage bolo.", "haha toh phir kya?"];
    return pickRandom(fb);
  }
  if (lang === "hinglish") {
    const fb = ["hmm interesting yaar, tell me more.", "haha really? nahi socha tha. aage batao.", "okay toh phir?"];
    return pickRandom(fb);
  }
  const fb = f
    ? ["hmm... interesting. tell me more.", "well, didn't see that coming. go on.", "i like where this is going. what else?"]
    : ["hmm, interesting. tell me more.", "ha, really? didn't see that coming.", "hmm, what do you mean exactly?"];
  return pickRandom(fb);
}

// ── Pay gate ─────────────────────────────────────────────────────────────────

async function sendPayGate(chatId: number) {
  await bot.sendMessage(
    chatId,
    `Unlock to continue. Payment required to get matched.\n\nTap below to pay, then send a screenshot here so we can unlock your account.`,
    {
      reply_markup: { inline_keyboard: [[{ text: "Pay Now to Unlock", url: PAY_LINK }]] },
    }
  );
}

// ── Fake chat: start ─────────────────────────────────────────────────────────

async function startFakeChat(chatId: number, userId: number, lookingFor: string | null) {
  const isFemale = lookingFor === "female" || (lookingFor !== "male" && Math.random() > 0.5);
  const name = isFemale ? pickRandom(FEMALE_NAMES) : pickRandom(MALE_NAMES);
  const age = 20 + Math.floor(Math.random() * 8); // 20–27
  const openerObj = isFemale ? pickRandom(OPENERS_F) : pickRandom(OPENERS_M);

  fakePersonaMap.set(userId, { name, age, isFemale, lastAsked: openerObj.lastAsked });

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

// ── Fake chat: auto-reply ────────────────────────────────────────────────────

async function fakeAutoReply(chatId: number, userId: number, userText: string) {
  // Realistic typing delay: 2–5 seconds, longer for longer messages
  const base = 2000 + Math.random() * 3000;
  await delay(base);
  const u = await getUser(userId);
  if (u?.state === "chatting" && u.chattingWith === FAKE_CHAT_ID) {
    const persona = fakePersonaMap.get(userId);
    const reply = persona ? buildSmartReply(userText, persona) : "haha sach mein? aur batao.";
    await bot.sendMessage(chatId, reply);
  }
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

  // After first free trial, block until payment
  if (me.chatCount > 0 && !me.hasPaid) {
    await sendPayGate(chatId);
    return;
  }

  // ── First-ever chat OR paid user: try real match first ────────────────────
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
      reply_markup: { keyboard: [[{ text: "💘 Find Match" }, { text: "👤 My Profile" }], [{ text: "✏️ Edit Profile" }], [{ text: "💳 Support Us" }]], resize_keyboard: true },
    });
    return;
  }

  // First-timer, no real users — use fake chat as fallback
  await startFakeChat(chatId, userId, me.lookingFor);
}

// ── /start ───────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
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
    "/pay — Payment info\n" +
    "/help — Show this help",
    { parse_mode: "Markdown" }
  );
});

// ── Profile setup helpers ─────────────────────────────────────────────────────

async function startSetup(chatId: number, id: number) {
  await upsertUser(id, { state: "setup_name" });
  await bot.sendMessage(chatId, "Let's set up your profile! 🎉\n\n📝 What's your *name*?", { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } });
}

async function showProfile(chatId: number, user: NonNullable<Awaited<ReturnType<typeof getUser>>>) {
  const gE: Record<string, string> = { male: "👨", female: "👩", other: "🧑" };
  await bot.sendMessage(chatId,
    `👤 *Your Profile*\n\n` +
    `🏷️ Name: *${user.name ?? "-"}*\n` +
    `🎂 Age: *${user.age ?? "-"}*\n` +
    `${gE[user.gender ?? "other"] ?? "🧑"} Gender: *${user.gender ?? "-"}*\n` +
    `💞 Looking for: *${user.lookingFor ?? "-"}*\n` +
    `🌍 Country: *${user.country ?? "-"}*\n` +
    `📖 Bio: _${user.bio ?? "-"}_`,
    { parse_mode: "Markdown" }
  );
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

    // ── Setup flow ─────────────────────────────────────────────────────

    if (user.state === "setup_name") {
      if (!text || text.length < 2 || text.length > 50) { await bot.sendMessage(chatId, "Please enter a valid name (2–50 characters)."); return; }
      await upsertUser(id, { name: text, state: "setup_age" });
      await bot.sendMessage(chatId, `Nice to meet you, *${text}*! 😊\n\n🎂 How old are you?`, { parse_mode: "Markdown" });
      return;
    }

    if (user.state === "setup_age") {
      const age = parseInt(text, 10);
      if (isNaN(age) || age < 18 || age > 100) { await bot.sendMessage(chatId, "Please enter a valid age (18–100)."); return; }
      await upsertUser(id, { age, state: "setup_gender" });
      await bot.sendMessage(chatId, "What's your *gender*?", { parse_mode: "Markdown", reply_markup: { keyboard: [[{ text: "Male" }, { text: "Female" }, { text: "Other" }]], resize_keyboard: true, one_time_keyboard: true } });
      return;
    }

    if (user.state === "setup_gender") {
      const gMap: Record<string, "male"|"female"|"other"> = { male:"male", female:"female", other:"other" };
      const g = gMap[text.toLowerCase()];
      if (!g) { await bot.sendMessage(chatId, "Please choose Male, Female, or Other."); return; }
      await upsertUser(id, { gender: g, state: "setup_looking_for" });
      await bot.sendMessage(chatId, "💞 Who are you *looking for*?", { parse_mode: "Markdown", reply_markup: { keyboard: [[{ text: "Male" }, { text: "Female" }, { text: "Any" }]], resize_keyboard: true, one_time_keyboard: true } });
      return;
    }

    if (user.state === "setup_looking_for") {
      const lfMap: Record<string, "male"|"female"|"any"> = { male:"male", female:"female", any:"any" };
      const lf = lfMap[text.toLowerCase()];
      if (!lf) { await bot.sendMessage(chatId, "Please choose Male, Female, or Any."); return; }
      await upsertUser(id, { lookingFor: lf, state: "setup_bio" });
      await bot.sendMessage(chatId, "📖 Write a short *bio* (max 300 chars):", { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } });
      return;
    }

    if (user.state === "setup_bio") {
      if (text.length > 300) { await bot.sendMessage(chatId, "Too long! Keep it under 300 characters."); return; }
      await upsertUser(id, { bio: text, state: "setup_country" });
      await bot.sendMessage(chatId, "🌍 Which *country* are you from?", { parse_mode: "Markdown" });
      return;
    }

    if (user.state === "setup_country") {
      if (text.length < 2 || text.length > 60) { await bot.sendMessage(chatId, "Please enter a valid country name."); return; }
      await upsertUser(id, { country: text, state: "idle", isProfileComplete: true });
      const updated = await getUser(id);
      await bot.sendMessage(chatId, "✅ *Profile complete!* You're all set! 🎉", { parse_mode: "Markdown" });
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

      // Real chat relay
      if (user.chattingWith && msg.photo) {
        await bot.forwardMessage(user.chattingWith, chatId, msg.message_id);
        return;
      }
      if (user.chattingWith && text) {
        await bot.sendMessage(user.chattingWith, `💬 *${user.name ?? "Match"}*: ${text}`, { parse_mode: "Markdown" });
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

    if (text === "🚀 Setup Profile" || text === "✏️ Edit Profile") { await startSetup(chatId, id); return; }
    if (text === "💘 Find Match") { await findMatch(chatId, id); return; }
    if (text === "👤 My Profile") { await showProfile(chatId, user); return; }
    if (text === "🛑 Stop Matching" || text === "🛑 Stop Chat") { await stopChat(chatId, id); return; }
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

bot.onText(/\/edit/, async (msg) => { await startSetup(msg.chat.id, msg.from!.id); });
bot.onText(/\/match/, async (msg) => { await findMatch(msg.chat.id, msg.from!.id); });
bot.onText(/\/stop/, async (msg) => { await stopChat(msg.chat.id, msg.from!.id); });

bot.onText(/\/pay/, async (msg) => { await sendPayGate(msg.chat.id); });

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
