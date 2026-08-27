import { normalizePhone, samePhone } from "@/lib/utils/phone";

describe("normalizePhone", () => {
  it("keeps a number already in the stored form", () => {
    expect(normalizePhone("+6281213098656")).toBe("+6281213098656");
  });

  it("reads the three forms a customer types", () => {
    expect(normalizePhone("081213098656")).toBe("+6281213098656");
    expect(normalizePhone("6281213098656")).toBe("+6281213098656");
    expect(normalizePhone("81213098656")).toBe("+6281213098656");
  });

  it("ignores the punctuation people put in phone numbers", () => {
    expect(normalizePhone("0812-1309-8656")).toBe("+6281213098656");
    expect(normalizePhone("+62 812 1309 8656")).toBe("+6281213098656");
    expect(normalizePhone(" 0812.1309.8656 ")).toBe("+6281213098656");
  });

  // The whole point of the helper: the same person written two ways must not
  // become two customer records with two packages.
  it("collapses every form to one key", () => {
    const forms = [
      "+6281213098656",
      "081213098656",
      "0812-1309-8656",
      "62 812 1309 8656",
    ];
    expect(new Set(forms.map(normalizePhone)).size).toBe(1);
  });

  it("refuses anything it cannot read as a number", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("nggak tahu")).toBeNull();
    expect(normalizePhone("nanti saya kirim")).toBeNull();
    expect(normalizePhone("0812 atau 0813")).toBeNull();
  });

  it("refuses a fragment and a run-on", () => {
    expect(normalizePhone("08121")).toBeNull();
    expect(normalizePhone("081213098656081213098656")).toBeNull();
  });

  // A landline or a mistyped prefix is not a WhatsApp number, and guessing at
  // one would attach an order to nobody.
  it("refuses a number that is not an Indonesian mobile", () => {
    expect(normalizePhone("0215550123")).toBeNull();
  });

  it("passes a foreign number through untouched", () => {
    expect(normalizePhone("+6591234567")).toBe("+6591234567");
  });
});

describe("samePhone", () => {
  it("matches across written forms", () => {
    expect(samePhone("081213098656", "+6281213098656")).toBe(true);
  });

  it("does not match two different people", () => {
    expect(samePhone("081213098656", "+6287808781094")).toBe(false);
  });

  it("is false when either side is unreadable", () => {
    expect(samePhone("nggak tahu", "+6281213098656")).toBe(false);
    expect(samePhone(null, null)).toBe(false);
  });
});
