import { getActiveInstructions, getSetting } from "@/lib/cache/settings";
import { buildSystemPrompt } from "@/lib/claude/prompts/system";

jest.mock("@/lib/cache/settings", () => ({
  getActiveInstructions: jest.fn(),
  getSetting: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  (getActiveInstructions as jest.Mock).mockResolvedValue([]);
  (getSetting as jest.Mock).mockImplementation((key: string) => {
    const values: Record<string, string> = {
      business_name: "Pian Yi Catering",
      bank_name: "BCA",
      bank_account_number: "123",
      bank_account_name: "Pian Yi",
      escalation_keywords: "[]",
      order_deadline_hour: "20",
      order_deadline_daily_hour: "20",
    };
    return Promise.resolve(values[key] ?? "");
  });
});

describe("customer chatbot system prompt", () => {
  test("uses new S-only personal package price list", async () => {
    const prompt = await buildSystemPrompt({
      casual: false,
      customerState: "new",
      customerName: null,
      customerNotes: null,
      detectedMapsLink: null,
      menuShown: true,
      dapurOptions: [],
      dapurMenuTexts: [],
      servedAreas: ["BSD Baru"],
      neighborhoods: {},
      activeOrder: null,
    });

    expect(prompt).toContain("Only size S is available");
    expect(prompt).toContain("- 5 hari siang/malam saja: Rp 145.000");
    expect(prompt).toContain("- 72 hari siang + malam: Rp 3.600.000");
    expect(prompt).toContain(
      "Fixed weekly orders are available 5 days (Senin–Jumat) or 6 days (Senin–Sabtu)",
    );
    expect(prompt).not.toContain("M (+Rp 2.000/porsi)");
    expect(prompt).not.toContain("Mau ukuran S");
  });

  test("prices off-list totals at the tier below, not as repeated packages", async () => {
    const prompt = await buildSystemPrompt({
      casual: false,
      customerState: "new",
      customerName: null,
      customerNotes: null,
      detectedMapsLink: null,
      menuShown: true,
      dapurOptions: [],
      dapurMenuTexts: [],
      servedAreas: ["BSD Baru"],
      neighborhoods: {},
      activeOrder: null,
    });

    expect(prompt).toContain("is a multiple of 5 or of 6");
    expect(prompt).toContain(
      "15 porsi → largest listed size below 15 is 12 → Rp 28.000/porsi → 15 × Rp 28.000 = *Rp 420.000*",
    );
    expect(prompt).toContain(
      "25 porsi → largest listed size below 25 is 24 → Rp 27.000/porsi → 25 × Rp 27.000 = *Rp 675.000*",
    );
    expect(prompt).toContain(
      "Never build the price out of repeated smaller packages",
    );
    expect(prompt).toContain(
      "neither on the list nor a multiple of 5 or of 6: reject it",
    );
    // The block-pricing rule this replaced must not come back — it charged the
    // small-package rate on large orders, so 25 porsi cost more than 24.
    expect(prompt).not.toContain("Rp 435.000");
  });
});
