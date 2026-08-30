import { splitPreferences } from "@/lib/kitchen/preferences";

describe("splitPreferences", () => {
  // Julian S's card on 2026-08-30: one green box in which the only thing the
  // kitchen has to act on is the middle third of a paragraph about stairs.
  it("splits Julian S's note into what to cook and what to do with it", () => {
    expect(
      splitPreferences(
        "Makanan diantar ke atas (lantai atas)\ntidak ada kacang dan bawang goreng\ntitip dibagian drop off info aja kepetugasnya kalo makanan ini diantar keatas",
      ),
    ).toEqual({
      food: "tidak ada kacang dan bawang goreng",
      delivery:
        "Makanan diantar ke atas (lantai atas), titip dibagian drop off info aja kepetugasnya kalo makanan ini diantar keatas",
    });
  });

  it("leaves a food-only note in one box", () => {
    expect(splitPreferences("Tidak pedas, tanpa seafood")).toEqual({
      food: "Tidak pedas, tanpa seafood",
      delivery: null,
    });
  });

  it("leaves a delivery-only note in one box", () => {
    expect(splitPreferences("Diambil di security, telepon dulu")).toEqual({
      food: null,
      delivery: "Diambil di security, telepon dulu",
    });
  });

  // Nothing is filtered here: a clause that reads as neither still has to
  // reach the kitchen, so the default side is food.
  it("files an unclassifiable clause under food", () => {
    expect(splitPreferences("Porsi kecil")).toEqual({
      food: "Porsi kecil",
      delivery: null,
    });
  });

  it("has nothing to split when there is no note", () => {
    expect(splitPreferences(null)).toEqual({ food: null, delivery: null });
  });
});
