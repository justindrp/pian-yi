import { claimsInvoiceSent } from "@/app/api/webhook/whatsapp/route";

// Same shape as the menu-claim test: the pattern is pure, the mocks exist only
// so importing the route does not drag the webhook's dependencies in.
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/claude/client", () => ({
  getAnthropicClient: jest.fn(),
  SONNET_MODEL: "x",
  HAIKU_MODEL: "x",
  NO_THINKING: {},
}));
jest.mock("@/lib/whatsapp/client");
jest.mock("@/lib/push/send");

describe("claimsInvoiceSent", () => {
  it.each([
    "Baik kak, invoice-nya saya kirimkan ya",
    "Invoice sudah saya kirim ya kak, silakan dicek",
    "saya lampirkan invoice untuk pesanan kakak",
    "kwitansinya saya kirim ya kak",
    "Nota pembayarannya sudah dikirim kak",
  ])("treats %p as a claim", (reply) => {
    expect(claimsInvoiceSent(reply)).toBe(true);
  });

  it.each([
    // A promise about a later turn is still true when nothing goes out now.
    "Invoice-nya menyusul ya kak setelah pembayaran masuk",
    "nanti saya kirim invoice-nya ya kak",
    // Ordinary replies that mention nothing of the sort.
    "Baik kak, sudah saya terima bukti transfernya",
    "Totalnya Rp 174.000 untuk 6 porsi ya kak",
  ])("treats %p as no claim", (reply) => {
    expect(claimsInvoiceSent(reply)).toBe(false);
  });

  it("is not left stateful by the global flag on the deferral pattern", () => {
    const reply = "invoice-nya saya kirimkan ya kak";
    expect(claimsInvoiceSent(reply)).toBe(true);
    expect(claimsInvoiceSent(reply)).toBe(true);
  });
});
