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

  it("drops deliberation that follows the answer, and the restatement after it", () => {
    // Verbatim from what Febby was sent on 2026-09-02. The leak came after the
    // answer, not before it, so slicing from the first answer kept all of it.
    const leaked = [
      "Baik kak, selamat menikmati ya 😊 sampai besok ya 🍱",
      "",
      'Wait, let me review carefully. The user said "ok ok". The previous assistant message was about a delivery arriving.',
      "",
      "Also note there's no size M message needed since menu already mentioned. Keep it short.",
      "",
      "Selamat menikmati kak 🍱 sampai besok ya!",
    ].join("\n");
    expect(sanitizeReply(leaked)).toBe(
      "Baik kak, selamat menikmati ya 😊 sampai besok ya 🍱",
    );
  });

  // 2026-09-03: an address on the excluded list. Every paragraph was the model
  // reasoning at itself, and quoting one Indonesian phrase out of the prompt
  // was enough for `looksEnglish` to call the whole thing Indonesian, so the
  // language guard passed it through and the customer got it verbatim.
  it("returns nothing when the whole reply is deliberation", () => {
    const leaked = [
      'I need to check the address first. Synergy Building is explicitly on the "Kami tidak mengantar ke" list — it sits inside Alam Sutera but is still not deliverable, and no area matching overrides this.',
      "",
      "This means I must not quote a price, must not call extract_order, and must call escalate_to_human.",
      "",
      "Let me record her name too before escalating.",
    ].join("\n");
    expect(sanitizeReply(leaked)).toBe("");
  });

  // A plain English answer is not a leak — the language guard translates it,
  // and cutting it here would leave the customer with silence instead.
  it("keeps an English reply that is an answer, not deliberation", () => {
    const english = "Yes, we can deliver on Monday. The total is Rp 336.000.";
    expect(sanitizeReply(english)).toBe(english);
  });

  it("keeps a multi-paragraph Indonesian reply whole", () => {
    const reply = [
      "Bisa banget kak, masih sempat kok karena sekarang masih sebelum jam 16.00.",
      "",
      "Pengiriman Jumat 4 September tetap jalan seperti biasa ya.",
    ].join("\n");
    expect(sanitizeReply(reply)).toBe(reply);
  });
});

describe("sanitizeReply — retracted false start", () => {
  it("drops everything the model corrects itself on", () => {
    // Verbatim from the 2026-08-16 pricing run, asked for 13 porsi.
    const leaked =
      "Maaf kak, untuk paket 13 porsi belum tersedia. Kami punya paket 12 porsi (Rp 336.000) atau 14...\nSebentar, izinkan saya cek lagi. Paket yang tersedia: 12 porsi (Rp 336.000) atau 15 porsi (Rp 420.000) kak.";
    expect(sanitizeReply(leaked)).toBe(
      "Paket yang tersedia: 12 porsi (Rp 336.000) atau 15 porsi (Rp 420.000) kak.",
    );
  });

  it("keeps a genuine 'give me a moment' reply", () => {
    const reply = "Sebentar ya kak, saya cek dulu ke dapur.";
    expect(sanitizeReply(reply)).toBe(reply);
  });

  it("keeps a retraction with no answer after it", () => {
    // Nothing to promote, so cutting would leave the customer with nothing.
    const reply = "Harga 15 porsi Rp 420.000 kak. Maaf salah.";
    expect(sanitizeReply(reply)).toBe(reply);
  });
});

describe("sanitizeReply — WhatsApp formatting", () => {
  it("rewrites markdown bold as WhatsApp bold", () => {
    expect(sanitizeReply("Totalnya **Rp 1.300.000** kak")).toBe(
      "Totalnya *Rp 1.300.000* kak",
    );
  });

  it("leaves WhatsApp bold alone", () => {
    const reply = "Totalnya *Rp 420.000* kak";
    expect(sanitizeReply(reply)).toBe(reply);
  });
});

describe("sanitizeReply — image stage directions", () => {
  // ****7277 on 2026-08-26 read these brackets in WhatsApp, twice in four
  // minutes, with no image behind either.
  it("drops a stage-direction paragraph and keeps the rest", () => {
    const out = sanitizeReply(
      "Tentu kak, boleh banget liat-lihat dulu. Berikut menu gambar untuk minggu ini (Senin 24 – Sabtu 29 Agustus 2026) saya kirimkan ya.\n\n[gambar menu terkirim]\n\nSilakan dipertimbangkan dulu 🙏",
    );
    expect(out).not.toContain("[");
    expect(out).toContain("Tentu kak");
    expect(out).toContain("Silakan dipertimbangkan dulu");
    // No blank crater where the paragraph was.
    expect(out).not.toMatch(/\n{3,}/);
  });

  it("drops the second shape too", () => {
    const out = sanitizeReply(
      "Oh iya kak, maaf. Saya kirimkan lagi menu minggu ini sekarang ya.\n\n[gambar menu terkirim]",
    );
    expect(out).toBe(
      "Oh iya kak, maaf. Saya kirimkan lagi menu minggu ini sekarang ya.",
    );
  });

  it("cuts an inline stage direction without eating the sentence", () => {
    expect(sanitizeReply("Ini menunya kak [gambar terkirim] ya.")).toBe(
      "Ini menunya kak ya.",
    );
  });

  it("leaves the webhook's own bracketed labels alone", () => {
    // Written by the webhook into conversations, not by the model, and they
    // describe the customer's message rather than a fake attachment.
    const label = "[Bukti pembayaran dikirim]";
    expect(sanitizeReply(label)).toBe(label);
  });

  it("leaves ordinary brackets alone", () => {
    const t = "Paket 20 porsi (Rp 520.000) ya kak.";
    expect(sanitizeReply(t)).toBe(t);
  });
});

describe("sanitizeReply — bracketed asides meant for us", () => {
  it("drops a [Warning: ...] block the model wrote to itself", () => {
    const reply =
      "Boleh kakak, aku cek dulu ya bukti pengantarannya buat dipastikan.\n\n" +
      "[Warning: bagian ini aku tulis ulang tanpa klaim data pelanggan, karena memang belum aku lihat catatannya — kalau mau aku diverifikasi dulu, aku tanya langsung ya]\n\n" +
      "Kak, soal status pengantaran hari ini aku mau pastikan dulu ya.";
    expect(sanitizeReply(reply)).toBe(
      "Boleh kakak, aku cek dulu ya bukti pengantarannya buat dipastikan.\n\n" +
        "Kak, soal status pengantaran hari ini aku mau pastikan dulu ya.",
    );
  });

  it("cuts an inline meta bracket without eating the sentence", () => {
    expect(
      sanitizeReply("Pengiriman malam ini jam 16.00-18.00 [Note: belum diverifikasi] ya kak."),
    ).toBe("Pengiriman malam ini jam 16.00-18.00 ya kak.");
  });

  it("leaves the webhook's own bracketed labels alone", () => {
    const label = "[Bukti pembayaran dikirim]";
    expect(sanitizeReply(label)).toBe(label);
  });
});
