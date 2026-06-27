import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const MAX_UPDATES = 200;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PATCH(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const db = createAdminClient();

  const { data: adminUser, error: adminError } = await db
    .from("admin_users")
    .select("email")
    .eq("email", user.email)
    .maybeSingle();
  if (adminError) {
    return NextResponse.json(
      { ok: false, error: adminError.message },
      { status: 500 },
    );
  }
  if (!adminUser) {
    return NextResponse.json(
      { ok: false, error: "Forbidden" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON" },
      { status: 400 },
    );
  }

  const parsed = parseUpdates(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: parsed.error },
      { status: 400 },
    );
  }
  if (parsed.updates.length === 0) return NextResponse.json({ ok: true });

  const ids = parsed.updates.map((u) => u.id);
  const { data: routedCustomers, error: fetchError } = await db
    .from("customers")
    .select("id")
    .in("id", ids)
    .not("delivery_route", "is", null);
  if (fetchError) {
    return NextResponse.json(
      { ok: false, error: fetchError.message },
      { status: 500 },
    );
  }

  const routedIds = new Set((routedCustomers ?? []).map((c) => c.id));
  const invalidId = ids.find((id) => !routedIds.has(id));
  if (invalidId) {
    return NextResponse.json(
      { ok: false, error: "All customers must belong to a delivery route" },
      { status: 400 },
    );
  }

  const results = await Promise.all(
    parsed.updates.map(({ id, delivery_position }) =>
      db
        .from("customers")
        .update({ delivery_position })
        .eq("id", id)
        .not("delivery_route", "is", null),
    ),
  );
  const failed = results.find((result) => result.error);
  if (failed?.error) {
    return NextResponse.json(
      { ok: false, error: failed.error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}

function parseUpdates(
  body: unknown,
):
  | { ok: true; updates: { id: string; delivery_position: number }[] }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object" || !("updates" in body)) {
    return { ok: false, error: "updates required" };
  }

  const updates = (body as { updates: unknown }).updates;
  if (!Array.isArray(updates)) {
    return { ok: false, error: "updates must be an array" };
  }
  if (updates.length > MAX_UPDATES) {
    return { ok: false, error: `updates cannot exceed ${MAX_UPDATES} rows` };
  }

  const seen = new Set<string>();
  const parsed: { id: string; delivery_position: number }[] = [];
  for (const item of updates) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: "each update must be an object" };
    }

    const { id, delivery_position: position } = item as {
      id?: unknown;
      delivery_position?: unknown;
    };
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      return { ok: false, error: "each update requires a valid customer id" };
    }
    if (seen.has(id)) {
      return { ok: false, error: "duplicate customer id in updates" };
    }
    if (
      typeof position !== "number" ||
      !Number.isInteger(position) ||
      position < 0
    ) {
      return {
        ok: false,
        error: "delivery_position must be a non-negative integer",
      };
    }

    seen.add(id);
    parsed.push({ id, delivery_position: position });
  }

  return { ok: true, updates: parsed };
}

export const dynamic = "force-dynamic";
