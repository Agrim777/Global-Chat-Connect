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

const FEMALE_NAMES = ["Priya", "Sofia", "Neha", "Emma", "Aisha", "Zara", "Riya", "Ava"];
const MALE_NAMES   = ["Arjun", "Alex", "Rahul", "Ethan", "Omar", "Luca", "Ryan", "Noah"];

interface Opener { text: string; lastAsked: string }

// No emojis, casual and direct openers
const OPENERS_F: Opener[] = [
  { text: "hey, finally someone interesting. how's your day been so far?", lastAsked: "wellbeing" },
  { text: "hi... okay this is a bit random but, where are you from?", lastAsked: "location" },
  { text: "hey, so... student or working? i always start with that, don't judge me.", lastAsked: "job" },
];
const OPENERS_M: Opener[] = [
  { text: "hey, how's it going? be honest.", lastAsked: "wellbeing" },
  { text: "hey there. so where are you from, originally?", lastAsked: "location" },
  { text: "hey. student or working? what's your deal?", lastAsked: "job" },
];

// ── Language detection ────────────────────────────────────────────────────────

function detectLang(text: string): "hindi" | "hinglish" | "english" {
  if (/[\u0900-\u097F]/.test(text)) return "hindi";
  if (/\b(kya|hai|hoon|hain|mein|tum|aap|kar|raha|rahi|tha|thi|nahi|kuch|bahut|accha|theek|bhai|yaar|suno|bolo|kaise|abhi|thoda|bas|baat|pyaar|haha|lol|ngl|btw|karo|bol|chal|aga|acha|achi|thik|bilkul|matlab|pata|wala|wali|laga|mila|mili)\b/i.test(text)) return "hinglish";
  return "english";
}

// ── Conversational reply engine (no emojis, human fillers, language-aware) ────

