import { mergeKitchenNote } from "@/lib/claude/extract-order";

const AI_BLOCK = `[AI learned context]
- Preferensi: tidak pedas
- Harga: Rp 420.000
[/AI learned context]`;

describe("mergeKitchenNote", () => {
  test("writes the request as a manual note when there are none", () => {
    expect(mergeKitchenNote(null, "tanpa nasi")).toBe("tanpa nasi");
    expect(mergeKitchenNote("", "tanpa nasi")).toBe("tanpa nasi");
  });

  test("leaves the column alone when there is nothing to record", () => {
    expect(mergeKitchenNote(null, "")).toBeNull();
    expect(mergeKitchenNote("diambil di security", "   ")).toBeNull();
  });

  // The kitchen sheet cuts everything from [AI learned context] onwards, so the
  // block has to stay last. A note appended after it would be invisible, and
  // worse, would drag the block's price lines onto an unauthenticated page.
  test("keeps the AI block last so manualNotesOnly still cuts it off", () => {
    const merged = mergeKitchenNote(AI_BLOCK, "tanpa nasi");
    expect(merged).not.toBeNull();
    const cut = (merged as string).indexOf("[AI learned context]");
    expect(cut).toBeGreaterThan(0);
    expect((merged as string).slice(0, cut).trim()).toBe("tanpa nasi");
    expect(merged).toContain("[/AI learned context]");
  });

  test("keeps existing manual notes, with the new request above them", () => {
    const merged = mergeKitchenNote(
      `diambil di security\n\n${AI_BLOCK}`,
      "tanpa nasi",
    );
    expect(merged).toBe(`tanpa nasi\ndiambil di security\n\n${AI_BLOCK}`);
  });

  // extract_order re-runs on every amendment and every renewal.
  test("does not stack the same request on repeat calls", () => {
    const once = mergeKitchenNote(null, "tanpa nasi") as string;
    expect(mergeKitchenNote(once, "tanpa nasi")).toBeNull();
    expect(mergeKitchenNote(once, "TANPA NASI")).toBeNull();
    expect(mergeKitchenNote(`${once}\n\n${AI_BLOCK}`, "tanpa nasi")).toBeNull();
  });

  test("a request already in the AI block is still written manually", () => {
    // aiPreferences() only surfaces `Preferensi:` bullets, and only when there
    // is no manual note at all — so presence in the block is not coverage.
    expect(mergeKitchenNote(AI_BLOCK, "tidak pedas")).toContain("tidak pedas");
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
