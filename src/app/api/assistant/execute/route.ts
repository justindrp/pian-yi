import { NextResponse } from "next/server";
import { createJournalEntry } from "@/lib/accounting/journal";
import { saveAssistantReply } from "@/lib/claude/assistant-history";
import { WRITE_TOOLS } from "@/lib/claude/assistant-tools";
import { saveMessage } from "@/lib/claude/conversation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole } from "@/lib/supabase/get-role";
import { sendImageMessageById, sendTextMessage, uploadMediaToMeta } from "@/lib/whatsapp/client";

const ALLOWED_CUSTOMER_FIELDS = new Set(["name", "address", "area", "notes"]);

export async function POST(request: Request) {
  const session = await getSessionWithRole();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { tool?: string; input?: Record<string, unknown>; conversationId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const { tool, input, conversationId } = body;
  if (!tool || !input || (tool !== "batch" && !WRITE_TOOLS.has(tool))) {
    return NextResponse.json({ ok: false, error: "Invalid or disallowed tool" }, { status: 400 });
  }

  const db = createAdminClient();

  // Persist the assistant's confirmation reply to the active thread, then respond.
  function reply(text: string) {
    if (conversationId) {
      saveAssistantReply(db, conversationId, text).catch((err) =>
        console.error("[execute] persist reply:", err),
      );
    }
    return NextResponse.json({ ok: true, text, conversationId });
  }

  async function sendAssistantText(phone: string, message: string) {
    await sendTextMessage(phone, message);
    const { data: cust } = await db
      .from("customers")
      .select("id")
      .eq("phone_number", phone)
      .maybeSingle();
    if (cust?.id) {
      await saveMessage({ customerId: cust.id, role: "assistant", content: message, modelUsed: "human" });
    }
  }

  async function sendAssistantImage(phone: string, imageUrl: string, caption: string) {
    const mediaId = await uploadImageUrlToMeta(imageUrl);
    await sendImageMessageById(phone, mediaId, caption);
    const { data: cust } = await db
      .from("customers")
      .select("id")
      .eq("phone_number", phone)
      .maybeSingle();
    if (cust?.id) {
      await saveMessage({
        customerId: cust.id,
        role: "assistant",
        content: imageUrl,
        messageType: "image",
        modelUsed: "human",
      });
    }
  }

  switch (tool) {
    case "batch": {
      const actions = input.actions;
      if (!Array.isArray(actions) || actions.length === 0) {
        return NextResponse.json({ ok: false, error: "actions required" }, { status: 400 });
      }

      for (const action of actions) {
        if (!isWriteAction(action)) {
          return NextResponse.json({ ok: false, error: "Invalid batch action" }, { status: 400 });
        }
        switch (action.tool) {
          case "send_whatsapp_message":
            await sendAssistantText(action.input.phone_number as string, action.input.message as string);
            break;
          case "send_whatsapp_image":
            await sendAssistantImage(
              action.input.phone_number as string,
              action.input.image_url as string,
              action.input.caption as string,
            );
            break;
          default:
            return NextResponse.json(
              { ok: false, error: `Tool '${action.tool}' cannot be batched yet` },
              { status: 400 },
            );
        }
      }

      return reply(`Selesai menjalankan ${actions.length} aksi.`);
    }

    case "mark_order_paid": {
      const orderId = input.order_id as string;
      const { data: order, error: fetchErr } = await db
        .from("orders")
        .select("id, total_price, package_size, customer_id, customers(name, phone_number)")
        .eq("id", orderId)
        .single();
      if (fetchErr || !order) {
        return NextResponse.json({ ok: false, error: "Order not found" }, { status: 404 });
      }

      const { error: updateErr } = await db
        .from("orders")
        .update({ status: "active", paid_at: new Date().toISOString() })
        .eq("id", orderId);
      if (updateErr) {
        return NextResponse.json({ ok: false, error: updateErr.message }, { status: 500 });
      }

      // Conversion tracking (fire-and-forget)
      const convCustomerId = order.customer_id;
      if (convCustomerId) {
        Promise.resolve(
          db.from("customers").select("converted_at").eq("id", convCustomerId).single(),
        ).then(({ data: cust }) => {
          if (cust && !cust.converted_at) {
            const pkgSize = order.package_size ?? 0;
            return db.from("customers").update({
              converted_at: new Date().toISOString(),
              total_portions: pkgSize,
              total_payment: order.total_price ?? 0,
              package: pkgSize > 0 ? `${pkgSize} porsi` : null,
            }).eq("id", convCustomerId);
          }
        }).catch((err: unknown) => console.error("[execute/mark_paid] conversion error:", err));
      }

      // Journal: Dr Bank BCA / Cr Uang Muka Pelanggan (fire-and-forget)
      const today = new Date().toISOString().slice(0, 10);
      createJournalEntry({
        description: "Penerimaan pembayaran pesanan",
        date: today,
        sourceType: "order_payment",
        sourceId: orderId,
        lines: [
          { accountCode: "1002", debit: order.total_price ?? 0, credit: 0 },
          { accountCode: "2100", debit: 0, credit: order.total_price ?? 0 },
        ],
      }).catch((err) => console.error("[execute/mark_paid] journal error:", err));

      // WhatsApp confirmation
      const rawCustomer = order.customers;
      const customer = (Array.isArray(rawCustomer) ? rawCustomer[0] : rawCustomer) as {
        name: string | null;
        phone_number: string;
      } | null;
      if (customer?.phone_number && order.customer_id) {
        const firstName = (customer.name ?? "").split(" ")[0] || "kak";
        const msg = `Halo kak ${firstName}! Pembayaran kamu sudah kami verifikasi dan pesananmu sekarang sudah aktif. Terima kasih ya kak, selamat menikmati! 🎉`;
        try {
          await saveMessage({ customerId: order.customer_id, role: "assistant", content: msg });
          await sendTextMessage(customer.phone_number, msg);
        } catch (err) {
          console.error("[execute/mark_paid] WhatsApp send failed:", err);
        }
      }

      return reply("Pesanan sudah ditandai lunas dan pesan konfirmasi WhatsApp sudah dikirim.");
    }

    case "cancel_order": {
      const orderId = input.order_id as string;
      const notifyCustomer = input.notify_customer as boolean;
      const reason = input.reason as string | undefined;

      const { data: order, error: fetchErr } = await db
        .from("orders")
        .select("id, customer_id, customers(name, phone_number)")
        .eq("id", orderId)
        .single();
      if (fetchErr || !order) {
        return NextResponse.json({ ok: false, error: "Order not found" }, { status: 404 });
      }

      const { error: updateErr } = await db
        .from("orders")
        .update({ status: "cancelled_by_admin" })
        .eq("id", orderId);
      if (updateErr) {
        return NextResponse.json({ ok: false, error: updateErr.message }, { status: 500 });
      }

      if (notifyCustomer) {
        const rawCustomer = order.customers;
        const customer = (Array.isArray(rawCustomer) ? rawCustomer[0] : rawCustomer) as {
          name: string | null;
          phone_number: string;
        } | null;
        if (customer?.phone_number && order.customer_id) {
          const firstName = (customer.name ?? "").split(" ")[0] || "kak";
          const reasonText = reason ? ` Alasan: ${reason}.` : "";
          const msg = `Halo kak ${firstName}, mohon maaf pesanan kamu terpaksa kami batalkan.${reasonText} Silakan hubungi kami jika ada pertanyaan ya kak.`;
          try {
            await saveMessage({ customerId: order.customer_id, role: "assistant", content: msg });
            await sendTextMessage(customer.phone_number, msg);
          } catch (err) {
            console.error("[execute/cancel_order] WhatsApp send failed:", err);
          }
        }
      }

      return reply("Pesanan sudah dibatalkan.");
    }

    case "send_whatsapp_message": {
      const phone = input.phone_number as string;
      const message = input.message as string;
      await sendAssistantText(phone, message);
      return reply(`Pesan WhatsApp sudah dikirim ke ${phone}.`);
    }

    case "send_whatsapp_image": {
      const phone = input.phone_number as string;
      const imageUrl = input.image_url as string;
      const caption = input.caption as string;
      await sendAssistantImage(phone, imageUrl, caption);
      return reply(`Gambar WhatsApp sudah dikirim ke ${phone}.`);
    }

    case "update_customer_field": {
      const customerId = input.customer_id as string;
      const field = input.field as string;
      const value = input.value as string;

      if (!ALLOWED_CUSTOMER_FIELDS.has(field)) {
        return NextResponse.json({ ok: false, error: `Field '${field}' is not editable` }, { status: 400 });
      }

      const { error: updateErr } = await db
        .from("customers")
        // biome-ignore lint/suspicious/noExplicitAny: dynamic field from validated allowlist
        .update({ [field]: value } as any)
        .eq("id", customerId);
      if (updateErr) {
        return NextResponse.json({ ok: false, error: updateErr.message }, { status: 500 });
      }

      return reply(`Field ${field} customer sudah diperbarui.`);
    }

    default:
      return NextResponse.json({ ok: false, error: "Unknown tool" }, { status: 400 });
  }
}

function isWriteAction(value: unknown): value is { tool: string; input: Record<string, unknown> } {
  if (!value || typeof value !== "object") return false;
  const action = value as { tool?: unknown; input?: unknown };
  return typeof action.tool === "string"
    && WRITE_TOOLS.has(action.tool)
    && !!action.input
    && typeof action.input === "object";
}

async function uploadImageUrlToMeta(imageUrl: string): Promise<string> {
  const res = await fetch(imageUrl);
  if (!res.ok) {
    throw new Error(`Failed to download image: ${res.status}`);
  }
  const contentType = res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
  if (!contentType.startsWith("image/")) {
    throw new Error(`URL did not return an image (${contentType})`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return uploadMediaToMeta(buffer, contentType);
}

export const dynamic = "force-dynamic";
