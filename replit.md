# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Telegram Bot**: node-telegram-bot-api (polling mode)

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   └── api-server/         # Express API server + Telegram dating bot
│       └── src/bot/bot.ts  # Telegram bot logic
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
│       └── src/schema/users.ts  # Dating bot user schema
├── scripts/                # Utility scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## Telegram Dating Bot

Bot username: @Mydatingbabybot

Features:
- Profile setup flow: name, age, gender, looking-for, bio, country
- Smart matching based on gender preferences
- Real-time relay chat between matched users
- Stop/end chat anytime

Commands:
- /start — Start the bot
- /profile — View profile
- /edit — Edit profile
- /match — Find a match
- /stop — End current chat
- /help — Show help

Secret required: `TELEGRAM_BOT_TOKEN`

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Database Schema

### `users` table
- `id` — Telegram user ID (bigint, primary key)
- `telegram_username`, `first_name`, `name` — identity
- `age`, `gender`, `looking_for` — matching criteria
- `bio`, `country` — profile info
- `is_profile_complete`, `is_active` — status flags
- `state` — bot FSM state (idle, setup_*, chatting)
- `chatting_with` — current chat partner ID
