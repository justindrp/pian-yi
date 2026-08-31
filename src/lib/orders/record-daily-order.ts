import type { SupabaseClient } from "@supabase/supabase-js";
import {
  coverageFor,
  kitchenCoverage,
} from "@/lib/subcontractors/coverage";
import { holidayOn, isClosedHoliday } from "@/lib/holidays/id";
import {
  loadCustomerSchedule,
  unbookedByOrder,
} from "@/lib/orders/customer-schedule";
import { pickDrawOrder } from "@/lib/orders/pick-draw-order";
import { sendPushToAllAdmins } from "@/lib/push/send";
import type { Database } from "@/types/database";

type Db = SupabaseClient<Database>;

/**
 * What the model asked for. `delivery_date` is still read because older
 * conversation histories carry it and the model copies what it sees.
 */
export type RecordDailyOrderInput = {
  delivery_dates?: string[];
  delivery_date?: string;
  meal_type: "lunch" | "dinner" | "both";
  portions: number;
  notes?: string;
};

/**
 * Structurally the webhook's `ToolResult` — see `handleToolUse` in
 * `src/app/api/webhook/whatsapp/route.ts`. Declared here so this module owes
 * the route nothing; the strings are Indonesian because the model paraphrases
 * them straight into its reply to the customer.
 */
export type RecordDailyOrderResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/**
 * Books the dates a customer asked for against a package they already bought.
 *
 * This is the busiest write in the product — most of the book is customers
 * naming days one or two at a time — and it is eight guards deep: no valid
 * date, no active order, no draw order, no unbooked quota, every date a libur
 * nasional, every date already on the sheet, not enough quota for a single
 * day, an insert error. Each one returns `ok: false` with a sentence saying so,
 * because the model reads the result and will otherwise tell the customer their
 * schedule is set over an empty calendar.
 *
 * Lived inside `handleToolUse` until 2026-08-29, where it was 200 of that
 * function's 354 lines and could only be exercised by driving a whole webhook
 * payload through the route.
 */
