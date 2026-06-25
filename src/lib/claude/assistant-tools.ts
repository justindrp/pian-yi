import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { createAdminClient } from "@/lib/supabase/admin";

export const assistantTools: Tool[] = [
  {
    name: "query_customers",
    description:
      "Search and list customers. Returns name, phone, area, address, subcontractor.",
    input_schema: {
      type: "object" as const,
      properties: {
        search: { type: "string", description: "Partial match on name or phone number" },
        area: { type: "string", description: "Filter by delivery area (e.g. BSD Baru, Gading Serpong)" },
        subcontractor_id: { type: "string", description: "Filter by subcontractor UUID" },
        limit: { type: "number", description: "Max rows (default 20, max 50)" },
      },
    },
  },
  {
    name: "query_orders",
    description:
      "Query orders with optional filters. Returns order details with customer name and phone.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          description:
            "Order status: pending_payment, payment_proof_received, active, paused, completed, cancelled_unpaid, cancelled_by_customer, cancelled_by_admin, refunded",
        },
        customer_phone: { type: "string", description: "Exact customer phone number" },
        start_date: { type: "string", description: "ISO date, filter by created_at >= this date" },
        end_date: { type: "string", description: "ISO date, filter by created_at <= this date" },
        limit: { type: "number", description: "Max rows (default 20, max 50)" },
      },
    },
  },
  {
    name: "query_deliveries",
    description:
      "Query daily delivery rows. Filter by date, status, or subcontractor.",
    input_schema: {
      type: "object" as const,
      properties: {
        date: { type: "string", description: "Specific delivery date (YYYY-MM-DD)" },
        start_date: { type: "string", description: "Start of date range (YYYY-MM-DD)" },
        end_date: { type: "string", description: "End of date range (YYYY-MM-DD)" },
        status: { type: "string", description: "Delivery status (e.g. pending, delivered, skipped)" },
        subcontractor_id: { type: "string", description: "Filter by subcontractor UUID" },
        limit: { type: "number", description: "Max rows (default 20, max 50)" },
      },
    },
  },
  {
    name: "query_financials",
    description:
      "Get revenue, COGS, and gross profit for a date range from the accounting journal.",
    input_schema: {
      type: "object" as const,
      properties: {
        start_date: { type: "string", description: "ISO date (inclusive)" },
        end_date: { type: "string", description: "ISO date (inclusive)" },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "query_metrics",
    description:
      "Get today's business snapshot: active orders, deliveries today, pending payments, today's revenue, pending proofs, lapsed customers.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "search_conversations",
    description:
      "Retrieve recent conversation messages for a customer by phone number or name.",
    input_schema: {
      type: "object" as const,
      properties: {
        customer_phone: { type: "string", description: "Customer phone number (exact)" },
        customer_name: { type: "string", description: "Customer name (partial match)" },
        limit: { type: "number", description: "Max messages (default 20, max 50)" },
      },
    },
  },
];

export async function runTool(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const db = createAdminClient();
  const limit = Math.min(Number(input.limit ?? 20), 50);

  switch (name) {
    case "query_customers": {
      let q = db
        .from("customers")
        .select(
          "id, name, phone_number, area, sub_area, address, google_maps_link, subcontractor_id, created_at",
        );
      if (input.search) {
        const s = input.search as string;
        q = q.or(`name.ilike.%${s}%,phone_number.ilike.%${s}%`);
      }
      if (input.area) q = q.ilike("area", `%${input.area as string}%`);
      if (input.subcontractor_id) q = q.eq("subcontractor_id", input.subcontractor_id as string);
      const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
      if (error) return { error: error.message };
      return { customers: data ?? [], count: data?.length ?? 0 };
    }

    case "query_orders": {
      let q = db
        .from("orders")
        .select(
          "id, status, package_size, price_per_portion, total_price, size, start_date, end_date, created_at, customer:customers(name, phone_number, area)",
        );
      if (input.status) q = q.eq("status", input.status as string);
      if (input.customer_phone) {
        const { data: cust } = await db
          .from("customers")
          .select("id")
          .eq("phone_number", input.customer_phone as string)
          .maybeSingle();
        if (!cust) return { orders: [], count: 0, note: "Customer not found" };
        q = q.eq("customer_id", cust.id);
      }
      if (input.start_date) q = q.gte("created_at", input.start_date as string);
      if (input.end_date) q = q.lte("created_at", `${input.end_date as string}T23:59:59`);
      const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
      if (error) return { error: error.message };
      return { orders: data ?? [], count: data?.length ?? 0 };
    }

    case "query_deliveries": {
      let q = db
        .from("daily_deliveries")
        .select(
          "id, delivery_date, status, portions, subcontractor_id, address_slot, customer:customers(name, phone_number, area)",
        );
      if (input.date) q = q.eq("delivery_date", input.date as string);
      if (input.start_date) q = q.gte("delivery_date", input.start_date as string);
      if (input.end_date) q = q.lte("delivery_date", input.end_date as string);
      if (input.status) q = q.eq("status", input.status as string);
      if (input.subcontractor_id) q = q.eq("subcontractor_id", input.subcontractor_id as string);
      const { data, error } = await q.order("delivery_date", { ascending: false }).limit(limit);
      if (error) return { error: error.message };
      return { deliveries: data ?? [], count: data?.length ?? 0 };
    }

    case "query_financials": {
      const [revenueRes, cogsRes] = await Promise.all([
        db
          .from("journal_lines")
          .select(
            "credit, account:accounts!inner(code), journal:journals!inner(date, source_type)",
          )
          .eq("account.code", "4001")
          .gte("journal.date", input.start_date as string)
          .lte("journal.date", input.end_date as string),
        db
          .from("journal_lines")
          .select(
            "debit, account:accounts!inner(code), journal:journals!inner(date, source_type)",
          )
          .eq("account.code", "5001")
          .gte("journal.date", input.start_date as string)
          .lte("journal.date", input.end_date as string),
      ]);
      const revenue = (revenueRes.data ?? []).reduce((sum, r) => sum + (r.credit ?? 0), 0);
      const cogs = (cogsRes.data ?? []).reduce((sum, r) => sum + (r.debit ?? 0), 0);
      return {
        revenue,
        cogs,
        gross_profit: revenue - cogs,
        currency: "IDR",
        period: { start_date: input.start_date, end_date: input.end_date },
      };
    }

    case "query_metrics": {
      const today = new Date().toISOString().split("T")[0];
      const [activeRes, deliveriesRes, pendingRes, revenueRes, pendingProofsRes, lapsedRes] =
        await Promise.all([
          db.from("orders").select("id", { count: "exact", head: true }).eq("status", "active"),
          db
            .from("daily_deliveries")
            .select("id", { count: "exact", head: true })
            .eq("delivery_date", today)
            .neq("status", "skipped"),
          db
            .from("orders")
            .select("id", { count: "exact", head: true })
            .in("status", ["pending_payment", "payment_proof_received"]),
          db
            .from("journal_lines")
            .select(
              "credit, account:accounts!inner(code), journal:journals!inner(date, source_type)",
            )
            .eq("account.code", "4001")
            .eq("journal.date", today)
            .eq("journal.source_type", "delivery"),
          db
            .from("delivery_proofs")
            .select("id", { count: "exact", head: true })
            .eq("status", "needs_review"),
          db
            .from("customer_state")
            .select("id", { count: "exact", head: true })
            .eq("state", "lapsed"),
        ]);
      const revenueToday = (revenueRes.data ?? []).reduce((sum, r) => sum + (r.credit ?? 0), 0);
      return {
        today,
        activeOrders: activeRes.count ?? 0,
        deliveriesToday: deliveriesRes.count ?? 0,
        pendingPayments: pendingRes.count ?? 0,
        revenueToday,
        pendingProofs: pendingProofsRes.count ?? 0,
        lapsedCustomers: lapsedRes.count ?? 0,
      };
    }

    case "search_conversations": {
      let customerIds: string[] = [];
      if (input.customer_phone) {
        const { data } = await db
          .from("customers")
          .select("id")
          .eq("phone_number", input.customer_phone as string);
        customerIds = (data ?? []).map((c) => c.id);
      } else if (input.customer_name) {
        const { data } = await db
          .from("customers")
          .select("id")
          .ilike("name", `%${input.customer_name as string}%`);
        customerIds = (data ?? []).map((c) => c.id);
      }
      if (customerIds.length === 0) return { messages: [], count: 0, note: "No customers found" };
      const { data, error } = await db
        .from("conversations")
        .select("id, customer_id, role, content, created_at, message_type")
        .in("customer_id", customerIds.slice(0, 5))
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) return { error: error.message };
      return { messages: (data ?? []).reverse(), count: data?.length ?? 0 };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
