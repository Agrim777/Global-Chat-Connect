import TelegramBot from "node-telegram-bot-api";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN environment variable is required");
}

const PAY_LINK = "https://rzp.io/rzp/lx0R52O7";

export const bot = new TelegramBot(TOKEN, { polling: true });

// ── Helpers ────────────────────────────────────────────────────────────────

async function getUser(telegramId: number) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, telegramId));
  return user ?? null;
}

async function upsertUser(telegramId: number, data: Partial<typeof usersTable.$inferInsert>) {
  const existing = await getUser(telegramId);
  if (existing) {
    await db.update(usersTable).set({ ...data, updatedAt: new Date() }).where(eq(usersTable.id, telegramId));
  } else {
    await db.insert(usersTable).values({ id: telegramId, ...data } as typeof usersTable.$inferInsert);
  }
  return getUser(telegramId);
}

async function sendMain(chatId: number, user: { name?: string | null; isProfileComplete?: boolean }) {
  const name = user.name ?? "there";
  const keyboard = user.isProfileComplete
    ? {
        keyboard: [
          [{ text: "💘 Find Match" }, { text: "👤 My Profile" }],
          [{ text: "✏️ Edit Profile" }, { text: "🛑 Stop Matching" }],
          [{ text: "💳 Support Us" }],
        ],
        resize_keyboard: true,
        one_time_keyboard: false,
      }
    : {
        keyboard: [
          [{ text: "🚀 Setup Profile" }],
          [{ text: "💳 Support Us" }],
        ],
        resize_keyboard: true,
        one_time_keyboard: false,
      };

  await bot.sendMessage(
    chatId,
    user.isProfileComplete
      ? `Welcome back, *${name}* 💖\nWhat would you like to do?`
      : `Hi *${name}*! 👋\nYou haven't set up your profile yet.\nTap below to get started!`,
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
}

async function sendPayLink(chatId: number) {
  await bot.sendMessage(
    chatId,
    `💳 *Support WorldMatch*\n\n` +
    `Your support keeps this bot running and helps us connect more people worldwide! 🌍💕\n\n` +
    `Tap the button below to make a payment:\n${PAY_LINK}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "💳 Pay Now", url: PAY_LINK }]],
      },
    }
  );
}

// ── /start ─────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from!.id;
  const firstName = msg.from!.first_name ?? "";
  const username = msg.from!.username ?? null;

  try {
    let user = await getUser(telegramId);
    if (!user) {
      user = await upsertUser(telegramId, { firstName, telegramUsername: username, state: "idle" });
    }
    await bot.sendMessage(
      chatId,
      "💕 *Welcome to WorldMatch Dating Bot!*\n\nConnect with people from all over the world.\nFind your perfect match, chat, and build connections! 🌍",
      { parse_mode: "Markdown" }
    );
    await sendMain(chatId, user!);
  } catch (err) {
    logger.error({ err }, "Error in /start");
  }
});

// ── /help ──────────────────────────────────────────────────────────────────

bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    "ℹ️ *WorldMatch Bot Commands*\n\n" +
      "/start — Start or restart the bot\n" +
      "/profile — View your profile\n" +
      "/edit — Edit your profile\n" +
      "/match — Find a match\n" +
      "/stop — Stop current chat\n" +
      "/pay — Support us via Razorpay\n" +
      "/help — Show this help",
    { parse_mode: "Markdown" }
  );
});

// ── Profile setup flow ─────────────────────────────────────────────────────

async function startSetup(chatId: number, telegramId: number) {
  await upsertUser(telegramId, { state: "setup_name" });
  await bot.sendMessage(chatId, "Let's set up your profile! 🎉\n\n📝 What's your *name*?", {
    parse_mode: "Markdown",
    reply_markup: { remove_keyboard: true },
  });
}

async function showProfile(chatId: number, user: NonNullable<Awaited<ReturnType<typeof getUser>>>) {
  const genderEmoji: Record<string, string> = { male: "👨", female: "👩", other: "🧑" };
  const lookingEmoji: Record<string, string> = { male: "👨", female: "👩", any: "👥" };
  const text =
    `👤 *Your Profile*\n\n` +
    `🏷️ Name: *${user.name ?? "-"}*\n` +
    `🎂 Age: *${user.age ?? "-"}*\n` +
    `${genderEmoji[user.gender ?? "other"] ?? "🧑"} Gender: *${user.gender ?? "-"}*\n` +
    `💞 Looking for: *${user.lookingFor ?? "-"}*\n` +
    `🌍 Country: *${user.country ?? "-"}*\n` +
    `📖 Bio: _${user.bio ?? "-"}_`;
  await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
}

// ── Find match ─────────────────────────────────────────────────────────────

async function findMatch(chatId: number, userId: number) {
  const me = await getUser(userId);
  if (!me || !me.isProfileComplete) {
    await bot.sendMessage(chatId, "Please complete your profile first! Tap *Setup Profile*.", { parse_mode: "Markdown" });
    return;
  }
  if (me.state === "chatting") {
    await bot.sendMessage(chatId, "You're already in a chat! Send /stop to end it first.");
    return;
  }

  // Find an eligible match: different user, complete profile, active, not chatting, gender matches preferences
  const candidates = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.isProfileComplete, true));

  const eligible = candidates.filter((c) => {
    if (c.id === userId) return false;
    if (!c.isActive) return false;
    if (c.state === "chatting") return false;
    // Me looking for them
    const meWants = me.lookingFor === "any" || me.lookingFor === c.gender;
    // They looking for me
    const theyWant = c.lookingFor === "any" || c.lookingFor === me.gender;
    return meWants && theyWant;
  });

  if (eligible.length === 0) {
    await bot.sendMessage(
      chatId,
      "😔 No matches available right now.\nCheck back later or /match again!",
      { reply_markup: { keyboard: [[{ text: "💘 Find Match" }, { text: "👤 My Profile" }], [{ text: "✏️ Edit Profile" }, { text: "🛑 Stop Matching" }]], resize_keyboard: true } }
    );
    return;
  }

  // Pick random candidate
  const match = eligible[Math.floor(Math.random() * eligible.length)];

  // Set both users to chatting
  await db.update(usersTable).set({ state: "chatting", chattingWith: match.id, updatedAt: new Date() }).where(eq(usersTable.id, userId));
  await db.update(usersTable).set({ state: "chatting", chattingWith: userId, updatedAt: new Date() }).where(eq(usersTable.id, match.id));

  const stopKeyboard = {
    keyboard: [[{ text: "🛑 Stop Chat" }]],
    resize_keyboard: true,
  };

  await bot.sendMessage(
    chatId,
    `🎉 *Match found!*\n\nYou're now chatting with *${match.name}*, ${match.age} from ${match.country} 🌍\n\n_Say hello!_ 👋`,
    { parse_mode: "Markdown", reply_markup: stopKeyboard }
  );
  await bot.sendMessage(
    match.id,
    `🎉 *Match found!*\n\nYou're now chatting with *${me.name}*, ${me.age} from ${me.country} 🌍\n\n_Say hello!_ 👋`,
    { parse_mode: "Markdown", reply_markup: stopKeyboard }
  );
}

async function stopChat(chatId: number, userId: number) {
  const me = await getUser(userId);
  if (!me || me.state !== "chatting") {
    await bot.sendMessage(chatId, "You're not in a chat right now.");
    if (me) await sendMain(chatId, me);
    return;
  }

  const partnerId = me.chattingWith;

  await db.update(usersTable).set({ state: "idle", chattingWith: null, updatedAt: new Date() }).where(eq(usersTable.id, userId));

  if (partnerId) {
    const partner = await getUser(partnerId);
    if (partner && partner.state === "chatting") {
      await db.update(usersTable).set({ state: "idle", chattingWith: null, updatedAt: new Date() }).where(eq(usersTable.id, partnerId));
      await bot.sendMessage(partnerId, "💔 Your match has ended the chat.\n\nTap *Find Match* to meet someone new!", { parse_mode: "Markdown" });
      await sendMain(partnerId, { ...partner, isProfileComplete: partner.isProfileComplete });
    }
  }

  const updatedMe = await getUser(userId);
  await bot.sendMessage(chatId, "Chat ended. Hope you had a great conversation! 💕");
  await sendMain(chatId, updatedMe!);
}

// ── Message router ─────────────────────────────────────────────────────────

bot.on("message", async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;
  const telegramId = msg.from!.id;
  const text = msg.text.trim();

  // Skip commands — handled by onText
  if (text.startsWith("/")) return;

  try {
    let user = await getUser(telegramId);

    if (!user) {
      // Auto-create user if they somehow messaged without /start
      user = await upsertUser(telegramId, {
        firstName: msg.from!.first_name ?? "",
        telegramUsername: msg.from!.username ?? null,
        state: "idle",
      });
      await sendMain(chatId, user!);
      return;
    }

    // ── Setup flow states ──────────────────────────────────────────────

    if (user.state === "setup_name") {
      if (text.length < 2 || text.length > 50) {
        await bot.sendMessage(chatId, "Please enter a valid name (2-50 characters).");
        return;
      }
      await upsertUser(telegramId, { name: text, state: "setup_age" });
      await bot.sendMessage(chatId, `Nice to meet you, *${text}*! 😊\n\n🎂 How old are you? (Enter your age)`, { parse_mode: "Markdown" });
      return;
    }

    if (user.state === "setup_age") {
      const age = parseInt(text, 10);
      if (isNaN(age) || age < 18 || age > 100) {
        await bot.sendMessage(chatId, "Please enter a valid age between 18 and 100.");
        return;
      }
      await upsertUser(telegramId, { age, state: "setup_gender" });
      await bot.sendMessage(chatId, "What's your *gender*?", {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [[{ text: "Male" }, { text: "Female" }, { text: "Other" }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      });
      return;
    }

    if (user.state === "setup_gender") {
      const gMap: Record<string, "male" | "female" | "other"> = {
        male: "male",
        female: "female",
        other: "other",
      };
      const gender = gMap[text.toLowerCase()];
      if (!gender) {
        await bot.sendMessage(chatId, "Please choose Male, Female, or Other.");
        return;
      }
      await upsertUser(telegramId, { gender, state: "setup_looking_for" });
      await bot.sendMessage(chatId, "💞 Who are you *looking for*?", {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [[{ text: "Male" }, { text: "Female" }, { text: "Any" }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      });
      return;
    }

    if (user.state === "setup_looking_for") {
      const lfMap: Record<string, "male" | "female" | "any"> = {
        male: "male",
        female: "female",
        any: "any",
      };
      const lookingFor = lfMap[text.toLowerCase()];
      if (!lookingFor) {
        await bot.sendMessage(chatId, "Please choose Male, Female, or Any.");
        return;
      }
      await upsertUser(telegramId, { lookingFor, state: "setup_bio" });
      await bot.sendMessage(chatId, "📖 Write a short *bio* about yourself (max 300 characters):", {
        parse_mode: "Markdown",
        reply_markup: { remove_keyboard: true },
      });
      return;
    }

    if (user.state === "setup_bio") {
      if (text.length > 300) {
        await bot.sendMessage(chatId, "Bio is too long! Please keep it under 300 characters.");
        return;
      }
      await upsertUser(telegramId, { bio: text, state: "setup_country" });
      await bot.sendMessage(chatId, "🌍 Which *country* are you from?", { parse_mode: "Markdown" });
      return;
    }

    if (user.state === "setup_country") {
      if (text.length < 2 || text.length > 60) {
        await bot.sendMessage(chatId, "Please enter a valid country name.");
        return;
      }
      await upsertUser(telegramId, { country: text, state: "idle", isProfileComplete: true });
      const updated = await getUser(telegramId);
      await bot.sendMessage(chatId, "✅ *Profile complete!* You're all set to find matches! 🎉", { parse_mode: "Markdown" });
      await showProfile(chatId, updated!);
      await sendMain(chatId, updated!);
      await sendPayLink(chatId);
      return;
    }

    // ── Chatting relay ─────────────────────────────────────────────────

    if (user.state === "chatting") {
      if (text === "🛑 Stop Chat") {
        await stopChat(chatId, telegramId);
        return;
      }
      if (user.chattingWith) {
        await bot.sendMessage(user.chattingWith, `💬 *${user.name ?? "Match"}*: ${text}`, { parse_mode: "Markdown" });
      }
      return;
    }

    // ── Menu buttons ───────────────────────────────────────────────────

    if (text === "🚀 Setup Profile" || text === "✏️ Edit Profile") {
      await startSetup(chatId, telegramId);
      return;
    }

    if (text === "💘 Find Match") {
      await findMatch(chatId, telegramId);
      return;
    }

    if (text === "👤 My Profile") {
      await showProfile(chatId, user);
      return;
    }

    if (text === "🛑 Stop Matching" || text === "🛑 Stop Chat") {
      await stopChat(chatId, telegramId);
      return;
    }

    if (text === "💳 Support Us") {
      await sendPayLink(chatId);
      return;
    }

    // Fallback
    await sendMain(chatId, user);
  } catch (err) {
    logger.error({ err }, "Error handling message");
    await bot.sendMessage(chatId, "Something went wrong. Please try again or send /start.");
  }
});

// ── /profile & /match & /stop commands ────────────────────────────────────

bot.onText(/\/profile/, async (msg) => {
  const user = await getUser(msg.from!.id);
  if (!user || !user.isProfileComplete) {
    await bot.sendMessage(msg.chat.id, "You haven't set up your profile yet! Send /start to begin.");
    return;
  }
  await showProfile(msg.chat.id, user);
});

bot.onText(/\/edit/, async (msg) => {
  await startSetup(msg.chat.id, msg.from!.id);
});

bot.onText(/\/match/, async (msg) => {
  await findMatch(msg.chat.id, msg.from!.id);
});

bot.onText(/\/stop/, async (msg) => {
  await stopChat(msg.chat.id, msg.from!.id);
});

bot.onText(/\/pay/, async (msg) => {
  await sendPayLink(msg.chat.id);
});

logger.info("Telegram bot polling started");
