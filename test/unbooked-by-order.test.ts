import { unbookedByOrder } from "@/lib/orders/customer-schedule";

type Row = {
  order_id: string | null;
  portions: number | null;
  status: string | null;
};

/**
 * Enough of the query builder for unbookedByOrder: it chains
 * .select().in().not().range() and awaits the result.
 */
function stubDb(rows: Row[]) {
  return {
    from: () => ({
      select: () => ({
        in: (_col: string, ids: string[]) => ({
          not: () => ({
            range: () =>
              Promise.resolve({
                data: rows.filter(
                  (r) =>
                    r.order_id !== null &&
                    ids.includes(r.order_id) &&
                    r.status !== "cancelled" &&
                    r.status !== "skipped",
                ),
                error: null,
              }),
          }),
        }),
      }),
    }),
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any;
}

describe("unbookedByOrder", () => {
  test("an order with nothing booked has its whole package unbooked", async () => {
    const m = await unbookedByOrder(stubDb([]), [
      { id: "a", package_size: 20 },
    ]);
    expect(m.get("a")).toBe(20);
  });

  test("booked rows come off the package, future dates included", async () => {
    const m = await unbookedByOrder(
      stubDb([
        { order_id: "a", portions: 1, status: "delivered" },
        { order_id: "a", portions: 1, status: "scheduled" },
      ]),
      [{ id: "a", package_size: 20 }],
    );
    expect(m.get("a")).toBe(18);
  });

  // Nadya on 2026-08-20: twelve meals still owed, every one already dated.
  // The generator must write her nothing, which is what makes reactivating
  // her order safe.
  test("a fully booked order reads 0 even with deliveries still to come", async () => {
    const rows: Row[] = Array.from({ length: 20 }, () => ({
      order_id: "nadya",
      portions: 1,
      status: "scheduled",
    }));
    const m = await unbookedByOrder(stubDb(rows), [
      { id: "nadya", package_size: 20 },
    ]);
    expect(m.get("nadya")).toBe(0);
  });

  test("cancelled and skipped rows do not count as booked", async () => {
    const m = await unbookedByOrder(
      stubDb([
        { order_id: "a", portions: 5, status: "cancelled" },
        { order_id: "a", portions: 5, status: "skipped" },
        { order_id: "a", portions: 5, status: "scheduled" },
      ]),
      [{ id: "a", package_size: 20 }],
    );
    expect(m.get("a")).toBe(15);
  });

  test("over-drawn orders go negative rather than clamping", async () => {
    const m = await unbookedByOrder(
      stubDb([{ order_id: "a", portions: 32, status: "delivered" }]),
      [{ id: "a", package_size: 30 }],
    );
    expect(m.get("a")).toBe(-2);
  });

  test("a null package_size is treated as no quota, not unlimited", async () => {
    const m = await unbookedByOrder(stubDb([]), [
      { id: "a", package_size: null },
    ]);
    expect(m.get("a")).toBe(0);
  });

  test("no orders means no query and an empty map", async () => {
    const m = await unbookedByOrder(stubDb([]), []);
    expect(m.size).toBe(0);
  });
});
