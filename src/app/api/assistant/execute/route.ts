import { NextResponse } from "next/server";
import { createJournalEntry } from "@/lib/accounting/journal";
import { logEdit } from "@/lib/audit/log-edit";
import { saveAssistantReply } from "@/lib/claude/assistant-history";
import { WRITE_TOOLS } from "@/lib/claude/assistant-tools";
import { saveMessage, updateMessageReceipt } from "@/lib/claude/conversation";
import {
  deleteDelivery,
  isLocked,
  loadDeadlineHour,
} from "@/lib/orders/delivery-state";
import { orderHasDeliveries } from "@/lib/orders/order-has-deliveries";
import { buildPaidDeliveryRows } from "@/lib/orders/paid-delivery-rows";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole } from "@/lib/supabase/get-role";
import { getDeliveryRoute, withDeliveryRoute } from "@/lib/utils/format";
import {
  isOutsideWindowError,
  sendImageMessageById,
  sendTextMessage,
  uploadMediaToMeta,
} from "@/lib/whatsapp/client";
import { WINDOW_NOTICE_SHORT } from "@/lib/whatsapp/window-notice";
import type { Database } from "@/types/database";

// Typed against the generated row types, so a field added to either allowlist
// that is not actually an editable column fails typecheck instead of failing at
// runtime. Neither list may contain a server-controlled field (id, status,
// price_per_portion, total_price, created_at).
type CustomersUpdate = Database["public"]["Tables"]["customers"]["Update"];
type OrdersUpdate = Database["public"]["Tables"]["orders"]["Update"];
// Extract, not a bare literal union: a name that is not a real updatable column
// collapses to never here and the Set below stops accepting it.
type CustomerField = Extract<
  keyof CustomersUpdate,
  "name" | "address" | "area" | "notes"
>;
type OrderField = Extract<
  keyof OrdersUpdate,
  | "portions_per_delivery"
  | "portions_lunch"
  | "portions_dinner"
  | "start_date"
  | "end_date"
>;

const ALLOWED_CUSTOMER_FIELDS = new Set<CustomerField>([
  "name",
  "address",
  "area",
  "notes",
]);
const ALLOWED_ORDER_FIELDS = new Set<OrderField>([
  "portions_per_delivery",
  "portions_lunch",
  "portions_dinner",
  "start_date",
  "end_date",
]);
const NUMERIC_ORDER_FIELDS = new Set<OrderField>([
  "portions_per_delivery",
  "portions_lunch",
  "portions_dinner",
]);

