import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole } from "@/lib/supabase/get-role";

const PAGE_SIZE = 50;

/**
 * The `edit_log` timeline, newest first. Until this existed the table had been
 * collecting rows for months with nothing in the app that read them, so "who
 * changed this" was a question only answerable from a SQL prompt.
 *
 * Paginated with `.range()` rather than a fixed `.limit()`: the list has to be
 * complete to be worth anything, and a capped window drops the older half
 * silently.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const session = await getSessionWithRole();
  if (!session)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const { searchParams } = new URL(req.url);
  const page = Math.max(0, Number(searchParams.get("page") ?? 0));
  const entityType = searchParams.get("entity_type");
  const actor = searchParams.get("actor");
  const entityId = searchParams.get("entity_id");

  const db = createAdminClient();
  let query = db
    .from("edit_log")
    .select(
      "id, entity_type, entity_id, action, changed_by, changes, created_at",
      {
        count: "exact",
      },
    )
    .order("created_at", { ascending: false })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

  if (entityType) query = query.eq("entity_type", entityType);
  if (actor) query = query.eq("changed_by", actor);
  if (entityId) query = query.eq("entity_id", entityId);

  const { data, error, count } = await query;
  if (error)
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );

  return NextResponse.json({
    ok: true,
    data: data ?? [],
    total: count ?? 0,
    page,
    pageSize: PAGE_SIZE,
  });
}

export const dynamic = "force-dynamic";
