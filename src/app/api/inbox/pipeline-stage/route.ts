import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const STAGES = [
  "browsing",
  "ordering",
  "awaiting_payment",
  "payment_proof_received",
  "active_subscription",
] as const;

type PipelineStage = (typeof STAGES)[number];

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
    customer_id?: string;
    stage?: PipelineStage;
  };
  const { customer_id, stage } = body;

  if (!customer_id || !stage || !STAGES.includes(stage)) {
    return NextResponse.json(
      { ok: false, error: "customer_id and valid stage required" },
      { status: 400 },
    );
  }

  const db = createAdminClient();
  const now = new Date().toISOString();

  const { data: customer, error: customerErr } = await db
    .from("customers")
    .select("id")
    .eq("id", customer_id)
    .single();

  if (customerErr || !customer) {
    return NextResponse.json(
      { ok: false, error: "Customer not found" },
      { status: 404 },
    );
  }

  const { data: latestOrder } = await db
    .from("orders")
    .select("id, status")
    .eq("customer_id", customer_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const latestOrderId = latestOrder?.id ?? null;

  if (
    (stage === "awaiting_payment" ||
      stage === "payment_proof_received" ||
      stage === "active_subscription") &&
    !latestOrderId
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: "This stage requires an existing order for the customer",
      },
      { status: 400 },
    );
  }

  const stateUpdate: Record<string, string | null> = {
    state: stage,
    updated_at: now,
  };

  if (stage === "browsing" || stage === "ordering") {
    const { error } = await db
      .from("customer_state")
      .upsert({ customer_id, ...stateUpdate }, { onConflict: "customer_id" });
    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    }
  }

  if (stage === "awaiting_payment") {
    if (!latestOrderId) {
      return NextResponse.json(
        {
          ok: false,
          error: "This stage requires an existing order for the customer",
        },
        { status: 400 },
      );
    }

    if (latestOrder?.status !== "pending_payment") {
      const { error } = await db
        .from("orders")
        .update({ status: "pending_payment" })
        .eq("id", latestOrderId)
        .in("status", ["payment_proof_received"]);
      if (error) {
        return NextResponse.json(
          { ok: false, error: error.message },
          { status: 500 },
        );
      }
    }

    const { error } = await db
      .from("customer_state")
      .upsert({ customer_id, ...stateUpdate }, { onConflict: "customer_id" });
    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    }
  }

  if (stage === "payment_proof_received") {
    if (!latestOrderId) {
      return NextResponse.json(
        {
          ok: false,
          error: "This stage requires an existing order for the customer",
        },
        { status: 400 },
      );
    }

    const { error: orderErr } = await db
      .from("orders")
      .update({ status: "payment_proof_received" })
      .eq("id", latestOrderId)
      .eq("status", "pending_payment");
    if (orderErr) {
      return NextResponse.json(
        { ok: false, error: orderErr.message },
        { status: 500 },
      );
    }

    const { error: stateErr } = await db
      .from("customer_state")
      .upsert({ customer_id, ...stateUpdate }, { onConflict: "customer_id" });
    if (stateErr) {
      return NextResponse.json(
        { ok: false, error: stateErr.message },
        { status: 500 },
      );
    }
  }

  if (stage === "active_subscription") {
    if (!latestOrderId) {
      return NextResponse.json(
        {
          ok: false,
          error: "This stage requires an existing order for the customer",
        },
        { status: 400 },
      );
    }

    const { error: orderErr } = await db
      .from("orders")
      .update({ status: "active", paid_at: now })
      .eq("id", latestOrderId)
      .in("status", ["pending_payment", "payment_proof_received"]);
    if (orderErr) {
      return NextResponse.json(
        { ok: false, error: orderErr.message },
        { status: 500 },
      );
    }

    const { error: stateErr } = await db
      .from("customer_state")
      .upsert({ customer_id, ...stateUpdate }, { onConflict: "customer_id" });
    if (stateErr) {
      return NextResponse.json(
        { ok: false, error: stateErr.message },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ ok: true, stage });
}

export const dynamic = "force-dynamic";
