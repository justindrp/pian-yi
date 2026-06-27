/**
 * One-time import script: reads CUSTOMERS + ORDER_HARIAN CSVs exported from Google Sheets
 * and upserts into Supabase.
 *
 * Usage (Google Sheets — sheet must be "anyone with link can view"):
 *   pnpm tsx scripts/import-customers-orders.ts \
 *     --customers="https://docs.google.com/spreadsheets/d/ID/edit#gid=0" \
 *     --orders="https://docs.google.com/spreadsheets/d/ID/edit#gid=1234567890"
 *
 * Usage (local CSV files):
 *   pnpm tsx scripts/import-customers-orders.ts \
 *     --customers=scripts/import-data/customers.csv \
 *     --orders=scripts/import-data/orders.csv
 */

import { parse } from "csv-parse/sync";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";

// ─── Config ────────────────────────────────────────────────────────────────

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const db = createClient<Database>(supabaseUrl, serviceRoleKey);

// ─── Area prefix map ────────────────────────────────────────────────────────

const AREA_PREFIXES: [string, string][] = [
  ["BSD Baru", "BSD Baru"],
  ["BSD Lama", "BSD Lama"],
  ["Alsut", "Alam Sutera"],
  ["GS", "Gading Serpong"],
  ["Bintaro", "Bintaro"],
  ["Karawaci", "Karawaci"],
  ["Melati Mas", "Melati Mas"],
  ["GR", "Graha Raya"],
];

function parseAreaSubArea(raw: string): { area: string; sub_area: string | null } {
  const trimmed = raw.trim();
  for (const [prefix, area] of AREA_PREFIXES) {
    if (trimmed.startsWith(`${prefix}-`)) {
      return { area, sub_area: trimmed.slice(prefix.length + 1).trim() || null };
    }
    if (trimmed === prefix) {
      return { area, sub_area: null };
    }
  }
  // Fallback: treat whole string as area
  return { area: trimmed, sub_area: null };
}

// ─── Name helpers ───────────────────────────────────────────────────────────

