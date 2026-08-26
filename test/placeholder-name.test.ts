import {
  isPlaceholderName,
  shouldRecordName,
} from "@/lib/claude/extract-order";

describe("isPlaceholderName", () => {
  // The literal the old system prompt told the model to send when the customer
  // never gave a name. It was stored, then read back out by every greeting.
  it("rejects the honorific the prompt used to emit", () => {
    expect(isPlaceholderName("Kak")).toBe(true);
    expect(isPlaceholderName("kak")).toBe(true);
    expect(isPlaceholderName("Kakak")).toBe(true);
  });

  it("rejects the other stand-ins the model reaches for", () => {
    expect(isPlaceholderName("unknown")).toBe(true);
    expect(isPlaceholderName("Customer")).toBe(true);
    expect(isPlaceholderName("Pelanggan")).toBe(true);
    expect(isPlaceholderName("-")).toBe(true);
  });

  it("ignores surrounding whitespace and trailing punctuation", () => {
    expect(isPlaceholderName("  Kak ")).toBe(true);
    expect(isPlaceholderName("Kak.")).toBe(true);
  });

  it("keeps real names, including ones that merely start with the honorific", () => {
    expect(isPlaceholderName("Fahmi")).toBe(false);
    expect(isPlaceholderName("Kurniadi Tan")).toBe(false);
    expect(isPlaceholderName("Gracia Calista Sugiharto")).toBe(false);
    // "Kakang" is a real Javanese name; only an exact match is a placeholder.
    expect(isPlaceholderName("Kakang")).toBe(false);
    expect(isPlaceholderName("Kartika")).toBe(false);
  });
});

describe("shouldRecordName", () => {
  it("records a real name for a customer who has none", () => {
    expect(shouldRecordName("Keira", null)).toBe(true);
    expect(shouldRecordName("Keira", "")).toBe(true);
    expect(shouldRecordName("Keira", "   ")).toBe(true);
  });

  // Julian S was renamed to "Julian" by an order he never placed.
  it("never renames a customer who already has a name", () => {
    expect(shouldRecordName("Julian", "Julian S")).toBe(false);
    expect(shouldRecordName("Keira", "Kurniadi Tan")).toBe(false);
  });

  it("never records an honorific or a stand-in", () => {
    expect(shouldRecordName("Kak", null)).toBe(false);
    expect(shouldRecordName("unknown", null)).toBe(false);
    expect(shouldRecordName("", null)).toBe(false);
    expect(shouldRecordName(null, null)).toBe(false);
    expect(shouldRecordName(undefined, null)).toBe(false);
  });
});
