import { type NextRequest, NextResponse } from "next/server";
import { logEdit } from "@/lib/audit/log-edit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { TablesUpdate } from "@/types/database";

// Explicit allowlist, never mass assignment (CLAUDE.md, "allowlist field
// updates"). done_at and updated_at are derived below, not taken from input.
const EDITABLE = [
  "title",
  "body",
  "status",
  "priority",
  "area",
  "assignee",
  "customer_id",
  "order_id",
  "blocked_on",
  "due_date",
] as const;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
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

  const { id } = await params;
  const input = (await req.json()) as Record<string, unknown>;

  const db = createAdminClient();
  const { data: before, error: readError } = await db
    .from("tasks")
    .select("*")
    .eq("id", id)
    .single();
  if (readError || !before) {
    return NextResponse.json(
      { ok: false, error: "Task not found" },
      { status: 404 },
    );
  }

  const update: TablesUpdate<"tasks"> = { updated_at: new Date().toISOString() };
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of EDITABLE) {
    if (!(field in input)) continue;
    const value = input[field];
    const normalised =
      typeof value === "string" ? value.trim() || null : (value ?? null);
    if (normalised === (before as Record<string, unknown>)[field]) continue;
    (update as Record<string, unknown>)[field] = normalised;
    changes[field] = {
      from: (before as Record<string, unknown>)[field],
      to: normalised,
    };
  }

  // done_at answers "what shipped this week"; status stays the truth. Clearing
  // it when a task reopens keeps the two from disagreeing.
  if (update.status !== undefined) {
    update.done_at = update.status === "done" ? new Date().toISOString() : null;
  }

  if (Object.keys(changes).length === 0) {
    return NextResponse.json({ ok: true, data: before });
  }

  const { data, error } = await db
    .from("tasks")
    .update(update)
    .eq("id", id)
    .select(
      "*, customers(id, name, phone_number), orders(id, package_size, status, total_price)",
    )
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
    entityId: id,
    action: "update",
    changes,
  });

  return NextResponse.json({ ok: true, data });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
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

  const { id } = await params;
  const db = createAdminClient();
  // The whole row goes into the audit entry: tasks are deleted outright rather
  // than tombstoned, so this is the only remaining record of what was dropped.
  const { data: before } = await db
    .from("tasks")
    .select("*")
    .eq("id", id)
    .single();

  const { error } = await db.from("tasks").delete().eq("id", id);
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
    entityId: id,
    action: "delete",
    changes: { deleted: before ?? {} },
  });

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
