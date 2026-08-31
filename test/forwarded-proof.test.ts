import { matchCaption } from "@/lib/deliveries/forwarded-proof";

const today = [
  { customerId: "c1", name: "Clairine Aurelia" },
  { customerId: "c2", name: "Kurniadi Tan" },
  { customerId: "c3", name: "Fahmi" },
  { customerId: "c4", name: "Veronica Catherine" },
];

describe("matchCaption", () => {
  it("matches a full name exactly", () => {
    expect(matchCaption("Clairine Aurelia", today)).toEqual({
      ok: true,
      customerId: "c1",
      name: "Clairine Aurelia",
    });
  });

  it("matches on a first name alone", () => {
    const m = matchCaption("clairine", today);
    expect(m).toMatchObject({ ok: true, customerId: "c1" });
  });

  it("ignores case, punctuation and stray spaces", () => {
    expect(matchCaption("  KURNIADI, TAN ", today)).toMatchObject({
      ok: true,
      customerId: "c2",
    });
  });

  it("matches a word prefix", () => {
    expect(matchCaption("veron", today)).toMatchObject({
      ok: true,
      customerId: "c4",
    });
  });

  // The whole reason this does not call a model: a prefix that fits two people
  // must stop, not guess. Sending one customer another customer's food photo is
  // the failure this refuses to risk.
  it("refuses an ambiguous caption and names the candidates", () => {
    const two = [
      { customerId: "a", name: "Rina Wijaya" },
      { customerId: "b", name: "Rina Santoso" },
    ];
    expect(matchCaption("rina", two)).toEqual({
      ok: false,
      reason: "ambiguous",
      candidates: ["Rina Wijaya", "Rina Santoso"],
    });
  });

  // Exact equality is the strictest signal there is, so it beats the prefix
  // pass that would call this ambiguous. Without that precedence a customer
  // named "Budi" is unreachable on any day a "Budi Hartono" also has a row.
  it("prefers the exact name over a longer name it prefixes", () => {
    const two = [
      { customerId: "a", name: "Budi" },
      { customerId: "b", name: "Budi Hartono" },
    ];
    expect(matchCaption("budi", two)).toMatchObject({ ok: true, customerId: "a" });
  });

  it("stops at the first ambiguous pass instead of loosening", () => {
    const two = [
      { customerId: "a", name: "Andi Pratama" },
      { customerId: "b", name: "Andi Kusuma" },
    ];
    expect(matchCaption("andi", two)).toMatchObject({ ok: false, reason: "ambiguous" });
  });

  it("takes the exact name even when it prefixes another", () => {
    const two = [
      { customerId: "a", name: "Budi" },
      { customerId: "b", name: "Budi Hartono" },
    ];
    expect(matchCaption("Budi Hartono", two)).toMatchObject({
      ok: true,
      customerId: "b",
    });
  });

  it("counts one customer once, however many rows they have today", () => {
    const both = [
      { customerId: "c1", name: "Clairine Aurelia" },
      { customerId: "c1", name: "Clairine Aurelia" },
    ];
    expect(matchCaption("clairine", both)).toMatchObject({ ok: true, customerId: "c1" });
  });

  it("reports no match against today's list", () => {
    expect(matchCaption("Sinta", today)).toEqual({
      ok: false,
      reason: "none",
      candidates: today.map((c) => c.name),
    });
  });

  it("treats an empty or emoji-only caption as empty", () => {
    expect(matchCaption("", today)).toMatchObject({ ok: false, reason: "empty" });
    expect(matchCaption("   ", today)).toMatchObject({ ok: false, reason: "empty" });
    expect(matchCaption("🙏", today)).toMatchObject({ ok: false, reason: "empty" });
  });
});
