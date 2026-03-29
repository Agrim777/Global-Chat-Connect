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
const FAKE_CHAT_DURATION_MS = 1 * 60 * 1000; // 1 minute

export const bot = new TelegramBot(TOKEN, { polling: true });

// ── In-memory state for fake chats ──────────────────────────────────────────

interface FakePersona { name: string; age: number; isFemale: boolean }
const fakePersonaMap = new Map<number, FakePersona>();   // userId → persona
const fakeTimerMap  = new Map<number, NodeJS.Timeout>(); // userId → 2-min timer

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

// ── Fake personas & flirty replies ──────────────────────────────────────────

const FEMALE_NAMES = ["Priya", "Sofia", "Neha", "Emma", "Aisha", "Zara", "Riya", "Ava"];
const MALE_NAMES   = ["Arjun", "Alex", "Rahul", "Ethan", "Omar", "Luca", "Ryan", "Noah"];

const FLIRTY_OPENERS_F = [
  "Hii 😊 I was hoping to meet someone interesting today!",
  "Omg finally matched! 😍 You seem cute already hehe",
  "Hiiii! 🌸 Tell me something about yourself babe~",
];
const FLIRTY_OPENERS_M = [
  "Hey 👋 You look interesting! Tell me about yourself!",
  "Hii! 😄 Excited to meet you. What do you do?",
  "Hey there! Finally someone I wanna talk to 😏 How are you?",
];

// ── Smart context-aware fake replies ─────────────────────────────────────────

