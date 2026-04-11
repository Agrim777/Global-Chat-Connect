# Telegram Dating Bot — Full Build Prompt

Use this document to recreate the bot from scratch. Every feature, flow, rule, and edge case is described below.

---

## Bot Identity

- **Platform:** Telegram Bot (using `node-telegram-bot-api` in Node.js / TypeScript)
- **Bot handle:** `@Mydatingbabybot`
- **Purpose:** Freemium anonymous dating/chat bot. Free users get ONE 60-second AI demo chat. All real chats require a one-time premium payment.
- **Payment:** Telegram Stars (native Telegram payment — `XTR` currency, 100 Stars for Premium)
- **Admin Telegram ID:** `8273572245`

---

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Database:** PostgreSQL via Drizzle ORM
- **Bot library:** `node-telegram-bot-api` (long polling mode)
- **Logging:** Pino logger

---

## Database Schema — `users` table

| Column | Type | Description |
|---|---|---|
| `id` | bigint (PK) | Telegram user ID |
| `telegram_username` | varchar | @username |
| `first_name` | varchar | Telegram first name |
| `name` | varchar | Display name set during profile setup |
| `age` | integer | Age set during profile setup |
| `gender` | enum (male/female/other) | Gender |
| `looking_for` | enum (male/female/any) | Preference |
| `bio` | text | Short bio |
| `country` | varchar | Country |
| `is_profile_complete` | boolean | True only after all 6 steps are done |
| `is_active` | boolean | Whether user is active (default true) |
| `has_paid` | boolean | Premium status (default false) |
| `chat_count` | integer | Total chats started (used to gate free trial) |
| `state` | enum | Current bot state (see States section below) |
| `chatting_with` | bigint | ID of current chat partner (0 = AI fake chat) |
| `referral_code` | varchar unique | User's own referral code |
| `referred_by` | bigint | Who referred them |
| `referral_count` | integer | How many users they referred |
| `bonus_chats` | integer | Extra chats from referrals |
| `created_at` | timestamp | Registration time |
| `updated_at` | timestamp | Last update time |

### Bot States (state enum)

- `idle` — at main menu, not doing anything
- `setup_name` — waiting for user to type their name
- `setup_age` — waiting for age
- `setup_gender` — waiting for gender selection
- `setup_looking_for` — waiting for preference selection
- `setup_bio` — waiting for bio text
- `setup_country` — waiting for country text
- `chatting` — currently in a chat (real or AI fake)

---

## In-Memory State (clears on bot restart)

These are in-memory Maps/Sets — NOT stored in DB:

- **`fakePersonaMap`** — Maps userId → FakePersona object (name, age, gender, mood, message count, last topic asked, etc.) for users in AI fake chat
- **`editModeMap`** — Maps userId → which field they're editing ("name", "age", "gender", "looking_for", "bio", "country", "choosing"). Currently unused in main flow since Edit Profile now starts fresh.
- **`chatTimerMap`** — Maps userId → their 60-second free trial timeout handle. Used to cancel the timer if user stops chat early.
- **`processingSet`** — Set of userIds currently processing a message. Acts as a per-user lock to prevent concurrent DB writes when user taps buttons rapidly.
- **`matchingSet`** — Set of userIds currently inside the `findMatch` function. Prevents race conditions in pairing (users inside this set are excluded from being picked as a match by others).
- **`fakeReplySet`** — Set of userIds with an AI reply currently in flight. Prevents duplicate AI responses when user sends multiple messages rapidly.

---

## Bot Startup Sequence

1. Initialize bot WITHOUT polling first
2. Call `getUpdates` 3 times with short timeout to forcibly evict any stale polling session from Telegram's servers (prevents 409 Conflict errors)
3. Start polling
4. Run **startup ghost-connection cleanup** (see below)
5. Set bot profile description

---

## Startup Ghost-Connection Cleanup

Runs automatically every time the bot starts. Scans ALL users in `state = chatting` and fixes invalid states:

**Case 1 — Fake chat ghost (bot was restarted, in-memory persona lost):**
- User has `chatting_with = 0` (FAKE_CHAT_ID) but no persona in memory
- Fix: reset user to `state = idle`, `chatting_with = null`
- Notify: send fresh main menu keyboard to their Telegram chat

**Case 2 — Unpaid user in a real chat:**
- User has `has_paid = false` but `chatting_with = <real user ID>`
- Fix: reset both the unpaid user AND their partner to idle
- Notify: send fresh main menu to both

**Case 3 — Ghost connection (partner deleted or mismatched):**
- User's `chatting_with` points to a user who either doesn't exist, or whose own `chatting_with` doesn't point back
- Fix: reset the affected user to idle
- Notify: send "Your match is no longer available" message with fresh keyboard

