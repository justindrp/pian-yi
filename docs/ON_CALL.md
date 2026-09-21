# On call

For whoever is running Pian Yi's operations while Justin is not around. Written
2026-09-21, for a cover period to roughly 2026-12-21.

The person on call here is **not a developer**. That is the premise of this
file, and it changes what the rules have to be: there is nobody downstream
reading the diff, so every rule below has to hold on its own rather than be
caught later.

Read `CLAUDE.md` first — it is the map. This file is the part that is only true
while nobody is watching.

## What "on call" covers

Yes, on your own:

- Replying to customers, including hand-typed replies the bot got wrong
- Fixing delivery rows — a wrong date, a wrong kitchen, a meal that should not
  be on a sheet, one that should be
- Orders: marking paid, pausing, resuming, cancelling
- Anything in `pnpm tasks`

Still worth a message to Justin first, even though nothing blocks you:

- A price that is not on the ladder, a refund, a goodwill package
- A new subcontractor, or deactivating one — deactivating can remove a delivery
  area entirely, because some areas rest on a single kitchen
- A migration (anything in `supabase/migrations/`). A push to `main` applies it
  to production by itself
- Anything in Accounting that is not reading

## First time on this laptop

```bash
git clone https://github.com/justindrp/pian-yi.git
cd pian-yi
nvm use                 # Node 26.3.1, pinned in .nvmrc
pnpm install            # also sets core.hooksPath, so the pre-push gate runs
```

Then, none of which is in the repo and all of which someone has to hand you:

- `.env.local` — **AirDrop, never WhatsApp.** It holds the master key to the
  production database and the token that sends as Pian Yi on WhatsApp. A file
  sent over WhatsApp sits in two chat histories and both phone backups forever
- `supabase login`, `railway login`, `gh auth login`
- Push access to the repo (it is public, so cloning works and pushing does not
  until you are added)

Check it worked:

```bash
pnpm tasks              # should print the queue
pnpm check-balance      # should print a dollar figure
```

## Every session, before anything that writes

```bash
pnpm backup
```

Takes about a minute, writes a 4 MB file to `.backup/`. Do it before running
any script that changes data, every time, even when the change looks small.

The reason is specific: this project is on Supabase Free, which has **no
point-in-time recovery**. There is no "undo", no "restore to 10 minutes ago".
If a script deletes the wrong rows, the only thing that gets them back is a
dump someone took beforehand. Until 2026-09-21 there were none at all.

`.backup/` is gitignored and must stay that way. The dump is every customer's
name, phone number and address plus the whole ledger, and this repo is public.

## The rules that do not bend

**Dry run first, `--apply` second.** The scripts here default to printing what
they would do and changing nothing. Read that output. Then re-run with
`--apply`. If Claude writes you a new script, ask it for the dry run first —
it will offer one if you ask, and a script that only has an apply mode is a
script to push back on.

**Never say a kitchen's real name to a customer.** Not one of them, not any
kitchen added later — and that is why this file does not list them either, the
same rule CLAUDE.md applies to every doc and prompt. Read the names from the
`subcontractors` table when you need them; customers see `customer_nickname`
only, or "dapur partner kami". If a customer names a supplier, neither confirm
nor deny. That partner kitchens exist is not secret; which ones they are, is.

**Indonesian to customers, always.** "Kak" as the honorific, under 200 words,
emojis rarely. Never English, even if they write in English.

**Skipping a delivery is a deletion, and it goes through `deleteDelivery()`.**
Not a status change — there is no status column and adding one back breaks the
kitchen sheets. `deleteDelivery()` copies the whole row into `edit_log` first,
which is the only thing that can rebuild it. A raw `DELETE` on
`daily_deliveries` loses the row for good.

**Never delete from `edit_log`, `processed_messages` or `conversation_logs`.**
They are the record of what happened. If something goes wrong in week six,
they are how anyone finds out what.

**The cutoff is 16:00 WIB the day before.** After that the kitchen has the
sheet: the day cannot be booked, cancelled, or re-addressed. This applies to
you as much as to the bot.

**Never commit `.env.local` or anything from `.backup/`.** Public repo.

## The jobs, with commands

```bash
pnpm tasks                        # the queue. Start here
pnpm tasks <area>                 # filter
pnpm review-chats                 # threads with inbound in the last 24h
pnpm review-chats --waiting       # threads a human still owes an answer
pnpm review-chats --phone +62...  # one customer's whole thread
pnpm review-deliveries            # delivery rows that look wrong
pnpm review-leads                 # lead threads
pnpm check-balance                # DeepSeek credit (see below)
pnpm backup                       # before any write
```

Sending one message by hand — dry run, then apply:

```bash
pnpm exec tsx --env-file=.env.local scripts/manual-send.ts +62812... "Halo kak, ..."
pnpm exec tsx --env-file=.env.local scripts/manual-send.ts +62812... "Halo kak, ..." --apply
```

The `--env-file` is not optional — this script has no `dotenv` import, so
without it the credentials are simply absent and the failure is confusing
rather than obvious.

For anything else, describe the problem to Claude Code in the repo and let it
find the path. It has all of `CLAUDE.md` and `docs/`. Give it the customer's
phone number or the date, and ask it to show you what it will change before it
changes anything.

## When something is on fire

**The bot went silent.** Run `pnpm check-balance`. DeepSeek is prepaid with no
auto-debit, so the balance reaches zero on its own and the bot stops mid
conversation. It has happened three times — 24 August, 5-6 September, 16
September. Top it up with the Jago debit card. This is the single most common
outage and the least dramatic to fix.

**A message to a customer failed with `131042`.** The WhatsApp account has a
payment restriction, so any message sent *because the 24-hour window closed*
fails. Nothing is broken inside an open window. The fix is to get the customer
to message us first — not to wait, and not to retry. There is a second, manual
WhatsApp number for exactly this: **+6285128024390**.

Note that a send can return "accepted" and still fail; the failure only shows
up in the status webhook afterwards. A successful send is not proof of
delivery.

**A push was rejected.** The pre-push hook ran `pnpm lint`, `pnpm typecheck`
and the 969 tests, and one of them failed. That is the gate working. Do not
push with `--no-verify`. Ask Claude to fix what failed.

**The deploy broke the site.** Railway deploys `main` automatically. Revert the
commit and push the revert — `git revert <sha>` — rather than trying to fix
forward while it is down.

## Restoring from a backup

Honest caveat: **this path has not been tested.** The dump has been verified to
be complete and readable — 40 tables, 41,325 rows, valid gzip, valid JSON, row
counts matching the database — but no one has yet loaded one back into a
database. Test it on a local stack before you ever need it in anger, not
during the incident.

The dump is data only. The schema lives in `supabase/migrations/`, so a restore
is: apply the migrations to an empty database, then insert the rows back.

To read one:

```bash
node -e 'const z=require("zlib"),f=require("fs");
const j=JSON.parse(z.gunzipSync(f.readFileSync(process.argv[1])));
console.log(Object.keys(j.tables).length,"tables"); console.log(j.counts);' \
  .backup/pian-yi-<stamp>.json.gz
```

In practice, most recoveries are one table or a handful of rows, not the whole
database. Give Claude Code the dump file and tell it which rows went missing —
that is a much smaller job than a full restore, and the far more likely one.

## What has not been built

Named here so nobody assumes otherwise:

- **The backup does not run on a schedule.** `pnpm backup` is manual. If nobody
  runs it, there is no backup for that day.
- **There is no restricted database key.** The credential in `.env.local` can
  change or delete anything, including the audit tables. Nothing enforces the
  rules in this file except the person reading it.