export async function recordDailyOrder(params: {
  db: Db;
  customerId: string;
  phone: string;
  customerName: string | null;
  input: RecordDailyOrderInput;
}): Promise<RecordDailyOrderResult> {
  const { db, customerId, phone, customerName, input } = params;

  // One call books the whole run. delivery_date is still read because older
  // conversation histories carry it, and the model copies what it sees.
  const dates = Array.from(
    new Set(
      (
        input.delivery_dates ??
        (input.delivery_date ? [input.delivery_date] : [])
      ).filter((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)),
    ),
  ).sort();

  if (dates.length === 0) {
    console.error(
      "[record-daily-order] no valid delivery date",
      JSON.stringify(input),
    );
    return {
      ok: false,
      error:
        "Tidak ada tanggal yang valid di panggilan ini. Tidak ada yang tercatat — tanyakan tanggalnya ke customer, lalu panggil lagi.",
    };
  }

  // Every active order, with its undated portions counted from the delivery
  // rows. This used to read the stored `orders.portions_remaining`, a counter
  // nothing kept honest — the daily sheet's delete button removed a row and
  // left it where it was — and on 2026-08-24 it disagreed with the rows for
  // 63 of the 195 customers holding an active order. Vania's read 0 with ten
  // portions genuinely left, so this bailed and three dinners the bot had
  // already confirmed to her were never written. The column is gone now.
  const { data: activeOrders } = await db
    .from("orders")
    .select("id, package_size, start_date, created_at, subcontractor_id")
    .eq("customer_id", customerId)
    .eq("status", "active");

  const candidates = activeOrders ?? [];
  if (candidates.length === 0) {
    console.error(
      "[record-daily-order] no active order for customer",
      customerId,
    );
    return {
      ok: false,
      error:
        "Customer tidak punya order aktif, jadi tidak ada yang tercatat. Jangan bilang jadwalnya sudah masuk.",
    };
  }

  const unbookedPerOrder = await unbookedByOrder(
    db,
    candidates.map((o) => ({ id: o.id, package_size: o.package_size })),
  );

  // Which package the rows bill to: the oldest one that still has undated
  // portions, per pickDrawOrder. Nothing else narrows the field. Quota
  // belongs to the customer, not to one package — an order records that they
  // topped up their balance, and two orders held by the same customer are the
  // same money.
  //
  // A meal filter used to run first, preferring orders whose
  // meal_time_preference covered the requested meal. Measured against
  // production on 2026-08-28 it changed the outcome for 3 of the 89 customers
  // holding two or more active orders, and all 3 were wrong: it skipped the
  // older package and charged the newer one, which is the exact
  // misattribution pickDrawOrder was written to stop.
  const order = pickDrawOrder(
    candidates.map((o) => ({
      ...o,
      unbooked: unbookedPerOrder.get(o.id) ?? 0,
    })),
  );

  if (!order) {
    console.error(
      "[record-daily-order] no draw order for customer",
      customerId,
    );
    return {
      ok: false,
      error:
        "Tidak ada paket yang bisa dipakai untuk mencatat hari ini. Tidak ada yang tercatat.",
    };
  }

  // Whether the kitchen this order draws from will go to the address at all.
  //
  // Coverage is per kitchen at the neighborhood level (see
  // `kitchenCoverage`), and a customer whose package was sold before the
  // kitchen ruled on their building still has quota and a standing order —
  // Sharleen holds 65 portions to Apartemen Akasa, which Thenie refused on
  // 2026-08-31. Booking another date there writes a row the kitchen will not
  // cook. Refuse the booking and say why: the model escalates, and an admin
  // moves the customer or the address.
  const kitchenId = order.subcontractor_id;
  if (kitchenId) {
    const { data: addressRow } = await db
      .from("customers")
      .select("address, sub_area")
      .eq("id", customerId)
      .maybeSingle();
    const { blocked } = coverageFor(
      await kitchenCoverage(db, kitchenId),
      addressRow?.address,
      addressRow?.sub_area,
    );
    if (blocked) {
      console.warn(
        `[record-daily-order] ${customerId} is at ${blocked.name}, which dapur ${kitchenId} does not serve — nothing booked`,
      );
      return {
        ok: false,
        error: `Dapur yang memasak paket customer ini tidak bisa mengantar ke ${blocked.name}, jadi tidak ada tanggal yang tercatat. Minta maaf ke customer, jangan janjikan tanggalnya, dan panggil escalate_to_human.`,
      };
    }
  }

  // The gate is customer-wide: a customer with two packages can draw across
  // both, and pickDrawOrder above decides which one the row is charged to.
  const custUnbooked =
    (await loadCustomerSchedule(db, customerId))?.unbooked ?? 0;

  if (custUnbooked <= 0) {
    console.warn(
      "[record-daily-order] every portion this customer bought already has a date",
      customerId,
    );
    // Never a silent drop: the bot has already told the customer the dates
    // are booked by the time this runs, so somebody has to know it did not
    // happen.
    await sendPushToAllAdmins(
      `Order harian tidak tercatat — ${customerName ?? phone}`,
      `Bot menyanggupi ${dates.length} tanggal, tapi semua porsi customer sudah punya tanggal`,
      "/deliveries",
      "high",
    );
    return {
      ok: false,
      error:
        "Semua porsi yang customer beli sudah punya tanggal, jadi tidak ada yang tercatat. Sisa kuota yang belum dijadwalkan: 0.",
    };
  }

  // A libur nasional is a day we are definitely shut, and the model schedules
  // straight through one — it put 25 Agustus (Maulid Nabi) in an eight-day run
  // in the simulator even with the holiday list in its prompt. Dropping the
  // date here is the guarantee; the prompt rule is the first layer.
  const closedDates = dates.filter((d) => isClosedHoliday(d));
  const openDates = dates.filter((d) => !isClosedHoliday(d));

  if (openDates.length === 0) {
    console.warn(
      "[record-daily-order] every requested date is a holiday",
      JSON.stringify(closedDates),
    );
    await sendPushToAllAdmins(
      `Order harian jatuh di tanggal merah — ${customerName ?? phone}`,
      `${closedDates.map((d) => holidayOn(d)?.name ?? d).join(", ")} — tidak ada yang tercatat`,
      "/deliveries",
      "high",
    );
    return {
      ok: false,
      error: `Semua tanggal yang diminta jatuh di hari libur nasional (${closedDates.map((d) => `${d} ${holidayOn(d)?.name ?? "libur"}`).join(", ")}). Tidak ada yang tercatat — tawarkan tanggal lain.`,
    };
  }

  // The model re-states a schedule while confirming it, so the same dates can
  // arrive twice. Skip whatever is already on the sheet rather than double-book.
  const { data: existingRows } = await db
    .from("daily_deliveries")
    .select("delivery_date")
    .eq("customer_id", customerId)
    .in("delivery_date", openDates);
  const alreadyBooked = new Set(
    (existingRows ?? []).map((r) => r.delivery_date),
  );
  const fresh = openDates.filter((d) => !alreadyBooked.has(d));

  // portions is per date. Book only as many dates as the quota covers — a
  // multi-day request must not be the thing that pushes an order negative.
  const perDate = Math.max(1, input.portions);
  const affordable = Math.floor(custUnbooked / perDate);
  const booking = fresh.slice(0, affordable);

  if (booking.length === 0) {
    console.warn(
      "[record-daily-order] nothing to book",
      JSON.stringify({
        dates,
        alreadyBooked: [...alreadyBooked],
        affordable,
      }),
    );
    return {
      ok: false,
      error:
        alreadyBooked.size > 0 && fresh.length === 0
          ? `Tanggal itu sudah ada di jadwal customer sebelumnya (${[...alreadyBooked].join(", ")}), jadi tidak ada yang baru dicatat. Beri tahu customer jadwalnya memang sudah ada.`
          : "Kuota yang belum dijadwalkan tidak cukup untuk satu hari pun. Tidak ada yang tercatat.",
    };
  }

  const { error: insertError } = await db.from("daily_deliveries").insert(
    booking.map((delivery_date) => ({
      order_id: order.id,
      customer_id: customerId,
      delivery_date,
      meal_type: input.meal_type,
      portions: perDate,
      subcontractor_id: order.subcontractor_id,
      notes: input.notes ?? null,
    })),
  );
  if (insertError) {
    console.error("[record-daily-order] insert failed:", insertError.message);
    await sendPushToAllAdmins(
      `Order harian GAGAL — ${customerName ?? phone}`,
      `${booking.length} hari tidak tersimpan: ${insertError.message}`,
      "/deliveries",
      "high",
    );
    return {
      ok: false,
      error:
        "Gagal menyimpan ke database. Tidak ada yang tercatat — jangan bilang jadwalnya sudah masuk, bilang saja sedang dicek admin.",
    };
  }

  const deducted = booking.length * perDate;

  // Nothing to deduct on the order: the rows just inserted are the deduction.
  const { data: custQuota } = await db
    .from("customers")
    .select("portions_remaining")
    .eq("id", customerId)
    .single();
  if (custQuota) {
    await db
      .from("customers")
      .update({
        portions_remaining: Math.max(
          0,
          custQuota.portions_remaining - deducted,
        ),
      })
      .eq("id", customerId);
  }

  const span =
    booking.length === 1
      ? booking[0]
      : `${booking[0]} – ${booking[booking.length - 1]} (${booking.length} hari)`;
  await sendPushToAllAdmins(
    `Order harian — ${customerName ?? phone}`,
    `${span} ${input.meal_type} × ${perDate} porsi/hari`,
    "/deliveries",
    "low",
  );

  // The customer was told a schedule that runs through a day we are shut. The
  // bot may or may not have said so, so a human has to check.
  if (closedDates.length > 0) {
    await sendPushToAllAdmins(
      `Tanggal merah dilewati — ${customerName ?? phone}`,
      closedDates
        .map((d) => `${d} ${holidayOn(d)?.name ?? "libur"}`)
        .join(", "),
      "/deliveries",
      "high",
    );
  }

  // The customer was told a schedule the quota could not cover. A human has to
  // tell them, so this is not a low-priority note.
  if (booking.length < fresh.length) {
    await sendPushToAllAdmins(
      `Kuota kurang — ${customerName ?? phone}`,
      `Diminta ${fresh.length} hari, hanya ${booking.length} tercatat (${custUnbooked} porsi belum punya tanggal)`,
      "/deliveries",
      "high",
    );
  }

  // Partial success is still success, but it has to say which dates. The
  // model was told "done" for a booking that dropped half the run and
  // confirmed the whole run to the customer.
  const notBooked = [
    ...closedDates.map((d) => `${d} (libur nasional)`),
    ...[...alreadyBooked].map((d) => `${d} (sudah ada di jadwal)`),
    ...fresh.slice(booking.length).map((d) => `${d} (kuota tidak cukup)`),
  ];
  return {
    ok: true,
    message: `Tercatat: ${booking.join(", ")} — ${input.meal_type}, ${perDate} porsi/hari.${
      notBooked.length > 0
        ? ` TIDAK tercatat: ${notBooked.join(", ")}. Sebutkan ini ke customer, jangan konfirmasi tanggal yang tidak masuk.`
        : ""
    } Sisa porsi yang belum dijadwalkan setelah ini: ${custUnbooked - deducted}.`,
  };
}
