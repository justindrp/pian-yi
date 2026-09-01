import {
  manualDraft,
  matchCaption,
  windowWarning,
} from "@/lib/deliveries/forwarded-proof";

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
      fuzzy: false,
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

  it("forgives a one-character typo and flags it as fuzzy", () => {
    expect(matchCaption("Clarine", today)).toEqual({
      ok: true,
      customerId: "c1",
      name: "Clairine Aurelia",
      fuzzy: true,
    });
  });

  it("forgives a typo in a full name", () => {
    expect(matchCaption("Veronika Catherine", today)).toMatchObject({
      ok: true,
      customerId: "c4",
      fuzzy: true,
    });
  });

  it("does not reach for a typo when the caption spells someone exactly", () => {
    expect(matchCaption("Fahmi", today)).toMatchObject({ fuzzy: false });
  });

  // Tolerance scales with length, so a short name still has to be right —
  // otherwise "ani", "andi" and "adi" all collapse into one another.
  it("holds short captions to an exact spelling", () => {
    const short = [
      { customerId: "a", name: "Ani" },
      { customerId: "b", name: "Adi" },
    ];
    expect(matchCaption("ani", short)).toMatchObject({ ok: true, customerId: "a" });
    expect(matchCaption("andi", short)).toMatchObject({ ok: false, reason: "ambiguous" });
  });

  it("takes the closer spelling when a typo is nearer one name than another", () => {
    const two = [
      { customerId: "a", name: "Clairine Aurelia" },
      { customerId: "b", name: "Claudia Wijaya" },
    ];
    expect(matchCaption("clarine", two)).toMatchObject({
      ok: true,
      customerId: "a",
      fuzzy: true,
    });
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

describe("windowWarning", () => {
  const base = {
    name: "Clairine Aurelia",
    phone: "+628126619952",
    manualNumber: "+6285128024390",
    mainNumber: "+6285111214390",
  };

  it("says nothing while the window is open", () => {
    expect(windowWarning({ ...base, hours: 3 })).toBe("");
    expect(windowWarning({ ...base, hours: 23.9 })).toBe("");
  });

  it("warns the moment the window has closed, naming both numbers", () => {
    const w = windowWarning({ ...base, hours: 26 });
    expect(w).toContain("sudah tutup");
    expect(w).toContain("26 jam lalu");
    expect(w).toContain("+6285128024390");
    expect(w).toContain("+628126619952");
  });

  it("counts in days once it is past two", () => {
    expect(windowWarning({ ...base, hours: 100 })).toContain("4 hari lalu");
  });

  it("handles a customer who has never messaged in", () => {
    expect(windowWarning({ ...base, hours: Number.POSITIVE_INFINITY })).toContain(
      "belum pernah chat",
    );
  });

  // The manual number forwards proofs too (migration 088), so the warning was
  // telling the handset in someone's hand to send from itself.
  it("says \"nomor ini\" when the forwarder is the manual number", () => {
    const w = windowWarning({
      ...base,
      hours: 26,
      forwarder: "+6285128024390",
    });
    expect(w).toContain("Kirim manual dari nomor ini ke +628126619952");
  });

  it("still names the manual number to any other forwarder", () => {
    const w = windowWarning({
      ...base,
      hours: 26,
      forwarder: "+6281213098656",
    });
    expect(w).toContain("Kirim manual dari +6285128024390");
  });

  it("carries the ready-to-paste draft once the window is closed", () => {
    const w = windowWarning({ ...base, hours: 26 });
    expect(w).toContain("Draft, tinggal copy:");
    expect(w).toContain(manualDraft({ ...base }));
  });
});

describe("manualDraft", () => {
  const draft = manualDraft({
    name: "Clairine Aurelia",
    mainNumber: "+6285111214390",
  });

  it("asks the customer to message the main number", () => {
    expect(draft).toContain("+6285111214390");
    expect(draft).toMatch(/chat ke/i);
  });

  it("quotes the words that route the turn to send_delivery_proof", () => {
    // A bare "halo" reopens the window and lands on the welcome path, where
    // the bot knows nothing about a waiting photo.
    expect(draft).toContain('"Boleh minta bukti pengiriman hari ini?"');
  });

  it("says why we are writing from a number they do not know", () => {
    expect(draft).toContain("WhatsApp Business API");
    expect(draft).toContain("24 jam");
  });

  it("greets with the first name only", () => {
    expect(draft).toContain("kak Clairine");
    expect(draft).not.toContain("Aurelia");
  });

  it("leaves out the machinery the customer cannot act on", () => {
    for (const word of ["template", "WABA", "131042", "restriction"]) {
      expect(draft.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});
