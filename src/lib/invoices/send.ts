/**
 * Builds and sends one invoice PDF over WhatsApp.
 *
 * Until now every invoice was hand-made. Carolin asked for one on 2026-08-30,
 * got a PDF drawn by a throwaway script, found a wrong line on it, and asked
 * again the next day — by which time the script was gone and the layout had to
 * be rebuilt from a screenshot. Nothing recorded the number, the amount, or
 * that an invoice existed at all. Two people's evenings for a document the
 * order already contains every figure for.
 *
 * The number is allocated once per order by `next_invoice_number()` in the
 * database and kept in `invoices`; the PDF is re-rendered on every send,
 * because an unpaid invoice becomes a paid one and the customer who asks twice
 * should get today's truth under yesterday's number.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logEdit } from "@/lib/audit/log-edit";
import { getSetting } from "@/lib/cache/settings";
import { saveMessage, updateMessageReceipt } from "@/lib/claude/conversation";
import { jakartaDateString } from "@/lib/menu/week";
import { normalizeSize } from "@/lib/orders/size";
import { addDays } from "@/lib/time/jakarta";
import {
  sendDocumentMessageById,
  uploadMediaToMeta,
} from "@/lib/whatsapp/client";
import type { Database } from "@/types/database";
import { type InvoiceSpec, renderInvoicePdf } from "./render";

type Db = SupabaseClient<Database>;

/** An invoice sent minutes ago is the same invoice; don't send it twice. */
const RESEND_COOLDOWN_MS = 10 * 60 * 1000;

const MONTHS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

export function rupiah(n: number): string {
  return `Rp ${Math.round(n).toLocaleString("id-ID")}`;
}

/** "31 Agustus 2026" from an ISO date or timestamp. */
export function longDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export type InvoiceResult =
  | { ok: true; number: string; total: number; url: string; orderId: string }
  | { ok: false; error: string };

type OrderRow = Database["public"]["Tables"]["orders"]["Row"];
type CustomerRow = Database["public"]["Tables"]["customers"]["Row"];

/**
 * Which order the customer means.
 *
 * Their own packages and the ones they paid for on someone else's behalf both
 * count — the invoice follows the money, so a buyer asking for "invoice" means
 * the package they paid for even though they never eat from it. A cancelled
 * order is not invoiceable.
 */
async function pickOrder(
  db: Db,
  customerId: string,
  startDate?: string,
): Promise<OrderRow | null> {
  const { data, error } = await db
    .from("orders")
    .select("*")
    .or(`customer_id.eq.${customerId},paid_by_customer_id.eq.${customerId}`)
    .not(
      "status",
      "in",
      "(cancelled_unpaid,cancelled_by_customer,cancelled_by_admin,refunded)",
    )
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  const orders = data ?? [];
  if (!orders.length) return null;
  if (startDate) {
    const named = orders.find((o) => o.start_date === startDate);
    if (named) return named;
  }
  return orders[0];
}

function party(c: CustomerRow, withAddress: boolean) {
  const lines = [c.phone_number];
  if (withAddress && c.address) lines.push(c.address);
  if (withAddress && c.area) lines.push(c.area);
  return { name: c.name ?? "Pelanggan", lines };
}

