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
      menuWeek: { relation: "unknown" as const, weekStart: null },
      servedAreas: ["BSD Baru"],
      neighborhoods: {},
      activeOrder: null,
      schedule: null,
    });

    expect(prompt).toContain("Only size S is available");
    expect(prompt).toContain("- 5 hari siang/malam saja: Rp 145.000");
    expect(prompt).toContain("- 72 hari siang + malam: Rp 3.600.000");
    expect(prompt).toContain("Dapur kami delivers Senin–Sabtu");
    // 5 and 6 days are the commonest weekly shapes, never the permitted set.
    // Phrased as an availability list, the model read it as a closed menu and
    // refused a 7-day run outright — see "5 and 6 days are the common weeks"
    // in docs/BOT_RULES.md. The ladder prices total portions, not days.
    expect(prompt).toContain("NOT the only ones we sell");
    expect(prompt).toContain(
      "Never tell a customer we only offer 5- or 6-day packages",
    );
    expect(prompt).not.toContain("Fixed weekly orders are available 5 days");
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
      menuWeek: { relation: "unknown" as const, weekStart: null },
      servedAreas: ["BSD Baru"],
      neighborhoods: {},
      activeOrder: null,
      schedule: null,
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

  // The turn that follows the welcome sequence: 153 of the first 223 welcomed
  // customers got one. Everything has just been sent and the rules forbid
  // repeating any of it, so without a job the model fills the hole — an ad
  // lead on 2026-08-27 got "Aku cek dulu bentar ya kak" and nothing after,
  // because no second turn is ever scheduled. See docs/BOT_RULES.md.
  describe("the turn right after the welcome sequence", () => {
    const base = {
      customerState: "new",
      customerName: null,
      customerNotes: null,
      detectedMapsLink: null,
      menuShown: true,
      dapurOptions: [],
      dapurMenuTexts: [],
      menuWeek: { relation: "unknown" as const, weekStart: null },
      servedAreas: ["BSD Baru"],
      neighborhoods: {},
      activeOrder: null,
      schedule: null,
    };

    test("gives that turn one question to ask", async () => {
      const prompt = await buildSystemPrompt({
        ...base,
        casual: false,
        justWelcomed: true,
      });

      expect(prompt).toContain("This is your first reply to this customer");
      expect(prompt).toContain("one question that moves the order forward");
      expect(prompt).toContain("Never stall");
      expect(prompt).toContain("Aku cek dulu");
    });

    // The stall is what casual mode produced, so the block is worthless if
    // casual mode is what drops it.
    test("applies in casual mode too", async () => {
      const prompt = await buildSystemPrompt({
        ...base,
        casual: true,
        justWelcomed: true,
      });

      expect(prompt).toContain("This is your first reply to this customer");
      expect(prompt).toContain("Casual changes the wording, never the job");
    });

    test("says nothing on every other turn", async () => {
      const prompt = await buildSystemPrompt({ ...base, casual: false });

      expect(prompt).not.toContain("This is your first reply to this customer");
    });
  });
});
