import type { SupabaseClient } from "@supabase/supabase-js";
import { logEdit } from "@/lib/audit/log-edit";
import { isLocked, loadDeadlineHour } from "@/lib/orders/delivery-state";
import { sendPushToAllAdmins } from "@/lib/push/send";
import type { Database } from "@/types/database";

type Db = SupabaseClient<Database>;

/** What the model asked to re-address. */
export type ChangeDeliveryAddressInput = {
  delivery_dates?: string[];
  /** 1 = the customer's main address, 2 = their second one. */
  address_slot?: number;
  reason?: string;
};

/** Structurally the webhook's `ToolResult`. Indonesian, the model paraphrases it. */
export type ChangeDeliveryAddressResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/** Short enough to read back to a customer, long enough to tell the two apart. */
function label(address: string | null, area: string | null): string {
  const text = (address ?? "").trim() || (area ?? "").trim() || "alamat tercatat";
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * Moves scheduled deliveries between the two addresses the customer has on file.
 *
 * Until this existed the bot had no tool for an address at all, and the prompt
 * sent it to ask_admin_for_help — which it ignored, because confirming is
 * cheaper than escalating. Cindi asked three times in one week for her lunch to
 * go to her kost instead of UPH Gate 2; she was told "pengiriman dialihkan ke
 * Kost Platinum ya" and "jadwal di catatan kami memang sudah begitu kok", no
 * row ever changed, and we paid for two rescue Grabs from UPH before the third
 * one was caught by hand on 2026-09-07.
 *
 * Only the two saved addresses. A place the customer has never given us is
 * still an admin's job — this writes `address_slot`, it does not invent an
 * address — and so is a locked date, refused here the same way a skip is:
 * past the H-1 deadline the kitchen is cooking for the address it was given.
 */
export async function changeDeliveryAddress(params: {
  db: Db;
  customerId: string;
  phone: string;
  customerName: string | null;
  input: ChangeDeliveryAddressInput;
}): Promise<ChangeDeliveryAddressResult> {
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
      "[change-delivery-address] no valid delivery date",
      JSON.stringify(input),
    );
    return {
      ok: false,
      error:
        "Tidak ada tanggal yang valid di panggilan ini. Tidak ada alamat yang diubah — tanyakan tanggalnya ke customer, lalu panggil lagi.",
    };
  }

  const slot = Number(input.address_slot);
  if (slot !== 1 && slot !== 2) {
    return {
      ok: false,
      error:
        "address_slot harus 1 (alamat utama) atau 2 (alamat kedua). Tidak ada yang diubah.",
    };
  }

  const { data: customer } = await db
    .from("customers")
    .select("address, area, address_2, area_2")
    .eq("id", customerId)
    .maybeSingle();

  if (slot === 2 && !customer?.address_2) {
    return {
      ok: false,
      error:
        "Customer ini hanya punya satu alamat tercatat, jadi tidak ada alamat kedua untuk dipakai. Tidak ada yang diubah — kalau customer memberi alamat baru, panggil ask_admin_for_help dengan tanggal, meal dan alamatnya.",
    };
  }

  const target =
    slot === 2
      ? label(customer?.address_2 ?? null, customer?.area_2 ?? null)
      : label(customer?.address ?? null, customer?.area ?? null);

  const { data: rows } = await db
    .from("daily_deliveries")
    .select("id, delivery_date, meal_type, address_slot")
    .eq("customer_id", customerId)
    .in("delivery_date", dates);

  const scheduled = rows ?? [];
  if (scheduled.length === 0) {
    return {
      ok: false,
      error: `Tidak ada pengiriman terjadwal di tanggal itu (${dates.join(", ")}), jadi tidak ada alamat yang diubah. Beri tahu customer jadwalnya memang belum ada — jangan bilang alamatnya sudah dipindah.`,
    };
  }

  const deadlineHour = await loadDeadlineHour();
  const changed: string[] = [];
  const already: string[] = [];
  const locked: string[] = [];
  const failed: string[] = [];

  for (const row of scheduled) {
    const date = row.delivery_date;
    const meal = row.meal_type === "dinner" ? "malam" : "siang";
    if ((row.address_slot ?? 1) === slot) {
      already.push(`${date} (${meal})`);
      continue;
    }
    if (isLocked(date, { deadlineHour })) {
      locked.push(date);
      continue;
    }
    const { error } = await db
      .from("daily_deliveries")
      .update({ address_slot: slot })
      .eq("id", row.id);
    if (error) {
      console.error(`[change-delivery-address] ${date} failed:`, error.message);
      failed.push(date);
      continue;
    }
    changed.push(`${date} (${meal})`);
    await logEdit({
      db,
      actor: "system:webhook:change_delivery_address",
      entityType: "daily_deliveries",
      entityId: row.id,
      action: "change_address",
      changes: {
        address_slot: { from: row.address_slot ?? 1, to: slot },
        reason: input.reason?.trim()
          ? `Customer via WhatsApp: ${input.reason.trim()}`
          : "Customer minta ganti alamat lewat WhatsApp",
      },
    });
  }

  if (changed.length === 0) {
    if (failed.length > 0) {
      await sendPushToAllAdmins(
        `Ganti alamat GAGAL — ${customerName ?? phone}`,
        `${failed.join(", ")} tidak tersimpan`,
        "/deliveries",
        "high",
      );
      return {
        ok: false,
        error:
          "Gagal menyimpan alamatnya ke database. Tidak ada yang berubah — jangan bilang sudah dipindah, bilang saja sedang dicek admin.",
      };
    }
    if (locked.length > 0) {
      return {
        ok: false,
        error: `Tanggal ${locked.join(", ")} sudah terkunci — dapur sudah memegang alamat yang lama dan makanannya tetap ke sana. Tidak ada yang berubah. Katakan itu terus terang, sebutkan alamat yang dipakai, lalu tawarkan perubahan mulai tanggal pertama yang belum terkunci.`,
      };
    }
    // Everything already pointed at the address asked for. Saying so is the
    // whole answer, and it is the one case where "sudah begitu kok" is true.
    return {
      ok: true,
      message: `Tidak ada yang perlu diubah: ${already.join(", ")} memang sudah terjadwal ke *${target}*. Sebutkan itu ke customer.`,
    };
  }

  await sendPushToAllAdmins(
    `Alamat pengiriman diubah — ${customerName ?? phone}`,
    `${changed.join(", ")} ke ${target}`,
    "/deliveries",
    "low",
  );

  const dropped = [
    ...locked.map((d) => `${d} (sudah TERKUNCI, dapur sudah memegang alamat lama)`),
    ...failed.map((d) => `${d} (gagal disimpan)`),
  ];

  return {
    ok: true,
    message: `Alamat diubah ke *${target}* untuk: ${changed.join(", ")}.${
      already.length > 0 ? ` Sudah ke alamat itu sejak awal: ${already.join(", ")}.` : ""
    }${
      dropped.length > 0
        ? ` TIDAK diubah: ${dropped.join(", ")}. Sebutkan ini ke customer.`
        : ""
    }`,
  };
}