export async function buildInvoiceSpec(params: {
  order: OrderRow;
  beneficiary: CustomerRow;
  payer: CustomerRow;
  number: string;
  today: string;
}): Promise<InvoiceSpec> {
  const { order, beneficiary, payer, number, today } = params;
  const size = normalizeSize(order.size).toUpperCase();
  const portions = order.package_size ?? 0;
  const unit = order.price_per_portion ?? 0;
  const total = order.total_price ?? portions * unit;

  // `paid_at` is the only thing that says the money arrived. A status of
  // payment_proof_received means a screenshot arrived, which is not the same
  // claim and must not print a LUNAS stamp.
  const paidAt = order.paid_at;
  const partial = order.amount_paid ?? 0;
  const paid = paidAt ? total : Math.min(partial, total);
  const balance = total - paid;

  const sub = [`Size ${size} — nasi + lauk + sayur + sambal`];
  if (order.start_date) {
    sub.push(
      order.end_date && order.end_date !== order.start_date
        ? `Mulai ${longDate(order.start_date)} s/d ${longDate(order.end_date)}`
        : `Mulai ${longDate(order.start_date)}`,
    );
  }
  if (order.source === "free_quota")
    sub.push("Porsi gratis — tidak ditagihkan");

  const payment: string[] = [];
  if (balance <= 0) {
    payment.push(
      `Sudah lunas${paidAt ? ` — diterima ${longDate(paidAt)}` : ""}. Terima kasih kak.`,
    );
  } else {
    const [bankName, bankAccount, bankHolder] = await Promise.all([
      getSetting("bank_name"),
      getSetting("bank_account_number"),
      getSetting("bank_account_name"),
    ]);
    payment.push(`Transfer ke ${bankName ?? "-"}: ${bankAccount ?? "-"}`);
    payment.push(`a.n. ${bankHolder ?? "-"}`);
    payment.push("Mohon kirim bukti transfer setelah pembayaran.");
  }

  // Unpaid: the money is due at the cutoff on the day *before* the first
  // delivery, which is the same deadline `cancel-unpaid` sweeps against. It is
  // written as that date and that time, never as "sebelum pengiriman pertama" —
  // Clairine read that as the delivery morning and hers was already due the day
  // before. The hour is the setting, not a literal: it is editable in the UI and
  // the bot quotes the same one.
  const deadlineHour = Number(await getSetting("order_deadline_hour")) || 16;
  const cutoff = `pukul ${String(deadlineHour).padStart(2, "0")}.00 WIB`;
  const due =
    balance <= 0
      ? paidAt
        ? longDate(paidAt)
        : longDate(today)
      : order.start_date
        ? `${longDate(addDays(order.start_date, -1))} ${cutoff}`
        : cutoff;

  return {
    number,
    date: longDate(today),
    due,
    paidStamp: balance <= 0 ? "LUNAS" : undefined,
    billTo: party(payer, payer.id !== beneficiary.id),
    shipTo: party(beneficiary, true),
    items: [
      {
        desc: "Paket katering harian",
        sub,
        qty: `${portions} porsi`,
        unit: rupiah(unit),
        amount: rupiah(total),
      },
    ],
    subtotal: rupiah(total),
    shipping: "Gratis",
    total: rupiah(total),
    paidLine:
      paid > 0
        ? { label: "Sudah dibayar", amount: `-${rupiah(paid)}` }
        : undefined,
    balance: rupiah(balance),
    payment,
    footer: [
      "Terima kasih sudah memesan di Pian Yi Catering.",
      `Pesanan & perubahan ditutup ${cutoff} H-1.`,
    ],
  };
}

/**
 * Renders the invoice for one order and sends it to `customerId`.
 *
 * `customerId` is who asked — the invoice is addressed to them and the document
 * goes to their thread, which is why a buyer gets the package they paid for
 * rather than the one they eat from.
 */
