import { orderRemainingToday } from "@/lib/orders/customer-schedule";

type Row = { portions: number; delivery_date: string };

/**
 * Minimal stand-in for the chained Supabase select the helper builds:
 * .from().select().eq().lte(), awaited on the final call.
 */
function stubDb(rows: Row[]) {
  const q = {
    select: () => q,
    eq: () => q,
    lte: (_col: string, cutoff: string) =>
      Promise.resolve({
        data: rows.filter((r) => r.delivery_date <= cutoff),
      }),
  };
  // biome-ignore lint/suspicious/noExplicitAny: test stub, not the real client
  return { from: () => q } as any;
}

const row = (delivery_date: string, portions = 1) => ({
  delivery_date,
  portions,
});

describe("orderRemainingToday", () => {
  // Nadya's order on 2026-08-20: 20 bought, 8 delivered, 12 still to come and
  // every one of them already dated. The cron completed it on 2026-08-13.
  test("future rows do not count as delivered", async () => {
    const rows = [
      ...[
        "08-10",
        "08-11",
        "08-12",
        "08-13",
        "08-14",
        "08-18",
        "08-19",
        "08-20",
      ].map((d) => row(`2026-${d}`)),
      ...["08-21", "08-24", "08-26", "08-27"].map((d) => row(`2026-${d}`)),
    ];
    expect(await orderRemainingToday(stubDb(rows), "o", 20, "2026-08-20")).toBe(
      12,
    );
  });

  test("reaches zero only once the last portion has gone out", async () => {
    const rows = [row("2026-08-18"), row("2026-08-19"), row("2026-08-20")];
    expect(await orderRemainingToday(stubDb(rows), "o", 3, "2026-08-20")).toBe(
      0,
    );
  });

  // A skip is a DELETE. The row for the skipped day is not there to count, so
  // the portion is back in the balance without anything being written back.
  // This used to be two tests asserting that 'cancelled' and 'skipped' rows
  // were carved out of the sum; the status column that held them is gone.
  test("a deleted row is not a draw — the balance comes back on its own", async () => {
    const rows = [row("2026-08-19")];
    expect(await orderRemainingToday(stubDb(rows), "o", 3, "2026-08-20")).toBe(
      2,
    );
  });

  test("counts portions, not rows", async () => {
    expect(
      await orderRemainingToday(stubDb([row("2026-08-20", 4)]), "o", 10, "2026-08-20"),
    ).toBe(6);
  });
});
