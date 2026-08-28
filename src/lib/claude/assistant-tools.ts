import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { holidayOn, isClosedHoliday } from "@/lib/holidays/id";
import { FIXED_SCHEDULE_PREFS } from "@/lib/orders/build-recurring-deliveries";
import { remainingTodayByOrder } from "@/lib/orders/customer-schedule";
import {
  deliveryStatus,
  isLocked,
  loadDeadlineHour,
} from "@/lib/orders/delivery-state";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

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
  "pause_order",
  "resume_order",
  "send_payment_details",
  "mark_payment_proof_received",
  "update_order",
  "create_customer",
  "create_order",
]);

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}

export const assistantTools: Tool[] = [
  {
    name: "query_customers",
    description:
      "Search and list customers. Returns name, phone, area, address, subcontractor and portions_remaining — the customer's remaining quota across every open order, which answers 'sisa kuota berapa' on its own.",
    input_schema: {
      type: "object" as const,
      properties: {
        search: {
          type: "string",
          description: "Partial match on name or phone number",
        },
        area: {
          type: "string",
          description:
            "Filter by delivery area. The servable areas are listed in the system prompt — they come from the active kitchens and change, so never assume a name that is not there.",
        },
        subcontractor_id: {
          type: "string",
          description: "Filter by subcontractor UUID",
        },
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
        customer_phone: {
          type: "string",
          description: "Customer phone number; matched on the last 9 digits",
        },
        customer_name: {
          type: "string",
          description:
            "Partial customer name, when the phone number is unknown",
        },
        start_date: {
          type: "string",
          description: "ISO date, filter by created_at >= this date",
        },
        end_date: {
          type: "string",
          description: "ISO date, filter by created_at <= this date",
        },
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
        date: {
          type: "string",
          description: "Specific delivery date (YYYY-MM-DD)",
        },
        start_date: {
          type: "string",
          description: "Start of date range (YYYY-MM-DD)",
        },
        end_date: {
          type: "string",
          description: "End of date range (YYYY-MM-DD)",
        },
        subcontractor_id: {
          type: "string",
          description: "Filter by subcontractor UUID",
        },
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
      "Retrieve recent conversation messages for a customer by phone number or name, or search message text across ALL customers with `contains`. The cross-customer search is how you find related enquiries — two different numbers asking about the same venue, event or company are usually the same buyer.",
    input_schema: {
      type: "object" as const,
      properties: {
        customer_phone: {
          type: "string",
          description: "Customer phone number (exact)",
        },
        customer_name: {
          type: "string",
          description: "Customer name (partial match)",
        },
        contains: {
          type: "string",
          description:
            "Search every customer's messages for this text (case-insensitive). Use a distinctive fragment — a venue, a company, a street. Returns one row per match with the customer attached.",
        },
        limit: {
          type: "number",
          description: "Max messages (default 20, max 50)",
        },
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
    name: "query_expiring_orders",
    description:
      "Get active orders that are ending soon (within N days) or quota orders with fewer than 5 portions remaining. Use for renewal risk briefings and proactive outreach.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: {
          type: "number",
          description:
            "How many days ahead to check for expiring end_date (default 7, max 30)",
        },
      },
    },
  },
  {
    name: "query_revenue_trend",
    description:
      "Compare this week's revenue (Mon–today) vs last week (same Mon–Sun span) from the accounting journal. Returns totals and % change.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "query_lapsed_customers",
    description:
      "List lapsed customers (customer_state = 'lapsed') with days inactive and contact info. Use for re-engagement outreach recommendations.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max rows (default 20)" },
      },
    },
  },
  {
    name: "query_leads",
    description:
      "Enquiries that never became an order: customers with zero orders in any status. Returns what they asked for, who spoke last, and whether WhatsApp still lets us write to them. Use this for 'any leads worth chasing?', before writing any follow-up, and unprompted in a briefing — a lead whose 24h window is closing is the most perishable thing in the business.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: {
          type: "number",
          description: "How far back to look for first contact (default 30)",
        },
        limit: { type: "number", description: "Max leads (default 20)" },
        only_reachable: {
          type: "boolean",
          description:
            "Only leads we can still send a free-form message to (24h window open). Default false — a closed-window lead is still worth knowing about.",
        },
      },
    },
  },
  {
    name: "check_delivery_dates",
    description:
      "Whether we can actually deliver on given dates, and whether the order deadline for each has passed. Checks Minggu, libur nasional and the H-1 cutoff from settings. ALWAYS call this before promising a customer any date — never work a calendar out yourself.",
    input_schema: {
      type: "object" as const,
      properties: {
        dates: {
          type: "array",
          items: { type: "string" },
          description: 'ISO dates, e.g. ["2026-08-20", "2026-08-23"]',
        },
      },
      required: ["dates"],
    },
  },
  {
    name: "update_delivery",
    description:
      "Skip or reschedule a single daily_deliveries row. 'skip' deletes the row — the food is not cooked and the portion goes back to the customer's balance; it is refused once the H-1 cutoff for that date has passed. 'reschedule' moves it to a new date. Admin must confirm before this executes.",
    input_schema: {
      type: "object" as const,
      properties: {
        delivery_id: {
          type: "string",
          description: "The daily_deliveries UUID",
        },
        action: {
          type: "string",
          enum: ["skip", "reschedule"],
          description: "skip: delete the row. reschedule: move to new_date.",
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
          description:
            "Whether to send a WhatsApp cancellation message to the customer",
        },
        reason: {
          type: "string",
          description:
            "Optional reason for cancellation (included in WhatsApp message)",
        },
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
          description:
            "Customer's phone number in international format (e.g. +628...)",
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
          description:
            "Customer's phone number in international format (e.g. +628...)",
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
  {
    name: "pause_order",
    description:
      "Pause an active recurring order. Optionally specify a resume date for auto-resume. Admin must confirm before this executes.",
    input_schema: {
      type: "object" as const,
      properties: {
        order_id: { type: "string", description: "The order UUID" },
        pause_until: {
          type: "string",
          description:
            "Optional ISO date (YYYY-MM-DD) when the order should auto-resume",
        },
      },
      required: ["order_id"],
    },
  },
  {
    name: "resume_order",
    description:
      "Resume a paused order and set it back to active. Admin must confirm before this executes.",
    input_schema: {
      type: "object" as const,
      properties: {
        order_id: { type: "string", description: "The order UUID" },
      },
      required: ["order_id"],
    },
  },
  {
    name: "send_payment_details",
    description:
      "Send bank transfer payment details to a customer for a pending order. Admin must confirm before this executes.",
    input_schema: {
      type: "object" as const,
      properties: {
        order_id: {
          type: "string",
          description: "The order UUID (should be in pending_payment status)",
        },
      },
      required: ["order_id"],
    },
  },
  {
    name: "mark_payment_proof_received",
    description:
      "Advance an order from pending_payment to payment_proof_received after the customer sends proof. Admin must confirm before this executes.",
    input_schema: {
      type: "object" as const,
      properties: {
        order_id: { type: "string", description: "The order UUID" },
      },
      required: ["order_id"],
    },
  },
  {
    name: "update_order",
    description:
      "Update a single editable field on an order. Admin must confirm before this executes.",
    input_schema: {
      type: "object" as const,
      properties: {
        order_id: { type: "string", description: "The order UUID" },
        field: {
          type: "string",
          enum: [
            "portions_per_delivery",
            "portions_lunch",
            "portions_dinner",
            "start_date",
            "end_date",
          ],
          description: "Which field to update",
        },
        value: {
          type: "string",
          description:
            "The new value. For numeric fields (portions_per_delivery, portions_lunch, portions_dinner) pass the number as a string.",
        },
      },
      required: ["order_id", "field", "value"],
    },
  },
  {
    name: "create_customer",
    description:
      "Create a new customer record with companion rows. Admin must confirm before this executes.",
    input_schema: {
      type: "object" as const,
      properties: {
        phone_number: {
          type: "string",
          description: "International format (e.g. +628...)",
        },
        address: { type: "string", description: "Full delivery address" },
        area: {
          type: "string",
          description:
            "Delivery area. Must be one of the areas listed in the system prompt; those come from the active kitchens' coverage and change when a kitchen is added, edited or deactivated.",
        },
        name: { type: "string", description: "Customer name (optional)" },
        google_maps_link: {
          type: "string",
          description: "Google Maps link to address (optional)",
        },
      },
      required: ["phone_number", "address", "area"],
    },
  },
  {
    name: "create_order",
    description:
      "Create a new pending_payment order for an existing customer. Does not generate deliveries or send payment details — use mark_order_paid and send_payment_details as follow-up steps. Admin must confirm before this executes.",
    input_schema: {
      type: "object" as const,
      properties: {
        customer_id: { type: "string", description: "Customer UUID" },
        package_size: {
          type: "number",
          description: "Total portions in the package",
        },
        portions_per_delivery: {
          type: "number",
          // Spelled out because the model got this wrong on a real order: asked
          // to renew a 5-porsi package it passed 5 here, and every one of the
          // five days was generated at 5 portions.
          description:
            "Portions in ONE day's delivery — almost always 1. This is NOT the package total: a 5-porsi package eaten one a day is package_size 5, portions_per_delivery 1.",
        },
        price_per_portion: {
          type: "number",
          description: "Price in IDR per portion (e.g. 28000)",
        },
        meal_time_preference: {
          type: "string",
          description:
            // A standing pattern generates the package's whole run of days the
            // moment the order is paid. galvent's 10-porsi order was created as
            // dinner_only after he wrote "Jdwal tdk menetap" and asked only for
            // tomorrow, and five days were booked for him.
            "lunch_only, dinner_only, both_fixed, default_lunch and default_dinner are STANDING patterns: the days they produce are stored on the order and become deliveries when it is marked paid. This is an input only — the order stores the resulting days, not this value. Use per_day_decision whenever the customer decides day by day or says their schedule is not fixed — then no days are stored and each delivery is recorded as they ask for it.",
        },
        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
        end_date: {
          type: "string",
          description: "End date (YYYY-MM-DD) — optional for recurring",
        },
      },
      required: [
        "customer_id",
        "package_size",
        "portions_per_delivery",
        "price_per_portion",
        "meal_time_preference",
        "start_date",
      ],
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
      if (input.subcontractor_id)
        q = q.eq("subcontractor_id", input.subcontractor_id as string);
      const { data, error } = await q
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) return { error: error.message };
      // "Sisa kuota berapa?" is the most common question asked of the assistant
      // and used to need a second tool call the model rarely made — Nicholas
      // Satria's balance could not be produced at all on 2026-08-19. It is
      // derived from the open orders' delivery rows, never from a stored
      // counter — customers.portions_remaining is a dead column and
      // orders.portions_remaining has been dropped (see CLAUDE.md).
      const ids = (data ?? []).map((c) => c.id);
      const { data: openOrders } = ids.length
        ? await db
            .from("orders")
            .select("id, customer_id, package_size")
            .in("customer_id", ids)
            .in("status", ["active", "paused", "payment_proof_received"])
        : { data: [] };
      const remaining = await remainingTodayByOrder(db, openOrders ?? []);
      const quota = new Map<string, number>();
      for (const o of openOrders ?? []) {
        if (!o.customer_id) continue;
        const left = remaining.get(o.id) ?? 0;
        if (left <= 0) continue;
        quota.set(o.customer_id, (quota.get(o.customer_id) ?? 0) + left);
      }
      return {
        customers: (data ?? []).map((c) => ({
          ...c,
          portions_remaining: quota.get(c.id) ?? 0,
        })),
        count: data?.length ?? 0,
      };
    }

    case "query_orders": {
      let q = db
        .from("orders")
        .select(
          "id, status, package_size, price_per_portion, total_price, size, start_date, end_date, created_at, customer:customers!orders_customer_id_fkey(name, phone_number, area)",
        );
      if (input.status) q = q.eq("status", input.status as string);
      // Phone or name. An exact phone match was the only way in, and an admin
      // asking about a customer by name in the inbox has the name, not the
      // number in the exact format the column stores it in.
      if (input.customer_phone || input.customer_name) {
        const search = String(input.customer_phone ?? input.customer_name);
        const digits = search.replace(/\D/g, "");
        const { data: custs } = await db
          .from("customers")
          .select("id")
          .or(
            digits.length >= 8
              ? `phone_number.ilike.%${digits.slice(-9)}%`
              : `name.ilike.%${search}%`,
          )
          .limit(10);
        if (!custs?.length)
          return { orders: [], count: 0, note: "Customer not found" };
        q = q.in(
          "customer_id",
          custs.map((c) => c.id),
        );
      }
      if (input.start_date) q = q.gte("created_at", input.start_date as string);
      if (input.end_date)
        q = q.lte("created_at", `${input.end_date as string}T23:59:59`);
      const { data, error } = await q
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) return { error: error.message };
      return { orders: data ?? [], count: data?.length ?? 0 };
    }

    case "query_deliveries": {
      let q = db
        .from("daily_deliveries")
        .select(
          "id, delivery_date, portions, subcontractor_id, address_slot, customer:customers(name, phone_number, area)",
        );
      if (input.date) q = q.eq("delivery_date", input.date as string);
      if (input.start_date)
        q = q.gte("delivery_date", input.start_date as string);
      if (input.end_date) q = q.lte("delivery_date", input.end_date as string);
      if (input.subcontractor_id)
        q = q.eq("subcontractor_id", input.subcontractor_id as string);
      const { data, error } = await q
        .order("delivery_date", { ascending: false })
        .limit(limit);
      if (error) return { error: error.message };
      // Every row here is a delivery that is happening; there is no status to
      // filter on. What it is waiting for is a function of its own date.
      const deadlineHour = await loadDeadlineHour();
      return {
        deliveries: (data ?? []).map((d) => ({
          ...d,
          status: deliveryStatus(d.delivery_date, { deadlineHour }),
        })),
        count: data?.length ?? 0,
      };
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
      const revenue = (revenueRes.data ?? []).reduce(
        (sum, r) => sum + (r.credit ?? 0),
        0,
      );
      const cogs = (cogsRes.data ?? []).reduce(
        (sum, r) => sum + (r.debit ?? 0),
        0,
      );
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
      const [
        activeRes,
        deliveriesRes,
        pendingRes,
        revenueRes,
        pendingProofsRes,
        lapsedRes,
      ] = await Promise.all([
        db
          .from("orders")
          .select("id", { count: "exact", head: true })
          .eq("status", "active"),
        db
          .from("daily_deliveries")
          .select("id", { count: "exact", head: true })
          .eq("delivery_date", today),
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
      const revenueToday = (revenueRes.data ?? []).reduce(
        (sum, r) => sum + (r.credit ?? 0),
        0,
      );
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
      // Cross-customer keyword search. Two enquiries about the same venue rarely
      // arrive from the same number, so a lead is only recognisable as a repeat
      // buyer by what they wrote, not by who they are.
      if (input.contains) {
        const { data, error } = await db
          .from("conversations")
          .select(
            "id, customer_id, role, content, created_at, customers(name, phone_number)",
          )
          .ilike("content", `%${input.contains as string}%`)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) return { error: error.message };
        return {
          matches: (data ?? []).map((m) => {
            const c = m.customers as {
              name: string | null;
              phone_number: string | null;
            } | null;
            return {
              customer_id: m.customer_id,
              name: c?.name ?? null,
              phone_number: c?.phone_number ?? null,
              role: m.role,
              created_at: m.created_at,
              content: String(m.content).slice(0, 300),
            };
          }),
          count: data?.length ?? 0,
        };
      }

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
      if (customerIds.length === 0)
        return { messages: [], count: 0, note: "No customers found" };
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
        db
          .from("settings")
          .select("key, value")
          .eq("key", "price_list_image_url"),
        db
          .from("subcontractors")
          .select(
            "customer_nickname, menu_image_url, menu_text, delivery_areas",
          )
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

    case "query_expiring_orders": {
      const today = new Date().toISOString().split("T")[0];
      const days = Math.min(Number(input.days ?? 7), 30);
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + days);
      const futureDateStr = futureDate.toISOString().split("T")[0];

      // Two ways an order runs out: its end_date arrives, or its portions do.
      // The low-quota half used to filter on the stored portions_remaining
      // column; it is counted from the delivery rows now, which means the
      // whole active set has to be fetched and filtered here.
      const [scheduledRes, activeRes] = await Promise.all([
        db
          .from("orders")
          .select(
            "id, end_date, package_size, start_date, customer:customers!orders_customer_id_fkey(name, phone_number, area)",
          )
          .eq("status", "active")
          .not("end_date", "is", null)
          .gte("end_date", today)
          .lte("end_date", futureDateStr)
          .order("end_date", { ascending: true }),
        db
          .from("orders")
          .select(
            "id, end_date, package_size, start_date, customer:customers!orders_customer_id_fkey(name, phone_number, area)",
          )
          .eq("status", "active"),
      ]);

      const remaining = await remainingTodayByOrder(db, activeRes.data ?? []);
      const lowQuota = (activeRes.data ?? [])
        .map((o) => ({ ...o, portions_remaining: remaining.get(o.id) ?? 0 }))
        .filter((o) => o.portions_remaining < 5)
        .sort((a, b) => a.portions_remaining - b.portions_remaining);

      const seen = new Set<string>();
      const expiring: unknown[] = [];
      for (const row of [...(scheduledRes.data ?? []), ...lowQuota]) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          expiring.push(row);
        }
      }
      return { expiring, count: expiring.length, checked_days_ahead: days };
    }

    case "query_revenue_trend": {
      const now = new Date();
      const dayOfWeek = now.getDay();
      const daysFromMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const thisMonday = new Date(now);
      thisMonday.setDate(now.getDate() - daysFromMon);
      const thisMondayStr = thisMonday.toISOString().split("T")[0];
      const todayStr = now.toISOString().split("T")[0];

      const lastMonday = new Date(thisMonday);
      lastMonday.setDate(thisMonday.getDate() - 7);
      const lastMondayStr = lastMonday.toISOString().split("T")[0];
      const lastSunday = new Date(thisMonday);
      lastSunday.setDate(thisMonday.getDate() - 1);
      const lastSundayStr = lastSunday.toISOString().split("T")[0];

      const [thisRes, lastRes] = await Promise.all([
        db
          .from("journal_lines")
          .select(
            "credit, account:accounts!inner(code), journal:journals!inner(date)",
          )
          .eq("account.code", "4001")
          .gte("journal.date", thisMondayStr)
          .lte("journal.date", todayStr),
        db
          .from("journal_lines")
          .select(
            "credit, account:accounts!inner(code), journal:journals!inner(date)",
          )
          .eq("account.code", "4001")
          .gte("journal.date", lastMondayStr)
          .lte("journal.date", lastSundayStr),
      ]);

      const thisWeek = (thisRes.data ?? []).reduce(
        (sum, r) => sum + (r.credit ?? 0),
        0,
      );
      const lastWeek = (lastRes.data ?? []).reduce(
        (sum, r) => sum + (r.credit ?? 0),
        0,
      );
      const changePct =
        lastWeek === 0
          ? null
          : Math.round(((thisWeek - lastWeek) / lastWeek) * 100);

      return {
        this_week: thisWeek,
        last_week: lastWeek,
        change_pct: changePct,
        currency: "IDR",
        period: {
          this_start: thisMondayStr,
          this_end: todayStr,
          last_start: lastMondayStr,
          last_end: lastSundayStr,
        },
      };
    }

    case "query_lapsed_customers": {
      // Lapsed = had a delivery in the past but no active/pending order today.
      // Use daily_deliveries as the source of truth for last delivery date —
      // orders.status is unreliable (an order stays 'active' until its rows
      // account for the whole package).
      const ACTIVE_STATUSES = [
        "active",
        "paused",
        "pending_payment",
        "payment_proof_received",
      ];

      const today = new Date().toISOString().slice(0, 10);

      const [{ data: activeOrders }, { data: deliveries, error }] =
        await Promise.all([
          db
            .from("orders")
            .select("customer_id")
            .in("status", ACTIVE_STATUSES)
            .not("customer_id", "is", null),
          db
            .from("daily_deliveries")
            .select(
              "customer_id, delivery_date, customer:customers!inner(id, name, phone_number, area)",
            )
            .lt("delivery_date", today)
            .not("customer_id", "is", null)
            .order("delivery_date", { ascending: false }),
        ]);

      if (error) return { error: error.message };

      const activeIds = new Set(
        (activeOrders ?? [])
          .map((o) => o.customer_id)
          .filter((id): id is string => id !== null),
      );

      const now = Date.now();
      const seen = new Set<string>();
      const customers: {
        customer_id: string;
        name: string;
        phone_number: string;
        area: string;
        last_delivery_date: string;
        days_since_last_delivery: number;
      }[] = [];

      for (const row of deliveries ?? []) {
        if (!row.customer_id || !row.delivery_date) continue;
        if (activeIds.has(row.customer_id)) continue;
        if (seen.has(row.customer_id)) continue;
        seen.add(row.customer_id);

        const cust = row.customer as {
          name?: string;
          phone_number?: string;
          area?: string;
        } | null;
        const deliveryMs = new Date(row.delivery_date).getTime();
        customers.push({
          customer_id: row.customer_id,
          name: cust?.name ?? "Unknown",
          phone_number: cust?.phone_number ?? "?",
          area: cust?.area ?? "?",
          last_delivery_date: row.delivery_date,
          days_since_last_delivery: Math.floor(
            (now - deliveryMs) / (1000 * 60 * 60 * 24),
          ),
        });

        if (customers.length >= limit) break;
      }

      // Already sorted by delivery_date desc from the query
      return { customers, count: customers.length };
    }

    case "query_leads": {
      // A lead is a customer with no order in any status. The interesting facts
      // about one are not on the customers row: what they asked for, whether we
      // or they spoke last, and whether Meta still lets us write to them.
      const days = Math.min(Number(input.days ?? 30), 180);
      const since = new Date(
        Date.now() - days * 24 * 60 * 60 * 1000,
      ).toISOString();

      type LeadRow = {
        id: string;
        name: string | null;
        phone_number: string | null;
        area: string | null;
        notes: string | null;
        first_message: string | null;
        created_at: string | null;
      };
      type MsgRow = {
        customer_id: string | null;
        role: string;
        content: string;
        created_at: string | null;
      };

      const [candidates, ordered] = await Promise.all([
        fetchAllRows<LeadRow>((from, to) =>
          db
            .from("customers")
            .select(
              "id, name, phone_number, area, notes, first_message, created_at",
            )
            .gte("created_at", since)
            .not("phone_number", "like", "DEMO_%")
            .order("created_at", { ascending: false })
            .range(from, to),
        ),
        fetchAllRows<{ customer_id: string | null }>((from, to) =>
          db
            .from("orders")
            .select("customer_id")
            .not("customer_id", "is", null)
            .range(from, to),
        ),
      ]);
      if (candidates.error) return { error: candidates.error };
      if (ordered.error) return { error: ordered.error };

      const hasOrder = new Set(
        ordered.rows.map((o) => o.customer_id).filter(Boolean),
      );
      const leadRows = candidates.rows.filter((c) => !hasOrder.has(c.id));
      if (leadRows.length === 0) return { leads: [], count: 0 };

      // Chunked so a long lookback cannot build a URL too big for PostgREST.
      const ids = leadRows.map((c) => c.id);
      const msgs: MsgRow[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        const got = await fetchAllRows<MsgRow>((from, to) =>
          db
            .from("conversations")
            .select("customer_id, role, content, created_at")
            .in("customer_id", chunk)
            .order("created_at", { ascending: true })
            .range(from, to),
        );
        if (got.error) return { error: got.error };
        msgs.push(...got.rows);
      }

      const now = Date.now();
      const WINDOW_MS = 24 * 60 * 60 * 1000;
      const leads = leadRows.map((c) => {
        const mine = msgs.filter((m) => m.customer_id === c.id);
        const inbound = mine.filter((m) => m.role === "user");
        const last = mine.at(-1);
        const lastInbound = inbound.at(-1);
        const lastInboundMs = lastInbound
          ? new Date(lastInbound.created_at as string).getTime()
          : null;
        const windowClosesMs =
          lastInboundMs === null ? null : lastInboundMs + WINDOW_MS;
        const windowOpen = windowClosesMs !== null && windowClosesMs > now;

        return {
          customer_id: c.id,
          name: c.name,
          phone_number: c.phone_number,
          area: c.area,
          first_contact: c.created_at,
          days_since_first_contact: Math.floor(
            (now - new Date(c.created_at as string).getTime()) /
              (1000 * 60 * 60 * 24),
          ),
          first_message: c.first_message,
          learned_notes: c.notes,
          // What they actually asked for lives in their own words, so hand the
          // model every inbound message rather than a summary of them.
          customer_messages: inbound.map((m) => ({
            at: m.created_at,
            text: String(m.content).slice(0, 400),
          })),
          last_message_from: last?.role === "user" ? "customer" : "us",
          last_bot_message:
            last?.role === "user"
              ? null
              : String(last?.content ?? "").slice(0, 400),
          last_inbound_at: lastInbound?.created_at ?? null,
          hours_since_inbound:
            lastInboundMs === null
              ? null
              : Math.round(((now - lastInboundMs) / (1000 * 60 * 60)) * 10) /
                10,
          // Meta blocks a business writing first once 24h have passed since the
          // customer's last inbound message, and nothing we send reopens it.
          window_open: windowOpen,
          window_closes_at:
            windowClosesMs === null
              ? null
              : new Date(windowClosesMs).toISOString(),
          window_hours_left: windowOpen
            ? Math.round(((windowClosesMs - now) / (1000 * 60 * 60)) * 10) / 10
            : 0,
          reachable_by: windowOpen ? "free_form" : "template_only",
        };
      });

      const filtered = (
        input.only_reachable ? leads.filter((l) => l.window_open) : leads
      )
        .sort((a, b) => {
          // Closing windows first: that is the perishable end of the list.
          if (a.window_open !== b.window_open) return a.window_open ? -1 : 1;
          if (a.window_open) return a.window_hours_left - b.window_hours_left;
          return (b.last_inbound_at ?? "").localeCompare(
            a.last_inbound_at ?? "",
          );
        })
        .slice(0, limit);

      return {
        leads: filtered,
        count: filtered.length,
        total_leads: leads.length,
        // Template sends are the only way to reach a closed window, and every
        // one of ours currently fails 131042 for want of a payment method on
        // the WABA. Say so rather than proposing a send that cannot land.
        template_sends_working: false,
        note: "reachable_by 'template_only' means we cannot currently reach them at all — template sends fail with error 131042 until a payment method is added to the WhatsApp Business account.",
      };
    }

    case "check_delivery_dates": {
      const dates = (input.dates as string[] | undefined) ?? [];
      if (dates.length === 0) return { error: "dates is required" };

      const { data: settings } = await db
        .from("settings")
        .select("key, value")
        .eq("key", "order_deadline_hour");
      const cutoffHour = Number(settings?.[0]?.value ?? 16);

      const DAY_ID = [
        "Minggu",
        "Senin",
        "Selasa",
        "Rabu",
        "Kamis",
        "Jumat",
        "Sabtu",
      ];
      const nowJakarta = new Date(Date.now() + 7 * 60 * 60 * 1000);

      const results = dates.map((ymd) => {
        const d = new Date(`${ymd}T00:00:00Z`);
        if (Number.isNaN(d.getTime()))
          return { date: ymd, error: "unparseable" };
        const dow = d.getUTCDay();
        const holiday = holidayOn(ymd);
        const closedHoliday = isClosedHoliday(ymd);

        let servable = true;
        let reason: string | null = null;
        if (dow === 0) {
          servable = false;
          reason = "Minggu — tutup";
        } else if (closedHoliday) {
          servable = false;
          reason = `${holiday?.name} — libur nasional, tutup`;
        }

        // Deadline is cutoffHour WIB on the day before delivery.
        const cutoff = new Date(d);
        cutoff.setUTCDate(cutoff.getUTCDate() - 1);
        cutoff.setUTCHours(cutoffHour, 0, 0, 0);
        const cutoffPassed = nowJakarta.getTime() > cutoff.getTime();

        return {
          date: ymd,
          weekday: DAY_ID[dow],
          servable,
          reason,
          // Cuti bersama is not a closure: whether the partner kitchens work
          // those days is an admin decision, so it is surfaced, not enforced.
          cuti_bersama:
            holiday?.type === "cuti_bersama" ? (holiday?.name ?? null) : null,
          order_cutoff: `${cutoff.toISOString().slice(0, 10)} ${String(cutoffHour).padStart(2, "0")}:00 WIB`,
          cutoff_passed: cutoffPassed,
          bookable: servable && !cutoffPassed,
        };
      });

      return {
        dates: results,
        note: "A date past its cutoff can still be taken if Annie overrides the deadline — offer it as an override, not a refusal.",
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
        .select(
          "id, total_price, package_size, size, status, customers!orders_customer_id_fkey(name)",
        )
        .eq("id", input.order_id as string)
        .single();
      const rawCustomer = order?.customers;
      const customerName = Array.isArray(rawCustomer)
        ? (rawCustomer[0]?.name ?? "Unknown")
        : ((rawCustomer as { name: string | null } | null)?.name ?? "Unknown");
      const totalPrice =
        (order as { total_price?: number } | null)?.total_price ?? 0;
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
        .select(
          "id, status, package_size, customers!orders_customer_id_fkey(name)",
        )
        .eq("id", input.order_id as string)
        .single();
      const rawCustomer = order?.customers;
      const customerName = Array.isArray(rawCustomer)
        ? (rawCustomer[0]?.name ?? "Unknown")
        : ((rawCustomer as { name: string | null } | null)?.name ?? "Unknown");
      const orderData = order as {
        package_size?: number;
        status?: string;
      } | null;
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
      const preview =
        message.length > 60 ? `${message.slice(0, 60)}...` : message;
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
      const preview =
        caption.length > 60 ? `${caption.slice(0, 60)}...` : caption;
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
        .select("delivery_date, meal_type, portions, customer:customers(name)")
        .eq("id", input.delivery_id as string)
        .single();
      const customerName =
        (delivery?.customer as { name?: string } | null)?.name ?? "Unknown";
      const deliveryData = delivery as {
        delivery_date?: string;
        meal_type?: string;
        portions?: number;
      } | null;
      const action = input.action as string;
      const locked =
        !!deliveryData?.delivery_date &&
        isLocked(deliveryData.delivery_date, {
          deadlineHour: await loadDeadlineHour(),
        });
      return {
        tool,
        input,
        label:
          action === "skip"
            ? "Delete delivery (skip)"
            : `Reschedule delivery to ${input.new_date as string}`,
        details: [
          `Customer: ${customerName}`,
          `Date: ${deliveryData?.delivery_date ?? "?"}`,
          `Meal: ${deliveryData?.meal_type ?? "?"}, ${deliveryData?.portions ?? "?"} porsi`,
          // The admin needs to see this before approving: a skip deletes the
          // row, and past the cutoff the kitchen is already cooking it.
          locked
            ? "Sudah lewat batas H-1 — dapur sudah dapat sheet-nya"
            : "Masih bisa dibatalkan (belum lewat batas H-1)",
          ...(action === "skip"
            ? ["Baris pengiriman dihapus; porsinya kembali ke kuota"]
            : [`New date: ${input.new_date as string}`]),
        ],
        dangerous: action === "skip",
      };
    }

    case "pause_order": {
      const { data: order } = await db
        .from("orders")
        .select(
          "id, status, package_size, start_date, customers!orders_customer_id_fkey(name)",
        )
        .eq("id", input.order_id as string)
        .single();
      const rawCustomer = order?.customers;
      const customerName = Array.isArray(rawCustomer)
        ? (rawCustomer[0]?.name ?? "Unknown")
        : ((rawCustomer as { name: string | null } | null)?.name ?? "Unknown");
      const orderData = order as {
        id?: string;
        status?: string;
        package_size?: number;
      } | null;
      return {
        tool,
        input,
        label: "Pause order",
        details: [
          `Customer: ${customerName}`,
          `Current status: ${orderData?.status ?? "unknown"}`,
          `Portions remaining: ${
            orderData?.id
              ? ((
                  await remainingTodayByOrder(db, [
                    {
                      id: orderData.id,
                      package_size: orderData.package_size ?? 0,
                    },
                  ])
                ).get(orderData.id) ?? "?")
              : "?"
          }`,
          ...(input.pause_until
            ? [`Resume date: ${input.pause_until as string}`]
            : ["No auto-resume date"]),
        ],
        dangerous: false,
      };
    }

    case "resume_order": {
      const { data: order } = await db
        .from("orders")
        .select(
          "id, status, package_size, customers!orders_customer_id_fkey(name)",
        )
        .eq("id", input.order_id as string)
        .single();
      const rawCustomer = order?.customers;
      const customerName = Array.isArray(rawCustomer)
        ? (rawCustomer[0]?.name ?? "Unknown")
        : ((rawCustomer as { name: string | null } | null)?.name ?? "Unknown");
      const orderData = order as {
        id?: string;
        status?: string;
        package_size?: number;
      } | null;
      return {
        tool,
        input,
        label: "Resume order",
        details: [
          `Customer: ${customerName}`,
          `Current status: ${orderData?.status ?? "unknown"}`,
          `Portions remaining: ${
            orderData?.id
              ? ((
                  await remainingTodayByOrder(db, [
                    {
                      id: orderData.id,
                      package_size: orderData.package_size ?? 0,
                    },
                  ])
                ).get(orderData.id) ?? "?")
              : "?"
          }`,
        ],
        dangerous: false,
      };
    }

    case "send_payment_details": {
      const { data: order } = await db
        .from("orders")
        .select(
          "id, total_price, status, customers!orders_customer_id_fkey(name, phone_number)",
        )
        .eq("id", input.order_id as string)
        .single();
      const rawCustomer = order?.customers;
      const customer = (
        Array.isArray(rawCustomer) ? rawCustomer[0] : rawCustomer
      ) as { name: string | null; phone_number: string } | null;
      const orderData = order as {
        total_price?: number;
        status?: string;
      } | null;
      const formatted = new Intl.NumberFormat("id-ID").format(
        orderData?.total_price ?? 0,
      );
      return {
        tool,
        input,
        label: `Send payment details — Rp ${formatted}`,
        details: [
          `Customer: ${customer?.name ?? "Unknown"}`,
          `Phone: ${customer?.phone_number ?? "?"}`,
          `Amount: Rp ${formatted}`,
          `Order status: ${orderData?.status ?? "unknown"}`,
        ],
        dangerous: false,
      };
    }

    case "mark_payment_proof_received": {
      const { data: order } = await db
        .from("orders")
        .select(
          "id, total_price, status, customers!orders_customer_id_fkey(name)",
        )
        .eq("id", input.order_id as string)
        .single();
      const rawCustomer = order?.customers;
      const customerName = Array.isArray(rawCustomer)
        ? (rawCustomer[0]?.name ?? "Unknown")
        : ((rawCustomer as { name: string | null } | null)?.name ?? "Unknown");
      const orderData = order as {
        total_price?: number;
        status?: string;
      } | null;
      const formatted = new Intl.NumberFormat("id-ID").format(
        orderData?.total_price ?? 0,
      );
      return {
        tool,
        input,
        label: "Mark payment proof received",
        details: [
          `Customer: ${customerName}`,
          `Amount: Rp ${formatted}`,
          `Current status: ${orderData?.status ?? "unknown"}`,
        ],
        dangerous: false,
      };
    }

    case "update_order": {
      const field = input.field as string;
      const { data: order } = await db
        .from("orders")
        .select(
          "id, portions_per_delivery, portions_lunch, portions_dinner, start_date, end_date, customers!orders_customer_id_fkey(name)",
        )
        .eq("id", input.order_id as string)
        .single();
      const rawCustomer = order?.customers;
      const customerName = Array.isArray(rawCustomer)
        ? (rawCustomer[0]?.name ?? "Unknown")
        : ((rawCustomer as { name: string | null } | null)?.name ?? "Unknown");
      const currentVal = (order as Record<string, unknown> | null)?.[field];
      return {
        tool,
        input,
        label: `Update order ${field}`,
        details: [
          `Customer: ${customerName}`,
          `Field: ${field}`,
          `Current: ${currentVal ?? "—"}`,
          `New value: ${input.value as string}`,
        ],
        dangerous: false,
      };
    }

    case "create_customer": {
      return {
        tool,
        input,
        label: "Create customer",
        details: [
          `Name: ${(input.name as string | undefined) ?? "(none)"}`,
          `Phone: ${input.phone_number as string}`,
          `Area: ${input.area as string}`,
          `Address: ${input.address as string}`,
        ],
        dangerous: false,
      };
    }

    case "create_order": {
      const { data: customer } = await db
        .from("customers")
        .select("name")
        .eq("id", input.customer_id as string)
        .single();
      if (!customer) {
        return {
          tool,
          input,
          label: `⚠ create_order — customer not found (${input.customer_id as string})`,
          details: [
            `customer_id "${input.customer_id as string}" does not exist — use query_customers to get the correct UUID`,
          ],
          dangerous: true,
        };
      }
      const packageSize = input.package_size as number;
      const pricePerPortion = input.price_per_portion as number;
      const totalPrice = packageSize * pricePerPortion;
      const formatted = new Intl.NumberFormat("id-ID").format(totalPrice);
      const perDelivery = Math.max(
        1,
        (input.portions_per_delivery as number) || 1,
      );
      const scheduledDays = Math.ceil(packageSize / perDelivery);
      return {
        tool,
        input,
        label: `Create order — Rp ${formatted}`,
        details: [
          `Customer: ${(customer as { name?: string }).name}`,
          `Package: ${packageSize} porsi`,
          // Shown because it decides how many portions each generated delivery
          // draws. It was absent from this card while the model was getting it
          // wrong, so there was nothing on screen for the admin to catch.
          `Per pengiriman: ${input.portions_per_delivery as number} porsi`,
          `Price: Rp ${new Intl.NumberFormat("id-ID").format(pricePerPortion)}/porsi`,
          `Total: Rp ${formatted}`,
          `Start: ${input.start_date as string}${input.end_date ? ` → ${input.end_date as string}` : ""}`,
          `Meal: ${input.meal_time_preference as string}`,
          // What the meal preference actually costs the customer in booked days.
          // Nothing on this card said a standing pattern books the whole package
          // up front, so a wrong preference was invisible until the ledger.
          FIXED_SCHEDULE_PREFS.includes(input.meal_time_preference as string)
            ? `Jadwal: ${scheduledDays} hari dari ${input.start_date as string}, masuk ke dapur setelah pembayaran`
            : "Jadwal: tidak otomatis — pengiriman dicatat per hari",
        ],
        dangerous: false,
      };
    }

    default:
      return {
        tool,
        input,
        label: `Execute: ${tool}`,
        details: [],
        dangerous: false,
      };
  }
}
