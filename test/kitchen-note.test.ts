import { mergeKitchenNote } from "@/lib/claude/extract-order";

describe("mergeKitchenNote", () => {
  test("writes the request when the column is empty", () => {
    expect(mergeKitchenNote(null, "tanpa nasi")).toBe("tanpa nasi");
    expect(mergeKitchenNote("", "tanpa nasi")).toBe("tanpa nasi");
  });

  test("leaves the column alone when there is nothing to record", () => {
    expect(mergeKitchenNote(null, "")).toBeNull();
    expect(mergeKitchenNote("diambil di security", "   ")).toBeNull();
  });

  test("keeps existing notes, with the new request above them", () => {
    expect(mergeKitchenNote("diambil di security", "tanpa nasi")).toBe(
      "tanpa nasi\ndiambil di security",
    );
  });

  // extract_order re-runs on every amendment and every renewal.
  test("does not stack the same request on repeat calls", () => {
    const once = mergeKitchenNote(null, "tanpa nasi") as string;
    expect(mergeKitchenNote(once, "tanpa nasi")).toBeNull();
    expect(mergeKitchenNote(once, "TANPA NASI")).toBeNull();
  });

  test("records several requests as one line", () => {
    expect(mergeKitchenNote(null, "tanpa nasi, tidak pedas")).toBe(
      "tanpa nasi, tidak pedas",
    );
  });

  // The protein increase is our arrangement with the kitchen, not something the
  // customer asked for, and the sheet is unauthenticated.
  test("never writes the protein compensation to the sheet", () => {
    expect(mergeKitchenNote(null, "tanpa nasi (protein +25%)")).toBe(
      "tanpa nasi",
    );
    expect(mergeKitchenNote(null, "protein +25%")).toBeNull();
  });

  test("does not stack when the stored note was written without it", () => {
    expect(
      mergeKitchenNote("tanpa nasi", "tanpa nasi (protein +25%)"),
    ).toBeNull();
  });
});
