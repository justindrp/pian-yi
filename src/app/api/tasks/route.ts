import { type NextRequest, NextResponse } from "next/server";
import { logEdit } from "@/lib/audit/log-edit";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { STATUS_RANK, badRequest, text, validateTaskInput } from "./validate";

// A task may point at the customer or order it is about. The embed is the whole
// reason this lives in the app rather than in Asana: "Cindi — second address
// missing" resolves to her record instead of naming her in a sentence.
const SELECT = `
  *,
  customers(id, name, phone_number),
  orders(id, package_size, status, total_price)
`;

export async function GET(): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const db = createAdminClient();
  // Paged rather than a bare select: PostgREST caps one response at 1000 rows
  // and says nothing when it truncates (CLAUDE.md, principle 9).
  const { rows, error } = await fetchAllRows<{ status: string }>((from, to) =>
    db
      .from("tasks")
      .select(SELECT)
      .order("priority", { ascending: true })
      .order("created_at", { ascending: true })
      .range(from, to),
  );

  if (error) {
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }

  // Open work first, done last. Ordering on the status column itself sorts it
  // alphabetically, which puts `done` second — ahead of `in_progress` and
  // `open` — so the rank is applied here instead.
  const data = rows.sort(
    (a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9),
  );
  return NextResponse.json({ ok: true, data });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  let body: {
    title?: unknown;
    body?: unknown;
    status?: unknown;
    priority?: unknown;
    area?: unknown;
    assignee?: unknown;
    customer_id?: unknown;
    order_id?: unknown;
    blocked_on?: unknown;
    due_date?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return badRequest("Body is not valid JSON");
  }

  const invalid = validateTaskInput(body, { titleRequired: true });
  if (invalid) return badRequest(invalid);

  const db = createAdminClient();
  // id, created_at, updated_at and done_at are server-controlled and never
  // accepted from the client (CLAUDE.md, "server-controlled fields").
  const { data, error } = await db
    .from("tasks")
    .insert({
      title: text(body.title) as string,
      body: text(body.body),
      status: (text(body.status) ?? "open") as string,
      priority: (body.priority as number | undefined) ?? 2,
      area: text(body.area),
      assignee: text(body.assignee),
      customer_id: text(body.customer_id),
      order_id: text(body.order_id),
      blocked_on: text(body.blocked_on),
      due_date: text(body.due_date),
      done_at: body.status === "done" ? new Date().toISOString() : null,
    })
    .select(SELECT)
    .single();

  if (error) {
    // 23503 is a customer_id or order_id that points at nothing. That is the
    // caller's mistake, not ours, and the raw Postgres sentence helps nobody.
    if (error.code === "23503")
      return badRequest("Linked customer or order does not exist");
    console.error("[tasks] insert failed", error.message);
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  await logEdit({
    db,
    actor: user.email ?? "",
    entityType: "tasks",
    entityId: data.id,
    action: "create",
    changes: { title: data.title, status: data.status, priority: data.priority },
  });

  return NextResponse.json({ ok: true, data });
}

export const dynamic = "force-dynamic";
