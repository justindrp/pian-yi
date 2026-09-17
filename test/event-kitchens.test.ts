import { runTool } from "@/lib/claude/assistant-tools";
import { createAdminClient } from "@/lib/supabase/admin";

jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));

// The tool filters takes_events in SQL, so the mock returns only event
// kitchens. Dapur 2 runs no daily route (is_active false) — that must not
// remove it from the tender list.
const KITCHENS = [
  {
    id: "k1",
    customer_nickname: "Dapur 1",
    is_active: true,
    delivery_days: [1, 2, 3, 4, 5, 6],
    delivery_areas: ["BSD"],
    cost_per_portion: 19000,
  },
  {
    id: "k2",
    customer_nickname: "Dapur 2",
    is_active: false,
    delivery_days: [1, 2, 3, 4, 5],
    delivery_areas: ["Alam Sutera"],
    cost_per_portion: 20000,
  },
];

function mockDb(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order"]) {
    chain[m] = jest.fn(() => chain);
  }
  // `order` is the last call in the tool, so it resolves.
  chain.order = jest.fn(() => Promise.resolve({ data: rows, error: null }));
  (createAdminClient as jest.Mock).mockReturnValue({
    from: jest.fn(() => chain),
  });
}

describe("query_event_kitchens", () => {
  beforeEach(() => jest.clearAllMocks());

  it("keeps an event kitchen that runs no daily route", async () => {
    mockDb(KITCHENS);
    const res = (await runTool("query_event_kitchens", {})) as {
      tender_to: { dapur: string; runs_daily_route: boolean }[];
      all_event_kitchens: unknown[];
    };
    expect(res.tender_to.map((k) => k.dapur)).toEqual(["Dapur 1", "Dapur 2"]);
    expect(res.tender_to[1].runs_daily_route).toBe(false);
    expect(res.all_event_kitchens).toHaveLength(2);
  });

  it("drops an event kitchen that does not work that weekday", async () => {
    mockDb(KITCHENS);
    // 2026-09-19 is a Saturday: Dapur 2 is Senin-Jumat.
    const res = (await runTool("query_event_kitchens", {
      date: "2026-09-19",
    })) as { tender_to: { dapur: string }[] };
    expect(res.tender_to.map((k) => k.dapur)).toEqual(["Dapur 1"]);
  });

  it("falls back to Senin-Sabtu when a kitchen has no delivery_days", async () => {
    mockDb([
      { ...KITCHENS[0], delivery_days: null },
      { ...KITCHENS[1], delivery_days: [] },
    ]);
    const sat = (await runTool("query_event_kitchens", {
      date: "2026-09-19",
    })) as { tender_to: { dapur: string }[] };
    expect(sat.tender_to.map((k) => k.dapur)).toEqual(["Dapur 1", "Dapur 2"]);

    mockDb([{ ...KITCHENS[0], delivery_days: null }]);
    const sun = (await runTool("query_event_kitchens", {
      date: "2026-09-20",
    })) as { tender_to: unknown[] };
    expect(sun.tender_to).toHaveLength(0);
  });

  it("reports a closed libur nasional on the date", async () => {
    mockDb(KITCHENS);
    const res = (await runTool("query_event_kitchens", {
      date: "2026-08-17",
    })) as { closed_holiday: boolean | null };
    expect(res.closed_holiday).toBe(true);
  });
});
