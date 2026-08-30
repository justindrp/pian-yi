import { isAddressPlaceholder } from "@/lib/claude/extract-order";

describe("isAddressPlaceholder", () => {
  // Julian S's renewal, 2026-08-30. He was never asked for his address — the
  // bot is told not to ask a returning customer — so extraction returned its
  // own paraphrase of "alamat sama", and it replaced "Apartment Brooklyn
  // AlamSutera Unit A17F" on his record and printed on the kitchen sheet.
  it.each([
    "Alamat sama seperti sebelumnya (diantar ke atas)",
    "alamat sama",
    "Alamatnya masih sama kak",
    "Alamat tetap",
    "sama seperti sebelumnya",
    "Masih sama kayak kemarin",
    "Seperti biasa",
  ])("treats a back-reference as no address: %s", (text) => {
    expect(isAddressPlaceholder(text)).toBe(true);
  });

  it.each([
    "Apartment Brooklyn AlamSutera Unit A17F (titip dibagian drop off info aja kepetugasnya kalo makanan ini diantar keatas)",
    "The Brooklyn SOHO Tower B (East) 7th Fl. Unit O, Jl. Alam Sutera Boulevard",
    "Jl. Alam Sutera Boulevard No. 5, Tangsel",
    // The openers are only openers. A real address that starts with one of
    // these words is longer than a sentence pointing at the record.
    "Sama Residence Blok B No. 12, Jl. Raya Serpong, Tangerang Selatan",
  ])("keeps a real address: %s", (text) => {
    expect(isAddressPlaceholder(text)).toBe(false);
  });
});