function buildSmartReply(userText: string, persona: FakePersona): string {
  const t = userText.toLowerCase().trim();
  const f = persona.isFemale;
  const lang = detectLang(userText);

  // ── Questions directed at the persona ────────────────────────────────────
  if (/your name|who are you|what.?s your name|call you|tumhara naam|aapka naam|tera naam/.test(t)) {
    persona.lastAsked = "job";
    if (lang === "hindi") return `${persona.name} hun. tumhara?`;
    if (lang === "hinglish") return `${persona.name}. you?`;
    return f ? `${persona.name}. what about you, do you have one of those too?` : `${persona.name}. yours?`;
  }
  if (/how old|your age|years old|kitne saal|teri umar|tumhari umar/.test(t)) {
    persona.lastAsked = "hobby";
    if (lang === "hindi") return `${persona.age} ka hun. tumhara?`;
    if (lang === "hinglish") return `${persona.age}. you?`;
    return `${persona.age}. you?`;
  }
  if (/where (are you|r u|do you live)|which country|ur from|you from|kahan se|kahan ho|kahaan/.test(t)) {
    persona.lastAsked = "job";
    if (lang === "hindi") return "india se hun. tum?";
    if (lang === "hinglish") return "india, you know. you?";
    return f ? "well... india, originally. you?" : "india. you?";
  }
  if (/photo|pic|picture|selfie/.test(t)) {
    if (lang === "hindi") return "haha abhi nahi yaar... pehle thoda baat karte hain. tum kya karte ho?";
    if (lang === "hinglish") return "haha not yet, let's talk a bit first. student or working?";
    return f ? "hmm... maybe later. let's actually talk first. what do you do?" : "not yet, let's talk a bit first. what's your deal?";
  }
  if (/bye|goodbye|ttyl|gtg|gotta go|see you|alvida|chalta|chalti/.test(t)) {
    if (lang === "hindi") return "arre abhi? thoda aur baat karo na...";
    if (lang === "hinglish") return "aw already? was actually getting interesting.";
    return f ? "already? that was just getting interesting." : "alright, take care. was a decent conversation.";
  }

  // ── Context-aware: respond to what bot last asked ─────────────────────────
  switch (persona.lastAsked) {

    case "wellbeing": {
      persona.lastAsked = "job";
      if (/good|great|fine|well|amazing|awesome|happy|blessed|sahi|badhiya|accha|theek/.test(t)) {
        if (lang === "hindi") return "accha, same yaar... waise tum kya karte ho, student ho ya job?";
        if (lang === "hinglish") return "nice, same. so student or working?";
        return f ? "well, same honestly. so what do you do, student or working?" : "nice, same here. student or working?";
      }
      if (/bad|sad|tired|bored|stressed|not good|meh|bura|thaka|pareshan/.test(t)) {
        if (lang === "hindi") return "arre... umeed hai baat karne se thoda better lage. waise kya karte ho?";
        if (lang === "hinglish") return "hmm... hope this helps a bit. student or job?";
        return f ? "hmm... hope talking helps a little. what do you do anyway?" : "ah, that happens. student or working?";
      }
      if (lang === "hindi") return "okay, theek hai. tum student ho ya job karte ho?";
      if (lang === "hinglish") return "haha okay. student or working?";
      return f ? "haha okay, fair enough. student or working?" : "alright. student or working?";
    }

    case "location": {
      persona.lastAsked = "job";
      if (/india|delhi|mumbai|bangalore|hyderabad|chennai|kolkata|pune|lucknow|jaipur/.test(t)) {
        if (lang === "hindi") return "oh india se ho, nice... tum kya karte ho wahan?";
        if (lang === "hinglish") return "oh india, nice. student or job?";
        return f ? "oh india, nice. so what do you do there, student or working?" : "oh india. student or working?";
      }
      if (/usa|america|uk|canada|australia|dubai|uae|germany|singapore|london/.test(t)) {
        if (lang === "hinglish") return "oh abroad life, nice yaar. student or working there?";
        return f ? "well, abroad life. that's interesting actually. studying or working there?" : "oh abroad. student or working?";
      }
      if (lang === "hindi") return "oh nice... tum student ho ya kuch karte ho?";
      if (lang === "hinglish") return "oh nice. student or working?";
      return f ? "oh nice, interesting. so student or working?" : "cool. student or working?";
    }

    case "job": {
      persona.lastAsked = "hobby";
      if (/student|college|university|school|studying|btech|mtech|engineering|mbbs|padhai/.test(t)) {
        if (lang === "hindi") return "ooh student life... kya padhte ho? aur free time mein kya karte ho?";
        if (lang === "hinglish") return "nice, student life. what course? and hobbies?";
        return f ? "oh student life, you know i kind of miss that. what are you studying?" : "nice, student life. what course?";
      }
      if (/engineer|software|developer|tech|it |coding|programmer/.test(t)) {
        if (lang === "hindi") return "oh tech field... honest rehna, wfh hai ya office? aur off time mein kya?";
        if (lang === "hinglish") return "hmm techie. wfh or office? what do you do to unwind?";
        return f ? "hmm... tech person. wfh or office? and what do you actually enjoy outside work?" : "nice, tech. wfh or office?";
      }
      if (/doctor|nurse|medical|hospital/.test(t)) {
        if (lang === "hinglish") return "wow medical field, respect. how do you even unwind after all that?";
        return f ? "well, a doctor... that's honestly quite something. how do you decompress?" : "medical field, respect. how do you unwind?";
      }
      if (/business|entrepreneur|startup|self.?employ/.test(t)) {
        if (lang === "hinglish") return "ooh entrepreneur, nice yaar. what kind of business?";
        return f ? "hmm, entrepreneur... i have to ask, what kind of business?" : "own business, nice. what kind?";
      }
      if (/not working|unemployed|break|gap|abhi nahi|job nahi/.test(t)) {
        if (lang === "hindi") return "koi baat nahi yaar... toh fir kya chal raha hai life mein?";
        if (lang === "hinglish") return "no worries, what are you into these days then?";
        return f ? "oh okay, that's fine. what are you into these days then?" : "no worries. what are you into these days?";
      }
      if (lang === "hindi") return "sounds interesting... free time mein kya pasand hai?";
      if (lang === "hinglish") return "nice. hobbies?";
      return f ? "sounds interesting, you know. what do you like doing in your free time?" : "nice. what do you do in your free time?";
    }

    case "hobby": {
      persona.lastAsked = "food";
      if (/travel|trip|explore|adventure|trek|ghoomna/.test(t)) {
        if (lang === "hindi") return "yaar mujhe bhi travel bahut pasand hai... sabse acchi jagah kahan gayi/gaye ho abhi tak?";
        if (lang === "hinglish") return "same yaar i love travelling. best place you've been?";
        return f ? "oh same actually, i love that. best place you've been so far?" : "traveller, nice. best place?";
      }
      if (/music|sing|guitar|piano|drum|rap|gaana/.test(t)) {
        if (lang === "hindi") return "music... you know, sahi pasand hai. play karte ho kuch ya sirf sunna?";
        if (lang === "hinglish") return "music is life honestly. do you play anything or just listen?";
        return f ? "hmm, music... do you actually play something or just listen?" : "music, solid. play anything?";
      }
      if (/gym|fitness|workout|sport|cricket|football|running|yoga|exercise/.test(t)) {
        if (lang === "hindi") return "oh fitness... respect hai. kya karte ho exactly?";
        if (lang === "hinglish") return "oh fitness person, nice. what workout or sport?";
        return f ? "well, staying fit... i respect that honestly. what sport or workout?" : "fitness, nice. what workout?";
      }
      if (/game|gaming|ps5|xbox|pubg|cod|valorant|khelta|khelti/.test(t)) {
        if (lang === "hinglish") return "oh gamer, nice yaar. what games? solo ya friends ke saath?";
        return f ? "hmm, a gamer... solo or with friends mostly?" : "gamer, nice. what games?";
      }
      if (/movie|film|netflix|series|show|dekhna/.test(t)) {
        if (lang === "hindi") return "movies/shows... haan sahi hai. koi ek recommend karo jo recently dekhi ho?";
        if (lang === "hinglish") return "nice, movies. last thing you watched that was actually good?";
        return f ? "oh movies, you know i'm always looking for something good. last thing you watched that stuck with you?" : "movies, nice. anything good recently?";
      }
      if (lang === "hindi") return "sounds fun... khaana khaane mein interest hai? favourite kya hai?";
      if (lang === "hinglish") return "nice. are you a foodie? what's your go-to?";
      return f ? "that sounds fun, honestly. are you into food at all, what's your go-to?" : "nice. foodie? what's your favourite?";
    }

    case "food": {
      persona.lastAsked = "vibe";
      if (/biryani|biriyani/.test(t)) {
        if (lang === "hindi") return "yaar biryani toh life hai seriously... chicken ya mutton?";
        if (lang === "hinglish") return "biryani gang, i respect it. chicken or mutton?";
        return f ? "well, biryani is basically a personality trait at this point. chicken or mutton?" : "biryani, solid. chicken or mutton?";
      }
      if (/pizza/.test(t)) {
        if (lang === "hinglish") return "pizza nice. okay controversial — pineapple on pizza, yes or no?";
        return f ? "pizza... okay i have to ask, pineapple on pizza yes or no?" : "pizza. thin crust or thick?";
      }
      if (/burger|kfc|mcdonalds|fast food/.test(t)) {
        if (lang === "hinglish") return "haha fast food, no judgment yaar, same honestly.";
        return f ? "haha fast food, no judgment, honestly same sometimes." : "fast food, honest. same sometimes ngl.";
      }
      if (lang === "hindi") return "yum sahi... waise weekends mein kya karna pasand hai tujhe?";
      if (lang === "hinglish") return "nice. so what's a perfect weekend for you?";
      return f ? "hmm yum, honestly. okay so what does a perfect weekend look like for you?" : "sounds good. perfect weekend, what's that for you?";
    }

    case "vibe": {
      persona.lastAsked = "closing";
      if (/chill|relax|home|sleep|netflix|lazy|ghar|aram/.test(t)) {
        if (lang === "hindi") return "same yaar... main bhi homebody hun kabhi kabhi. waise yahan kya dhundh rahe ho?";
        if (lang === "hinglish") return "same yaar, lazy weekends hit different. what are you looking for here btw?";
        return f ? "same, honestly. i'm a bit of a homebody too. so what are you actually looking for here?" : "same, lazy weekends are underrated. what are you here for?";
      }
      if (/go out|party|hangout|friends|travel|adventure|bahar/.test(t)) {
        if (lang === "hindi") return "oh bahar jaana pasand hai... nice. yahan kya dhundh rahe ho serious mein?";
        if (lang === "hinglish") return "oh outing person, nice yaar. so what are you on this app for?";
        return f ? "oh you like going out, nice. so what are you actually looking for here?" : "outing person, nice. what are you here for?";
      }
      if (lang === "hindi") return "sounds nice... yahan kya dhundh rahe ho — serious kuch ya bas baat?";
      if (lang === "hinglish") return "nice vibe. what are you here for though — serious or just talking?";
      return f ? "hmm, nice. so what are you actually looking for here, something serious or just talking?" : "sounds good. what are you here for, serious or just seeing?";
    }

    case "closing": {
      persona.lastAsked = "done";
      if (/serious|relationship|love|partner|long.?term|settle|shaadi|rishta/.test(t)) {
        if (lang === "hindi") return "yaar same... casual se thak gaya/gayi hun. kuch real chahiye. lagta hai hum vibe karte hain.";
        if (lang === "hinglish") return "hmm same yaar, tired of casual stuff. feel like we could actually vibe.";
        return f ? "hmm, same actually. i'm tired of casual stuff, you know. feel like we could actually vibe." : "yeah same, want something real. let's see how this goes.";
      }
      if (/fun|casual|chat|friend|see|open|timepass/.test(t)) {
        if (lang === "hindi") return "haha fair baat hai... koi pressure nahi. dekhte hain kahan jaata hai.";
        if (lang === "hinglish") return "haha fair yaar, no pressure. let's just see.";
        return f ? "haha fair, no pressure at all. let's just see where it goes." : "fair enough, no pressure. let's just see.";
      }
      if (lang === "hindi") return "haha honest rehna pasand hai... dekhte hain yaar.";
      if (lang === "hinglish") return "haha i like the honesty. let's see.";
      return f ? "haha well, i like that you're honest. let's just see what happens." : "fair enough. let's see how it goes.";
    }

    case "done": {
      if (lang === "hindi") {
        const lines = ["yaar honestly bahut acchi baat ho rahi hai, sach mein.", "itni jaldi vibe karna... nahi hota usually.", "okay tum interesting ho, main admit karta/karti hun."];
        return pickRandom(lines);
      }
      if (lang === "hinglish") {
        const lines = f
          ? ["yaar honestly this is going well. not complaining.", "don't usually vibe this fast ngl.", "okay you're actually interesting, i'll admit it."]
          : ["honestly decent convo, glad we matched.", "you're easy to talk to ngl.", "don't usually chat this well this quick."];
        return pickRandom(lines);
      }
      const lines = f
        ? ["well... honestly this is going better than i expected.", "hmm, you know i don't usually vibe this fast.", "okay i'll admit, you're actually interesting."]
        : ["honestly decent conversation, glad we matched.", "you're easy to talk to, not gonna lie.", "hmm, don't usually chat this well this quickly."];
      return pickRandom(lines);
    }
  }

  // ── Fallback: handle greetings, reactions, common phrases ────────────────

  if (/^(hi|hey|hello|hii+|heyy+|namaste|yo|sup|hlo|hola)[\s!?.]*$/.test(t)) {
    persona.lastAsked = "wellbeing";
    if (lang === "hindi") return "hey... kaisa chal raha hai?";
    if (lang === "hinglish") return "hey. how's it going?";
    return f ? "hey. how's your day going, honestly?" : "hey. how's it going?";
  }
  if (/how are you|how r u|how.?s it|what.?s up|wassup|kaisa hai|kaise ho|kya haal/.test(t)) {
    persona.lastAsked = "job";
    if (lang === "hindi") return "theek hun yaar, acha chal raha hai. tum batao, kya karte ho?";
    if (lang === "hinglish") return "doing well honestly. you? and what do you do?";
    return f ? "well, doing pretty good honestly. was waiting for a decent conversation. what do you do?" : "doing well. you? what do you do?";
  }
  if (/thank|thanks|ty|tq|shukriya|dhanyawad/.test(t)) {
    if (lang === "hindi") return "arre yaar koi baat nahi...";
    return f ? "haha, of course. you're sweet." : "no problem. you seem alright honestly.";
  }
  if (/sad|bad|tired|bored|stressed|upset|dukhi|pareshan|thaka/.test(t)) {
    if (lang === "hindi") return "yaar kya hua? bata, sun raha/rahi hun.";
    if (lang === "hinglish") return "hmm what's up? i'm listening.";
    return f ? "hmm... tell me what happened, i'm listening." : "ah, what's going on? i'm listening.";
  }
  if (/love you|miss you|kiss|hug|marry|date me|pyaar|mohabbat/.test(t)) {
    if (lang === "hindi") return "haha arre ruko zara... pehle thoda baat toh karo.";
    if (lang === "hinglish") return "haha slow down yaar, let's talk first.";
    return f ? "hahaha slow down... let me actually get to know you first." : "ha, easy there. let's talk first.";
  }
  if (/you'?re? (cute|beautiful|hot|pretty|sweet|amazing|lovely|acchi|achi|sundar)/.test(t)) {
    if (lang === "hindi") return "haha shukriya... tum bhi kuch kum nahi ho.";
    if (lang === "hinglish") return "haha thanks yaar, that's sweet.";
    return f ? "hmm, that's sweet of you. don't stop." : "ha, thanks. that's kind of you to say.";
  }
  if (/ok(ay)?|sure|yes|yeah|yep|yup|no|nope|nah|haha|lol|hehe|achha|theek|han|haan/.test(t)) {
    if (lang === "hindi") {
      const n = ["haha okay... toh apne baare mein kuch interesting batao.", "achha achha... kuch aur bolo.", "haha theek hai, aage batao."];
      return pickRandom(n);
    }
    if (lang === "hinglish") {
      const n = ["haha okay yaar. tell me something random about yourself.", "achha... what else is on your mind?", "haha okay okay. something interesting about you?"];
      return pickRandom(n);
    }
    const n = f
      ? ["haha okay. tell me something interesting about yourself.", "well... go on, don't be shy.", "hmm okay, what else is on your mind?"]
      : ["ha okay. tell me something random about yourself.", "hmm, what else? i'm curious.", "haha alright. what's something interesting about you?"];
    return pickRandom(n);
  }

  // Ultimate fallback — always respond to what they said
  if (lang === "hindi") {
    const fb = ["hmm... interesting, aur batao.", "yaar sach mein? woh unexpected tha.", "haha toh phir?"];
    return pickRandom(fb);
  }
  if (lang === "hinglish") {
    const fb = ["hmm interesting yaar, tell me more.", "haha really? didn't expect that.", "okay toh phir what?"];
    return pickRandom(fb);
  }
  const fb = f
    ? ["hmm... that's interesting, tell me more.", "well, i didn't expect that. go on.", "hmm i like how you think. what else?"]
    : ["hmm, interesting. tell me more.", "ha really? didn't see that coming.", "hmm, what do you mean exactly?"];
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
  // Short typing delay — feels natural within 15s window
  await delay(700 + Math.random() * 1000);
  const u = await getUser(userId);
  if (u?.state === "chatting" && u.chattingWith === FAKE_CHAT_ID) {
    const persona = fakePersonaMap.get(userId);
    const reply = persona ? buildSmartReply(userText, persona) : "haha tell me more! 😊";
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
  const candidates = await db.select().from(usersTable).where(eq(usersTable.isProfileComplete, true));
  return candidates.filter((c) => {
    if (c.id === userId || !c.isActive || c.state === "chatting") return false;
    // Exclude unpaid users who have already used their free trial — they must pay first
    if ((c.chatCount ?? 0) > 0 && !c.hasPaid) return false;
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
