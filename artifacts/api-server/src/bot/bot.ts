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
const FREE_CHAT_DURATION_MS = 15 * 1000; // 15 seconds free for all users

export const bot = new TelegramBot(TOKEN, { polling: true });

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

// Short, punchy openers — each ends with ONE clear question
const OPENERS_F: Opener[] = [
  { text: "hii 😊 omg finally! how are you doing?", lastAsked: "wellbeing" },
  { text: "heyy 😍 where are you from btw?", lastAsked: "location" },
  { text: "hi!! so are you a student or working? 😊", lastAsked: "job" },
];
const OPENERS_M: Opener[] = [
  { text: "hey! 😄 how's your day going?", lastAsked: "wellbeing" },
  { text: "hey there 😏 where you from?", lastAsked: "location" },
  { text: "hii 😄 you student or working?", lastAsked: "job" },
];

// ── Advanced multi-turn conversational reply engine ───────────────────────────

function buildSmartReply(userText: string, persona: FakePersona): string {
  const t = userText.toLowerCase().trim();
  const f = persona.isFemale;

  // ── Direct questions asked to the bot ──────────────────────────────────────
  if (/your name|who are you|what.?s your name|call you/.test(t)) {
    persona.lastAsked = "job";
    return `${persona.name} 😊 what about you?`;
  }
  if (/how old|your age|years old/.test(t)) {
    persona.lastAsked = "hobby";
    return `${persona.age} 😊 you?`;
  }
  if (/where (are you|r u|do you live)|which country|ur from|you from/.test(t)) {
    persona.lastAsked = "job";
    return f ? "india 🇮🇳 you?" : "india 🇮🇳 you?";
  }
  if (/photo|pic|picture|selfie/.test(t)) {
    return f ? "haha later maybe 😏 let's talk first! what do you do?" : "ha not yet 😄 talk first. student or working?";
  }
  if (/bye|goodbye|ttyl|gtg|gotta go|see you/.test(t)) {
    return f ? "noo already?? 😢 was really enjoying this 💕" : "aw okay take care 😄 was nice talking!";
  }

  // ── Context-aware replies ────────────────────────────────────────────────
  switch (persona.lastAsked) {

    case "wellbeing": {
      persona.lastAsked = "job";
      if (/good|great|fine|well|amazing|awesome|happy|blessed/.test(t))
        return f ? "aw nice 😊 same! so what do you do — student or working?" : "nice 😄 same! student or working?";
      if (/bad|sad|tired|bored|stressed|not good|meh/.test(t))
        return f ? "aww 🥺 hope talking helps a bit! what do you do btw?" : "ah happens 😕 hope it gets better. student or working?";
      return f ? "haha okay 😄 so student or working?" : "nice 😄 student or working?";
    }

    case "location": {
      persona.lastAsked = "job";
      if (/india|delhi|mumbai|bangalore|hyderabad|chennai|kolkata|pune/.test(t))
        return f ? "oh nice india! 🇮🇳 we just get each other haha. studying or working?" : "fellow indian 😄 nice! student or job?";
      if (/usa|america|uk|canada|australia|dubai|uae|germany|singapore/.test(t))
        return f ? "wow abroad! 😍 that's so cool. studying or working there?" : "oh abroad life 😄 nice! student or working?";
      return f ? "oh nice 😊 so student or working?" : "cool 😄 student or working?";
    }

    case "job": {
      persona.lastAsked = "hobby";
      if (/student|college|university|school|studying|btech|mtech|engineering/.test(t))
        return f ? "aww student life 😊 what course? which year?" : "nice student life 😄 what course?";
      if (/engineer|software|developer|tech|it |coding|programmer/.test(t))
        return f ? "oh techie 😄 honestly attractive haha. wfh or office?" : "nice tech person 😄 wfh or office?";
      if (/doctor|nurse|medical|hospital/.test(t))
        return f ? "wow doctor! 🌟 so impressive. what do you do to relax?" : "medical field 😄 respect. how do you unwind?";
      if (/business|entrepreneur|startup|self.?employ/.test(t))
        return f ? "ooh entrepreneur 😍 what kind of business?" : "own business 😄 what kind?";
      if (/freelanc|design|artist|creative|content/.test(t))
        return f ? "love creative people 🎨 what do you do exactly?" : "creative field 😄 what exactly?";
      if (/not working|unemployed|break|gap/.test(t))
        return f ? "oh okay 😊 totally get it! any hobbies keeping you busy?" : "no worries 😄 what are you into these days?";
      return f ? "sounds cool 😊 what do you like doing in free time?" : "oh nice 😄 hobbies?";
    }

    case "hobby": {
      persona.lastAsked = "food";
      if (/travel|trip|explore|adventure|trek/.test(t))
        return f ? "omg me too!! 🌍 best place you've been?" : "traveller 🌍 nice. best place you've visited?";
      if (/music|sing|guitar|piano|drum|rap/.test(t))
        return f ? "music lover 🎵 do you play or just listen?" : "music is life 🎵 what kind? you play anything?";
      if (/gym|fitness|workout|sport|cricket|football|running|yoga/.test(t))
        return f ? "oh you stay fit 💪 love that! what sport?" : "fitness person 💪 nice! what workout?";
      if (/game|gaming|ps5|xbox|pubg|cod|valorant/.test(t))
        return f ? "ooh gamer 😄 solo or with friends? late nights? 😂" : "gamer 😄 what games? we should play sometime haha";
      if (/movie|film|netflix|series|show/.test(t))
        return f ? "yess movies 🎬 last thing you watched that was actually good?" : "movies/shows 😄 anything good recently?";
      if (/cook|bake|chef|kitchen/.test(t))
        return f ? "you cook?! 😍 honestly so attractive haha. best dish?" : "oh you cook 😄 nice! best dish?";
      return f ? "sounds fun 😊 are you a foodie? fav food?" : "nice 😄 fav food?";
    }

    case "food": {
      persona.lastAsked = "vibe";
      if (/biryani|biriyani/.test(t))
        return f ? "YESSS biryani is literally love 😍🍛 chicken or mutton?" : "biryani gang 🙌 chicken or mutton?";
      if (/pizza/.test(t))
        return f ? "pizza! 🍕 pineapple on pizza — yes or no? 😂" : "pizza 🍕 thin crust or thick?";
      if (/burger|kfc|mcdonalds|fast food/.test(t))
        return f ? "haha fast food fan 😄 no judgment same honestly 🙈" : "fast food 😄 honest lol. same sometimes ngl.";
      return f ? "yumm 😍 okay — perfect weekend for you looks like what?" : "nice 😄 what's a perfect weekend for you?";
    }

    case "vibe": {
      persona.lastAsked = "closing";
      if (/chill|relax|home|sleep|netflix|lazy/.test(t))
        return f ? "same 😄 total homebody sometimes. what are you looking for here btw?" : "same bro 😄 lazy weekends hit different. what are you here for?";
      if (/go out|party|hangout|friends|travel|adventure/.test(t))
        return f ? "oh you like going out! 😄 love spontaneous plans. so what are you looking for here?" : "outing person 😄 nice. what are you on this app for?";
      return f ? "love your vibe 😊 what are you looking for here — serious or just chatting?" : "sounds good 😄 what are you here for — serious thing or just seeing?";
    }

    case "closing": {
      persona.lastAsked = "done";
      if (/serious|relationship|love|partner|long.?term/.test(t))
        return f ? "aww same 🥰 tired of casual stuff. i feel like we could actually vibe 💕" : "yeah same 😄 want something real too. let's see 😊";
      if (/fun|casual|chat|friend|see|open/.test(t))
        return f ? "haha fair 😊 no pressure. let's just enjoy and see 💕" : "ha no pressure 😄 same. let's just vibe!";
      return f ? "haha love the honesty 😊 let's just see what happens 💕" : "fair enough 😄 let's see how it goes!";
    }

    case "done": {
      const lines = f
        ? ["really enjoying this 😊 you're so easy to talk to!", "don't usually vibe this fast haha 💕", "okay i think i like you 😄 genuinely fun!"]
        : ["honestly chill person 😄 glad we matched.", "you're easy to talk to 😊", "don't usually chat this well this quick haha 😄"];
      return pickRandom(lines);
    }
  }

  // ── Fallback keyword handlers ────────────────────────────────────────────

  if (/^(hi|hey|hello|hii+|heyy+|namaste|yo|sup)[\s!?]*$/.test(t)) {
    persona.lastAsked = "wellbeing";
    return f ? "heyy 😊 how are you doing?" : "hey! 😄 how's it going?";
  }
  if (/how are you|how r u|how.?s it|what.?s up|wassup/.test(t)) {
    persona.lastAsked = "job";
    return f ? "great thanks 😊 was waiting for a good convo! what do you do?" : "doing well 😄 you? what do you do?";
  }
  if (/thank|thanks|ty|tq/.test(t))
    return f ? "aww of course 😊 you're sweet!" : "no problem 😄 you seem cool honestly.";
  if (/sad|bad|tired|bored|stressed|upset/.test(t))
    return f ? "aww 🥺 tell me what happened, i'm listening 💕" : "ah man 😕 what's up? i'm listening.";
  if (/love you|miss you|kiss|hug|marry|date me/.test(t))
    return f ? "hahaha slow down!! 😂💕 let me get to know you first!" : "ha easy there 😄 let's talk first! haha.";
  if (/you'?re? (cute|beautiful|hot|pretty|sweet|amazing|lovely)/.test(t))
    return f ? "aww 🥰 you're sweet!" : "ha thanks 😄 that's nice of you!";
  if (/ok(ay)?|sure|yes|yeah|yep|yup|no|nope|nah|haha|lol|hehe/.test(t)) {
    const nudges = f
      ? ["hehe 😊 tell me something interesting about yourself!", "haha okay — what's something fun about you?", "go on 😊 don't be shy!"]
      : ["ha 😄 tell me something random about yourself!", "come on what's something interesting about you? 😄", "haha what else is on your mind?"];
    return pickRandom(nudges);
  }
  if (/wow|omg|really|seriously/.test(t))
    return f ? "haha yes really! 😄 what do you think?" : "ha yeah! 😄 what do you think?";

  // Ultimate fallback
  const fallbacks = f
    ? ["haha tell me more 😊 i'm curious!", "really?? 😄 what made you say that?", "hmm i like how you think! keep going 🤔", "that's cool actually 😍 tell me more!"]
    : ["oh interesting 😄 tell me more.", "ha really? what do you mean?", "that's cool 😊 what made you say that?", "ha i like that 😄 what else?"];
  return pickRandom(fallbacks);
}

// ── Pay gate ─────────────────────────────────────────────────────────────────

async function sendPayGate(chatId: number) {
  await bot.sendMessage(
    chatId,
    `⏰ *Your 15-second free chat is over!*\n\n` +
    `Hope you enjoyed it 😊💕\n\n` +
    `🔒 To keep chatting and connect with real people worldwide, upgrade to *Premium*!\n\n` +
    `👉 Tap the button below to pay, then *send a screenshot* of your payment here so we can unlock your account! 📸`,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "💳 Pay Now to Unlock 🔓", url: PAY_LINK }]] },
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
    `🎉 *Match found!*\n\nYou're now connected with someone special 💞\n\n⏳ *You have 15 seconds of free chat!*\n_Say hello!_ 👋`,
    { parse_mode: "Markdown", reply_markup: { keyboard: [[{ text: "🛑 Stop Chat" }]], resize_keyboard: true } }
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
      await bot.sendMessage(chatId, "⏰ *Time's up!* Your free 15-second chat has ended.", { parse_mode: "Markdown" });
      await sendPayGate(chatId);
    } else if (u && !u.hasPaid) {
      // Chat already ended somehow — still show pay gate
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
      await bot.sendMessage(partnerId, "💔 Your match ended the chat.\n\nTap *Find Match* to meet someone new!", { parse_mode: "Markdown" });
      await sendMain(partnerId, partner);
    }
  }

  const updated = await getUser(userId);
  await bot.sendMessage(chatId, "Chat ended. Hope you had a great time! 💕");
  await sendMain(chatId, updated!);

  if (partnerId === FAKE_CHAT_ID) {
    await delay(600);
    await sendPayGate(chatId);
  }
}

