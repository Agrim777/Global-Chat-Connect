import cron from "node-cron";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { usersTable } from "@workspace/db";
import { eq, and, ne } from "drizzle-orm";
import { logger } from "./lib/logger";

const PROD_DB_URL = "postgresql://postgres:GhLpEsBkAcBYSftlWBhOSmAuxZSqRKdG@hopper.proxy.rlwy.net:30481/railway";
const prodPool = new pg.Pool({ connectionString: PROD_DB_URL, ssl: { rejectUnauthorized: false }, max: 3 });
const db = drizzle(prodPool, { schema: { usersTable } });

const TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const ADMIN_KEY = process.env.ADMIN_TELEGRAM_ID ?? "8273572245";
const PAY_LINK = "https://rzp.io/rzp/lx0R52O7";

const GIRL_NAMES = ["Riya","Priya","Neha","Simran","Komal","Ananya","Kavya","Shreya","Pooja","Nidhi","Megha","Tanya","Ishika","Aisha","Sanya"];
const rndName = () => GIRL_NAMES[Math.floor(Math.random() * GIRL_NAMES.length)];
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const NIGHT_MSGS = [
  (name: string) => `🌙 Raat ko akela feel ho raha hai?\n\n*${name}* abhi bhi online hai aur tumhara wait kar rahi hai 🥺\n\nSirf ₹199 mein unlimited real chat. Aaj raat unlock karo 💕\n\n👉 [Unlock Now](${PAY_LINK})`,
  (name: string) => `💘 Aaj Friday raat hai...\n\n*${name}* ne socha — _"kash woh hote"_ 🥺\n\nReal baat, real log — ek baar try karo aaj raat.\n\n👉 [Unlock Premium](${PAY_LINK})`,
  (name: string) => `🔥 9 baj gaye hain — aur *${name}* abhi bhi chat mein active hai!\n\nWoh tumse baat karna chahti hai. Ek payment, lifetime access 💕\n\n👉 [Abhi Unlock Karo](${PAY_LINK})`,
  (name: string) => `✨ Late night special — *${name}* online hai abhi 🥺\n\nReal conversations. Real people. Sirf ₹199.\n\nAaj raat baat karo 💕\n\n👉 [Unlock Now](${PAY_LINK})`,
  (name: string) => `💌 Tumhara match yaad aa raha hai?\n\n*${name}* ne check kiya — _"kya woh aaye?"_ 🥺\n\nAaj raat hi unlock karo — woh wait kar rahi hai.\n\n👉 [Pay & Chat](${PAY_LINK})`,
];

async function sendTg(chatId: number, text: string) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
  });
  return r.json() as Promise<{ ok: boolean }>;
}

async function runNightBroadcast() {
  logger.info("[SCHEDULER] Starting 9 PM night broadcast...");
  const adminId = Number(ADMIN_KEY);

  const targets = await db.select({ id: usersTable.id })
    .from(usersTable)
    .where(and(
      eq(usersTable.hasPaid, false),
      eq(usersTable.isProfileComplete, true),
      ne(usersTable.id, adminId)
    ));

  logger.info(`[SCHEDULER] Night broadcast — ${targets.length} targets`);
  let sent = 0, failed = 0;

  for (const row of targets) {
    try {
      const msgFn = NIGHT_MSGS[Math.floor(Math.random() * NIGHT_MSGS.length)];
      const result = await sendTg(row.id, msgFn(rndName()));
      if (result.ok) sent++; else failed++;
    } catch { failed++; }
    await sleep(80);
  }

  logger.info(`[SCHEDULER] Night broadcast done — sent: ${sent}, failed: ${failed}, total: ${targets.length}`);
}

export function startScheduler() {
  // 9:00 PM IST = 3:30 PM UTC (cron: "30 15 * * *")
  cron.schedule("30 15 * * *", () => {
    runNightBroadcast().catch(err => logger.error({ err }, "[SCHEDULER] Night broadcast failed"));
  }, { timezone: "UTC" });

  logger.info("[SCHEDULER] Daily 9 PM IST broadcast scheduled");
}
