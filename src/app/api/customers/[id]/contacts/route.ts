import { NextResponse } from "next/server";
import { logEdit } from "@/lib/audit/log-edit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { normalizePhone } from "@/lib/utils/phone";

export const dynamic = "force-dynamic";

async function requireUser(): Promise<{ email: string } | { error: Response }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return {
      error: NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      ),
    };
  return { email: user.email ?? "" };
}

// GET — the numbers allowed to ask for this customer's delivery photos.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const { data, error } = await createAdminClient()
    .from("customer_contacts")
    .select("id, phone_number, name, created_at")
    .eq("customer_id", id)
    .order("created_at", { ascending: true });
  if (error)
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  return NextResponse.json({ ok: true, data });
}

// POST — register a recipient number. The link is proof-only: that number may
// ask for this customer's delivery photos and nothing else.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const body = (await req.json()) as { phone?: string; name?: string };
  const phone = normalizePhone(body.phone);
  if (!phone)
    return NextResponse.json(
      { ok: false, error: "Nomor tidak terbaca" },
      { status: 400 },
    );

  const db = createAdminClient();

  // A number that is already a customer with a purchase stays a customer: the
  // webhook only honours the link while the number has bought nothing itself,
  // so linking one here would promise a restricted thread it will never get.
  const { data: existing } = await db
    .from("customers")
    .select("id, name, orders!orders_customer_id_fkey(id)")
    .eq("phone_number", phone)
    .maybeSingle();
  if (existing?.orders?.length)
    return NextResponse.json(
      {
        ok: false,
        error: `${existing.name ?? phone} sudah jadi customer sendiri — nomornya tidak bisa dijadikan penerima.`,
      },
      { status: 409 },
    );

  const { data, error } = await db
    .from("customer_contacts")
    .insert({ customer_id: id, phone_number: phone, name: body.name || null })
    .select("id, phone_number, name, created_at")
    .single();
  if (error)
    return NextResponse.json(
      {
        ok: false,
        error:
          error.code === "23505"
            ? "Nomor itu sudah terdaftar sebagai penerima customer lain."
            : error.message,
      },
      { status: error.code === "23505" ? 409 : 500 },
    );

  await logEdit({
    db,
    actor: auth.email,
    entityType: "customer_contacts",
    entityId: data.id,
    action: "create",
    changes: { customer_id: id, phone_number: phone, name: data.name },
  });
  return NextResponse.json({ ok: true, data });
}

// DELETE — remove one recipient link. ?contactId=<uuid>
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const contactId = new URL(req.url).searchParams.get("contactId");
  if (!contactId)
    return NextResponse.json(
      { ok: false, error: "contactId wajib diisi" },
      { status: 400 },
    );

  const db = createAdminClient();
  const { data, error } = await db
    .from("customer_contacts")
    .delete()
    .eq("id", contactId)
    .eq("customer_id", id)
    .select("id, phone_number, name")
    .maybeSingle();
  if (error)
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  if (!data)
    return NextResponse.json(
      { ok: false, error: "Penerima tidak ditemukan" },
      { status: 404 },
    );

  await logEdit({
    db,
    actor: auth.email,
    entityType: "customer_contacts",
    entityId: data.id,
    action: "delete",
    changes: { customer_id: id, phone_number: data.phone_number },
  });
  return NextResponse.json({ ok: true });
}
