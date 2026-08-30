import { allocateDraws } from "@/lib/orders/paid-delivery-rows";

const cand = (
  id: string,
  unbooked: number | null,
  start_date: string | null,
  created_at?: string,
) => ({ id, unbooked, start_date, created_at });

const slot = (date: string, meal_type: string, portions = 1) => ({
  date,
  meal_type,
  portions,
});

describe("allocateDraws", () => {
  // Veronica Catherine, 2026-08-30. She held 1 porsi on the June order and
  // wanted seven days, so she bought a 6-porsi top-up. mark_paid charged all
  // seven to the new package: it sat 1 over its own size while the June order
  // kept a portion it had been paid for and could never complete.
  test("spends the older package's leftover before the new one", () => {
    const rows = allocateDraws(
      [
        slot("2026-08-31", "dinner"),
        slot("2026-09-01", "dinner"),
        slot("2026-09-02", "dinner"),
        slot("2026-09-03", "dinner"),
        slot("2026-09-04", "dinner"),
        slot("2026-09-05", "lunch"),
        slot("2026-09-05", "dinner"),
      ],
      [cand("june", 1, "2026-06-17"), cand("topup", 6, "2026-08-31")],
      "topup",
    );

    expect(rows.map((r) => r.order_id)).toEqual([
      "june",
      "topup",
      "topup",
      "topup",
      "topup",
      "topup",
      "topup",
    ]);
    expect(rows.filter((r) => r.order_id === "topup")).toHaveLength(6);
  });

  test("charges everything to the paid order when nothing else has balance", () => {
    const rows = allocateDraws(
      [slot("2026-09-01", "dinner"), slot("2026-09-02", "dinner")],
      [cand("drained", 0, "2026-07-01"), cand("new", 2, "2026-09-01")],
      "new",
    );
    expect(rows.every((r) => r.order_id === "new")).toBe(true);
  });

  // The June import left 89 active orders reading zero or below because their
  // deliveries predate the system. A row we refuse to charge is a meal that
  // never reaches a kitchen, so the fallback takes it.
  test("falls back rather than dropping a row when every balance is spent", () => {
    const rows = allocateDraws(
      [slot("2026-09-01", "dinner"), slot("2026-09-02", "dinner")],
      [cand("overdrawn", -3, "2026-06-08")],
      "paid",
    );
    expect(rows.map((r) => r.order_id)).toEqual(["paid", "paid"]);
  });

  test("a row is indivisible: 2 porsi against 1 of balance goes whole", () => {
    const rows = allocateDraws(
      [slot("2026-09-01", "dinner", 2), slot("2026-09-02", "dinner", 1)],
      [cand("old", 1, "2026-07-01"), cand("new", 3, "2026-09-01")],
      "new",
    );
    expect(rows[0].order_id).toBe("old");
    expect(rows[1].order_id).toBe("new");
  });

  test("does not mutate the candidates it was given", () => {
    const candidates = [cand("old", 2, "2026-07-01")];
    allocateDraws([slot("2026-09-01", "dinner")], candidates, "new");
    expect(candidates[0].unbooked).toBe(2);
  });

  test("keeps every slot, and keeps them in the order given", () => {
    const slots = [slot("2026-09-01", "lunch"), slot("2026-09-01", "dinner")];
    const rows = allocateDraws(slots, [cand("o", 5, "2026-09-01")], "o");
    expect(rows.map((r) => `${r.date} ${r.meal_type}`)).toEqual([
      "2026-09-01 lunch",
      "2026-09-01 dinner",
    ]);
  });
});
