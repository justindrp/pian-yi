import { type NextRequest, NextResponse } from "next/server";
import { logEdit } from "@/lib/audit/log-edit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

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
  // Open work first, highest priority first, oldest first inside a priority.
  // Done tasks come last rather than being hidden — the list filters them.
  const { data, error } = await db
    .from("tasks")
    .select(SELECT)
    .order("status", { ascending: true })
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }
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

  const body = (await req.json()) as {
    title?: string;
    body?: string | null;
    status?: string;
    priority?: number;
    area?: string | null;
    assignee?: string | null;
    customer_id?: string | null;
    order_id?: string | null;
    blocked_on?: string | null;
    due_date?: string | null;
  };

  if (!body.title?.trim()) {
    return NextResponse.json(
      { ok: false, error: "title required" },
      { status: 400 },
    );
  }

  const db = createAdminClient();
  // id, created_at, updated_at and done_at are server-controlled and never
  // accepted from the client (CLAUDE.md, "server-controlled fields").
  const { data, error } = await db
    .from("tasks")
    .insert({
      title: body.title.trim(),
      body: body.body?.trim() || null,
      status: body.status ?? "open",
      priority: body.priority ?? 2,
      area: body.area?.trim() || null,
      assignee: body.assignee?.trim() || null,
      customer_id: body.customer_id || null,
      order_id: body.order_id || null,
      blocked_on: body.blocked_on?.trim() || null,
      due_date: body.due_date || null,
      done_at: body.status === "done" ? new Date().toISOString() : null,
    })
    .select(SELECT)
    .single();

  if (error) {
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
