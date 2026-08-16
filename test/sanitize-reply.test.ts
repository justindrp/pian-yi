import { sanitizeReply } from "@/lib/claude/sanitize-reply";

describe("sanitizeReply", () => {
  it("strips quotes wrapping the whole reply", () => {
    expect(sanitizeReply('"Belum ada kak, menu terbit Jumat ya."')).toBe(
      "Belum ada kak, menu terbit Jumat ya.",
    );
    expect(sanitizeReply("“Baik kak, terima kasih ya”")).toBe(
      "Baik kak, terima kasih ya",
    );
  });

  it("keeps quotes that are part of the sentence", () => {
    const q = 'Kakak bisa balas "YA" untuk konfirmasi ya';
    expect(sanitizeReply(q)).toBe(q);
  });

  it("drops a paragraph repeated verbatim", () => {
    const p = "Menu minggu ini berlaku Senin 17 sampai Sabtu 22 Agustus 2026.";
    expect(sanitizeReply(`${p}\n\n${p}`)).toBe(p);
  });

  it("drops a repeat that differs only in punctuation", () => {
    const a = "Menu minggu ini berlaku Senin 17 sampai Sabtu 22 Agustus 2026.";
    const b = "Menu minggu ini berlaku Senin 17 sampai Sabtu 22 Agustus 2026!";
    expect(sanitizeReply(`${a}\n\n${b}`)).toBe(a);
  });

  it("keeps a short closing line that echoes the paragraph above", () => {
    // Order summaries thank the customer twice on purpose.
    const reply =
      "Terima kasih kak, pesanan sudah kami catat ya.\n\nTerima kasih!";
    expect(sanitizeReply(reply)).toBe(reply);
  });

  it("keeps two paragraphs that say different things", () => {
    const reply =
      "Belum ada kak, menu minggu depan terbit hari Jumat ya.\n\nKalau sudah keluar nanti saya kabari.";
    expect(sanitizeReply(reply)).toBe(reply);
  });

  it("unquotes a quoted first paragraph without touching the second", () => {
    expect(
      sanitizeReply('"Belum ada kak, terbit Jumat."\n\nNanti saya kabari ya.'),
    ).toBe("Belum ada kak, terbit Jumat.\n\nNanti saya kabari ya.");
  });
});

describe("sanitizeReply — leaked reasoning", () => {
  it("drops an English preamble glued to the Indonesian answer", () => {
    // Verbatim from the 2026-08-16 simulator run.
    const leaked = [
      'Hmm, "minggu depannya lagi" — this is ambiguous. It could be "the week after next."',
      "",
      "I should say plainly that the week Senin 24 – Sabtu 29 Agustus 2026 is not yet published.",
      "",
      'Let me respond in Indonesian, using "kak," no more than 200 words.Betul kak, untuk minggu Senin 24 – Sabtu 29 Agustus 2026 belum kami keluarkan ya.',
    ].join("\n");
    expect(sanitizeReply(leaked)).toBe(
      "Betul kak, untuk minggu Senin 24 – Sabtu 29 Agustus 2026 belum kami keluarkan ya.",
    );
  });

  it("leaves an all-English reply for the language guard to translate", () => {
    const english = "I will send the menu image for you to check.";
    expect(sanitizeReply(english)).toBe(english);
  });

  it("does not cut an Indonesian reply that opens with an English word", () => {
    const reply = "Oke kak, menu sudah saya kirim ya.";
    expect(sanitizeReply(reply)).toBe(reply);
  });
});
