import { priceListLines } from "@/lib/pricing/lines";

const HOUSE = [
  { portions: 5, price_per_portion: 29000 },
  { portions: 6, price_per_portion: 29000 },
  { portions: 10, price_per_portion: 28000 },
  { portions: 12, price_per_portion: 28000 },
  { portions: 20, price_per_portion: 27000 },
  { portions: 24, price_per_portion: 27000 },
  { portions: 40, price_per_portion: 26000 },
  { portions: 48, price_per_portion: 26000 },
  { portions: 60, price_per_portion: 26000 },
  { portions: 72, price_per_portion: 26000 },
  { portions: 120, price_per_portion: 25000 },
  { portions: 144, price_per_portion: 25000 },
];

describe("priceListLines", () => {
  it("renders the house ladder exactly as the hardcoded list used to read", () => {
    expect(priceListLines(HOUSE)).toBe(
      [
        "- 5 hari siang/malam saja: Rp 145.000 (Rp 29.000/meal)",
        "- 5 hari siang + malam: Rp 280.000 (Rp 28.000/meal)",
        "- 6 hari siang/malam saja: Rp 174.000 (Rp 29.000/meal)",
        "- 6 hari siang + malam: Rp 336.000 (Rp 28.000/meal)",
        "- 20 hari siang/malam saja: Rp 540.000 (Rp 27.000/meal)",
        "- 20 hari siang + malam: Rp 1.040.000 (Rp 26.000/meal)",
        "- 24 hari siang/malam saja: Rp 648.000 (Rp 27.000/meal)",
        "- 24 hari siang + malam: Rp 1.248.000 (Rp 26.000/meal)",
        "- 60 hari siang/malam saja: Rp 1.560.000 (Rp 26.000/meal)",
        "- 60 hari siang + malam: Rp 3.000.000 (Rp 25.000/meal)",
        "- 72 hari siang/malam saja: Rp 1.872.000 (Rp 26.000/meal)",
        "- 72 hari siang + malam: Rp 3.600.000 (Rp 25.000/meal)",
      ].join("\n"),
    );
  });

  it("quotes a kitchen's own ladder, not the house one", () => {
    const palem = HOUSE.map((t) => ({
      ...t,
      price_per_portion: t.price_per_portion + 1500,
    }));
    expect(priceListLines(palem)).toContain(
      "- 5 hari siang/malam saja: Rp 152.500 (Rp 30.500/meal)",
    );
  });

  it("falls back to a plain portions list when the ladder is not day-shaped", () => {
    expect(
      priceListLines([
        { portions: 5, price_per_portion: 29000 },
        { portions: 7, price_per_portion: 28000 },
      ]),
    ).toBe(
      [
        "- 5 porsi: Rp 145.000 (Rp 29.000/porsi)",
        "- 7 porsi: Rp 196.000 (Rp 28.000/porsi)",
      ].join("\n"),
    );
  });

  it("returns an empty string for an empty ladder", () => {
    expect(priceListLines([])).toBe("");
  });
});
