import {
  statedBareTotal,
  statedTransferAmount,
  statedWeeks,
} from "@/lib/claude/extract-order";

jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/whatsapp/client", () => ({
  sendWhatsAppMessage: jest.fn(),
}));

describe("statedTransferAmount", () => {
  it("reads the amount off a BCA transfer receipt", () => {
    expect(
      statedTransferAmount(
        "m-Transfer:\nBERHASIL\n04/08/2026 20:02:41\nKe 4971805760\nDANIEL RAHARDYAN PRAMADY\nRp 540.000,00\nKurniadi Tan Pian Yi Catering",
      ),
    ).toBe(540000);
  });

  it("ignores a price quoted outside a receipt", () => {
    expect(
      statedTransferAmount("Paket 10 porsi Rp 280.000 ya kak?"),
    ).toBeNull();
  });

  it("returns null when a receipt states two different amounts", () => {
    expect(
      statedTransferAmount("Transfer Rp 540.000 dan Rp 280.000"),
    ).toBeNull();
  });
});

describe("statedWeeks", () => {
  it("reads a duration in weeks", () => {
    expect(statedWeeks("Iya mau 2 minggu dl aja.. 1 porsi")).toBe(2);
  });

  it("returns null when no duration is stated", () => {
    expect(statedWeeks("mau pesan 10 porsi kak")).toBeNull();
  });
});

describe("statedBareTotal", () => {
  it("still reads a bare total", () => {
    expect(statedBareTotal("Boleh 6 porsi dulu kak")).toBe(6);
  });

  it("does not read across a line break", () => {
    // PT Bintang's filled order form: the maps link ends in a digit and the
    // next line starts with the "Porsi:" label. Read as one string this used
    // to yield 6, and amended their 110-porsi order down to 6.
    const form = [
      "Link Google Maps (sesuai titik): https://maps.app.goo.gl/mBzv9vRiN9WhZA3f6",
      "Porsi: 22 box",
      "Lunch/Dinner/Keduanya : Lunch",
    ].join("\n");
    expect(statedBareTotal(form)).toBeNull();
  });

  it("ignores 'Porsi:' used as a form label", () => {
    expect(statedBareTotal("10 Porsi: 22 box")).toBeNull();
  });

  it("ignores a number glued to a word", () => {
    expect(statedBareTotal("goo.gl/abc6 porsi")).toBeNull();
  });

  it("still reads a total stated on its own line", () => {
    expect(statedBareTotal("Halo kak\nTotal 20 porsi ya")).toBe(20);
  });

  it("still ignores a per-delivery figure", () => {
    expect(statedBareTotal("1 porsi per pengiriman")).toBeNull();
  });
});

describe("DATE_LIST gate", () => {
  // Mirrors the regex in extract-order.ts; the module itself pulls in the
  // Supabase client, so the gate is asserted on its own shape.
  const DATE_LIST =
    /(?<![\d.,])\d{1,2}\s*(jan|feb|mar|apr|mei|jun|jul|agu|sep|okt|nov|des)|(?<![\d.,])\d{1,2}\s*[,/-]\s*\d{1,2}\s*[,/-]\s*\d{1,2}/i;

  it("matches a day with a month name", () => {
    expect(DATE_LIST.test("mulai 11 Agustus ya kak")).toBe(true);
  });

  it("matches a bare list of three days", () => {
    expect(DATE_LIST.test("tanggal 11, 12, 13")).toBe(true);
  });

  it("ignores an ordinary sentence with one number", () => {
    expect(DATE_LIST.test("5 porsi dulu kak")).toBe(false);
  });

  it("ignores a rupiah figure", () => {
    expect(DATE_LIST.test("sudah transfer Rp 170.000")).toBe(false);
  });
});
