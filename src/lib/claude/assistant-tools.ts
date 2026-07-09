import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { createAdminClient } from "@/lib/supabase/admin";

export type PendingAction = {
  tool: string;
  input: Record<string, unknown>;
  label: string;
  details: string[];
  dangerous: boolean;
};

export const WRITE_TOOLS = new Set([
  "mark_order_paid",
  "cancel_order",
  "send_whatsapp_message",
  "send_whatsapp_image",
  "update_customer_field",
  "update_delivery",
]);

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}

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
  {
    name: "query_menu_assets",
    description:
      "Get the current price list image and active weekly dapur menu images/text. Use this before answering or sending this week's menu.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "update_delivery",
    description:
      "Skip or reschedule a single daily_deliveries row. Use 'skip' to mark it skipped, 'reschedule' to move it to a new date. Admin must confirm before this executes.",
    input_schema: {
      type: "object" as const,
      properties: {
        delivery_id: { type: "string", description: "The daily_deliveries UUID" },
        action: {
          type: "string",
          enum: ["skip", "reschedule"],
          description: "skip: set status to skipped. reschedule: move to new_date.",
        },
        new_date: {
          type: "string",
          description: "Required for reschedule. Target date (YYYY-MM-DD).",
        },
      },
      required: ["delivery_id", "action"],
    },
  },
  {
    name: "mark_order_paid",
    description:
      "Mark a pending order as paid and activate it. Admin must confirm before this executes.",
    input_schema: {
      type: "object" as const,
      properties: {
        order_id: { type: "string", description: "The order UUID" },
      },
      required: ["order_id"],
    },
  },
  {
    name: "cancel_order",
    description:
      "Cancel an order by admin. Optionally notify the customer via WhatsApp. Admin must confirm before this executes.",
    input_schema: {
      type: "object" as const,
      properties: {
        order_id: { type: "string", description: "The order UUID" },
        notify_customer: {
          type: "boolean",
          description: "Whether to send a WhatsApp cancellation message to the customer",
        },
        reason: { type: "string", description: "Optional reason for cancellation (included in WhatsApp message)" },
      },
      required: ["order_id", "notify_customer"],
    },
  },
  {
    name: "send_whatsapp_message",
    description:
      "Send a WhatsApp text message to a customer's phone number. Admin must confirm before this executes.",
    input_schema: {
      type: "object" as const,
      properties: {
        phone_number: {
          type: "string",
          description: "Customer's phone number in international format (e.g. +628...)",
        },
        message: { type: "string", description: "The message text to send" },
      },
      required: ["phone_number", "message"],
    },
  },
  {
    name: "send_whatsapp_image",
    description:
      "Send a WhatsApp image by public URL to a customer's phone number. Use for price list or weekly menu images. Admin must confirm before this executes.",
    input_schema: {
      type: "object" as const,
      properties: {
        phone_number: {
          type: "string",
          description: "Customer's phone number in international format (e.g. +628...)",
        },
        image_url: { type: "string", description: "Public image URL to send" },
        caption: { type: "string", description: "Short image caption" },
      },
      required: ["phone_number", "image_url", "caption"],
    },
  },
  {
    name: "update_customer_field",
    description:
      "Update a specific field on a customer record. Only name, address, area, and notes are allowed. Admin must confirm before this executes.",
    input_schema: {
      type: "object" as const,
      properties: {
        customer_id: { type: "string", description: "The customer UUID" },
        field: {
          type: "string",
          enum: ["name", "address", "area", "notes"],
          description: "Which field to update",
        },
        value: { type: "string", description: "The new value" },
      },
      required: ["customer_id", "field", "value"],
    },
  },
];