// "Devi 1" → { base: "Devi", index: 1 }  |  "Annie" → { base: "Annie", index: 0 }
function parseName(name: string): { base: string; index: number } {
  const m = name.trim().match(/^(.+?)\s+(\d+)$/);
  if (m) return { base: m[1].trim(), index: Number.parseInt(m[2], 10) };
  return { base: name.trim(), index: 0 };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

// ─── CSV row types ──────────────────────────────────────────────────────────

interface CustomerRow {
  no: string;
  nama: string;
  areaSubArea: string; // legacy combined format "Alsut-Pacific Garden"
  subArea: string;     // separate Sub Area column (new sheet format)
  alamat: string;
  mapsLink: string;
  catatan: string;
  subcontractor: string;
  sisaKuota: string;
  hargaPerKuota: string;
  total: string;
  phoneNumber?: string;
}

interface OrderRow {
  tanggal: string;   // Date / Tanggal
  mealType: string;  // Meal / Lunch/Dinner column value
  nama: string;      // Customer / Nama
  areaSubArea: string;
  subArea: string;
  alamat: string;    // Address / Alamat
  mapsLink: string;
  jumlah: string;    // Portions / Jumlah
  catatan: string;   // Notes / Catatan
  subcontractor: string; // Vendor / Subcontractor
}

// ─── CSV loading (file path or Google Sheets URL) ───────────────────────────

// Converts a Google Sheets share URL to a CSV export URL.
// Input:  https://docs.google.com/spreadsheets/d/ID/edit#gid=GID
// Output: https://docs.google.com/spreadsheets/d/ID/export?format=csv&gid=GID
function toSheetsCsvUrl(url: string): string {
  const idMatch = url.match(/\/spreadsheets\/d\/([^/]+)/);
  const gidMatch = url.match(/[#&?]gid=(\d+)/);
  if (!idMatch) throw new Error(`Cannot parse spreadsheet ID from URL: ${url}`);
  const id = idMatch[1];
  const gid = gidMatch ? gidMatch[1] : "0";
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

async function loadCsvContent(source: string): Promise<string> {
  if (source.startsWith("https://docs.google.com/spreadsheets/")) {
    const csvUrl = toSheetsCsvUrl(source);
    console.log(`  Fetching sheet: ${csvUrl}`);
    const res = await fetch(csvUrl);
    if (!res.ok) throw new Error(`Failed to fetch sheet (${res.status}): ${res.statusText}`);
    return res.text();
  }
  return readFileSync(source, "utf-8");
}

async function parseCsv(source: string): Promise<Record<string, string>[]> {
  const content = await loadCsvContent(source);

  // Parse as raw arrays first to handle sheets with side-by-side summary tables
  // that reuse the same column headers (e.g. a second "Nama" column).
  const rawRows = parse(content, {
    skip_empty_lines: false,
    relax_column_count: true,
    relax_quotes: true,
    trim: true,
  }) as string[][];

  if (rawRows.length === 0) return [];

  // Find the column count of the primary (left) table:
  // stop at the first duplicate non-empty header.
  const headers = rawRows[0];
  const seen = new Set<string>();
  let colCount = headers.length;
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].trim().toLowerCase();
    if (!h) continue;
    if (seen.has(h)) { colCount = i; break; }
    seen.add(h);
  }

  // Build records using only the primary table's columns
  const colNames = headers.slice(0, colCount);
  return rawRows
    .slice(1)
    .filter((row) => row.some((cell) => cell.trim() !== ""))
    .map((row) => {
      const record: Record<string, string> = {};
      for (let i = 0; i < colCount; i++) {
        record[colNames[i]] = row[i] ?? "";
      }
      return record;
    });
}

function normalizeCustomerRow(raw: Record<string, string>): CustomerRow | null {
  // Try to find columns by scanning header keys case-insensitively
  const get = (keys: string[]): string => {
    for (const k of keys) {
      for (const [header, val] of Object.entries(raw)) {
        if (header.toLowerCase().includes(k.toLowerCase())) return val ?? "";
      }
    }
    return "";
  };

  const nama = get(["nama"]).trim();
  if (!nama || nama === "#N/A" || nama === "No.") return null;
  // Skip header row or formula errors
  if (nama.toLowerCase() === "nama") return null;

  return {
    no: get(["no."]),
    nama,
    areaSubArea: get(["area"]),
    subArea: get(["sub area", "sub_area"]),
    alamat: get(["alamat lengkap", "alamat", "address"]),
    mapsLink: get(["google maps", "link google", "maps"]),
    catatan: get(["catatan", "notes"]),
    subcontractor: get(["subcontractor", "vendor"]),
    sisaKuota: get(["sisa kuota", "sisa kuota", "quota"]),
    hargaPerKuota: get(["harga per kuota", "harga per", "sell price", "harga"]),
    total: get(["total sale", "total"]),
    phoneNumber: get(["phone", "telpon", "telepon", "wa", "whatsapp", "no. hp", "no hp"]),
  };
}

function normalizeOrderRow(raw: Record<string, string>): OrderRow | null {
  const get = (keys: string[]): string => {
    for (const k of keys) {
      for (const [header, val] of Object.entries(raw)) {
        if (header.toLowerCase().includes(k.toLowerCase())) return val ?? "";
      }
    }
    return "";
  };

  const nama = get(["customer", "nama"]).trim();
  const tanggal = get(["date", "tanggal"]).trim();
  // Skip #N/A rows or empty rows
  if (!nama || nama === "#N/A" || !tanggal || tanggal === "#N/A") return null;

  return {
    tanggal,
    mealType: get(["lunch", "dinner", "makan", "meal"]).trim().toLowerCase(),
    nama,
    areaSubArea: get(["area"]),
    subArea: get(["sub area", "subarea", "sub_area"]),
    alamat: get(["alamat lengkap", "alamat", "address"]),
    mapsLink: get(["link alamat", "maps", "link google"]),
    jumlah: get(["jumlah", "porsi", "portions", "portion"]),
    catatan: get(["catatan", "notes"]),
    subcontractor: get(["subcontractor", "vendor"]),
  };
}

// ─── Date parsing ───────────────────────────────────────────────────────────

function parseDate(raw: string): string | null {
  if (!raw || raw === "#N/A") return null;
  // Handle "6/5/2026" (M/D/YYYY) and "2026-06-05" (ISO)
  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, m, d, y] = slash;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const iso = raw.match(/^\d{4}-\d{2}-\d{2}/);
  if (iso) return raw.slice(0, 10);
  return null;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    const cleaned = a.replace(/^--/, "");
    const idx = cleaned.indexOf("=");
    if (idx !== -1) args[cleaned.slice(0, idx)] = cleaned.slice(idx + 1);
  }
  const customersCsvPath = args.customers;
  const ordersCsvPath = args.orders;

  if (!customersCsvPath) {
    console.error("Usage: pnpm tsx scripts/import-customers-orders.ts --customers=<path> [--orders=<path>]");
    process.exit(1);
  }

  // ── Load subcontractors ──────────────────────────────────────────────────
  const { data: subcontractors } = await db.from("subcontractors").select("id, name");
  const subByName = new Map<string, string>(
    (subcontractors ?? []).map((s) => [s.name.trim().toLowerCase(), s.id]),
  );

  function resolveSubcontractor(name: string): string | null {
    return subByName.get(name.trim().toLowerCase()) ?? null;
  }

  function normalizePhone(raw: string): string {
    const digits = raw.replace(/[\s\-().+]/g, "");
    if (!digits || digits.length < 8) return "";
    if (digits.startsWith("62")) return `+${digits}`;
    if (digits.startsWith("0")) return `+62${digits.slice(1)}`;
    return `+62${digits}`;
  }

  // ── Parse CSVs ───────────────────────────────────────────────────────────
  const rawCustomers = (await parseCsv(customersCsvPath)).map(normalizeCustomerRow).filter(Boolean) as CustomerRow[];
  const rawOrders = ordersCsvPath
    ? ((await parseCsv(ordersCsvPath)).map(normalizeOrderRow).filter(Boolean) as OrderRow[])
    : [];

  console.log(`Parsed ${rawCustomers.length} customer rows, ${rawOrders.length} order rows`);

  // ── Group customer rows by base name ─────────────────────────────────────
  // "Devi 1" and "Devi 2" → same customer, two orders
  const groups = new Map<string, CustomerRow[]>();
  for (const row of rawCustomers) {
    const { base } = parseName(row.nama);
    const key = base.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(row);
  }

  // ── Load existing orders to avoid duplicates ────────────────────────────
  const { data: existingOrders } = await db
    .from("orders")
    .select("id, customer_id, delivery_address, area, status")
    .in("status", ["active", "pending_payment", "payment_proof_received", "paused"]);
  const existingOrdersByCustomer = new Map<string, typeof existingOrders>();
  for (const ord of existingOrders ?? []) {
    if (!ord.customer_id) continue;
    if (!existingOrdersByCustomer.has(ord.customer_id)) {
      existingOrdersByCustomer.set(ord.customer_id, []);
    }
    const bucket = existingOrdersByCustomer.get(ord.customer_id);
    if (bucket) bucket.push(ord);
  }

  // ── Upsert customers + orders ────────────────────────────────────────────
  // Map from display name (lowercase) → customer id, for ORDER_HARIAN matching
  const customerIdByName = new Map<string, string>();
  // Map from "customerId:alamat_slug" → order id
  const orderIdByKey = new Map<string, string>();

  let customerCount = 0;
  let orderCount = 0;

  for (const [baseKey, rows] of groups) {
    const baseName = parseName(rows[0].nama).base;
    if (baseName.toLowerCase() === "total") continue; // skip spreadsheet summary rows
    const slug = slugify(baseName);

    // Phone: normalize and use first valid phone in the group, else placeholder
    const rawPhone = rows.map((r) => r.phoneNumber ?? "").find((p) => p.trim() !== "") ?? "";
    const phone = normalizePhone(rawPhone) || `IMPORT_${slug}`;

    // Calculate WAC across all rows in this group
    let totalPortions = 0;
    let weightedPrice = 0;
    for (const row of rows) {
      const qty = Number.parseInt(row.sisaKuota, 10) || 0;
      const price = Number.parseInt(row.hargaPerKuota.replace(/[^0-9]/g, ""), 10) || 0;
      totalPortions += qty;
      weightedPrice += qty * price;
    }
    const avgPrice = totalPortions > 0 ? Math.round(weightedPrice / totalPortions) : 0;

    // Resolve area: prefer separate subArea column, fall back to parseAreaSubArea on combined
    const parsedArea = parseAreaSubArea(rows[0].areaSubArea);
    const resolvedArea = parsedArea.area || rows[0].areaSubArea || null;
    const resolvedSubArea = rows[0].subArea || parsedArea.sub_area || null;

    const ROUTE_1_AREAS = ["Alam Sutera", "BSD Lama"];
    const ROUTE_2_AREAS = ["Gading Serpong", "BSD Baru", "Karawaci"];
    const deliveryRoute = ROUTE_1_AREAS.includes(resolvedArea ?? "")
      ? 1
      : ROUTE_2_AREAS.includes(resolvedArea ?? "")
        ? 2
        : null;

    // Upsert customer
    const { data: cust, error: custErr } = await db
      .from("customers")
      .upsert(
        {
          phone_number: phone,
          name: baseName,
          address: rows[0].alamat || null,
          area: resolvedArea,
          sub_area: resolvedSubArea,
          google_maps_link: rows[0].mapsLink || null,
          notes: rows[0].catatan || null,
          subcontractor_id: resolveSubcontractor(rows[0].subcontractor),
          portions_remaining: totalPortions,
          avg_price_per_portion: avgPrice,
          customer_number: Number.parseInt(rows[0].no, 10) || null,
          delivery_route: deliveryRoute,
        },
        { onConflict: "phone_number" },
      )
      .select("id")
      .single();

    if (custErr || !cust) {
      console.error(`  ERROR creating customer "${baseName}":`, custErr?.message);
      continue;
    }
    customerCount++;
    customerIdByName.set(baseKey, cust.id);
    for (const row of rows) {
      customerIdByName.set(row.nama.trim().toLowerCase(), cust.id);
    }

    // Ensure customer_state and customer_flags exist
    await db.from("customer_state").upsert(
      { customer_id: cust.id, state: totalPortions > 0 ? "active_subscription" : "new" },
      { onConflict: "customer_id", ignoreDuplicates: true },
    );
    await db.from("customer_flags").upsert(
      { customer_id: cust.id },
      { onConflict: "customer_id", ignoreDuplicates: true },
    );

    // Skip order creation if customer already has active orders
    const existingCustOrders = existingOrdersByCustomer.get(cust.id) ?? [];
    if (existingCustOrders.length > 0) {
      for (const ord of existingCustOrders) {
        const alamatSlug = slugify(ord.delivery_address || ord.area || "");
        orderIdByKey.set(`${cust.id}:${alamatSlug}`, ord.id);
      }
      console.log(`  ↩ ${baseName} (existing orders, skipped creation)`);
      continue;
    }

    // New customer — create one order per row
    for (const row of rows) {
      const parsed = parseAreaSubArea(row.areaSubArea);
      const area = parsed.area || row.areaSubArea || "";
      const portions = Number.parseInt(row.sisaKuota, 10) || 0;
      const priceRaw = Number.parseInt(row.hargaPerKuota.replace(/[^0-9]/g, ""), 10) || 0;
      const totalPrice = portions * priceRaw;

      const { data: ord, error: ordErr } = await db
        .from("orders")
        .insert({
          customer_id: cust.id,
          subcontractor_id: resolveSubcontractor(row.subcontractor),
          status: "active",
          package_size: portions,
          portions_per_delivery: 1,
          portions_remaining: portions,
          price_per_portion: priceRaw,
          total_price: totalPrice,
          meal_time_preference: "per_day_decision",
          start_date: new Date().toISOString().slice(0, 10),
          delivery_address: row.alamat,
          maps_link: row.mapsLink,
          area,
        })
        .select("id")
        .single();

      if (ordErr || !ord) {
        console.error(`  ERROR creating order for "${row.nama}":`, ordErr?.message);
        continue;
      }
      orderCount++;

      const alamatSlug = slugify(row.alamat || row.areaSubArea);
      orderIdByKey.set(`${cust.id}:${alamatSlug}`, ord.id);
    }

    console.log(`  ✓ ${baseName} (${rows.length} order${rows.length > 1 ? "s" : ""})`);
  }

  console.log(`\nImported ${customerCount} customers, ${orderCount} new orders`);

  // ── Upsert daily_deliveries from ORDER_HARIAN ────────────────────────────
  let deliveryCount = 0;
  let deliverySkipped = 0;

  for (const row of rawOrders) {
    const date = parseDate(row.tanggal);
    if (!date) { deliverySkipped++; continue; }

    const mealType = row.mealType.toLowerCase().includes("dinner") ? "dinner" : "lunch";
    const portions = Number.parseInt(row.jumlah, 10) || 1;
    const nameKey = row.nama.trim().toLowerCase();

    // Match customer: try full name first, then base name
    const { base } = parseName(row.nama);
    const customerId = customerIdByName.get(nameKey) ?? customerIdByName.get(base.toLowerCase());
    if (!customerId) {
      console.warn(`  SKIP delivery row: no customer found for "${row.nama}" on ${date}`);
      deliverySkipped++;
      continue;
    }

    // Match order: prefer address match, fall back to any order for this customer
    const alamatSlug = slugify(row.alamat || row.areaSubArea);
    const orderId =
      orderIdByKey.get(`${customerId}:${alamatSlug}`) ??
      [...orderIdByKey.entries()].find(([k]) => k.startsWith(`${customerId}:`))?.[1];

    if (!orderId) {
      console.warn(`  SKIP delivery row: no order found for "${row.nama}" on ${date}`);
      deliverySkipped++;
      continue;
    }

    const subcontractorId = resolveSubcontractor(row.subcontractor);

    const { error } = await db.from("daily_deliveries").upsert(
      {
        delivery_date: date,
        customer_id: customerId,
        order_id: orderId,
        meal_type: mealType,
        portions,
        subcontractor_id: subcontractorId,
        notes: row.catatan || null,
        status: "scheduled",
      },
      { onConflict: "delivery_date,customer_id,meal_type", ignoreDuplicates: false },
    );

    if (error) {
      console.warn(`  ERROR delivery "${row.nama}" ${date}:`, error.message);
      deliverySkipped++;
    } else {
      deliveryCount++;
    }
  }

  console.log(`Imported ${deliveryCount} deliveries, skipped ${deliverySkipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
