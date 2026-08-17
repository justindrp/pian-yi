// Human-readable labels for the assistant's tool calls, so the streaming UI can
// show what it is doing instead of an opaque spinner. Indonesian, matching the
// rest of the dashboard.

const TOOL_LABELS: Record<string, string> = {
  query_customers: "Mencari pelanggan",
  query_orders: "Membuka pesanan",
  query_deliveries: "Mengecek pengiriman",
  query_financials: "Menghitung keuangan",
  query_metrics: "Mengambil ringkasan bisnis",
  search_conversations: "Membaca riwayat chat",
  query_menu_assets: "Mengecek menu",
  query_expiring_orders: "Mencari paket yang hampir habis",
  query_revenue_trend: "Melihat tren pendapatan",
  query_lapsed_customers: "Mencari pelanggan yang berhenti",
};

/** What the assistant is about to do, e.g. `Mencari pelanggan "Julian"`. */
export function describeToolCall(
  name: string,
  input: Record<string, unknown>,
): string {
  const label = TOOL_LABELS[name] ?? name;
  // Only the arguments an admin would recognize on sight. Anything else (limit,
  // ids, offsets) is noise on a phone-width screen.
  const hint =
    pick(input, "search") ??
    pick(input, "customer_phone") ??
    pick(input, "date") ??
    pick(input, "area") ??
    pick(input, "status") ??
    pick(input, "month");
  return hint ? `${label} "${hint}"` : label;
}

function pick(input: Record<string, unknown>, key: string): string | null {
  const v = input[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * One line saying what came back. Read tools all return an object holding a
 * named array plus a count, so the row count is the honest summary — the full
 * payload can be tens of kilobytes and is never worth rendering.
 */
export function summarizeToolResult(result: unknown): string {
  if (result === null || typeof result !== "object") return "Selesai";
  const obj = result as Record<string, unknown>;
  if (typeof obj.error === "string") return `Gagal: ${obj.error}`;

  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      return value.length === 0
        ? "Tidak ada data"
        : `${value.length} baris ditemukan`;
    }
  }
  // Aggregate tools (query_metrics, query_financials) return scalars, not rows.
  const scalars = Object.entries(obj)
    .filter(([, v]) => typeof v === "number" || typeof v === "string")
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${v}`);
  return scalars.length > 0 ? scalars.join(", ") : "Selesai";
}
