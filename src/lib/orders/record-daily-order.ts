import type { SupabaseClient } from "@supabase/supabase-js";
import { holidayOn, isClosedHoliday } from "@/lib/holidays/id";
import { jakartaDateString } from "@/lib/menu/week";
import {
  loadCustomerSchedule,
  unbookedByOrder,
} from "@/lib/orders/customer-schedule";
import { isLocked, loadDeadlineHour } from "@/lib/orders/delivery-state";
import { pickDrawOrder } from "@/lib/orders/pick-draw-order";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { coverageFor, kitchenCoverage } from "@/lib/subcontractors/coverage";
import { daysLabel, kitchenDeliversOn } from "@/lib/subcontractors/days";
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

  // A date already gone. The shape check above passes any well-formed ISO
  // string, and on 2026-09-01 Rachel was told "besok Rabu 2 September" — the
  // reply named no year, and the date that reached this function was
  // 2025-09-02. It booked cleanly: the double-booking guard compares strings,
  // so the real 2026-09-02 row sitting on her sheet did not stop it, and the
  // phantom ate the fifth portion of her five-portion package. Nothing downstream
  // can tell a mistyped year from a real booking, so drop it here.
  // jakartaDateString(), not jakartaTimeString().slice(0, 10): the latter
  // returns "HH:MM", so todayWib was "20:23" and every well-formed date sorted
  // below it as a string — the guard refused every booking it ever saw.
  const todayWib = jakartaDateString();
  const pastDates = dates.filter((d) => d < todayWib);
  const futureDates = dates.filter((d) => d >= todayWib);

  if (futureDates.length === 0) {
    console.error(
      "[record-daily-order] every requested date is in the past",
      JSON.stringify({ dates, todayWib }),
    );
    return {
      ok: false,
      error: `Tanggal yang diminta (${pastDates.join(", ")}) sudah lewat, hari ini ${todayWib}. Tidak ada yang tercatat — pastikan tahunnya benar dan tanyakan tanggalnya lagi ke customer.`,
    };
  }

  // Past the kitchen's cutoff. The filter above only catches a date that has
  // already gone; the deadline is 16:00 WIB the *day before*, so both today and
  // — after 16:00 — tomorrow are already committed. `delete_deliveries` and
  // `change_delivery_address` have refused a locked date since they were
  // written; this one never checked, which left the bot able to add a meal to a
  // day it was not allowed to cancel a meal from. Adding is the worse half:
  // the sheet went to the kitchen hours ago and is not re-read, so the row is
  // cooked by nobody, while the insert still spends the customer's quota and
  // the tool still returns ok — so the bot tells them it is booked.
  //
  // 2026-09-12 is the case. Thenie was never paid for that day and cancelled
  // it; six rows were deleted at 11:57 WIB. At 13:38 the bot booked Puspa a
  // fresh row for that same date. Nothing cooked it, her package went back to
  // fully dated, and her next request — a real one, for the 15th — was refused
  // by the unbooked<=0 gate below, which pushed the admin an alert about the
  // second failure while the first stayed silent.
  //
  // Dropped rather than refused outright, the way a libur and a kitchen's off
  // day are: the rest of the run still books and the dropped dates are named
  // in the result, so the model does not confirm one that was thrown away.
  const deadlineHour = await loadDeadlineHour();
  const lockedDates = futureDates.filter((d) => isLocked(d, { deadlineHour }));
  const openDeadlineDates = futureDates.filter(
    (d) => !isLocked(d, { deadlineHour }),
  );

  if (openDeadlineDates.length === 0) {
    console.warn(
      "[record-daily-order] every requested date is past the kitchen cutoff",
      JSON.stringify({ lockedDates, deadlineHour }),
    );
    return {
      ok: false,
      error: `Tanggal yang diminta (${lockedDates.join(", ")}) sudah lewat batas pemesanan jam ${deadlineHour}.00 WIB H-1, jadi tidak ada yang tercatat. Jangan janjikan tanggal itu — tawarkan tanggal yang masih bisa.`,
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

  const { data: customerRow } = await db
    .from("customers")
    .select("address, sub_area, subcontractor_id")
    .eq("id", customerId)
    .maybeSingle();

  // Which dapur cooks this booking: the customer's, not the package's. The
  // package can be months old and its kitchen long since changed — galvent was
  // moved to Thenie in August, and on 2026-09-08 the bot booked him 2 porsi for
  // the 10th which landed on Perut Bahagia, the kitchen on the June order this
  // drew against. Nobody at Thenie saw the order and Perut Bahagia had a row
  // for a customer they do not serve. The order's kitchen is only the fallback,
  // for a customer with none recorded.
  const withUnbooked = candidates.map((o) => ({
    ...o,
    unbooked: unbookedPerOrder.get(o.id) ?? 0,
  }));
  const customerKitchenId = customerRow?.subcontractor_id ?? null;

  // Which package the rows bill to: the oldest one that still has undated
  // portions, per pickDrawOrder. Quota belongs to the customer, not to one
  // package — an order records that they topped up their balance, and two
  // orders held by the same customer are the same money.
  //
  // Packages bought from the kitchen doing the cooking come first, the same
  // rule allocateDraws() applies: the ladders are per kitchen (migration 098),
  // so charging a Thenie dinner to a Perut Bahagia package balances the portion
  // ledger while spending the wrong ladder's money. It is a preference and not
  // a filter because 70 customers currently hold undated portions only on a
  // kitchen they have since been moved off; refusing those bookings would
  // strand quota they have paid for.
  //
  // A meal filter used to run first, preferring orders whose
  // meal_time_preference covered the requested meal. Measured against
  // production on 2026-08-28 it changed the outcome for 3 of the 89 customers
  // holding two or more active orders, and all 3 were wrong: it skipped the
  // older package and charged the newer one, which is the exact
  // misattribution pickDrawOrder was written to stop.
  const sameKitchen = customerKitchenId
    ? withUnbooked.filter(
        (o) =>
          o.subcontractor_id == null ||
          o.subcontractor_id === customerKitchenId,
      )
    : withUnbooked;
  const order =
    pickDrawOrder(sameKitchen.filter((o) => o.unbooked > 0)) ??
    pickDrawOrder(withUnbooked);

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

  // Whether the kitchen cooking this booking will go to the address at all.
  //
  // Coverage is per kitchen at the neighborhood level (see
  // `kitchenCoverage`), and a customer whose package was sold before the
  // kitchen ruled on their building still has quota and a standing order —
  // Sharleen holds 65 portions to Apartemen Akasa, which Thenie refused on
  // 2026-08-31. Booking another date there writes a row the kitchen will not
  // cook. Refuse the booking and say why: the model escalates, and an admin
  // moves the customer or the address.
  const kitchenId = customerKitchenId ?? order.subcontractor_id;
  if (kitchenId) {
    const { blocked } = coverageFor(
      await kitchenCoverage(db, kitchenId),
      customerRow?.address,
      customerRow?.sub_area,
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
  const closedDates = openDeadlineDates.filter((d) => isClosedHoliday(d));
  const businessDates = openDeadlineDates.filter((d) => !isClosedHoliday(d));

  // A weekday the kitchen cooking this package does not work. `isClosedHoliday`
  // answers for the business and used to be the whole calendar, because every
  // kitchen worked Senin–Sabtu; Homey works Senin–Jumat, so a Sabtu booked on a
  // Homey package is a row on a sheet nobody reads. Dropped like a libur is —
  // the portions stay unbooked and the customer can move them — and named in
  // the result, so the model does not confirm a date that was thrown away.
  const { data: kitchenDaysRow } = kitchenId
    ? await db
        .from("subcontractors")
        .select("delivery_days")
        .eq("id", kitchenId)
        .maybeSingle()
    : { data: null };
  const kitchenDays = kitchenDaysRow?.delivery_days ?? null;
  const offDates = businessDates.filter(
    (d) => !kitchenDeliversOn(kitchenDays, d),
  );
  const openDates = businessDates.filter((d) =>
    kitchenDeliversOn(kitchenDays, d),
  );

  if (openDates.length === 0 && offDates.length > 0) {
    console.warn(
      "[record-daily-order] every open date falls on a day this dapur does not cook",
      JSON.stringify({ kitchenId, offDates }),
    );
    return {
      ok: false,
      error: `Dapur yang memasak paket customer ini hanya kirim ${daysLabel(kitchenDays)}, jadi tanggal yang diminta (${offDates.join(", ")}) tidak bisa dicatat. Tidak ada yang tercatat — tawarkan hari lain.`,
    };
  }

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
      subcontractor_id: kitchenId,
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
    ...pastDates.map((d) => `${d} (sudah lewat)`),
    ...lockedDates.map(
      (d) => `${d} (sudah lewat batas jam ${deadlineHour}.00 WIB H-1)`,
    ),
    ...closedDates.map((d) => `${d} (libur nasional)`),
    ...offDates.map((d) => `${d} (dapur tidak kirim hari itu)`),
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
