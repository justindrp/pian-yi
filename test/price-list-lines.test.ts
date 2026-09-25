import {
  largestSizeBelow,
  priceListLines,
  sellableSizesLines,
} from "@/lib/pricing/lines";

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

describe("sellableSizesLines", () => {
  it("renders the house ladder exactly as the hardcoded list used to read", () => {
    expect(sellableSizesLines(HOUSE)).toBe(
      [
        "- 5 porsi → Rp 29.000/porsi → *Rp 145.000*",
        "- 6 porsi → Rp 29.000/porsi → *Rp 174.000*",
        "- 10 porsi → Rp 28.000/porsi → *Rp 280.000*",
        "- 12 porsi → Rp 28.000/porsi → *Rp 336.000*",
        "- 20 porsi → Rp 27.000/porsi → *Rp 540.000*",
        "- 24 porsi → Rp 27.000/porsi → *Rp 648.000*",
        "- 40 porsi → Rp 26.000/porsi → *Rp 1.040.000*",
        "- 48 porsi → Rp 26.000/porsi → *Rp 1.248.000*",
        "- 60 porsi → Rp 26.000/porsi → *Rp 1.560.000*",
        "- 72 porsi → Rp 26.000/porsi → *Rp 1.872.000*",
        "- 120 porsi → Rp 25.000/porsi → *Rp 3.000.000*",
        "- 144 porsi → Rp 25.000/porsi → *Rp 3.600.000*",
      ].join("\n"),
    );
  });

  it("sells a kitchen's food at that kitchen's rate", () => {
    const monstera = HOUSE.map((t) => ({
      ...t,
      price_per_portion: t.price_per_portion + 16000,
    }));
    const lines = sellableSizesLines(monstera).split("\n");
    expect(lines[0]).toBe("- 5 porsi → Rp 45.000/porsi → *Rp 225.000*");
    expect(lines[6]).toBe("- 40 porsi → Rp 42.000/porsi → *Rp 1.680.000*");
    expect(sellableSizesLines(monstera)).not.toContain("Rp 26.000");
  });

  it("sorts an unsorted ladder and handles an empty one", () => {
    expect(sellableSizesLines([HOUSE[2], HOUSE[0]])).toBe(
      [
        "- 5 porsi → Rp 29.000/porsi → *Rp 145.000*",
        "- 10 porsi → Rp 28.000/porsi → *Rp 280.000*",
      ].join("\n"),
    );
    expect(sellableSizesLines([])).toBe("");
  });
});

describe("largestSizeBelow", () => {
  it("names the tier an off-list total is priced from", () => {
    expect(largestSizeBelow(HOUSE, 15)).toBe(12);
    expect(largestSizeBelow(HOUSE, 25)).toBe(24);
    expect(largestSizeBelow(HOUSE, 110)).toBe(72);
  });

  it("is strictly below, so a listed size names the tier under it", () => {
    expect(largestSizeBelow(HOUSE, 12)).toBe(10);
  });

  it("returns null under the floor", () => {
    expect(largestSizeBelow(HOUSE, 4)).toBeNull();
    expect(largestSizeBelow([], 20)).toBeNull();
  });
});
