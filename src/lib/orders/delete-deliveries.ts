import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCustomerSchedule } from "@/lib/orders/customer-schedule";
import {
  deleteDelivery,
  isLocked,
  loadDeadlineHour,
} from "@/lib/orders/delivery-state";
import { sendPushToAllAdmins } from "@/lib/push/send";
import type { Database } from "@/types/database";

type Db = SupabaseClient<Database>;

/** What the model asked to remove. */
export type DeleteDeliveriesInput = {
  delivery_dates?: string[];
  /** Omitted, or "both", means every meal scheduled on those dates. */
  meal_type?: "lunch" | "dinner" | "both";
  reason?: string;
};

/**
 * Structurally the webhook's `ToolResult` — see `handleToolUse` in
 * `src/app/api/webhook/whatsapp/route.ts`. The strings are Indonesian because
 * the model paraphrases them straight into its reply to the customer.
 */
export type DeleteDeliveriesResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/**
 * Removes scheduled deliveries a customer asked to skip, cancel or move.
 *
 * Until this existed the bot had no way to act on a skip at all: the prompt
 * told it to "konfirmasi skip sendiri" for an unlocked date, so it answered
 * "baik kak, dicatat" and the row stayed on the sheet — the same empty
 * confirmation docs/BOT_RULES.md forbids for orders and schedules. Nadya asked
 * on 2026-09-02 to move the next day's lunch to dinner; nothing could have
 * carried out the first half of that.
 *
 * A skip is a DELETE and nothing else (migration 075): the balance is
 * `package_size` minus the rows that exist, so removing the row *is* the
 * refund. Never write a counter back. Every removal goes through
 * `deleteDelivery()`, which copies the whole row into `edit_log` first, because
 * nothing else can rebuild it.
 *
 * A locked date is refused rather than deleted — past the H-1 deadline the
 * kitchen holds the sheet and we owe them the portion whether or not the
 * customer eats it — and the refusal names the dates, because a tool result
 * must say what the tool actually did.
 */
export async function deleteDeliveries(params: {
  db: Db;
  customerId: string;
  phone: string;
  customerName: string | null;
  input: DeleteDeliveriesInput;
}): Promise<DeleteDeliveriesResult> {
  const { db, customerId, phone, customerName, input } = params;

  const dates = Array.from(
    new Set(
      (input.delivery_dates ?? []).filter(
        (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d),
      ),
    ),
  ).sort();

  if (dates.length === 0) {
    console.error(
      "[delete-deliveries] no valid delivery date",
      JSON.stringify(input),
    );
    return {
      ok: false,
      error:
        "Tidak ada tanggal yang valid di panggilan ini. Tidak ada yang dibatalkan — tanyakan tanggalnya ke customer, lalu panggil lagi.",
    };
  }

  const wantedMeal =
    input.meal_type && input.meal_type !== "both" ? input.meal_type : null;

  const { data: rows } = await db
    .from("daily_deliveries")
    .select("id, delivery_date, meal_type, portions")
    .eq("customer_id", customerId)
    .in("delivery_date", dates);

  const scheduled = rows ?? [];
  if (scheduled.length === 0) {
    return {
      ok: false,
      error: `Tidak ada pengiriman terjadwal di tanggal itu (${dates.join(", ")}), jadi tidak ada yang dibatalkan. Beri tahu customer jadwalnya memang belum ada — jangan bilang sudah dibatalkan.`,
    };
  }

  const deadlineHour = await loadDeadlineHour();
  const deleted: string[] = [];
  const locked: string[] = [];
  const wrongMeal: string[] = [];
  // A row written as "both" is one row carrying two meals, so half of it cannot
  // be removed by deleting it. Refuse and let an admin split it, rather than
  // cancelling the meal the customer still wants.
  const undividable: string[] = [];
  const failed: string[] = [];

  for (const row of scheduled) {
    const date = row.delivery_date;
    const meal = row.meal_type ?? "lunch";
    if (wantedMeal && meal !== wantedMeal) {
      if (meal === "both") undividable.push(date);
      else wrongMeal.push(`${date} (${meal})`);
      continue;
    }
    if (isLocked(date, { deadlineHour })) {
      locked.push(date);
      continue;
    }
    try {
      const removed = await deleteDelivery({
        db,
        id: row.id,
        actor: "system:webhook:delete_deliveries",
        reason: input.reason?.trim()
          ? `Customer via WhatsApp: ${input.reason.trim()}`
          : "Customer meminta pembatalan lewat WhatsApp",
      });
      if (removed) deleted.push(`${date} (${meal})`);
      else failed.push(date);
    } catch (err) {
      console.error(
        `[delete-deliveries] ${date} failed:`,
        (err as Error).message,
      );
      failed.push(date);
    }
  }

  const dropped = [
    ...locked.map((d) => `${d} (sudah TERKUNCI, dapur sudah memasaknya)`),
    ...wrongMeal.map((d) => `${d} — yang terjadwal meal lain`),
    ...undividable.map(
      (d) => `${d} (terjadwal siang dan malam dalam satu catatan)`,
    ),
    ...failed.map((d) => `${d} (gagal disimpan)`),
  ];

  if (deleted.length === 0) {
    if (failed.length > 0) {
      await sendPushToAllAdmins(
        `Pembatalan GAGAL — ${customerName ?? phone}`,
        `${failed.join(", ")} tidak terhapus`,
        "/deliveries",
        "high",
      );
      return {
        ok: false,
        error:
          "Gagal menghapus jadwalnya dari database. Tidak ada yang dibatalkan — jangan bilang sudah dibatalkan, bilang saja sedang dicek admin.",
      };
    }
    if (undividable.length > 0) {
      return {
        ok: false,
        error: `Tanggal ${undividable.join(", ")} tercatat siang dan malam sekaligus dalam satu baris, jadi salah satunya tidak bisa dibatalkan sendiri. Tidak ada yang berubah — panggil ask_admin_for_help dengan tanggal dan meal yang dimaksud.`,
      };
    }
    if (locked.length > 0) {
      return {
        ok: false,
        error: `Tanggal ${locked.join(", ")} sudah terkunci — deadline sudah lewat dan dapur sudah memasaknya, jadi tidak ada yang dibatalkan dan makanannya tetap dikirim. Katakan itu terus terang, lalu tawarkan pembatalan mulai tanggal pertama yang belum terkunci.`,
      };
    }
    return {
      ok: false,
      error: `Tidak ada yang cocok untuk dibatalkan${dropped.length > 0 ? ` — ${dropped.join(", ")}` : ""}. Jangan bilang sudah dibatalkan.`,
    };
  }

  // The portions are back in the balance the moment the rows are gone, so this
  // is read after the deletes, not before.
  const after = await loadCustomerSchedule(db, customerId);

  await sendPushToAllAdmins(
    `Pengiriman dibatalkan — ${customerName ?? phone}`,
    `${deleted.join(", ")} dihapus dari jadwal`,
    "/deliveries",
    "low",
  );

  return {
    ok: true,
    message: `Dibatalkan: ${deleted.join(", ")}. Porsinya kembali ke saldo customer dan bisa dijadwalkan ulang.${
      dropped.length > 0
        ? ` TIDAK dibatalkan: ${dropped.join(", ")}. Sebutkan ini ke customer.`
        : ""
    } Sisa porsi yang belum dijadwalkan sekarang: ${after?.unbooked ?? 0}.`,
  };
}
