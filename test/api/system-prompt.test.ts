import { getActiveInstructions, getSetting } from "@/lib/cache/settings";
import { buildSystemPrompt } from "@/lib/claude/prompts/system";
import { jakartaDateString } from "@/lib/menu/week";
import { addDays } from "@/lib/time/jakarta";

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
      coverageNotes: [],
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
      coverageNotes: [],
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
  // "Area never blocks the order" was written for a cluster inside coverage the
  // bot did not recognise — Janice's "Pagedangan" was asked about four times
  // running. It had no floor, so an address in another kabupaten took the same
  // path: Sarah Sinaga gave Gunung Sindur, Kab. Bogor on 2026-08-30, the word
  // "Serpong" in her cluster name was enough, and she was quoted Rp 1.040.000
  // for 40 portions to an address no kitchen can reach.
  test("stops nearest-area rounding at the edge of coverage", async () => {
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
      coverageNotes: [],
      activeOrder: null,
      schedule: null,
    });
    expect(prompt).toContain("different kota or kabupaten");
    expect(prompt).toContain("do not call extract_order");
    // The old rule stays for the case it was written for.
    expect(prompt).toContain("Area never blocks the order");
    expect(prompt).toContain("check the address is reachable before you quote");
  });

  // The kabupaten rule above assumed the address arrives as words. Sarah
  // Sinaga's second one did not: told her home was out of coverage, she sent a
  // bare maps pin for her office. The model cannot open a link, so it filled
  // `area` with "BSD Baru", wrote the address as "Alamat kantor sesuai titik
  // Google Maps yang dikirim", quoted Rp 336.000 and sent the bank details —
  // for an office that is also outside coverage. The "a maps link counts as an
  // address given" rule is about not asking twice, never about coverage.
  test("does not let a maps link settle the area", async () => {
    const prompt = await buildSystemPrompt({
      casual: false,
      customerState: "new",
      customerName: null,
      customerNotes: null,
      detectedMapsLink: "https://maps.app.goo.gl/abc",
      menuShown: true,
      dapurOptions: [],
      dapurMenuTexts: [],
      menuWeek: { relation: "unknown" as const, weekStart: null },
      servedAreas: ["BSD Baru"],
      neighborhoods: {},
      coverageNotes: [],
      activeOrder: null,
      schedule: null,
    });
    expect(prompt).toContain(
      "A Google Maps link is not an address you can read",
    );
    expect(prompt).toContain("never let a link end the area question");
    expect(prompt).toContain(
      "do not quote a price or call extract_order until they answer",
    );
    // The bullet is worthless if it leaves the old "counts as given" wording
    // reading as permission to skip the area.
    expect(prompt).toContain("it never means the area is confirmed");
  });

  describe("a renewal whose quota is exhausted", () => {
    const renewing = {
      casual: false,
      customerState: "ordering" as const,
      customerName: "Julian S",
      customerNotes: null,
      detectedMapsLink: null,
      menuShown: true,
      dapurOptions: [],
      dapurMenuTexts: [],
      menuWeek: { relation: "unknown" as const, weekStart: null },
      servedAreas: ["BSD Baru"],
      neighborhoods: {},
      coverageNotes: [],
      activeOrder: {
        id: "o1",
        packageSize: 5,
        portionsPerDelivery: 1,
        pricePerPortion: 29000,
      },
      schedule: { unbooked: 0, remainingToday: 0, upcoming: [] },
    };

    // The branch gated the call ("only once they have told you the days") and
    // never fired it. Julian S renewed on 2026-08-30, gave dinner, Senin–Jumat
    // and a 31 August start, and was asked to confirm three more times before
    // the bot promised an order it never created — flagOrderAtRisk caught it as
    // an unkept promise. Everything a renewal needs is already on the record,
    // so the days arriving is the trigger, not another gate.
    test("makes the days the trigger, not one more gate", async () => {
      const prompt = await buildSystemPrompt(renewing as never);
      expect(prompt).toContain(
        "the turn they arrive is the turn that calls extract_order",
      );
      expect(prompt).toContain("sudah benar semua kan kak?");
      expect(prompt).toContain("saya buatkan ordernya sekarang ya kak");
    });

    test("says none of it while quota is left", async () => {
      const prompt = await buildSystemPrompt({
        ...renewing,
        schedule: { unbooked: 3, remainingToday: 3, upcoming: [] },
      } as never);
      expect(prompt).not.toContain(
        "the turn they arrive is the turn that calls extract_order",
      );
    });
  });

  // Veronica Catherine asked for seven days on 2026-08-30 holding 1 porsi she
  // had already paid for. The bot named the leftover in one message and still
  // sized the new package at the full 7 — her porsi sold to her twice, and 7 is
  // not a size we sell. The renewal block only fires once quota is exhausted, so
  // a customer with quota left but not enough of it had no rule at all.
  describe("a customer whose leftover quota is smaller than what they want", () => {
    const base = {
      casual: false,
      customerState: "ordering" as const,
      customerName: "Veronica Catherine",
      customerNotes: null,
      detectedMapsLink: null,
      menuShown: true,
      dapurOptions: [],
      dapurMenuTexts: [],
      menuWeek: { relation: "unknown" as const, weekStart: null },
      servedAreas: ["BSD Baru"],
      neighborhoods: {},
      coverageNotes: [],
      activeOrder: null,
    };

    test("nets the leftover off the new package first", async () => {
      const prompt = await buildSystemPrompt({
        ...base,
        schedule: { unbooked: 1, remainingToday: 1, upcoming: [] },
      } as never);

      expect(prompt).toContain(
        "Sisa itu dipakai dulu sebelum menjual paket baru",
      );
      expect(prompt).toContain("− 1 porsi sisa");
      expect(prompt).toContain("7 − 1 = paket 6 porsi");
    });

    // The renewal branch that carries "never promise an order you do not
    // create" fires only once quota hits 0, so her 1 leftover porsi switched it
    // off. She agreed to the 6-porsi package and confirmed her address; the bot
    // answered "Aku siapkan sekarang ya kak", then "Nanti detail transfernya
    // menyusul", and called nothing. Payment details are only ever sent by
    // extract_order, so the promise could not have been kept.
    test("makes the agreed size the trigger, and forbids the empty promise", async () => {
      const prompt = await buildSystemPrompt({
        ...base,
        schedule: { unbooked: 1, remainingToday: 1, upcoming: [] },
      } as never);

      expect(prompt).toContain("turn itu juga yang memanggil extract_order");
      expect(prompt).toContain("aku siapkan sekarang ya kak");
      expect(prompt).toContain("detail transfernya menyusul");
    });

    test("says nothing when there is no leftover to net off", async () => {
      const prompt = await buildSystemPrompt({
        ...base,
        schedule: { unbooked: 0, remainingToday: 0, upcoming: [] },
      } as never);

      expect(prompt).not.toContain(
        "Sisa itu dipakai dulu sebelum menjual paket baru",
      );
    });
  });

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
      coverageNotes: [],
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

  // Naya bought on 2026-08-24, ate the S box all week and learned M existed on
  // 2026-08-31 from an admin, not the bot: "gaada diinfo kak". The prompt knew
  // about M the whole time and was told to default to S without mentioning it.
  describe("size M is volunteered, not waited for", () => {
    const base = {
      casual: false,
      customerState: "ordering",
      customerName: null,
      customerNotes: null,
      detectedMapsLink: null,
      menuShown: true,
      dapurMenuTexts: [],
      menuWeek: { relation: "unknown" as const, weekStart: null },
      servedAreas: ["BSD Baru"],
      neighborhoods: {},
      coverageNotes: [],
      activeOrder: null,
      schedule: null,
    };

    test("a kitchen that cooks M makes the bot name both sizes on the first quote", async () => {
      (getSetting as jest.Mock).mockImplementation((key: string) =>
        Promise.resolve(key === "size_m_surcharge" ? "4000" : ""),
      );
      const prompt = await buildSystemPrompt({
        ...base,
        dapurOptions: [{ id: "1", nickname: "Dapur 1", offersM: true }],
      });

      expect(prompt).toContain("Name both sizes the first time you quote");
      expect(prompt).toContain("gaada diinfo kak");
    });

    test("a customer already eating S is told once, unprompted", async () => {
      (getSetting as jest.Mock).mockImplementation((key: string) =>
        Promise.resolve(key === "size_m_surcharge" ? "4000" : ""),
      );
      const prompt = await buildSystemPrompt({
        ...base,
        dapurOptions: [{ id: "1", nickname: "Dapur 1", offersM: true }],
        activeOrder: {
          id: "o1",
          packageSize: 20,
          portionsPerDelivery: 1,
          onSizeSWithMAvailable: true,
        },
      });

      expect(prompt).toContain("bought before anyone told them M existed");
      expect(prompt).toContain("call escalate_to_human");
    });

    test("a customer whose dapur is S only never hears the offer", async () => {
      (getSetting as jest.Mock).mockImplementation((key: string) =>
        Promise.resolve(key === "size_m_surcharge" ? "4000" : ""),
      );
      const prompt = await buildSystemPrompt({
        ...base,
        dapurOptions: [{ id: "1", nickname: "Dapur 1", offersM: true }],
        activeOrder: {
          id: "o1",
          packageSize: 20,
          portionsPerDelivery: 1,
          onSizeSWithMAvailable: false,
        },
      });

      expect(prompt).not.toContain("bought before anyone told them M existed");
    });

    test("says nothing about M when no active kitchen cooks it", async () => {
      const prompt = await buildSystemPrompt({
        ...base,
        dapurOptions: [{ id: "1", nickname: "Dapur 1", offersM: false }],
      });

      expect(prompt).toContain("Only size S is available");
      expect(prompt).not.toContain("Name both sizes the first time you quote");
    });
  });

  // The menu text keeps the S box and the M tambahan apart; Batch 51's card
  // (31 Agustus) did not, and Naya — eating S — read its five items as food
  // she had been shorted.
  describe("the M dish is named apart from the S box", () => {
    const base = {
      casual: false,
      customerState: "new" as const,
      customerName: null,
      customerNotes: null,
      detectedMapsLink: null,
      menuShown: true,
      dapurMenuTexts: [],
      menuWeek: { relation: "unknown" as const, weekStart: null },
      servedAreas: ["BSD Baru"],
      neighborhoods: {},
      coverageNotes: [],
      activeOrder: null,
      schedule: null,
    };

    test("a kitchen that cooks M carries the caveat", async () => {
      (getSetting as jest.Mock).mockImplementation((key: string) =>
        Promise.resolve(key === "size_m_surcharge" ? "4000" : ""),
      );
      const prompt = await buildSystemPrompt({
        ...base,
        dapurOptions: [{ id: "1", nickname: "Dapur 1", offersM: true }],
      });

      expect(prompt).toContain('The dish after "Tambahan size M:"');
      expect(prompt).toContain("Never fold the M dish into the S list");
    });

    test("an S-only kitchen carries no caveat and no empty bullet", async () => {
      const prompt = await buildSystemPrompt({
        ...base,
        dapurOptions: [{ id: "1", nickname: "Dapur 1", offersM: false }],
      });

      expect(prompt).not.toContain('The dish after "Tambahan size M:"');
      expect(prompt).not.toMatch(/^ {2}- *$/m);
    });
  });

  // A short run of days multiplies out to a total below the 5-porsi floor, and
  // the days-flexibility rule said nothing about totals: Rachel was quoted
  // "4 porsi x Rp 29.000 = Rp 116.000" on 2026-08-31 for a package that does
  // not exist, then told to ignore the Rp 145.000 the system had sent.
  describe("a run of days is not a licence to quote any total", () => {
    test("the days rule carries the portions floor with it", async () => {
      const prompt = await buildSystemPrompt({
        casual: false,
        customerState: "new",
        customerName: null,
        customerNotes: null,
        detectedMapsLink: null,
        menuShown: true,
        dapurOptions: [{ id: "1", nickname: "Dapur 1", offersM: false }],
        dapurMenuTexts: [],
        menuWeek: { relation: "unknown" as const, weekStart: null },
        servedAreas: ["BSD Baru"],
        neighborhoods: {},
        coverageNotes: [],
        activeOrder: null,
        schedule: null,
      });

      expect(prompt).toContain("The days are free; the total is not");
      expect(prompt).toContain("4 porsi × Rp 29.000 = Rp 116.000");
      expect(prompt).toContain(
        "Never tell a customer to ignore the amount the system sent",
      );
    });
  });

  // Three tools send images and each was added after a turn that claimed an
  // image without one: the menu (2026-08-26), the price list and the delivery
  // proof (both 2026-08-31). The prompt has to name all three, or the model
  // falls back to promising the picture in prose.
  describe("image tools", () => {
    test("names every tool that can send an image", async () => {
      const prompt = await buildSystemPrompt({
        customerState: "ordering",
        customerName: null,
        customerNotes: null,
        detectedMapsLink: null,
        menuShown: true,
        dapurOptions: [],
        dapurMenuTexts: [],
        menuWeek: { relation: "unknown" as const, weekStart: null },
        servedAreas: ["BSD Baru"],
        neighborhoods: {},
        coverageNotes: [],
        activeOrder: null,
        schedule: null,
        casual: false,
      });

      expect(prompt).toContain("send_price_list");
      expect(prompt).toContain("send_delivery_proof");
      expect(prompt).toContain(
        "Images go out only through send_menu_image, send_price_list and send_delivery_proof",
      );
    });
  });

  // The bot was handed the change rule and never the reading it needed to apply
  // it. "Sudah terjadwal" listed every upcoming date flat, so on 2026-09-01 at
  // 02.07 Winy asked for that day's lunch to go to Brooklyn Apartment instead
  // of her office and was told "Baik kak, dicatat ya" — nine hours after the
  // kitchen had taken the sheet with her office address on it, and with no tool
  // behind the confirmation. Same shape as the cutoff bug in jakarta.ts: the
  // lock is computed here, not left to the model.
  describe("locked dates on the customer schedule", () => {
    const withSchedule = (upcoming: { date: string; mealType: string; portions: number }[]) =>
      buildSystemPrompt({
        casual: false,
        customerState: "ordering" as const,
        customerName: "Winy",
        customerNotes: null,
        detectedMapsLink: null,
        menuShown: true,
        dapurOptions: [],
        dapurMenuTexts: [],
        menuWeek: { relation: "unknown" as const, weekStart: null },
        servedAreas: ["Alam Sutera"],
        neighborhoods: {},
        coverageNotes: [],
        activeOrder: {
          id: "o1",
          packageSize: 6,
          portionsPerDelivery: 1,
          pricePerPortion: 29000,
        },
        schedule: { unbooked: 0, remainingToday: 4, upcoming },
      } as never);

    test("marks today locked and leaves a later date open", async () => {
      const today = jakartaDateString();
      const later = addDays(today, 4);
      const prompt = await withSchedule([
        { date: today, mealType: "lunch", portions: 1 },
        { date: later, mealType: "lunch", portions: 1 },
      ]);

      const lines = prompt
        .split("\n")
        .filter((l) => l.startsWith("- ") && l.includes("(10.00-12.00), 1 porsi"));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("TERKUNCI");
      expect(lines[1]).not.toContain("TERKUNCI");
    });

    test("says a locked date cannot have its address changed either", async () => {
      const prompt = await withSchedule([
        { date: jakartaDateString(), mealType: "lunch", portions: 1 },
      ]);

      expect(prompt).toContain("tidak bisa diubah dengan cara apa pun");
      expect(prompt).toContain("tidak bisa diganti alamat kirimnya");
      expect(prompt).toContain('Jangan pernah menjawab "baik kak, dicatat"');
    });

    // An admin is the only thing that can move one day's address, and nothing
    // makes an admin look. "Admin sees the conversation and updates the record"
    // was the standing instruction for every schedule change.
    test("routes an unlocked change through ask_admin_for_help", async () => {
      const prompt = await withSchedule([]);

      expect(prompt).toContain(
        "call ask_admin_for_help with the date, the meal and what changes",
      );
      expect(prompt).toContain('"Admin sees the conversation" is not a mechanism');
      expect(prompt).not.toContain(
        "Confirm the change yourself in your reply — admin sees the conversation",
      );
      expect(prompt).toContain("you have no tool that can do it");
    });
  });
});