export async function POST(request: Request) {
  const session = await getSessionWithRole();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  let body: {
    tool?: string;
    input?: Record<string, unknown>;
    conversationId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON" },
      { status: 400 },
    );
  }

  // Captured once: the closures below outlive the null check above, and TS
  // will not carry the narrowing into them.
  const actor = session.email;

  const { tool, input, conversationId } = body;
  if (!tool || !input || (tool !== "batch" && !WRITE_TOOLS.has(tool))) {
    return NextResponse.json(
      { ok: false, error: "Invalid or disallowed tool" },
      { status: 400 },
    );
  }

  const db = createAdminClient();

  // Persist the assistant's confirmation reply to the active thread, clear any pending action, then respond.
  function reply(text: string) {
    if (conversationId) {
      saveAssistantReply(db, conversationId, text).catch((err) =>
        console.error("[execute] persist reply:", err),
      );
      Promise.resolve(
        db
          .from("assistant_conversations")
          .update({ pending_action: null })
          .eq("id", conversationId),
      ).catch((err: unknown) =>
        console.error("[execute] clear pending_action:", err),
      );
    }
    return NextResponse.json({ ok: true, text, conversationId });
  }

  // Meta refuses any business-initiated message once 24 hours have passed since
  // the customer's last inbound one, and nothing we send reopens it — only they
  // can. Without this the throw surfaced as a 500 carrying a raw Meta payload,
  // which reads as "the app is broken" rather than "the customer has to write
  // first". Admins now have no other way to reach a customer (hand-typed sends
  // are owner-only), so this is the message they will actually hit.
  async function trySend(
    phone: string,
    run: () => Promise<void>,
  ): Promise<NextResponse | null> {
    try {
      await run();
      return null;
    } catch (err) {
      if (!isOutsideWindowError(err)) throw err;
      return NextResponse.json(
        {
          ok: false,
          code: "window_closed",
          error: `WhatsApp menutup jalur ke ${phone} — sudah lewat 24 jam sejak pesan terakhir dari customer. Pesan ini tidak terkirim. Customer harus mengirim pesan dulu supaya jalurnya terbuka lagi.`,
        },
        { status: 409 },
      );
    }
  }

  async function sendAssistantText(phone: string, message: string) {
    const messageId = await sendTextMessage(phone, message);
    const { data: cust } = await db
      .from("customers")
      .select("id")
      .eq("phone_number", phone)
      .maybeSingle();
    if (cust?.id) {
      const conversationId = await saveMessage({
        customerId: cust.id,
        role: "assistant",
        content: message,
        modelUsed: "human",
        sentBy: actor,
      });
      await updateMessageReceipt({
        conversationId,
        whatsappMessageId: messageId,
        status: "sent",
      });
    }
  }

  async function sendAssistantImage(
    phone: string,
    imageUrl: string,
    caption: string,
  ) {
    const mediaId = await uploadImageUrlToMeta(imageUrl);
    const messageId = await sendImageMessageById(phone, mediaId, caption);
    const { data: cust } = await db
      .from("customers")
      .select("id")
      .eq("phone_number", phone)
      .maybeSingle();
    if (cust?.id) {
      const conversationId = await saveMessage({
        customerId: cust.id,
        role: "assistant",
        content: caption || "[Image]",
        mediaUrl: imageUrl,
        messageType: "image",
        modelUsed: "human",
        sentBy: actor,
      });
      await updateMessageReceipt({
        conversationId,
        whatsappMessageId: messageId,
        status: "sent",
      });
    }
  }

  // One row per confirmed tool call, written before the switch runs because
  // every case returns from inside it. So this records what the admin approved,
  // not what succeeded — the tool's own effects (an order marked paid, a
  // customer field changed) are logged again by the routes they go through
  // where they have one. Without it the Assistant was the one path that could
  // cancel an order or edit an address with nobody's name on it.
  const target =
    (input.order_id as string | undefined) ??
    (input.customer_id as string | undefined) ??
    (input.phone_number as string | undefined) ??
    tool;
  await logEdit({
    db,
    actor,
    entityType: "assistant_tool",
    entityId: target,
    action: tool,
    changes: input,
  });

  switch (tool) {
    case "batch": {
      const actions = input.actions;
      if (!Array.isArray(actions) || actions.length === 0) {
        return NextResponse.json(
          { ok: false, error: "actions required" },
          { status: 400 },
        );
      }

      // Every action runs, and each one reports for itself. The loop used to
      // return on the first failure, which sent the actions before it, dropped
      // the ones after it and left pending_action set so the thread was stuck:
      // sending the menu, the price list and a note together failed as a unit
      // on 2026-08-19 with nothing saying which part had gone out.
      const outcomes: string[] = [];
      for (const [i, action] of actions.entries()) {
        if (!isWriteAction(action)) {
          outcomes.push(`${i + 1}. gagal — aksi tidak dikenali`);
          continue;
        }
        const phone = action.input.phone_number as string;
        try {
          if (action.tool === "send_whatsapp_message") {
            await sendAssistantText(phone, action.input.message as string);
            outcomes.push(`${i + 1}. pesan terkirim ke ${phone}`);
          } else if (action.tool === "send_whatsapp_image") {
            await sendAssistantImage(
              phone,
              action.input.image_url as string,
              action.input.caption as string,
            );
            outcomes.push(`${i + 1}. gambar terkirim ke ${phone}`);
          } else {
            outcomes.push(
              `${i + 1}. gagal — '${action.tool}' belum bisa dijalankan sekaligus`,
            );
          }
        } catch (err) {
          outcomes.push(
            isOutsideWindowError(err)
              ? `${i + 1}. gagal — jalur WhatsApp ke ${phone} sudah tertutup (lewat 24 jam sejak pesan terakhir customer)`
              : `${i + 1}. gagal — ${(err as Error).message}`,
          );
        }
      }

      return reply(outcomes.join("\n"));
    }

    case "mark_order_paid": {
      const orderId = input.order_id as string;
      const { data: order, error: fetchErr } = await db
        .from("orders")
        .select(
          "id, total_price, package_size, customer_id, start_date, end_date, requested_schedule, portions_per_delivery, portions_lunch, portions_dinner, subcontractor_id, lunch_address_slot, dinner_address_slot, customers!orders_customer_id_fkey(name, phone_number, subcontractor_id)",
        )
        .eq("id", orderId)
        .single();
      if (fetchErr || !order) {
        return NextResponse.json(
          { ok: false, error: "Order not found" },
          { status: 404 },
        );
      }

      const { error: updateErr } = await db
        .from("orders")
        .update({ status: "active", paid_at: new Date().toISOString() })
        .eq("id", orderId);
      if (updateErr) {
        return NextResponse.json(
          { ok: false, error: updateErr.message },
          { status: 500 },
        );
      }

      // Conversion tracking (fire-and-forget)
      const convCustomerId = order.customer_id;
      if (convCustomerId) {
        Promise.resolve(
          db
            .from("customers")
            .select("converted_at")
            .eq("id", convCustomerId)
            .single(),
        )
          .then(({ data: cust }) => {
            if (cust && !cust.converted_at) {
              const pkgSize = order.package_size ?? 0;
              return db
                .from("customers")
                .update({
                  converted_at: new Date().toISOString(),
                  total_portions: pkgSize,
                  total_payment: order.total_price ?? 0,
                  package: pkgSize > 0 ? `${pkgSize} porsi` : null,
                })
                .eq("id", convCustomerId);
            }
          })
          .catch((err: unknown) =>
            console.error("[execute/mark_paid] conversion error:", err),
          );
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
      }).catch((err) =>
        console.error("[execute/mark_paid] journal error:", err),
      );

      // Payment is when the food becomes real: nothing filters the kitchen
      // sheet by order status, so a row written before payment is a portion a
      // kitchen cooks for an order nobody paid for. The days come off
      // orders.requested_schedule, stored when the order was created. Nothing
      // is derived here — a schedule the customer never gave is not one we may
      // invent. A null schedule is normal: most customers book day by day.
      const alreadyScheduled = await orderHasDeliveries(orderId);
      const requested = (order.requested_schedule ?? null) as
        | { date: string; meal_type: string; portions: number }[]
        | null;

      if (
        Array.isArray(requested) &&
        requested.length > 0 &&
        !alreadyScheduled
      ) {
        // Minggu and libur nasional are dropped, and each row is charged to
        // the order that owes it — a top-up's schedule runs longer than its own
        // package by the portions the customer still holds. See
        // buildPaidDeliveryRows().
        const deliveryRows = await buildPaidDeliveryRows({
          db,
          order: {
            id: orderId,
            customer_id: order.customer_id,
            package_size: order.package_size,
            subcontractor_id: order.subcontractor_id,
            lunch_address_slot: order.lunch_address_slot,
            dinner_address_slot: order.dinner_address_slot,
          },
          customerSubcontractorId: order.customers?.subcontractor_id ?? null,
          requested,
        });

        if (deliveryRows.length > 0) {
          const { error: deliveryErr } = await db
            .from("daily_deliveries")
            .upsert(deliveryRows, {
              onConflict: "delivery_date,customer_id,meal_type",
              ignoreDuplicates: true,
            });
          if (deliveryErr) {
            console.error(
              "[execute/mark_paid] delivery generation error:",
              deliveryErr,
            );
          }
        }
      }

      // WhatsApp confirmation
      const rawCustomer = order.customers;
      const customer = (
        Array.isArray(rawCustomer) ? rawCustomer[0] : rawCustomer
      ) as {
        name: string | null;
        phone_number: string;
      } | null;
      if (customer?.phone_number && order.customer_id) {
        // The honorific lives in `greeting`, never in the sentence: a customer we
        // have no name for gets a clean "Halo kak!" instead of "Halo kak kak!".
        // Same doubling extract-order.ts already fixed for the payment request.
        const displayName = (customer.name ?? "").trim().split(" ")[0];
        const greeting = displayName ? `kak ${displayName}` : "kak";
        const msg = `Halo ${greeting}! Pembayaran kamu sudah kami verifikasi dan pesananmu sekarang sudah aktif. Terima kasih ya kak, selamat menikmati! 🎉\n\n${WINDOW_NOTICE_SHORT}`;
        try {
          const conversationId = await saveMessage({
            customerId: order.customer_id,
            role: "assistant",
            content: msg,
          });
          const messageId = await sendTextMessage(customer.phone_number, msg);
          await updateMessageReceipt({
            conversationId,
            whatsappMessageId: messageId,
            status: "sent",
          });
        } catch (err) {
          console.error("[execute/mark_paid] WhatsApp send failed:", err);
        }
      }

      return reply(
        "Pesanan sudah ditandai lunas dan pesan konfirmasi WhatsApp sudah dikirim.",
      );
    }

    case "cancel_order": {
      const orderId = input.order_id as string;
      const notifyCustomer = input.notify_customer as boolean;
      const reason = input.reason as string | undefined;

      const { data: order, error: fetchErr } = await db
        .from("orders")
        .select(
          "id, customer_id, customers!orders_customer_id_fkey(name, phone_number)",
        )
        .eq("id", orderId)
        .single();
      if (fetchErr || !order) {
        return NextResponse.json(
          { ok: false, error: "Order not found" },
          { status: 404 },
        );
      }

      const { error: updateErr } = await db
        .from("orders")
        .update({ status: "cancelled_by_admin" })
        .eq("id", orderId);
      if (updateErr) {
        return NextResponse.json(
          { ok: false, error: updateErr.message },
          { status: 500 },
        );
      }

      if (notifyCustomer) {
        const rawCustomer = order.customers;
        const customer = (
          Array.isArray(rawCustomer) ? rawCustomer[0] : rawCustomer
        ) as {
          name: string | null;
          phone_number: string;
        } | null;
        if (customer?.phone_number && order.customer_id) {
          const displayName = (customer.name ?? "").trim().split(" ")[0];
          const greeting = displayName ? `kak ${displayName}` : "kak";
          const reasonText = reason ? ` Alasan: ${reason}.` : "";
          const msg = `Halo ${greeting}, mohon maaf pesanan kamu terpaksa kami batalkan.${reasonText} Silakan hubungi kami jika ada pertanyaan ya kak.`;
          try {
            const conversationId = await saveMessage({
              customerId: order.customer_id,
              role: "assistant",
              content: msg,
            });
            const messageId = await sendTextMessage(customer.phone_number, msg);
            await updateMessageReceipt({
              conversationId,
              whatsappMessageId: messageId,
              status: "sent",
            });
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
      const failed = await trySend(phone, () =>
        sendAssistantText(phone, message),
      );
      if (failed) return failed;
      return reply(`Pesan WhatsApp sudah dikirim ke ${phone}.`);
    }

    case "send_whatsapp_image": {
      const phone = input.phone_number as string;
      const imageUrl = input.image_url as string;
      const caption = input.caption as string;
      const failed = await trySend(phone, () =>
        sendAssistantImage(phone, imageUrl, caption),
      );
      if (failed) return failed;
      return reply(`Gambar WhatsApp sudah dikirim ke ${phone}.`);
    }

    case "update_customer_field": {
      const customerId = input.customer_id as string;
      const field = input.field as string;
      const value = input.value as string;

      if (!ALLOWED_CUSTOMER_FIELDS.has(field as CustomerField)) {
        return NextResponse.json(
          { ok: false, error: `Field '${field}' is not editable` },
          { status: 400 },
        );
      }
      // withDeliveryRoute so that editing `area` here restamps the route the
      // same way creating the customer would have.
      const patch = withDeliveryRoute({ [field]: value }) as Partial<
        Pick<CustomersUpdate, CustomerField>
      >;

      const { error: updateErr } = await db
        .from("customers")
        .update(patch)
        .eq("id", customerId);
      if (updateErr) {
        return NextResponse.json(
          { ok: false, error: updateErr.message },
          { status: 500 },
        );
      }

      return reply(`Field ${field} customer sudah diperbarui.`);
    }

    case "update_delivery": {
      const deliveryId = input.delivery_id as string;
      const action = input.action as string;

      if (action === "skip") {
        // A skip removes the row. There is no 'skipped' state to mark: the
        // customer's balance is their package minus the rows that exist, so
        // deleting the row is what gives the portion back, and the kitchen
        // sheet is built from the rows, so a row left behind is food cooked
        // for a meal the customer already told us to cancel.
        const { data: existing } = await db
          .from("daily_deliveries")
          .select("delivery_date")
          .eq("id", deliveryId)
          .maybeSingle();
        if (!existing) {
          return NextResponse.json(
            { ok: false, error: "Pengiriman tidak ditemukan." },
            { status: 404 },
          );
        }

        // Past the H-1 cutoff the sheet has gone to the kitchen and we owe
        // them the portion either way, so removing the row would hand back
        // quota we have already paid for.
        const deadlineHour = await loadDeadlineHour();
        if (isLocked(existing.delivery_date, { deadlineHour })) {
          return NextResponse.json(
            {
              ok: false,
              error: `Sudah lewat batas ${deadlineHour}:00 H-1 — pengiriman ${existing.delivery_date} sudah masuk ke dapur dan tidak bisa dibatalkan.`,
            },
            { status: 409 },
          );
        }

        try {
          const removed = await deleteDelivery({
            db,
            id: deliveryId,
            actor,
            reason: "assistant update_delivery skip",
          });
          if (!removed) {
            return NextResponse.json(
              { ok: false, error: "Pengiriman tidak ditemukan." },
              { status: 404 },
            );
          }
        } catch (err) {
          return NextResponse.json(
            { ok: false, error: (err as Error).message },
            { status: 500 },
          );
        }
        return reply(
          `Pengiriman ${existing.delivery_date} sudah dihapus dan porsinya kembali ke kuota.`,
        );
      }

      if (action === "reschedule") {
        const newDate = input.new_date as string | undefined;
        if (!newDate) {
          return NextResponse.json(
            { ok: false, error: "new_date required for reschedule" },
            { status: 400 },
          );
        }
        const { error } = await db
          .from("daily_deliveries")
          .update({ delivery_date: newDate })
          .eq("id", deliveryId);
        if (error) {
          return NextResponse.json(
            { ok: false, error: error.message },
            { status: 500 },
          );
        }
        return reply(`Pengiriman dijadwalkan ulang ke ${newDate}.`);
      }

      return NextResponse.json(
        { ok: false, error: "Invalid action" },
        { status: 400 },
      );
    }

    case "pause_order": {
      const orderId = input.order_id as string;
      const pauseUntil = (input.pause_until as string | undefined) ?? null;
      const { error } = await db
        .from("orders")
        .update({ status: "paused", pause_until: pauseUntil })
        .eq("id", orderId)
        .eq("status", "active");
      if (error) {
        return NextResponse.json(
          { ok: false, error: error.message },
          { status: 500 },
        );
      }
      return reply(
        pauseUntil
          ? `Pesanan dijeda sampai ${pauseUntil}.`
          : "Pesanan sudah dijeda.",
      );
    }

    case "resume_order": {
      const orderId = input.order_id as string;
      const { error } = await db
        .from("orders")
        .update({ status: "active", pause_until: null })
        .eq("id", orderId)
        .eq("status", "paused");
      if (error) {
        return NextResponse.json(
          { ok: false, error: error.message },
          { status: 500 },
        );
      }
      return reply("Pesanan sudah diaktifkan kembali.");
    }

    case "send_payment_details": {
      const orderId = input.order_id as string;
      const { data: order, error: fetchErr } = await db
        .from("orders")
        .select(
          "id, total_price, customer_id, customers!orders_customer_id_fkey(name, phone_number)",
        )
        .eq("id", orderId)
        .single();
      if (fetchErr || !order) {
        return NextResponse.json(
          { ok: false, error: "Order not found" },
          { status: 404 },
        );
      }
      const rawCustomer = order.customers;
      const customer = (
        Array.isArray(rawCustomer) ? rawCustomer[0] : rawCustomer
      ) as { name: string | null; phone_number: string } | null;
      if (!customer?.phone_number) {
        return NextResponse.json(
          { ok: false, error: "Customer phone not found" },
          { status: 400 },
        );
      }
      const [bankNameRes, bankAccountRes, bankHolderRes] = await Promise.all([
        db.from("settings").select("value").eq("key", "bank_name").single(),
        db
          .from("settings")
          .select("value")
          .eq("key", "bank_account_number")
          .single(),
        db
          .from("settings")
          .select("value")
          .eq("key", "bank_account_name")
          .single(),
      ]);
      const bankName = bankNameRes.data?.value ?? "";
      const bankAccount = bankAccountRes.data?.value ?? "";
      const bankHolder = bankHolderRes.data?.value ?? "";
      const displayName = (customer.name ?? "").trim().split(" ")[0];
      const greeting = displayName ? `kak ${displayName}` : "kak";
      const totalPrice = (order as { total_price?: number }).total_price ?? 0;
      const msg = `Terima kasih ${greeting}! 🎉 Silakan transfer ke:\n🏦 ${bankName}: ${bankAccount}\n👤 a.n. ${bankHolder}\n💰 Nominal: Rp ${totalPrice.toLocaleString("id-ID")}\n\nSetelah transfer, mohon kirim bukti pembayaran ya kak.`;
      try {
        const convId = await saveMessage({
          customerId: order.customer_id ?? "",
          role: "assistant",
          content: msg,
        });
        const messageId = await sendTextMessage(customer.phone_number, msg);
        await updateMessageReceipt({
          conversationId: convId,
          whatsappMessageId: messageId,
          status: "sent",
        });
      } catch (err) {
        console.error(
          "[execute/send_payment_details] WhatsApp send failed:",
          err,
        );
        return NextResponse.json(
          { ok: false, error: "Failed to send WhatsApp message" },
          { status: 500 },
        );
      }
      return reply("Detail pembayaran sudah dikirim via WhatsApp.");
    }

    case "mark_payment_proof_received": {
      const orderId = input.order_id as string;
      const { error } = await db
        .from("orders")
        .update({
          status: "payment_proof_received",
          payment_proof_received_at: new Date().toISOString(),
        })
        .eq("id", orderId)
        .eq("status", "pending_payment");
      if (error) {
        return NextResponse.json(
          { ok: false, error: error.message },
          { status: 500 },
        );
      }
      return reply(
        "Status pesanan sudah diperbarui ke payment_proof_received.",
      );
    }

    case "update_order": {
      const orderId = input.order_id as string;
      const field = input.field as string;
      const rawValue = input.value as string;

      if (!ALLOWED_ORDER_FIELDS.has(field as OrderField)) {
        return NextResponse.json(
          { ok: false, error: `Field '${field}' is not editable` },
          { status: 400 },
        );
      }
      const coercedValue = NUMERIC_ORDER_FIELDS.has(field as OrderField)
        ? Number(rawValue)
        : rawValue;
      const patch = { [field]: coercedValue } as Partial<
        Pick<OrdersUpdate, OrderField>
      >;
      const { error } = await db.from("orders").update(patch).eq("id", orderId);
      if (error) {
        return NextResponse.json(
          { ok: false, error: error.message },
          { status: 500 },
        );
      }
      return reply(`Field ${field} pesanan sudah diperbarui.`);
    }

    case "create_customer": {
      const phoneNumber = input.phone_number as string;
      const address = input.address as string;
      const area = input.area as string;
      const name = input.name as string | undefined;
      const googleMapsLink = input.google_maps_link as string | undefined;

      const { data: existing } = await db
        .from("customers")
        .select("id")
        .eq("phone_number", phoneNumber)
        .maybeSingle();
      if (existing) {
        return NextResponse.json(
          {
            ok: false,
            error: `Customer with phone ${phoneNumber} already exists`,
          },
          { status: 409 },
        );
      }

      // A customer who changes WhatsApp number arrives as a stranger: phone is
      // the only unique key, so nothing matches and a second row is created
      // holding none of their orders. galvent wrote "No wa lama gk pakai lg y"
      // on 2026-08-19 and was duplicated. Refuse on a name collision and hand
      // back the row that already exists, so the number can be moved onto it
      // with update_customer_field instead.
      if (name?.trim()) {
        const { data: sameName } = await db
          .from("customers")
          .select("id, name, phone_number, area")
          .ilike("name", name.trim())
          .limit(5);
        if (sameName?.length) {
          return NextResponse.json(
            {
              ok: false,
              error: `Sudah ada customer bernama "${name.trim()}": ${sameName
                .map(
                  (c) =>
                    `${c.name} (${c.phone_number}, ${c.area ?? "-"}, id ${c.id})`,
                )
                .join(
                  "; ",
                )}. Kalau ini orang yang sama dan cuma ganti nomor, pakai update_customer_field untuk mengubah phone_number-nya, jangan buat customer baru.`,
            },
            { status: 409 },
          );
        }
      }

      const deliveryRoute = getDeliveryRoute(area);
      const { data: newCustomer, error: insertErr } = await db
        .from("customers")
        .insert({
          phone_number: phoneNumber,
          address,
          area,
          name: name ?? null,
          google_maps_link: googleMapsLink ?? null,
          delivery_route: deliveryRoute,
        })
        .select("id")
        .single();
      if (insertErr || !newCustomer) {
        return NextResponse.json(
          { ok: false, error: insertErr?.message ?? "Insert failed" },
          { status: 500 },
        );
      }

      await Promise.all([
        db
          .from("customer_rate_limits")
          .upsert(
            { customer_id: newCustomer.id },
            { onConflict: "customer_id", ignoreDuplicates: true },
          ),
        db
          .from("customer_flags")
          .upsert(
            { customer_id: newCustomer.id },
            { onConflict: "customer_id", ignoreDuplicates: true },
          ),
        db
          .from("customer_state")
          .upsert(
            { customer_id: newCustomer.id },
            { onConflict: "customer_id", ignoreDuplicates: true },
          ),
      ]);

      return reply(
        `Customer ${name ?? phoneNumber} sudah dibuat (ID: ${newCustomer.id}).`,
      );
    }

    default:
      return NextResponse.json(
        { ok: false, error: "Unknown tool" },
        { status: 400 },
      );
  }
}

function isWriteAction(
  value: unknown,
): value is { tool: string; input: Record<string, unknown> } {
  if (!value || typeof value !== "object") return false;
  const action = value as { tool?: unknown; input?: unknown };
  return (
    typeof action.tool === "string" &&
    WRITE_TOOLS.has(action.tool) &&
    !!action.input &&
    typeof action.input === "object"
  );
}

async function uploadImageUrlToMeta(imageUrl: string): Promise<string> {
  const res = await fetch(imageUrl);
  if (!res.ok) {
    throw new Error(`Failed to download image: ${res.status}`);
  }
  const contentType =
    res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
  if (!contentType.startsWith("image/")) {
    throw new Error(`URL did not return an image (${contentType})`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return uploadMediaToMeta(buffer, contentType);
}

export const dynamic = "force-dynamic";
