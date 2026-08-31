import {
  addressMatchesNeighborhood,
  type CoverageRule,
  coverageFor,
} from "@/lib/subcontractors/coverage";

const rule = (
  name: string,
  canDeliver: boolean,
  surchargePerDelivery = 0,
): CoverageRule => ({
  neighborhoodId: name,
  area: "BSD Lama",
  name,
  canDeliver,
  surchargePerDelivery,
});

// Thenie refused Kost Casa Living outright on 2026-08-31 and, asked again the
// same evening, priced Apartemen Akasa at Rp 10.000 a drop instead of refusing
// it. Both answers are neighborhood names matched against an address line the
// customer typed, so the matcher has to be exact enough not to catch a
// different building and loose enough to catch the same one written longer.
describe("addressMatchesNeighborhood", () => {
  test("matches the same complex written longer", () => {
    expect(
      addressMatchesNeighborhood(
        "Apartemen Akasa Tower Kalyana BSD",
        "Apartemen Akasa",
      ),
    ).toBe(true);
    expect(
      addressMatchesNeighborhood(
        "Apartemen Akasa Pure Living, Tower Kirana, Jl. Jombang Astek No 5",
        "Apartemen Akasa",
      ),
    ).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(
      addressMatchesNeighborhood("kost casa living 158", "Casa Living"),
    ).toBe(true);
  });

  // Valen lives at "Tucasa Living, Regentown" in BSD Baru, which a substring
  // test reads as Casa Living and refuses — a customer in a different area
  // entirely, with a kitchen that will happily deliver to her.
  test("does not match a name that only ends with the neighborhood", () => {
    expect(
      addressMatchesNeighborhood("Tucasa Living, Regentown BSD", "Casa Living"),
    ).toBe(false);
  });

  test("an empty name matches nothing", () => {
    expect(addressMatchesNeighborhood("Jl. Anggrek No 3", "  ")).toBe(false);
  });
});

describe("coverageFor", () => {
  test("an address nobody has ruled on is served at the normal rate", () => {
    expect(
      coverageFor([rule("Casa Living", false)], "Jl. Anggrek No 3, BSD Lama"),
    ).toEqual({ blocked: null, surchargePerDelivery: 0 });
  });

  test("a refusal comes back with the rule that refused", () => {
    const result = coverageFor(
      [rule("Casa Living", false), rule("Apartemen Akasa", true, 10000)],
      "Kost Casa Living 158, Jl. HR. Rasuna Said",
    );
    expect(result.blocked?.name).toBe("Casa Living");
    expect(result.surchargePerDelivery).toBe(0);
  });

  test("a surcharged address is deliverable, priced", () => {
    expect(
      coverageFor(
        [rule("Apartemen Akasa", true, 10000)],
        "Apartemen Akasa Tower Kalyana BSD",
      ),
    ).toEqual({ blocked: null, surchargePerDelivery: 10000 });
  });

  // Two names for one building is two names, not two trips.
  test("surcharges do not stack — the largest match wins", () => {
    expect(
      coverageFor(
        [rule("Apartemen Akasa", true, 10000), rule("Akasa", true, 5000)],
        "Apartemen Akasa Tower Kalyana",
      ).surchargePerDelivery,
    ).toBe(10000);
  });

  test("a refusal wins over a surcharge on the same address", () => {
    const result = coverageFor(
      [rule("Casa Living", true, 5000), rule("Kost Casa Living", false)],
      "Kost Casa Living 158",
    );
    expect(result.blocked?.name).toBe("Kost Casa Living");
  });

  // Evelyn's sub_area is "Pakojan" and her address says "Kost Casa Living 158";
  // Sharleen's area is BSD Baru while Pane's identical complex is filed under
  // BSD Lama. Every field gets searched because no single one is reliable.
  test("searches every address field it is given", () => {
    expect(
      coverageFor(
        [rule("Casa Living", false)],
        null,
        undefined,
        "Kost Casa Living 158",
      ).blocked?.name,
    ).toBe("Casa Living");
  });
});
