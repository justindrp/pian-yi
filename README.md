# Pian Yi Catering

WhatsApp-based ordering system for **Pian Yi Catering**, a daily catering business in Tangerang Selatan, Indonesia (BSD City, Gading Serpong, Alam Sutera, Bintaro, Graha Raya).

Two surfaces:

- **Customers** — chat only via WhatsApp with an AI bot (Claude Sonnet 4.6)
- **Admins** — a PWA dashboard for operations (orders, deliveries, payments, inbox, accounting)

## Tech stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js 16.2.6 (App Router, `output: 'standalone'`) + TypeScript |
| Package manager | pnpm (only) |
| Lint / format | Biome (only) |
| Hosting | Railway (always-on Node, Singapore region) |
| Database | Supabase Postgres + Row Level Security |
| Auth | Supabase Auth (magic-link, admins only) |
| AI | Claude Sonnet 4.6 (chat), Haiku 4.5 (classify/photo-match/sentiment) |
| Messaging | Meta WhatsApp Business Cloud API v25.0 |
| Push | `web-push` (VAPID, no Firebase) |
| Data fetching | TanStack Query |
| UI | Tailwind CSS + shadcn/ui |

## Prerequisites

- Node `26.3.1` (see `engines` in `package.json`)
- pnpm
- Supabase CLI
- A Supabase project (local stack or staging) and a Meta WhatsApp app

## Getting started

```bash
pnpm install
cp .env.example .env.local   # fill in env vars
pnpm supabase start          # local Supabase stack
pnpm db:reset                # apply migrations + seed
pnpm dev                     # http://localhost:3000
```

## Scripts

```bash
pnpm dev          # dev server
pnpm build        # production build (standalone)
pnpm start        # serve production build
pnpm lint         # Biome lint
pnpm check        # Biome check (format + lint + imports) — full gate
pnpm typecheck    # tsc --noEmit
pnpm test         # Jest suite
pnpm db:types     # regenerate src/types/database.ts from linked project
pnpm db:push      # push migrations to remote
```

## Architecture principles

1. **HTTP 200 first, process after** — webhook acks Meta immediately, processes async
2. **Idempotency everywhere** — every `message_id` checked against `processed_messages`
3. **Defense in depth** — 9 layers of AI cost protection
4. **Settings over hardcoding** — mutable config lives in the `settings` table
5. **Server-controlled fields** — `id`, `status`, `total_price`, timestamps set server-side
6. **Allowlist field updates** — no mass assignment
7. **Append-only audit logs** — `edit_log`, `processed_messages`, `conversation_logs`

## Project layout

```text
src/
  app/
    (dashboard)/   admin PWA pages (inbox, orders, deliveries, payments, ...)
    (auth)/        login + callback
    api/           webhook, cron, push, and dashboard APIs
  lib/             supabase, claude, whatsapp, push, utils
  components/      ui (shadcn), dashboard, shared
  types/database.ts  (generated)
supabase/migrations/  SQL migrations (Supabase CLI)
test/                 Jest suite
```

WhatsApp webhook (after deploy): `https://<railway-app>.up.railway.app/api/webhook/whatsapp`

See `CLAUDE.md` for full conventions, business rules, and the API route reference.

## Testing

Jest suite under `test/` (Node env, all external deps mocked — no network). A pre-push hook runs `pnpm typecheck && pnpm test` and blocks on failure.

```bash
pnpm test
pnpm test:coverage
```

## Deployment

Railway auto-deploys on push to `main`. Cron jobs hit `/api/cron/*` with a `CRON_SECRET` header. Not deployed to Vercel.

## License

Private. All rights reserved.