// ── Find eligible real users ──────────────────────────────────────────────────

async function findEligibleUsers(me: NonNullable<Awaited<ReturnType<typeof getUser>>>, userId: number) {
  const candidates = await db.select().from(usersTable).where(eq(usersTable.isProfileComplete, true));
  return candidates.filter((c) => {
    if (c.id === userId || !c.isActive || c.state === "chatting") return false;
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

    await db.update(usersTable)
      .set({ state: "chatting", chattingWith: match.id, chatCount: newCount, updatedAt: new Date() })
      .where(eq(usersTable.id, userId));
    await db.update(usersTable)
      .set({ state: "chatting", chattingWith: userId, updatedAt: new Date() })
      .where(eq(usersTable.id, match.id));

    const stopKb = { keyboard: [[{ text: "🛑 Stop Chat" }]], resize_keyboard: true };
    await bot.sendMessage(chatId,
      me.hasPaid
        ? `🎉 *Match found!*\n\nYou're now chatting with *${match.name}*, ${match.age} 🌍\n\n_Say hello!_ 👋`
        : `🎉 *Match found!*\n\nYou're connected with *${match.name}*, ${match.age} 🌍\n\n⏳ *15-second free chat — make it count!*\n_Say hello!_ 👋`,
      { parse_mode: "Markdown", reply_markup: stopKb }
    );
    await bot.sendMessage(match.id,
      `🎉 *Match found!*\n\nYou're now chatting with *${me.name}*, ${me.age} 🌍\n\n_Say hello!_ 👋`,
      { parse_mode: "Markdown", reply_markup: stopKb }
    );

    // Apply 15-second timer for unpaid first-time users on real chats too
    if (!me.hasPaid) {
      const timer = setTimeout(async () => {
        chatTimerMap.delete(userId);
        const u = await getUser(userId);
        if (u?.state === "chatting" && !u.hasPaid) {
          // Disconnect both users
          await db.update(usersTable)
            .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
            .where(eq(usersTable.id, userId));
          await db.update(usersTable)
            .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
            .where(eq(usersTable.id, match.id));
          await bot.sendMessage(chatId, "⏰ *Time's up!* Your free 15-second chat has ended.", { parse_mode: "Markdown" });
          await bot.sendMessage(match.id, "💔 The other user's free trial ended. Try finding another match!", { parse_mode: "Markdown" });
          await sendMain(match.id, (await getUser(match.id))!);
          await sendPayGate(chatId);
        } else if (u && !u.hasPaid) {
          await sendPayGate(chatId);
        }
      }, FREE_CHAT_DURATION_MS);
      chatTimerMap.set(userId, timer);
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
