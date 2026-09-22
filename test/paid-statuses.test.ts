/**
 * Which order statuses count as quota is a decision, not a formula, and it is
 * the half of a balance that drifts. Four places net packages against delivery
 * rows; on 2026-09-22 two of them counted `payment_proof_received` and two did
 * not, so a customer awaiting payment verification read as credited on the
 * Customers page and as still running out to the bot and the renewal cron.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { remainingTodayByCustomer } from "@/lib/orders/customer-schedule";
import { PAID_STATUSES } from "@/lib/orders/paid-statuses";

/** Every site that nets package_size against delivery rows. */
const QUOTA_SITES = [
  "src/lib/orders/customer-schedule.ts",
  "src/app/api/customers/[id]/route.ts",
  "src/components/dashboard/customers-client.tsx",
];

type Order = { customer_id: string; package_size: number; status: string };
type Draw = { customer_id: string; portions: number; delivery_date: string };

/**
 * Stand-in for the two paginated selects the helper runs. `orders` ends on
 * `.range()` after `.in().in()`; `daily_deliveries` ends on `.range()` after
 * `.in().lte()`.
 */
function stubDb(orders: Order[], draws: Draw[]) {
  const from = (table: string) => {
    const state: { statuses?: string[]; cutoff?: string } = {};
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.in = (column: string, values: string[]) => {
      if (column === "status") state.statuses = values;
      return q;
    };
    q.lte = (_column: string, cutoff: string) => {
      state.cutoff = cutoff;
      return q;
    };
    q.range = () =>
      Promise.resolve({
        data:
          table === "orders"
            ? orders.filter((o) => state.statuses?.includes(o.status))
            : draws.filter((d) => d.delivery_date <= (state.cutoff ?? "")),
        error: null,
      });
    return q;
  };
  // biome-ignore lint/suspicious/noExplicitAny: test stub, not the real client
  return { from } as any;
}

describe("PAID_STATUSES", () => {
  it("excludes an order whose payment is not verified", () => {
    // Proof sent is not payment verified. `mark_paid` is what writes delivery
    // rows and nothing filters the kitchen sheet by order status, so treating
    // an unverified screenshot as quota is how a forged one becomes food.
    expect(PAID_STATUSES).not.toContain("payment_proof_received");
    expect(PAID_STATUSES).not.toContain("pending_payment");
  });

  it("includes completed orders", () => {
    // The June import's package_size = 0 catch-all orders hold completed
    // packages' delivery rows, so dropping the credit charges food the
    // customer paid for to the orders still open.
    expect(PAID_STATUSES).toContain("completed");
  });

  it("is the only copy — no quota site carries its own status list", () => {
    // An array literal listing order statuses is the shape each copy took.
    // A bare mention is not: `customers-client.tsx` also maps every status to
    // a badge colour, which must keep naming payment_proof_received.
    const statusList = /\[[^[\]]*"(?:active|completed)"[^[\]]*\]/g;
    for (const site of QUOTA_SITES) {
      const source = readFileSync(join(process.cwd(), site), "utf8");
      const lists = source.match(statusList) ?? [];
      expect({ site, lists: lists.filter((l) => l.includes("payment_proof")) })
        .toEqual({ site, lists: [] });
      expect({ site, imports: source.includes("PAID_STATUSES") }).toEqual({
        site,
        imports: true,
      });
    }
  });
});

describe("remainingTodayByCustomer", () => {
  it("does not credit a package awaiting payment verification", async () => {
    const db = stubDb(
      [
        { customer_id: "c1", package_size: 20, status: "active" },
        // Renewal paid for but not yet verified by an admin.
        { customer_id: "c1", package_size: 30, status: "payment_proof_received" },
      ],
      [
        { customer_id: "c1", portions: 1, delivery_date: "2026-09-20" },
        { customer_id: "c1", portions: 1, delivery_date: "2026-09-21" },
        // Booked ahead: not drawn yet, so it does not reduce today's balance.
        { customer_id: "c1", portions: 1, delivery_date: "2026-09-25" },
      ],
    );

    const balances = await remainingTodayByCustomer(db, ["c1"], "2026-09-22");

    expect(balances.get("c1")).toBe(18);
  });
});
