import { pickDrawOrder } from "@/lib/orders/pick-draw-order";

const order = (
  id: string,
  portions_remaining: number | null,
  start_date: string | null,
  created_at?: string,
) => ({ id, portions_remaining, start_date, created_at });

describe("pickDrawOrder", () => {
  test("returns null when the customer has no active order", () => {
    expect(pickDrawOrder([])).toBeNull();
  });

  test("drains the oldest package that still has balance", () => {
    const picked = pickDrawOrder([
      order("new", 20, "2026-08-05"),
      order("old", 3, "2026-07-16"),
    ]);
    expect(picked?.id).toBe("old");
  });

  test("skips a drained order in favour of a newer one with balance", () => {
    // Julian S: eb853b86 was fully drawn down but kept winning because it was
    // created first, so four deliveries landed on it instead of 0831e475.
    const picked = pickDrawOrder([
      order("eb853b86", 0, "2026-07-27"),
      order("0831e475", 5, "2026-08-05"),
    ]);
    expect(picked?.id).toBe("0831e475");
  });

  test("skips an order already gone negative", () => {
    const picked = pickDrawOrder([
      order("overdrawn", -2, "2026-06-08"),
      order("fresh", 20, "2026-08-04"),
    ]);
    expect(picked?.id).toBe("fresh");
  });

  test("falls back to the newest order when none has balance", () => {
    // portions_remaining is unreliable on the June import, so returning null
    // here would drop a real customer off the daily sheet. Charging the newest
    // package is the least wrong answer.
    const picked = pickDrawOrder([
      order("june", 0, "2026-06-08", "2026-06-08T00:00:00Z"),
      order("july", 0, "2026-07-24", "2026-07-24T00:00:00Z"),
    ]);
    expect(picked?.id).toBe("july");
  });

  test("sorts a null start_date last rather than treating it as earliest", () => {
    const picked = pickDrawOrder([
      order("undated", 5, null),
      order("dated", 5, "2026-08-01"),
    ]);
    expect(picked?.id).toBe("dated");
  });

  test("breaks a start_date tie on created_at", () => {
    const picked = pickDrawOrder([
      order("later", 5, "2026-08-01", "2026-08-01T09:00:00Z"),
      order("earlier", 5, "2026-08-01", "2026-08-01T02:00:00Z"),
    ]);
    expect(picked?.id).toBe("earlier");
  });

  test("does not depend on the order rows arrive in", () => {
    const rows = [
      order("a", 0, "2026-06-08"),
      order("b", 4, "2026-07-16"),
      order("c", 5, "2026-08-05"),
    ];
    expect(pickDrawOrder(rows)?.id).toBe("b");
    expect(pickDrawOrder([...rows].reverse())?.id).toBe("b");
  });

  test("does not mutate the array it is given", () => {
    const rows = [order("b", 5, "2026-08-05"), order("a", 5, "2026-07-01")];
    pickDrawOrder(rows);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });
});
