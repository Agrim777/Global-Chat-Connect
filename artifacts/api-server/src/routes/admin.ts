import { Router } from "express";
import pg from "pg";
import { eq, and, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { usersTable } from "@workspace/db";

const PROD_DB_URL = "postgresql://postgres:GhLpEsBkAcBYSftlWBhOSmAuxZSqRKdG@hopper.proxy.rlwy.net:30481/railway";
const prodPool = new pg.Pool({ connectionString: PROD_DB_URL, ssl: { rejectUnauthorized: false }, max: 5 });
const db = drizzle(prodPool, { schema: { usersTable } });

const router = Router();

const ADMIN_KEY = process.env.ADMIN_TELEGRAM_ID ?? "8273572245";
const TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const PAY_LINK = "https://rzp.io/rzp/lx0R52O7";

const GIRL_NAMES = ["Riya","Priya","Neha","Simran","Komal","Ananya","Kavya","Shreya","Pooja","Nidhi","Megha","Tanya","Ishika","Aisha","Sanya"];
function rndName() { return GIRL_NAMES[Math.floor(Math.random() * GIRL_NAMES.length)]; }

function fomoMsg(name: string): string {
  const msgs = [
    `💌 *${name}* ab bhi soch rahi hai tumhare baare mein 🥺\n\n_"unka message padhke dil khush ho gaya"_\n\nReal log, real baat — ek baar unlock karo, phir koi limit nahi 💕\n\n👉 [Premium Unlock](${PAY_LINK})`,
    `🔔 Yaad hai tumhara woh match?\n\n*${name}* ne poochha — _"kya woh wapas aayenge?"_ 🥺\n\nWoh abhi bhi yahan hai. Premium lo aur baat shuru karo 💕\n\n👉 [Unlock Now](${PAY_LINK})`,
    `✨ Tumhara free preview khatam hua — *${name}* nahi gayi 🥺\n\nWoh online hai abhi. Ek payment aur real chat forever.\n\nNo timer. No limits 💕\n\n👉 [Unlock Premium](${PAY_LINK})`,
    `💘 Woh ladki jisse tumhara match hua?\n\n*${name}* ne kaha — _"kya woh serious hain?"_ 🥺\n\nProve it. Pay once, chat unlimited 💕\n\n👉 [Unlock Now](${PAY_LINK})`,
    `💕 *${name}* nahi bhooli tumhe.\n\n_"interesting lag rahe the, kash aur baat hoti"_ — yahi kaha usne 🥺\n\nReal conversations. One-time payment. No limits.\n\n👉 [Pay & Chat](${PAY_LINK})`,
    `🌙 Late night thought — *${name}* abhi bhi app pe hai.\n\nWoh match kiya tha tumhare saath ek reason se 💕\n\nPremium = real chats, real people, koi timer nahi.\n\n👉 [Unlock Now](${PAY_LINK})`,
    `💬 *${name}* ne message kiya... lekin tumhara Premium nahi hai abhi.\n\nReal connection tha. Waste mat karo.\n\nPay once. Chat forever 💕\n\n👉 [Unlock Premium](${PAY_LINK})`,
  ];
  return msgs[Math.floor(Math.random() * msgs.length)];
}

async function sendTg(chatId: number, text: string) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
  });
  return r.json() as Promise<{ ok: boolean }>;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

let broadcastRunning = false;

router.get("/admin/broadcast", async (req, res) => {
  const key = req.query["key"] as string;
  if (key !== ADMIN_KEY) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  if (broadcastRunning) {
    res.json({ status: "already_running", message: "Broadcast already in progress" });
    return;
  }

  const targets = await db.select({ id: usersTable.id })
    .from(usersTable)
    .where(and(gt(usersTable.chatCount, 0), eq(usersTable.hasPaid, false), eq(usersTable.isProfileComplete, true)));

  res.json({ status: "started", total: targets.length, message: `Broadcast started for ${targets.length} users` });

  broadcastRunning = true;
  let sent = 0, failed = 0;
  for (const row of targets) {
    try {
      const result = await sendTg(row.id, fomoMsg(rndName()));
      if (result.ok) sent++; else failed++;
    } catch { failed++; }
    await sleep(80);
  }
  broadcastRunning = false;
  console.log(`[BROADCAST] Done — sent: ${sent}, failed: ${failed}, total: ${targets.length}`);
});

router.get("/admin/broadcast/status", async (req, res) => {
  const key = req.query["key"] as string;
  if (key !== ADMIN_KEY) { res.status(403).json({ error: "Forbidden" }); return; }
  res.json({ running: broadcastRunning });
});

export default router;