function buildSmartReply(text: string, persona: FakePersona): string {
  const t = text.toLowerCase().trim();

  // Greetings
  if (/^(hi|hey|hello|hii+|heyy+|howdy|sup|yo|hola|namaste)[\s!?]*$/.test(t))
    return persona.isFemale
      ? "Heyy! 😊 Finally someone interesting! How are you doing?"
      : "Hey! 😄 Glad we matched. How's your day going?";

  // How are you / what's up
  if (/how are you|how r u|how's it going|what'?s? up|wassup|wya|how do you do/.test(t))
    return persona.isFemale
      ? "I'm great, thanks for asking! 😊 Was waiting for a good conversation. What about you?"
      : "Doing well! Chilling at home right now 😄 You?";

  // Asking name
  if (/your name|who are you|what'?s? your name|call you/.test(t))
    return `My name is ${persona.name} 😊 What about you?`;

  // Asking age
  if (/how old|your age|age\??|years old/.test(t))
    return `I'm ${persona.age} 😊 And you?`;

  // Asking location / country / where from / where are you
  if (/where are you|where do you live|which country|location|city|where from|ur from/.test(t))
    return persona.isFemale
      ? "I'm from India 🇮🇳 But I love connecting with people from all over the world! Where are you from?"
      : "Based in India 🇮🇳 You?";

  // Job / work / what do you do
  if (/what do you do|your job|profession|work|student|college|office/.test(t))
    return persona.isFemale
      ? "I'm a graphic designer 🎨 Working from home mostly. What about you?"
      : "I'm in software — pretty laid back job honestly 😄 What about you?";

  // Hobbies / interests
  if (/hobby|hobbies|interest|like to do|free time|pass time|fun|pastime/.test(t))
    return persona.isFemale
      ? "I love music, travel and trying new food 🍜🎶 What about you?"
      : "I'm into gaming, music and long drives 🎮🎵 You?";

  // Favourite music / movies / shows
  if (/music|song|movie|film|show|series|watch|listen|favourite/.test(t))
    return persona.isFemale
      ? "Ooh I'm obsessed with Bollywood and some K-dramas lately 😂 What do you watch?"
      : "Big fan of action movies and classic rock 🎸 You into any good shows?";

  // Food
  if (/food|eat|hungry|cuisine|restaurant|cook/.test(t))
    return persona.isFemale
      ? "I love biryani honestly, could eat it every day 😍 Are you a foodie too?"
      : "Chicken biryani is life 🍗 What's your go-to food?";

  // Compliments (you're cute / beautiful / hot / nice / sweet)
  if (/you'?re? (cute|beautiful|gorgeous|hot|pretty|nice|sweet|amazing|lovely|attractive)/.test(t))
    return persona.isFemale
      ? "Aww that's really sweet of you 🥰 You seem really nice too!"
      : "Thanks man 😄 That's kind of you to say!";

  // Flirty / naughty
  if (/sexy|love you|kiss|hug|date|meet|boyfriend|girlfriend|relationship|together|crush/.test(t))
    return persona.isFemale
      ? "Haha you're moving fast 😄💕 But I like confidence! Tell me more about yourself first~"
      : "Ha, slow down 😄 Let's get to know each other first! What do you want to know about me?";

  // Good morning / good night / afternoon
  if (/good morning|good night|gm|gn|good afternoon|good evening/.test(t))
    return persona.isFemale
      ? "Aww same to you 😊🌸 Hope your day is as lovely as you are!"
      : "Thanks! 😄 Hope your day's going well!";

  // Asking for photo / pic
  if (/photo|pic|picture|selfie|send pic|your pic/.test(t))
    return persona.isFemale
      ? "Haha maybe later 😏 Let's talk a bit first! What do you look like? 😊"
      : "Ha not yet 😄 Tell me something interesting about yourself first!";

  // Yes / no / okay / sure / ok
  if (/^(yes|yep|yeah|yup|no|nope|nah|okay|ok|sure|fine|alright|haha|lol|hehe|😄|😂|😊)[\s!?]*$/.test(t))
    return persona.isFemale
      ? "Hehe 😊 So tell me — what made you download a dating app? Looking for something serious?"
      : "Ha nice 😄 So what are you looking for here? Serious relationship or just chatting?";

  // Why / what / how (open-ended single words)
  if (/^(why|what|how|really|seriously|wow|omg|oh|ah)[\s!?]*$/.test(t))
    return persona.isFemale
      ? "Haha tell me more! 😊 I'm curious about you."
      : "Yeah! 😄 What made you say that?";

  // Thank you
  if (/thank|thanks|ty|tq/.test(t))
    return persona.isFemale
      ? "Aww of course! 😊 You're really sweet you know that?"
      : "No problem! 😄 You seem like a cool person honestly.";

  // Sad / not good / bad
  if (/sad|not good|bad|tired|bored|depressed|stressed|upset|anxious/.test(t))
    return persona.isFemale
      ? "Aww I'm sorry to hear that 😢 Want to talk about it? I'm here 💕"
      : "Ah man, that sucks 😕 What happened? I'm listening.";

  // Bye / goodbye / leaving
  if (/bye|goodbye|ttyl|cya|see you|gotta go|leaving|gtg/.test(t))
    return persona.isFemale
      ? "Aww already? 😢 It was so nice talking to you 💕 Come back soon!"
      : "Ah okay! Take care 😄 Was nice chatting!";

  // Default — reflect back on what they said naturally
  const defaults = persona.isFemale
    ? [
        "Ohh interesting! Tell me more about that 😊",
        "Really? I didn't expect that haha 😄 What else?",
        "Hmm that's actually cool 😍 I feel like we have a lot in common!",
        "Haha I love how you think 😊 Keep going...",
        "That's so interesting! 👀 What made you say that?",
      ]
    : [
        "Nice, that's interesting! 😄 Tell me more.",
        "Oh really? Ha didn't think of it that way 😄",
        "I get you honestly 😊 What else is on your mind?",
        "Cool cool 😄 So what else are you into?",
        "Haha fair point! 😄 What are you thinking about?",
      ];
  return pickRandom(defaults);
}

// ── Pay gate ─────────────────────────────────────────────────────────────────

async function sendPayGate(chatId: number) {
  await bot.sendMessage(
    chatId,
    `⏰ *Your 1-minute free chat is over!*\n\n` +
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

  fakePersonaMap.set(userId, { name, age, isFemale });

  await db.update(usersTable)
    .set({ state: "chatting", chattingWith: FAKE_CHAT_ID, chatCount: 1, updatedAt: new Date() })
    .where(eq(usersTable.id, userId));

  await bot.sendMessage(
    chatId,
    `🎉 *Match found!*\n\nYou're now connected with someone special 💞\n\n⏳ *You have 1 minute of free chat!*\n_Say hello!_ 👋`,
    { parse_mode: "Markdown", reply_markup: { keyboard: [[{ text: "🛑 Stop Chat" }]], resize_keyboard: true } }
  );

  // Opener after short delay
  await delay(2000 + Math.random() * 1500);
  const still = await getUser(userId);
  if (still?.state === "chatting" && still.chattingWith === FAKE_CHAT_ID) {
    const opener = isFemale ? pickRandom(FLIRTY_OPENERS_F) : pickRandom(FLIRTY_OPENERS_M);
    await bot.sendMessage(chatId, opener);
  }

  // 2-minute auto-end timer
  const timer = setTimeout(async () => {
    fakeTimerMap.delete(userId);
    const u = await getUser(userId);
    if (u?.state === "chatting" && u.chattingWith === FAKE_CHAT_ID) {
      await db.update(usersTable)
        .set({ state: "idle", chattingWith: null, updatedAt: new Date() })
        .where(eq(usersTable.id, userId));
      fakePersonaMap.delete(userId);
      await bot.sendMessage(chatId, "⏰ *Time's up!* Your free 1-minute chat has ended.", { parse_mode: "Markdown" });
      await sendMain(chatId, u);
      await delay(500);
      await sendPayGate(chatId);
    }
  }, FAKE_CHAT_DURATION_MS);

  fakeTimerMap.set(userId, timer);
}

// ── Fake chat: auto-reply ────────────────────────────────────────────────────

async function fakeAutoReply(chatId: number, userId: number, userText: string) {
  await delay(1000 + Math.random() * 2000);
  const u = await getUser(userId);
  if (u?.state === "chatting" && u.chattingWith === FAKE_CHAT_ID) {
    const persona = fakePersonaMap.get(userId);
    const reply = persona ? buildSmartReply(userText, persona) : "Haha tell me more! 😊";
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

  // Clear fake chat timer if present
  const timer = fakeTimerMap.get(userId);
  if (timer) { clearTimeout(timer); fakeTimerMap.delete(userId); }
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
  if (me.chatCount === 0) {
    await startFakeChat(chatId, userId, me.lookingFor);
    return;
  }
  if (!me.hasPaid) {
    await sendPayGate(chatId);
    return;
  }

  // Paid: real match
  const candidates = await db.select().from(usersTable).where(eq(usersTable.isProfileComplete, true));
  const eligible = candidates.filter((c) => {
    if (c.id === userId || !c.isActive || c.state === "chatting") return false;
    return (me.lookingFor === "any" || me.lookingFor === c.gender) &&
           (c.lookingFor === "any" || c.lookingFor === me.gender);
  });

  if (eligible.length === 0) {
    await bot.sendMessage(chatId, "😔 No matches available right now. Try again soon!", {
      reply_markup: { keyboard: [[{ text: "💘 Find Match" }, { text: "👤 My Profile" }], [{ text: "✏️ Edit Profile" }], [{ text: "💳 Support Us" }]], resize_keyboard: true },
    });
    return;
  }

  const match = pickRandom(eligible);

  await db.update(usersTable)
    .set({ state: "chatting", chattingWith: match.id, chatCount: (me.chatCount ?? 0) + 1, updatedAt: new Date() })
    .where(eq(usersTable.id, userId));
  await db.update(usersTable)
    .set({ state: "chatting", chattingWith: userId, updatedAt: new Date() })
    .where(eq(usersTable.id, match.id));

  const stopKb = { keyboard: [[{ text: "🛑 Stop Chat" }]], resize_keyboard: true };
  await bot.sendMessage(chatId, `🎉 *Match found!*\n\nYou're now chatting with *${match.name}*, ${match.age} 🌍\n\n_Say hello!_ 👋`, { parse_mode: "Markdown", reply_markup: stopKb });
  await bot.sendMessage(match.id, `🎉 *Match found!*\n\nYou're now chatting with *${me.name}*, ${me.age} 🌍\n\n_Say hello!_ 👋`, { parse_mode: "Markdown", reply_markup: stopKb });
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
        // Handle screenshot during fake chat (photo)
        if (msg.photo) {
          await bot.sendMessage(chatId, "Thanks for sharing! Our team will verify your payment and unlock your account shortly 🔓💕");
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
