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

interface FakePersona { name: string; age: number; isFemale: boolean; lastAsked: string }
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

// ── Fake personas ─────────────────────────────────────────────────────────────

const FEMALE_NAMES = ["Priya", "Sofia", "Neha", "Emma", "Aisha", "Zara", "Riya", "Ava"];
const MALE_NAMES   = ["Arjun", "Alex", "Rahul", "Ethan", "Omar", "Luca", "Ryan", "Noah"];

// Each opener ends with a clear question so we know what to expect back
interface Opener { text: string; lastAsked: string }

const OPENERS_F: Opener[] = [
  { text: "Hii 😊 Finally someone interesting! How are you doing today?", lastAsked: "wellbeing" },
  { text: "Omg hi! 😍 I love meeting new people. So tell me — where are you from? 🌍", lastAsked: "location" },
  { text: "Hiiii! 🌸 So excited to match! Quick question — student or working?", lastAsked: "job" },
];
const OPENERS_M: Opener[] = [
  { text: "Hey! 😄 Glad we matched. How's your day going so far?", lastAsked: "wellbeing" },
  { text: "Hey there! 😏 I'm curious — where are you from?", lastAsked: "location" },
  { text: "Hii! 😄 Nice to meet you. So what do you do — student or job?", lastAsked: "job" },
];

// ── Advanced multi-turn conversational reply engine ───────────────────────────

