import { type NextRequest, NextResponse } from "next/server";
import { logEdit } from "@/lib/audit/log-edit";
import { sendDeliveryPhotoToCustomer } from "@/lib/claude/photo-matcher";
import { compressUploadedImage } from "@/lib/images/compress";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

type UploadedImage = Awaited<ReturnType<typeof compressUploadedImage>>;

export async function GET(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const { searchParams } = new URL(req.url);
  const date =
    searchParams.get("date") ?? new Date().toISOString().slice(0, 10);

  const db = createAdminClient();
  const { data, error } = await db
    .from("delivery_proofs")
    .select(
      "*, subcontractors(name), customers:matched_customer_id(name, phone_number)",
    )
    .gte("received_at", `${date}T00:00:00Z`)
    .lt("received_at", `${date}T23:59:59Z`)
    .order("received_at", { ascending: false });

  if (error)
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );

  // Generate signed URLs for images
  const withSignedUrls = await Promise.all(
    (data ?? []).map(async (proof) => {
      if (!proof.image_url) return proof;
      const path = proof.image_url.split("/delivery-proofs/")[1];
      if (!path) return proof;
      const { data: signedUrl } = await db.storage
        .from("delivery-proofs")
        .createSignedUrl(path, 3600);
      return { ...proof, signed_url: signedUrl?.signedUrl ?? null };
    }),
  );

  return NextResponse.json({ ok: true, data: withSignedUrls });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const body = (await req.json()) as {
    id: string;
    action: "send" | "unmatch";
    customer_id?: string;
  };

  const db = createAdminClient();

  if (body.action === "send" && body.customer_id) {
    await sendDeliveryPhotoToCustomer(
      body.id,
      body.customer_id,
      undefined,
      user.email,
    );
    await db
      .from("delivery_proofs")
      .update({
        matched_customer_id: body.customer_id,
        match_method: "manual",
        status: "manually_sent",
        sent_to_customer_at: new Date().toISOString(),
        sent_by: user.email,
      })
      .eq("id", body.id);
  } else if (body.action === "unmatch") {
    await db
      .from("delivery_proofs")
      .update({ status: "unmatched" })
      .eq("id", body.id);
  }

  await logEdit({
    db,
    actor: user.email ?? "",
    entityType: "delivery_proofs",
    entityId: body.id,
    action: body.action,
    changes: { customer_id: body.customer_id ?? null },
  });

  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const customerId = formData.get("customer_id") as string | null;
  const subcontractorId = formData.get("subcontractor_id") as string | null;
  const mealType = formData.get("meal_type") as string | null;
  const date =
    (formData.get("date") as string | null) ??
    new Date().toISOString().slice(0, 10);

  if (!file || !customerId) {
    return NextResponse.json(
      { ok: false, error: "file and customer_id required" },
      { status: 400 },
    );
  }
  if (!file.type.startsWith("image/")) {
    return NextResponse.json(
      { ok: false, error: "File must be an image" },
      { status: 400 },
    );
  }

  const db = createAdminClient();
  let image: UploadedImage;
  try {
    image = await compressUploadedImage(Buffer.from(await file.arrayBuffer()));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Image compression failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }

  const storagePath = `manual/${date}/${customerId}/${Date.now()}.${image.extension}`;

  const { error: uploadErr } = await db.storage
    .from("delivery-proofs")
    .upload(storagePath, image.buffer, {
      contentType: image.contentType,
      upsert: false,
    });

  if (uploadErr)
    return NextResponse.json(
      { ok: false, error: uploadErr.message },
      { status: 500 },
    );

  const { data: urlData } = db.storage
    .from("delivery-proofs")
    .getPublicUrl(storagePath);

  // Uploaded from a row on the sheet, so the meal is known exactly rather than
  // inferred — this is the one path that never has to guess which delivery the
  // photo is of.
  const { data: uploadedFor } = mealType
    ? await db
        .from("daily_deliveries")
        .select("id")
        .eq("customer_id", customerId)
        .eq("delivery_date", date)
        .eq("meal_type", mealType)
        .maybeSingle()
    : { data: null };

  const { data: proof, error: insertErr } = await db
    .from("delivery_proofs")
    .insert({
      image_url: urlData.publicUrl,
      matched_customer_id: customerId,
      matched_delivery_id: uploadedFor?.id ?? null,
      subcontractor_id: subcontractorId ?? null,
      match_method: "admin_upload",
      status: "admin_uploaded",
      received_at: new Date(`${date}T12:00:00Z`).toISOString(),
      sent_by: user.email,
    })
    .select("id")
    .single();

  if (insertErr)
    return NextResponse.json(
      { ok: false, error: insertErr.message },
      { status: 500 },
    );

  return NextResponse.json({ ok: true, data: proof });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const { id } = (await req.json()) as { id: string };
  if (!id)
    return NextResponse.json(
      { ok: false, error: "id required" },
      { status: 400 },
    );

  const db = createAdminClient();
  const { data: proof } = await db
    .from("delivery_proofs")
    .select("image_url")
    .eq("id", id)
    .single();

  if (proof?.image_url) {
    const path = proof.image_url.split("/delivery-proofs/")[1];
    if (path) await db.storage.from("delivery-proofs").remove([path]);
  }

  const { error } = await db.from("delivery_proofs").delete().eq("id", id);
  if (error)
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );

  // The proof row and its image are both gone; this is what is left of it.
  await logEdit({
    db,
    actor: user.email ?? "",
    entityType: "delivery_proofs",
    entityId: id,
    action: "delete",
    changes: { image_url: proof?.image_url ?? null },
  });

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