export async function runTool(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (isWriteTool(name)) {
    throw new Error(`Write tool '${name}' must not be executed via runTool`);
  }

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
          "id, status, package_size, price_per_portion, total_price, size, start_date, end_date, created_at, customer:customers!orders_customer_id_fkey(name, phone_number, area)",
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

    case "query_menu_assets": {
      const [{ data: settings }, { data: subcontractors }] = await Promise.all([
        db.from("settings").select("key, value").eq("key", "price_list_image_url"),
        db
          .from("subcontractors")
          .select("customer_nickname, menu_image_url, menu_text, delivery_areas")
          .eq("is_active", true)
          .not("menu_image_url", "is", null)
          .order("customer_nickname"),
      ]);
      return {
        price_list_image_url: settings?.[0]?.value ?? null,
        menus: (subcontractors ?? []).map((s) => ({
          dapur: s.customer_nickname,
          image_url: s.menu_image_url,
          menu_text: s.menu_text,
          delivery_areas: s.delivery_areas,
        })),
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

export async function buildPendingAction(
  tool: string,
  input: Record<string, unknown>,
): Promise<PendingAction> {
  const db = createAdminClient();

  switch (tool) {
    case "mark_order_paid": {
      const { data: order } = await db
        .from("orders")
        .select("id, total_price, package_size, size, status, customers!orders_customer_id_fkey(name)")
        .eq("id", input.order_id as string)
        .single();
      const rawCustomer = order?.customers;
      const customerName = Array.isArray(rawCustomer)
        ? (rawCustomer[0]?.name ?? "Unknown")
        : ((rawCustomer as { name: string | null } | null)?.name ?? "Unknown");
      const totalPrice = (order as { total_price?: number } | null)?.total_price ?? 0;
      const formatted = new Intl.NumberFormat("id-ID").format(totalPrice);
      const orderData = order as {
        package_size?: number;
        size?: string;
        status?: string;
      } | null;
      return {
        tool,
        input,
        label: `Mark order as paid — Rp ${formatted}`,
        details: [
          `Customer: ${customerName}`,
          `Package: ${orderData?.package_size ?? "?"} porsi (${(orderData?.size ?? "s").toUpperCase()})`,
          `Current status: ${orderData?.status ?? "unknown"}`,
        ],
        dangerous: false,
      };
    }

    case "cancel_order": {
      const { data: order } = await db
        .from("orders")
        .select("id, status, package_size, customers!orders_customer_id_fkey(name)")
        .eq("id", input.order_id as string)
        .single();
      const rawCustomer = order?.customers;
      const customerName = Array.isArray(rawCustomer)
        ? (rawCustomer[0]?.name ?? "Unknown")
        : ((rawCustomer as { name: string | null } | null)?.name ?? "Unknown");
      const orderData = order as { package_size?: number; status?: string } | null;
      return {
        tool,
        input,
        label: "Cancel order",
        details: [
          `Customer: ${customerName}`,
          `Package: ${orderData?.package_size ?? "?"} porsi`,
          `Current status: ${orderData?.status ?? "unknown"}`,
          input.notify_customer
            ? "Will notify customer via WhatsApp"
            : "Customer will NOT be notified",
          ...(input.reason ? [`Reason: ${input.reason as string}`] : []),
        ],
        dangerous: true,
      };
    }

    case "send_whatsapp_message": {
      const phone = input.phone_number as string;
      const message = input.message as string;
      const preview = message.length > 60 ? `${message.slice(0, 60)}...` : message;
      return {
        tool,
        input,
        label: `Send WhatsApp to ${phone}`,
        details: [`Message: "${preview}"`],
        dangerous: false,
      };
    }

    case "send_whatsapp_image": {
      const phone = input.phone_number as string;
      const imageUrl = input.image_url as string;
      const caption = input.caption as string;
      const preview = caption.length > 60 ? `${caption.slice(0, 60)}...` : caption;
      return {
        tool,
        input,
        label: `Send WhatsApp image to ${phone}`,
        details: [`Caption: "${preview}"`, `Image: ${imageUrl}`],
        dangerous: false,
      };
    }

    case "update_customer_field": {
      const { data: customer } = await db
        .from("customers")
        .select("name")
        .eq("id", input.customer_id as string)
        .single();
      return {
        tool,
        input,
        label: `Update customer ${input.field as string}`,
        details: [
          `Customer: ${(customer as { name?: string } | null)?.name ?? "Unknown"}`,
          `Field: ${input.field as string}`,
          `New value: ${input.value as string}`,
        ],
        dangerous: false,
      };
    }

    case "update_delivery": {
      const { data: delivery } = await db
        .from("daily_deliveries")
        .select("delivery_date, meal_type, portions, status, customer:customers(name)")
        .eq("id", input.delivery_id as string)
        .single();
      const customerName =
        (delivery?.customer as { name?: string } | null)?.name ?? "Unknown";
      const deliveryData = delivery as {
        delivery_date?: string;
        meal_type?: string;
        portions?: number;
        status?: string;
      } | null;
      const action = input.action as string;
      return {
        tool,
        input,
        label: action === "skip" ? "Skip delivery" : `Reschedule delivery to ${input.new_date as string}`,
        details: [
          `Customer: ${customerName}`,
          `Date: ${deliveryData?.delivery_date ?? "?"}`,
          `Meal: ${deliveryData?.meal_type ?? "?"}, ${deliveryData?.portions ?? "?"} porsi`,
          `Current status: ${deliveryData?.status ?? "?"}`,
          ...(action === "reschedule" ? [`New date: ${input.new_date as string}`] : []),
        ],
        dangerous: action === "skip",
      };
    }

    default:
      return { tool, input, label: `Execute: ${tool}`, details: [], dangerous: false };
  }
}