export async function sendInvoice(params: {
  db: Db;
  customerId: string;
  phone: string;
  startDate?: string;
  actor: string;
}): Promise<InvoiceResult> {
  const { db, customerId, phone, startDate, actor } = params;

  const order = await pickOrder(db, customerId, startDate);
  if (!order) {
    return {
      ok: false,
      error:
        "Tidak ada order yang bisa dibuatkan invoice untuk customer ini — belum ada pesanan aktif atau yang menunggu pembayaran. Jangan janjikan invoice; tanyakan dulu pesanan yang mana.",
    };
  }

  const ids: string[] = [
    order.customer_id,
    order.paid_by_customer_id ?? order.customer_id,
  ].filter((id): id is string => Boolean(id));
  const { data: people, error: peopleErr } = await db
    .from("customers")
    .select("*")
    .in("id", [...new Set(ids)]);
  if (peopleErr) throw new Error(peopleErr.message);

  const beneficiary = (people ?? []).find((p) => p.id === order.customer_id);
  const payer =
    (people ?? []).find(
      (p) => p.id === (order.paid_by_customer_id ?? order.customer_id),
    ) ?? beneficiary;
  if (!beneficiary || !payer) {
    return {
      ok: false,
      error:
        "Data customer untuk order ini tidak lengkap, invoice tidak dibuat.",
    };
  }

  const { data: existing } = await db
    .from("invoices")
    .select("*")
    .eq("order_id", order.id)
    .maybeSingle();

  if (
    existing?.last_sent_at &&
    Date.now() - new Date(existing.last_sent_at).getTime() < RESEND_COOLDOWN_MS
  ) {
    return {
      ok: false,
      error: `Invoice ${existing.number} baru saja dikirim ke customer beberapa menit lalu, jadi tidak dikirim ulang. Minta customer cek chat ini — dokumennya ada di atas.`,
    };
  }

  const today = jakartaDateString();
  let number = existing?.number;
  if (!number) {
    const { data: allocated, error: seqErr } = await db.rpc(
      "next_invoice_number",
      {
        p_period: today.slice(0, 7),
      },
    );
    if (seqErr || !allocated)
      throw new Error(seqErr?.message ?? "no invoice number");
    number = allocated;
  }

  const spec = await buildInvoiceSpec({
    order,
    beneficiary,
    payer,
    number,
    today,
  });
  const pdf = await renderInvoicePdf(spec);

  const filename = `Invoice-PianYi-${number.replace(/\//g, "-")}.pdf`;
  const storagePath = `invoices/${customerId}/${number.replace(/\//g, "-")}-${Date.now()}.pdf`;
  const { error: uploadErr } = await db.storage
    .from("menu-images")
    .upload(storagePath, pdf, {
      contentType: "application/pdf",
      upsert: false,
    });
  if (uploadErr) throw new Error(uploadErr.message);
  const {
    data: { publicUrl },
  } = db.storage.from("menu-images").getPublicUrl(storagePath);

  const caption = `Invoice ${number} — Pian Yi Catering`;
  const conversationId = await saveMessage({
    customerId,
    role: "assistant",
    // What the customer sees on the document, with the file beside it rather
    // than instead of it: a row whose content is the URL draws in the inbox as
    // a bare link and says nothing about what was invoiced.
    content: caption,
    mediaUrl: publicUrl,
    messageType: "document",
    modelUsed: "system",
  });
  const mediaId = await uploadMediaToMeta(pdf, "application/pdf", filename);
  const messageId = await sendDocumentMessageById(
    phone,
    mediaId,
    filename,
    caption,
  );
  await updateMessageReceipt({
    conversationId,
    whatsappMessageId: messageId,
    status: "sent",
  });

  const total = order.total_price ?? 0;
  const row = {
    order_id: order.id,
    customer_id: customerId,
    number,
    issued_on: today,
    total,
    pdf_url: publicUrl,
    sent_count: (existing?.sent_count ?? 0) + 1,
    last_sent_at: new Date().toISOString(),
  };
  const { error: saveErr } = await db
    .from("invoices")
    .upsert(row, { onConflict: "order_id" });
  if (saveErr)
    console.error(
      `[invoice] ${number} sent but not recorded: ${saveErr.message}`,
    );

  await logEdit({
    db,
    actor,
    entityType: "invoice",
    entityId: order.id,
    action: existing ? "resend_invoice" : "send_invoice",
    changes: { number, total, customer_id: customerId, url: publicUrl },
  });

  return { ok: true, number, total, url: publicUrl, orderId: order.id };
}