**Why notifications matter:** Telegram caches the last keyboard on the user's device forever. Without pushing a fresh keyboard, users see stale buttons like "✅ Premium" or "🛑 Stop Chat" even after their state was reset.

---

## User Registration Flow

When a user sends any message and the bot can't find them in the DB:
1. Insert new record with `state = idle`, `has_paid = false` (default), and their Telegram first name
2. Send them the main menu (shows "🚀 Setup Profile" button since profile is incomplete)

**Important:** `hasPaid` is NEVER inherited. Fresh users always start with `hasPaid = false`.

---

## Profile Setup Flow (6 Steps)

Triggered by "🚀 Setup Profile" or "✏️ Edit Profile" button — BOTH start completely fresh, wiping all old data.

When `startSetup` is called:
1. Clear ALL profile fields: name, age, gender, lookingFor, bio, country → set to null
2. Set `isProfileComplete = false`
3. Set `state = setup_name`
4. Ask: *"Step 1 of 6 — What should we call you?"*

**Step 1 — Name (`setup_name` state):**
- User types any text
- Capitalize first letter, save as `name`
- Advance to `setup_age`
- Ask: *"Step 2 of 6 — How old are you?"*

**Step 2 — Age (`setup_age` state):**
- Parse integer from input
- Must be between 18–60, else ask again
- Save as `age`
- Advance to `setup_gender`
- Show inline buttons: Male / Female / Other

**Step 3 — Gender (`setup_gender` state):**
- Show keyboard: Male, Female, Other
- Save as `gender`
- Advance to `setup_looking_for`
- Show: *"Step 4 of 6 — Who are you looking to meet?"*

**Step 4 — Looking For (`setup_looking_for` state):**
- Show keyboard: Male, Female, Any
- Save as `lookingFor`
- Advance to `setup_bio`
- Ask: *"Step 5 of 6 — Write a short bio"*

**Step 5 — Bio (`setup_bio` state):**
- User types any text (max 300 chars, trim excess)
- Save as `bio`
- Advance to `setup_country`
- Ask: *"Step 6 of 6 — Which country are you from?"*

**Step 6 — Country (`setup_country` state):**
- User types any text
- Capitalize, save as `country`
- Set `isProfileComplete = true`, `state = idle`
- Send profile card summary + full main menu

**Escape hatch:** If user taps any main menu button while stuck in a setup step, they are reset to idle and shown the main menu.

---

## Main Menu

Shown whenever user completes an action or sends an unrecognised message.

**Profile complete + paid:**
```
[💘 Find Match]  [👤 My Profile]
[✏️ Edit Profile] [✅ Premium]
```

**Profile complete + free:**
```
[💘 Find Match]  [👤 My Profile]
[✏️ Edit Profile] [💎 Go Premium]
```

**Profile incomplete:**
```
[🚀 Setup Profile]
[💎 Go Premium]
```

---

## Free User Flow — AI Fake Chat

**Rule: Free users NEVER interact with real paid users. Ever.**