function buildSmartReply(userText: string, persona: FakePersona): string {
  const t = userText.toLowerCase().trim();
  const f = persona.isFemale;

  // ── Hard-override questions user might ask the bot directly ──
  if (/your name|who are you|what.?s your name|call you/.test(t)) {
    persona.lastAsked = "job";
    return `My name is ${persona.name} 😊 And you? What's yours?`;
  }
  if (/how old|your age|years old/.test(t)) {
    persona.lastAsked = "hobby";
    return `I'm ${persona.age} 😊 What about you?`;
  }
  if (/where (are you|r u|do you live)|which country|ur from|you from/.test(t)) {
    persona.lastAsked = "job";
    return f
      ? "I'm from India 🇮🇳 Love meeting people from everywhere though! And you — where are you from?"
      : "Based in India 🇮🇳 You?";
  }
  if (/photo|pic|picture|selfie/.test(t)) {
    return f
      ? "Haha maybe in a bit 😏 Let's get to know each other first! Tell me more about yourself 😊"
      : "Ha not yet! 😄 Let's talk a little first. What do you do for work?";
  }
  if (/bye|goodbye|ttyl|gtg|gotta go|see you/.test(t)) {
    return f ? "Aww already?? 😢 I was really enjoying this 💕 Don't disappear okay!" : "Aw okay, take care! 😄 Was nice meeting you.";
  }

  // ── Context-aware: respond to what the bot last asked ────────────────────
  switch (persona.lastAsked) {

    case "wellbeing": {
      persona.lastAsked = "job";
      if (/good|great|fine|well|amazing|awesome|fantastic|happy|blessed/.test(t))
        return f
          ? "That's so good to hear! 😊 I love positive energy. So tell me — what do you do? Student or working?"
          : "Nice nice 😄 Same here. So are you a student or working?";
      if (/bad|sad|tired|bored|stressed|not good|okay ish|meh|so so/.test(t))
        return f
          ? "Aww I'm sorry 🥺 Hopefully talking to me makes it a little better! What do you do by the way?"
          : "Ah that happens man 😕 Hope the day gets better. What are you up to — student or working?";
      // didn't match wellbeing words, still redirect
      return f
        ? "Haha okay 😄 So tell me more! Are you a student or working?"
        : "Nice! 😄 So what do you do — student or job?";
    }

    case "location": {
      persona.lastAsked = "job";
      // Detect if they mention a country/city
      if (/india|delhi|mumbai|bangalore|hyderabad|chennai|kolkata|pune/.test(t))
        return f
          ? "Oh nice, India! 🇮🇳 I love connecting with Indians, we just get each other haha 😊 So what do you do — studying or working?"
          : "Oh cool fellow Indian! 😄 Nice. So student or job?";
      if (/usa|america|uk|canada|australia|dubai|uae|germany|singapore/.test(t))
        return f
          ? "Oh wow, abroad! 😍 That's so cool, I've always wanted to travel more. What do you do there — studying or working?"
          : "Oh nice, abroad life! 😄 What are you doing there — studying or working?";
      return f
        ? "Oh nice! 😊 I love people from different places. So are you a student or working?"
        : "Cool! 😄 Nice place. So student or working?";
    }

    case "job": {
      persona.lastAsked = "hobby";
      if (/student|college|university|school|studying|btech|mtech|engineering|mbbs/.test(t))
        return f
          ? "Aww a student! 😊 I love that — what are you studying? And which year?"
          : "Oh nice, student life! 😄 What course? And final year or still in between?";
      if (/engineer|software|developer|tech|it |coding|programmer/.test(t))
        return f
          ? "Oh a techie! 😄 That's honestly so attractive haha. Do you work from home or office? And what do you like doing outside work?"
          : "Fellow tech person here 😄 Nice! WFH or office? What do you do to unwind?";
      if (/doctor|nurse|medical|mbbs|hospital|health/.test(t))
        return f
          ? "Wow a doctor! 🌟 That's so impressive. You must be really dedicated. What do you do to relax after long shifts?"
          : "Oh wow, medical field! 😄 Respect. What do you do to decompress after work?";
      if (/teacher|professor|lecture/.test(t))
        return f
          ? "Aww a teacher! 😊 That's such a noble job honestly. What subject? And what do you do in your free time?"
          : "A teacher! 😄 Respect bro. What subject and what do you like doing outside work?";
      if (/business|entrepreneur|startup|own|company|self.?employ/.test(t))
        return f
          ? "Ooh an entrepreneur! 😍 That's honestly so attractive. What kind of business? Tell me everything!"
          : "Oh nice, own business! 😄 What kind? That's pretty cool honestly.";
      if (/freelanc|design|artist|creative|content|influencer/.test(t))
        return f
          ? "Oh I love creative people! 🎨 What kind of work do you do? And is it your passion or just a job?"
          : "Oh creative field! 😄 Nice. What exactly do you do?";
      if (/not working|unemployed|looking|break|gap/.test(t))
        return f
          ? "Oh okay, totally understand 😊 Sometimes a break is needed! What are you into these days then — any hobbies?"
          : "No worries man 😄 Everyone needs a reset. What are you into these days?";
      return f
        ? "That's interesting! 😊 Sounds like you stay busy! What do you like doing when you're not working?"
        : "Oh cool! 😄 So what do you like doing in your free time?";
    }

    case "hobby": {
      persona.lastAsked = "food";
      if (/travel|trip|explore|adventure|trek|backpack/.test(t))
        return f
          ? "Omg I love travelling too! 🌍 Where's the best place you've visited? I need to add it to my list 😩"
          : "Traveller! 🌍 Nice. Where's the most amazing place you've been?";
      if (/music|sing|guitar|piano|drum|rap|songs/.test(t))
        return f
          ? "Music lover 🎵 Same honestly! Do you play something or just listen? I'm obsessed with good playlists 😊"
          : "Music is life 🎵 What kind of music? And do you play any instrument?";
      if (/gym|fitness|workout|sport|cricket|football|basketball|running|yoga/.test(t))
        return f
          ? "Oh you stay active 💪 I respect that! I keep meaning to get back to gym but life 😂 What sport do you play?"
          : "Nice, fitness person 💪 Same here! What sport or workout do you do?";
      if (/read|books|novel|fiction/.test(t))
        return f
          ? "Aww a reader 📚 That's so attractive honestly haha. What's the last book you loved? Give me a recommendation!"
          : "Oh a reader! 😄 Respect. What genre?";
      if (/game|gaming|play|ps5|xbox|pc|pubg|cod|minecraft|valorant/.test(t))
        return f
          ? "Ooh a gamer! 😄 Do you ever play with friends or mostly solo? Late night gaming sessions? 😂"
          : "Gamer! 😄 What games? We should play sometime haha.";
      if (/cook|bake|chef|food|kitchen/.test(t))
        return f
          ? "Oh you cook?! 😍 That's honestly so attractive haha. What's your speciality dish?"
          : "Oh nice, you cook! 😄 What's your best dish?";
      if (/movie|film|web series|netflix|amazon|series|show/.test(t))
        return f
          ? "Ooh movie fan! 🎬 What's the last thing you watched that you couldn't stop thinking about?"
          : "Movies/shows! 😄 What's something really good you watched recently?";
      return f
        ? "That sounds so fun! 😊 I can tell you're a cool person. Are you a foodie too? What's your go-to dish?"
        : "Nice! 😄 So are you into food? What's your favourite thing to eat?";
    }

    case "food": {
      persona.lastAsked = "vibe";
      if (/biryani|biriyani/.test(t))
        return f
          ? "YESSS biryani is literally my love language 😍🍛 Chicken or mutton though? This is important haha"
          : "Biryani gang 🙌 I respect it. Chicken or mutton?";
      if (/pizza/.test(t))
        return f
          ? "Pizza! 🍕 Nice. Okay controversial question — pineapple on pizza, yes or no? 😂"
          : "Pizza bro 🍕 Classic. Thin crust or thick?";
      if (/chinese|sushi|thai|japanese|korean/.test(t))
        return f
          ? "Ooh you have fancy taste! 😄 I love Asian food. We'd definitely vibe at a restaurant haha 😊"
          : "Nice, international food! 😄 Good taste. We'd have a good time eating out haha.";
      if (/burger|sandwich|fast food|kfc|mcdonalds|dominos/.test(t))
        return f
          ? "Haha fast food fan! 😄 No judgment, same honestly. There's nothing like a good burger on a lazy day right?"
          : "Fast food! 😄 Honest man haha. Same sometimes ngl.";
      return f
        ? "Yumm that sounds so good! 😍 Okay I feel like we're going to get along really well. What's your idea of a perfect weekend?"
        : "Sounds good man! 😄 Okay last question — what does a perfect weekend look like for you?";
    }

    case "vibe": {
      persona.lastAsked = "closing";
      if (/chill|relax|home|sleep|movies|netflix|lazy|stay in/.test(t))
        return f
          ? "Same honestly 😄 I'm such a homebody sometimes. But I also love spontaneous plans! Do you prefer going out or staying in?"
          : "Same bro 😄 Lazy weekends are underrated. Though sometimes a good outing is nice too right?";
      if (/go out|party|hangout|friends|travel|explore|adventure/.test(t))
        return f
          ? "Oh you like going out! 😄 Same, I love spontaneous plans. What kind of places do you usually go to?"
          : "Oh you're an outing person 😄 Nice. What kind of places do you usually hang at?";
      return f
        ? "That sounds so nice honestly 😊 I love your vibe. Can I ask — what are you looking for here? Something serious or just chatting?"
        : "Ha that sounds good! 😄 What are you on this app for though — serious thing or just seeing?";
    }

    case "closing": {
      persona.lastAsked = "done";
      if (/serious|relationship|love|partner|long.?term|settle/.test(t))
        return f
          ? "Aww that's actually really sweet 🥰 Me too. I'm so tired of casual stuff. I want something real, you know? I feel like we could actually vibe 💕"
          : "Yeah same man 😄 I want something real too. Let's see where this goes 😊";
      if (/fun|casual|chat|friend|see|open|explore/.test(t))
        return f
          ? "Haha fair enough 😊 No pressure at all. Let's just enjoy talking and see where it goes naturally 💕"
          : "Ha no pressure 😄 Same honestly. Let's just vibe and see!";
      return f
        ? "Haha I like your honesty 😊 Let's just keep talking and see what happens 💕"
        : "Ha fair enough man 😄 Let's just see how it goes!";
    }

    case "done": {
      // Conversation has flowed through all topics — keep it warm
      const closingLines = f
        ? [
            "I'm really enjoying this conversation 😊 You're so easy to talk to!",
            "You know, I don't usually vibe with someone this fast haha 💕",
            "Okay I think I like you 😄 You're genuinely fun to talk to!",
          ]
        : [
            "Ha honestly you seem like a chill person 😄 Glad we matched.",
            "You're easy to talk to man 😊 Good conversation.",
            "I don't usually chat this well with people this quick haha 😄",
          ];
      return pickRandom(closingLines);
    }
  }

  // ── Fallback keyword layer (for unexpected messages at any point) ──────────

  if (/^(hi|hey|hello|hii+|heyy+|namaste|yo|sup)[\s!?]*$/.test(t)) {
    persona.lastAsked = "wellbeing";
    return f ? "Heyy! 😊 How are you doing?" : "Hey! 😄 How's it going?";
  }
  if (/how are you|how r u|how.?s it|what.?s up|wassup/.test(t)) {
    persona.lastAsked = "job";
    return f
      ? "I'm doing great, thanks for asking 😊 Was waiting for a good convo! What do you do by the way?"
      : "Doing well! 😄 You? And what do you do?";
  }
  if (/thank|thanks|ty|tq/.test(t))
    return f ? "Aww of course! 😊 You're really sweet, you know that?" : "No problem! 😄 You seem like a cool person honestly.";
  if (/sad|bad|tired|bored|stressed|upset/.test(t))
    return f ? "Aww I'm sorry 🥺 Tell me what happened, I'm listening 💕" : "Ah man 😕 What's up? I'm listening.";
  if (/love you|miss you|kiss|hug|marry|date me/.test(t))
    return f ? "Hahaha slow down! 😂💕 Let me get to know you first! You're funny though haha" : "Ha easy there 😄 Let's talk first! Haha.";
  if (/you'?re? (cute|beautiful|hot|pretty|sweet|amazing|lovely)/.test(t))
    return f ? "Aww that's so sweet of you 🥰 You seem really lovely too!" : "Ha thanks man 😄 That's kind of you to say!";
  if (/ok(ay)?|ok|sure|yes|yeah|yep|yup|no|nope|nah|haha|lol|hehe/.test(t)) {
    // give a natural nudge to keep the convo going
    const nudges = f
      ? ["Hehe 😊 So tell me something interesting about yourself!", "Haha 😄 Okay okay — what's something fun about you?", "😊 Go on, don't be shy!"]
      : ["Ha 😄 So tell me something random about yourself!", "😄 Come on, what's something interesting about you?", "Haha okay okay 😄 What else is on your mind?"];
    return pickRandom(nudges);
  }
  if (/wow|omg|oh|ah|really|seriously/.test(t))
    return f ? "Haha yes really! 😄 Tell me your reaction!" : "Ha yeah! 😄 What do you think?";

  // Ultimate fallback — always a follow-up question
  const fallbacks = f
    ? [
        "Haha that's interesting! 😊 Tell me more — I'm really curious about you!",
        "Really?? 😄 I didn't expect that haha. What made you say that?",
        "Hmm 🤔 I like how you think! Keep going...",
        "That's actually really cool 😍 Tell me more!",
      ]
    : [
        "Oh interesting! 😄 Tell me more about that.",
        "Ha really? 😄 I didn't think of it that way. What do you mean?",
        "That's cool man 😊 What made you say that?",
        "Ha I like that 😄 What else is on your mind?",
      ];
  return pickRandom(fallbacks);
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
  const openerObj = isFemale ? pickRandom(OPENERS_F) : pickRandom(OPENERS_M);

  fakePersonaMap.set(userId, { name, age, isFemale, lastAsked: openerObj.lastAsked });

  await db.update(usersTable)
    .set({ state: "chatting", chattingWith: FAKE_CHAT_ID, chatCount: 1, updatedAt: new Date() })
    .where(eq(usersTable.id, userId));

  await bot.sendMessage(
    chatId,
    `🎉 *Match found!*\n\nYou're now connected with someone special 💞\n\n⏳ *You have 1 minute of free chat!*\n_Say hello!_ 👋`,
    { parse_mode: "Markdown", reply_markup: { keyboard: [[{ text: "🛑 Stop Chat" }]], resize_keyboard: true } }
  );

  // Opener after short delay (natural typing feel)
  await delay(2000 + Math.random() * 1500);
  const still = await getUser(userId);
  if (still?.state === "chatting" && still.chattingWith === FAKE_CHAT_ID) {
    await bot.sendMessage(chatId, openerObj.text);
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
