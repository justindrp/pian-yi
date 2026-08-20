import { orderRemainingToday } from "@/lib/orders/customer-schedule";

type Row = { portions: number; status: string; delivery_date: string };

/**
 * Minimal stand-in for the chained Supabase select the helper builds:
 * .from().select().eq().lte().neq(), awaited on the final call.
 */
function stubDb(rows: Row[]) {
  let cutoff = "9999-12-31";
  const q = {
    select: () => q,
    eq: () => q,
    lte: (_col: string, val: string) => {
      cutoff = val;
      return q;
    },
    neq: (_col: string, excluded: string) =>
      Promise.resolve({
        data: rows.filter(
          (r) => r.delivery_date <= cutoff && r.status !== excluded,
        ),
      }),
  };
  // biome-ignore lint/suspicious/noExplicitAny: test stub, not the real client
  return { from: () => q } as any;
}

const row = (delivery_date: string, status = "scheduled", portions = 1) => ({
  delivery_date,
  status,
  portions,
});

describe("orderRemainingToday", () => {
  // Nadya's order on 2026-08-20: 20 bought, 8 delivered, 12 still to come and
  // every one of them already dated. The cron completed it on 2026-08-13.
  test("future rows do not count as delivered", async () => {
    const rows = [
      ...["08-10", "08-11", "08-12", "08-13", "08-14", "08-18", "08-19", "08-20"].map(
        (d) => row(`2026-${d}`),
      ),
      ...["08-21", "08-24", "08-26", "08-27"].map((d) => row(`2026-${d}`)),
    ];
    expect(await orderRemainingToday(stubDb(rows), "o", 20, "2026-08-20")).toBe(12);
  });

  test("reaches zero only once the last portion has gone out", async () => {
    const rows = [row("2026-08-18"), row("2026-08-19"), row("2026-08-20")];
    expect(await orderRemainingToday(stubDb(rows), "o", 3, "2026-08-20")).toBe(0);
  });

  test("a cancelled row is not a draw", async () => {
    const rows = [row("2026-08-19"), row("2026-08-20", "cancelled")];
    expect(await orderRemainingToday(stubDb(rows), "o", 3, "2026-08-20")).toBe(2);
  });

  test("a skipped row is not a draw — quota is preserved", async () => {
    const rows = [row("2026-08-19"), row("2026-08-20", "skipped")];
    expect(await orderRemainingToday(stubDb(rows), "o", 3, "2026-08-20")).toBe(2);
  });

  test("counts portions, not rows", async () => {
    expect(
      await orderRemainingToday(stubDb([row("2026-08-20", "scheduled", 4)]), "o", 10, "2026-08-20"),
    ).toBe(6);
  });
});