When a free user taps "💘 Find Match":
- If `chatCount = 0` → start AI fake chat (one-time free demo)
- If `chatCount > 0` → show pay gate (they've used their free trial)

### Starting the AI Fake Chat (`startFakeChat`)

1. Pick a random persona — name, age, gender (based on user's `lookingFor` preference)
2. Store persona in `fakePersonaMap`
3. Update DB: `state = chatting`, `chatting_with = 0` (FAKE_CHAT_ID sentinel), `chat_count = 1`
4. Send: *"Match found. Say hello — you have a short free trial to chat."* (with 🛑 Stop Chat keyboard)
5. After 1.2–2 second delay (simulates typing), send the opener message
6. Set a 60-second countdown timer (`chatTimerMap`)

### Opener Messages (Female persona)
Randomly picked from 7 variants, all casual Hinglish WhatsApp style:
- "heyy 😊\nkahan se ho tum?"
- "hii 🙈\nomg finally match hua haha\nokay bolo — student ho ya job?"
- "heyy!!\nngl bahut bore ho rahi thi 😭\nkuch interesting batao..."
- "hi 💕\nquick question — job hai ya still college?"
- (+ 3 more variants)

### AI Reply Engine (`fakeAutoReply` + `buildSmartReply`)

When user sends a message during fake chat:
1. Check `fakeReplySet` — if an AI reply is already in flight for this user, ignore the message (prevents duplicate replies)
2. Add userId to `fakeReplySet`
3. Simulate "typing" delay (1–3 seconds based on message length)
4. Call `buildSmartReply(userText, persona)` to generate 1–3 short reply messages
5. Send replies one by one with 0.8–1.5 second gaps between them (burst message style)
6. Remove from `fakeReplySet`

### `buildSmartReply` — How it works

The reply engine detects language first:
- **Hindi** — if text contains Hindi Unicode characters
- **Hinglish** — if text contains common Hinglish words (kya, hai, hoon, yaar, ngl, etc.)
- **English** — default

Then matches against topic patterns in order:

| User says... | AI response |
|---|---|
| Asks persona's name | Tells name, asks user's |
| Asks age | Tells age, asks user's |
| Asks location | Picks random city (Delhi, Mumbai, Pune), asks user's |
| Asks for photo | "haha not yet, talk first" |
| Sexual/vulgar words | Light teasing deflection |
| Asks for number/WhatsApp/Instagram | "slow down, talk here first" |
| Bye/leaving | "arre itni jaldi? 🥺" |
| Love/pyaar | "haha we just met lol" |
| Compliments the persona | Flustered thanks + mild compliment back |
| Thanks | Casual acknowledgement |
| Sad/bored | Empathetic "kya hua?" |
| Greetings (hi/hello/hey) | Casual greeting back |
| How are you | "theek hun, tum?" style |
| Short/one-word replies | Light teasing ("yahi tha? 😒") |

Context-aware replies based on `persona.lastAsked`:
- After asking about job → process their job response, ask about hobby
- After asking about hobby → process, ask about location
- After asking about location → process, ask about something else
- After 8 messages (high msgCount) → "callback" to something user said earlier to seem human

Ultimate fallback: "hmm 🤔", "sach mein? 👀", "haha aur batao"

### 60-Second Trial Timer

When the timer fires:
- Check if user is still in fake chat (`state = chatting` AND `has_paid = false`)
- If yes: reset to idle, show pay gate with message: *"⏰ Your free 1-minute trial has ended! Unlock Premium to keep chatting with real people 💕"*
- Schedule 5-minute pay reminder
- If user already stopped manually before timer fired: do nothing (timer has already been cleared by stopChat)

### 5-Minute Pay Reminder (`schedulePayReminder`)

Fires 5 minutes after free trial ends (if user still hasn't paid):
- Picks a girl's name (Riya, Shikha, Kanvi, Radika, Suhma, Pooja, Neha)
- Sends: *"[Name] is still thinking about your chat... She told me — 'he was actually different 🥺' Don't let her wait. Unlock Premium!"* + pay link

---

## Pay Gate (`sendPayGate`)

Shown to free users who try to find a real match (or whose free trial ends).

Message content:
- "💎 Go Premium — Unlock Full Access"
- Lists benefits: unlimited real matches, chat real people, priority queue, one-time payment
- Telegram Stars invoice sent via `bot.sendInvoice()` with `XTR` currency, 100 Stars price
- Payment is automatic: `pre_checkout_query` handler approves instantly, `successful_payment` handler grants premium

When `pre_checkout_query` arrives:
- Call `bot.answerPreCheckoutQuery(query.id, true)` — always approve

When `successful_payment` message arrives:
- Set `has_paid = true` in DB immediately
- Notify admin with user info and Stars paid
- Send success message to user + fresh main menu

---

## Paid User Flow — Real Chat Matching

### Finding a Match (`findMatch` → `findEligibleUsers`)

`findEligibleUsers` fetches candidates where:
- `is_profile_complete = true`
- `has_paid = true`
- `state = idle`

Then filters out:
- The user themselves
- Users with `is_active = false`
- Users currently inside `matchingSet` (race condition guard)
- **No gender filtering** — paid users match with anyone

### Atomic Pairing Transaction

To prevent the "one person connected to two" race condition:
1. Start a DB transaction
2. Update user A: set `state = chatting`, `chatting_with = B` WHERE `state = idle` — if 0 rows affected, throw "self_taken"
3. Update user B: set `state = chatting`, `chatting_with = A` WHERE `state = idle` — if 0 rows affected, throw "match_taken"
4. If transaction succeeds: send "✅ Match found!" to both users
5. If transaction fails: check if we were already matched by someone else during the race — if yes, stay silent. If no, show "no matches" message.

### Message Relay

When a paid user in a real chat sends a message:

**Safety checks before relay (ALL must pass):**
1. User has `has_paid = true` (sender is paid)
2. Recipient exists in DB
3. Recipient `state = chatting`
4. Recipient's `chatting_with = sender's ID` (mutual connection confirmed)
5. Recipient is NOT in fake chat (`chatting_with ≠ 0`)
6. Recipient also has `has_paid = true` (recipient is paid)

If all pass → relay the message (text or photo forward).

If relay throws (user blocked bot) → disconnect both users, notify sender "match no longer reachable."

If any check fails → stale connection → reset sender to idle, show "match no longer available."

### Photo Relay

Photos are forwarded using `bot.forwardMessage` (preserves original quality). Same safety checks as text relay apply.

---

## Stopping a Chat (`stopChat`)

Triggered by "🛑 Stop Chat" button or "🛑 Stop Matching" button.

1. Fetch user from DB — if not chatting, say "You're not in a chat right now"
2. If in fake chat (chatting_with = 0):
   - Cancel the 60-second timer
   - Clear persona from fakePersonaMap
   - Reset user to idle
   - If chatCount > 0 and not paid → show pay gate
   - If paid → show main menu
3. If in real chat:
   - Atomic update: reset user to idle WHERE their chatting_with = partner
   - Atomic update: reset partner to idle WHERE partner's chatting_with = user
   - Notify both: "Chat ended." + fresh main menu

---

## Profile Card (`showProfile`)

Shown when user taps "👤 My Profile". Sends a formatted card:

```
👤 Your Profile

📝 Name: [name]
🎂 Age: [age]
⚤ Gender: [gender]
💞 Looking For: [lookingFor]
🌍 Country: [country]
📖 Bio: [bio]

💎 Status: Premium ✅ / Free User
```

---

## Admin Commands

All commands check `msg.from.id === ADMIN_ID` first. Unauthorised users get their ID shown.

### `/grant <userId>`
- Check if user exists in DB — if not, return error: *"User not found. They must start the bot first."*
- If already premium → *"Already has Premium"*
- If exists and free → set `has_paid = true`
- Send confirmation to admin
- Send "🎉 Your premium is now active!" + fresh main menu to the user

### `/revoke <userId>`
- Set `has_paid = false` for target user
- If they were in a real chat → stop the chat, reset partner too
- Notify target user: *"Your premium has been revoked"*
- Confirm to admin

### `/users`
Shows a summary of all users: total count, premium count, active chats count, profile complete count.

### `/test`
Admin-only command to test the bot is alive and responding.

### `/start` (with referral code)
If `/start ref_XXXX` is sent, record the referral: find the user with that referral code, increment their referral count.

---

## Bot Commands (Slash)

| Command | Action |
|---|---|
| `/start` | Register/welcome user, show main menu |
| `/help` | Show help text with all commands listed |
| `/profile` | Show user's profile card |
| `/edit` | Start fresh profile setup (same as "✏️ Edit Profile" button) |
| `/match` | Trigger find match (same as "💘 Find Match" button) |
| `/stop` | Stop current chat (same as "🛑 Stop Chat" button) |
| `/premium` | Show pay gate |
| `/grant <id>` | (Admin) Grant premium to user |
| `/revoke <id>` | (Admin) Revoke premium from user |
| `/users` | (Admin) Show user stats |
| `/test` | (Admin) Health check |

---

## Key Rules & Constraints

1. **Free users NEVER reach real users** — enforced in `findEligibleUsers` (returns empty if `!me.hasPaid`) and in relay safety gate
2. **One free AI chat per lifetime** — `chatCount > 0` check blocks second attempt even after account wipe (chatCount stays)
3. **Atomic pairing** — DB transaction with WHERE state='idle' prevents any user being connected to two people simultaneously
4. **No duplicate AI replies** — `fakeReplySet` prevents concurrent `fakeAutoReply` calls for same user
5. **No double pay gate** — timer only fires pay gate if user is STILL in fake chat; if they stopped manually, `stopChat` already handled it
6. **Stale keyboards fixed on restart** — startup cleanup pushes fresh Telegram keyboards to all affected users so "✅ Premium" or "🛑 Stop Chat" never stays stuck
7. **No phantom premium** — `/grant` refuses to create a user record if the user hasn't started the bot yet
8. **Gender-blind real matching** — paid users match with anyone regardless of preference
9. **Per-user message lock** — `processingSet` prevents rapid button taps from causing concurrent DB operations for same user
10. **Profile wipe on re-setup** — "🚀 Setup Profile" AND "✏️ Edit Profile" both wipe all profile fields and restart from step 1. There is no incremental field editing.

---

## Error Handling

- **Unhandled promise rejections** — caught globally, logged, and a warning is sent to admin's Telegram chat
- **Relay failure (user blocked bot)** — caught in try/catch, both users reset to idle and notified
- **DB transaction failure** — handled gracefully with silent fallback if user is already matched
- **Timer errors** — logged but non-fatal
- **Bot polling 409 errors** — suppressed (expected during restart overlap window)
- **Startup cleanup failures** — logged but non-fatal (bot continues to run)
