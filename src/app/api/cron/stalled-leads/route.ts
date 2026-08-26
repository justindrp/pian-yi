import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { logEdit } from "@/lib/audit/log-edit";
import { getSetting } from "@/lib/cache/settings";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

// Leads whose last word was theirs, and nobody answered.
//
// `abandoned-recovery` claims in its own comment to find "customers in
// 'ordering' state with no order placed", but it then does
// `if (!order) continue` on a `pending_payment` row — so it only ever recovers
// leads who already have an order. A lead the bot never converted has no order
// row at all and was therefore invisible to every scheduled job we run.
//
// That is not hypothetical. On 2026-08-12 +628159000176 filled in the whole
// form (name, BSD address, maps pin), narrowed to 1–5 September, answered the
// bot's own clarifying question at 17:59 with "2 porsi makan siang + 2 porsi
// makan malam" — and the bot never replied again. 4 porsi × 5 days ≈
// Rp 540.000, and no flag was ever raised, so no admin could have known.
//
// This job does NOT message the customer. It raises the same
// `needs_human_review` flag the webhook's own escalations use and pushes to the
// admins, for two reasons: every business-initiated send currently fails on
// `131042` while the WABA payment restriction stands, and a lead who has been
// waiting days is owed a human, not a second robot.

/** Only flag a thread whose last message is the customer's — a real question nobody answered. */
type Msg = {
  customer_id: string | null;
  role: string;
  content: string | null;
  created_at: string | null;
};

export async function GET(req: NextRequest): Promise<Response> {
  if (req.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const db = createAdminClient();
  const hoursRaw = await getSetting("stalled_lead_hours");
  const hours = Number.parseInt(hoursRaw ?? "3", 10) || 3;
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  // Every customer who has ever had an order, so "lead" means what it says.
  // Walked rather than selected in one go: `orders` is past the 1000-row cap,
  // and a truncated set here would flag paying customers as abandoned leads.
  const ordered = await fetchAllRows<{ customer_id: string | null }>(
    (from, to) =>
      db
        .from("orders")
        .select("customer_id")
        .not("customer_id", "is", null)
        .range(from, to),
  );
  if (ordered.error) {
    return NextResponse.json(
      { ok: false, error: ordered.error },
      { status: 500 },
    );
  }
  const hasOrder = new Set(ordered.rows.map((o) => o.customer_id));

  const states = await fetchAllRows<{ customer_id: string }>((from, to) =>
    db
      .from("customer_state")
      .select("customer_id")
      .eq("state", "ordering")
      .range(from, to),
  );
  if (states.error) {
    return NextResponse.json(
      { ok: false, error: states.error },
      { status: 500 },
    );
  }

  const candidates = states.rows
    .map((s) => s.customer_id)
    .filter((id) => !hasOrder.has(id));
  if (candidates.length === 0)
    return NextResponse.json({ ok: true, flagged: 0 });

  // Already-flagged leads are skipped, not re-pushed. Same rule as
  // flagOrderAtRisk: one push per unresolved flag, or an admin who has already
  // been told gets told again every four hours until they act.
  const { data: flagRows } = await db
    .from("customer_flags")
    .select("customer_id, needs_human_review, escalated_to_human")
    .in("customer_id", candidates);
  const flagged = new Set(
    (flagRows ?? [])
      .filter(
        (f) => f.needs_human_review === true || f.escalated_to_human === true,
      )
      .map((f) => f.customer_id),
  );

  const pending = candidates.filter((id) => !flagged.has(id));
  if (pending.length === 0) return NextResponse.json({ ok: true, flagged: 0 });

  const newlyFlagged: { id: string; label: string; asked: string }[] = [];

  // Chunked so the `.in()` list cannot outgrow what PostgREST will take.
  for (let i = 0; i < pending.length; i += 200) {
    const chunk = pending.slice(i, i + 200);
    const msgs = await fetchAllRows<Msg>((from, to) =>
      db
        .from("conversations")
        .select("customer_id, role, content, created_at")
        .in("customer_id", chunk)
        .order("created_at", { ascending: true })
        .range(from, to),
    );
    if (msgs.error) {
      return NextResponse.json(
        { ok: false, error: msgs.error },
        { status: 500 },
      );
    }

    // Ordered ascending, so the last write per customer wins. Rows with no
    // customer_id or no timestamp cannot be attributed or aged and are dropped
    // rather than treated as the newest message.
    const lastByCustomer = new Map<string, Msg>();
    for (const m of msgs.rows) {
      if (!m.customer_id || !m.created_at) continue;
      lastByCustomer.set(m.customer_id, m);
    }

    const { data: customers } = await db
      .from("customers")
      .select("id, name, phone_number")
      .in("id", chunk);
    const byId = new Map((customers ?? []).map((c) => [c.id, c]));

    for (const id of chunk) {
      const last = lastByCustomer.get(id);
      // The bot spoke last: an ordinary drop-off, not a dropped thread. Flagging
      // those would put all 61 browsing leads in front of an admin at once.
      if (!last?.created_at || last.role !== "user") continue;
      if (last.created_at > cutoff) continue;

      const c = byId.get(id);
      const label = c?.name?.trim() || c?.phone_number || id;
      const asked = (last.content ?? "").replace(/\s+/g, " ").slice(0, 120);
      const waited = Math.floor(
        (Date.now() - new Date(last.created_at).getTime()) / 3600_000,
      );

      const { error } = await db.from("customer_flags").upsert(
        {
          customer_id: id,
          needs_human_review: true,
          escalation_reason: `Lead menunggu balasan ${waited} jam, belum ada order: "${asked}"`,
        },
        { onConflict: "customer_id" },
      );
      if (error) {
        console.error(`[stalled-leads] could not flag ${id}:`, error.message);
        continue;
      }

      await logEdit({
        db,
        actor: "system:cron:stalled-leads",
        entityType: "customer_flags",
        entityId: id,
        action: "update",
        changes: { needs_human_review: { from: false, to: true } },
      });

      newlyFlagged.push({ id, label, asked });
    }
  }

  if (newlyFlagged.length > 0) {
    const first = newlyFlagged[0];
    await sendPushToAllAdmins(
      newlyFlagged.length === 1
        ? `Lead belum dibalas — ${first.label}`
        : `${newlyFlagged.length} lead belum dibalas`,
      newlyFlagged.length === 1
        ? first.asked
        : `Terlama: ${first.label} — "${first.asked}"`,
      "/inbox",
      "high",
    );
  }

  console.log(
    `[stalled-leads] flagged ${newlyFlagged.length} of ${pending.length} candidates`,
  );
  return NextResponse.json({ ok: true, flagged: newlyFlagged.length });
}

export const dynamic = "force-dynamic";
