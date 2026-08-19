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
    expect(statedTransferAmount("Paket 10 porsi Rp 280.000 ya kak?")).toBeNull();
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
});
