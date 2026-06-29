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
      activeOrder: null,
    });

    expect(prompt).toContain("Only size S is available");
    expect(prompt).toContain("- 5 hari siang/malam saja: Rp 145.000");
    expect(prompt).toContain("- 72 hari siang + malam: Rp 3.600.000");
    expect(prompt).toContain("Only 5 days/week is currently available");
    expect(prompt).not.toContain("M (+Rp 2.000/porsi)");
    expect(prompt).not.toContain("Mau ukuran S");
  });

  test("does not allow invented prices for custom day counts", async () => {
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
      activeOrder: null,
    });

    expect(prompt).toContain("for example 15 hari siang only");
    expect(prompt).toContain("do not invent a price");
    expect(prompt).toContain("call ask_admin_for_help");
  });
});
