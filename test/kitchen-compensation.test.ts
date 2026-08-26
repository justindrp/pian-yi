import { stripCompensation } from "@/lib/kitchen/compensation";

describe("stripCompensation", () => {
  // The request must survive: it is the only reason the note exists. Dropping
  // the whole clause would take "tanpa nasi" off the sheet with the parenthetical.
  test("keeps the request and drops the parenthetical", () => {
    expect(stripCompensation("tanpa nasi (protein +25%)")).toBe("tanpa nasi");
    expect(stripCompensation("Tanpa nasi (porsi protein +25%)")).toBe(
      "Tanpa nasi",
    );
    expect(stripCompensation("tanpa nasi (protein ditambah 25%)")).toBe(
      "tanpa nasi",
    );
  });

  test("drops the compensation written as its own clause", () => {
    expect(stripCompensation("tanpa nasi, protein ditambah 25%")).toBe(
      "tanpa nasi",
    );
    expect(
      stripCompensation("tanpa nasi, porsi protein tambah 25% sebagai gantinya"),
    ).toBe("tanpa nasi");
    expect(stripCompensation("tanpa nasi, +25% protein")).toBe("tanpa nasi");
    expect(stripCompensation("tanpa nasi dengan protein 25% lebih banyak")).toBe(
      "tanpa nasi",
    );
  });

  test("leaves a note that says nothing about the compensation alone", () => {
    expect(stripCompensation("tanpa nasi, tidak pedas")).toBe(
      "tanpa nasi, tidak pedas",
    );
    expect(stripCompensation("diambil di security, telepon dulu")).toBe(
      "diambil di security, telepon dulu",
    );
    // Nasi merah is a real customer-facing surcharge, not our arrangement with
    // the kitchen, and its percentage-free wording must not be touched.
    expect(stripCompensation("nasi merah")).toBe("nasi merah");
  });

  test("keeps other requests when the compensation sits between them", () => {
    expect(
      stripCompensation("tidak pedas, protein +25%, tanpa seafood"),
    ).toBe("tidak pedas, tanpa seafood");
  });

  test("returns empty when the compensation was the whole note", () => {
    expect(stripCompensation("protein +25%")).toBe("");
    expect(stripCompensation("(protein +25%)")).toBe("");
  });
});
