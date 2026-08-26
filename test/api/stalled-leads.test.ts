import { NextRequest } from "next/server";
import { GET } from "@/app/api/cron/stalled-leads/route";
import { logEdit } from "@/lib/audit/log-edit";
import { getSetting } from "@/lib/cache/settings";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";

jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/push/send", () => ({ sendPushToAllAdmins: jest.fn() }));
jest.mock("@/lib/audit/log-edit", () => ({ logEdit: jest.fn() }));
jest.mock("@/lib/cache/settings", () => ({ getSetting: jest.fn() }));

const SECRET = "test-cron-secret";

type Row = Record<string, unknown>;

type Db = {
  orders?: Row[];
  customer_state?: Row[];
  customer_flags?: Row[];
  conversations?: Row[];
  customers?: Row[];
  /** Fail the first `.range()` walk of this table. */
  failTable?: string;
  /** Reject the upsert for these customer_ids, as a constraint violation would. */
  upsertFailsFor?: string[];
};

const upserted: Row[] = [];

/**
 * A chain that is awaited two different ways: `fetchAllRows` awaits the result
 * of `.range()`, while the flag lookup awaits the builder itself after `.in()`.
 * Both have to resolve, so every filter method returns a thenable chain.
 */
function makeDb(spec: Db) {
  const from = jest.fn((table: string) => {
    const rows = (spec[table as keyof Db] as Row[] | undefined) ?? [];
    const chain: Record<string, unknown> = {};

    for (const m of ["select", "eq", "not", "order", "in"]) {
      chain[m] = jest.fn().mockReturnValue(chain);
    }

    chain.range = jest.fn((start: number, end: number) => {
      if (spec.failTable === table) {
        return Promise.resolve({
          data: null,
          error: { message: `${table} exploded` },
        });
      }
      return Promise.resolve({ data: rows.slice(start, end + 1), error: null });
    });

    chain.upsert = jest.fn((row: Row) => {
      if (spec.upsertFailsFor?.includes(row.customer_id as string)) {
        return Promise.resolve({
          data: null,
          error: { message: "constraint violation" },
        });
      }
      upserted.push(row);
      return Promise.resolve({ data: null, error: null });
    });

    // Awaiting the builder directly (the customer_flags and customers lookups).
    // The thenable is the point: a real PostgREST builder resolves when awaited
    // without any terminal call, and the route relies on that.
    // biome-ignore lint/suspicious/noThenProperty: mocking PostgREST's thenable builder
    chain.then = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(res);

    return chain;
  });

  return { from };
}

function req(secret: string | null = SECRET) {
  return new NextRequest("http://localhost/api/cron/stalled-leads", {
    method: "GET",
    headers: secret === null ? {} : { "x-cron-secret": secret },
  });
}

const HOURS_AGO = (h: number) =>
  new Date(Date.now() - h * 3600 * 1000).toISOString();

beforeEach(() => {
  jest.clearAllMocks();
  upserted.length = 0;
  process.env.CRON_SECRET = SECRET;
  (getSetting as jest.Mock).mockResolvedValue("3");
});

describe("stalled-leads auth", () => {
  it("rejects a request with no secret", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(makeDb({}));
    const res = await GET(req(null));
    expect(res.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(makeDb({}));
    expect((await GET(req("nope"))).status).toBe(401);
  });
});

describe("stalled-leads selection", () => {
  it("flags a lead whose own message went unanswered past the cutoff", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDb({
        orders: [],
        customer_state: [{ customer_id: "julie" }],
        customer_flags: [
          {
            customer_id: "julie",
            needs_human_review: false,
            escalated_to_human: false,
          },
        ],
        conversations: [
          {
            customer_id: "julie",
            role: "assistant",
            content: "berapa porsi?",
            created_at: HOURS_AGO(331),
          },
          {
            customer_id: "julie",
            role: "user",
            content: "2 porsi makan siang+ 2 porsi makan malam",
            created_at: HOURS_AGO(330),
          },
        ],
        customers: [{ id: "julie", name: null, phone_number: "+628159000176" }],
      }),
    );

    const body = await (await GET(req())).json();
    expect(body).toEqual({ ok: true, flagged: 1 });
    expect(upserted[0].needs_human_review).toBe(true);
    expect(upserted[0].escalation_reason).toContain("330 jam");
    expect(upserted[0].escalation_reason).toContain("2 porsi makan siang");
    expect(logEdit).toHaveBeenCalledTimes(1);
    expect(sendPushToAllAdmins).toHaveBeenCalledTimes(1);
  });

  it("ignores a thread the bot answered last", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDb({
        orders: [],
        customer_state: [{ customer_id: "browsing" }],
        customer_flags: [],
        conversations: [
          {
            customer_id: "browsing",
            role: "user",
            content: "harga?",
            created_at: HOURS_AGO(100),
          },
          {
            customer_id: "browsing",
            role: "assistant",
            content: "Rp 29.000 kak",
            created_at: HOURS_AGO(99),
          },
        ],
        customers: [{ id: "browsing", name: null, phone_number: "+62800" }],
      }),
    );

    expect(await (await GET(req())).json()).toEqual({ ok: true, flagged: 0 });
    expect(sendPushToAllAdmins).not.toHaveBeenCalled();
  });

  it("leaves a customer message inside the cutoff alone", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDb({
        orders: [],
        customer_state: [{ customer_id: "fresh" }],
        customer_flags: [],
        conversations: [
          {
            customer_id: "fresh",
            role: "user",
            content: "halo",
            created_at: HOURS_AGO(1),
          },
        ],
        customers: [{ id: "fresh", name: null, phone_number: "+62801" }],
      }),
    );

    expect(await (await GET(req())).json()).toEqual({ ok: true, flagged: 0 });
  });

  it("never flags a customer who already has an order", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDb({
        orders: [{ customer_id: "paying" }],
        customer_state: [{ customer_id: "paying" }],
        customer_flags: [],
        conversations: [
          {
            customer_id: "paying",
            role: "user",
            content: "sudah transfer",
            created_at: HOURS_AGO(50),
          },
        ],
        customers: [{ id: "paying", name: "Budi", phone_number: "+62802" }],
      }),
    );

    expect(await (await GET(req())).json()).toEqual({ ok: true, flagged: 0 });
    expect(upserted).toHaveLength(0);
  });

  // The reason fetchAllRows exists. A single unpaginated select stops at 1000
  // rows without saying so, and every order past that would read as "no order" —
  // turning paying customers into leads and pushing their names to the admins.
  it("does not mistake the 1001st paying customer for a lead", async () => {
    const orders = Array.from({ length: 1400 }, (_, i) => ({
      customer_id: `c${i}`,
    }));
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDb({
        orders,
        customer_state: [{ customer_id: "c1200" }],
        customer_flags: [],
        conversations: [
          {
            customer_id: "c1200",
            role: "user",
            content: "?",
            created_at: HOURS_AGO(50),
          },
        ],
        customers: [{ id: "c1200", name: null, phone_number: "+62803" }],
      }),
    );

    expect(await (await GET(req())).json()).toEqual({ ok: true, flagged: 0 });
  });

  it("walks past 1000 conversation rows to find the real last message", async () => {
    const filler = Array.from({ length: 1200 }, (_, i) => ({
      customer_id: "chatty",
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${i}`,
      created_at: HOURS_AGO(400 - i * 0.1),
    }));
    // Last row is the customer's, and it sits well past the first page.
    filler.push({
      customer_id: "chatty",
      role: "user",
      content: "masih ditunggu ya kak",
      created_at: HOURS_AGO(20),
    });

    (createAdminClient as jest.Mock).mockReturnValue(
      makeDb({
        orders: [],
        customer_state: [{ customer_id: "chatty" }],
        customer_flags: [],
        conversations: filler,
        customers: [{ id: "chatty", name: null, phone_number: "+62804" }],
      }),
    );

    const body = await (await GET(req())).json();
    expect(body.flagged).toBe(1);
    expect(upserted[0].escalation_reason).toContain("masih ditunggu ya kak");
  });
});

describe("stalled-leads catches unkept bot promises", () => {
  it("flags a thread the bot ended by promising to check", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDb({
        orders: [],
        customer_state: [{ customer_id: "palem" }],
        customer_flags: [],
        conversations: [
          {
            customer_id: "palem",
            role: "user",
            content: "ini di daerah karawaci kak",
            created_at: HOURS_AGO(309),
          },
          {
            customer_id: "palem",
            role: "assistant",
            content:
              "Hmm aku cek dulu ya kak, aku pastikan sama admin. Sebentar ya kak",
            created_at: HOURS_AGO(308),
          },
        ],
        customers: [
          { id: "palem", name: null, phone_number: "+6281902067248" },
        ],
      }),
    );

    const body = await (await GET(req())).json();
    expect(body.flagged).toBe(1);
    expect(upserted[0].escalation_reason).toContain("Bot janji cek dulu");
    expect(upserted[0].escalation_reason).toContain("308 jam");
  });

  it("still ignores an ordinary bot-last thread with no promise in it", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDb({
        orders: [],
        customer_state: [{ customer_id: "quiet" }],
        customer_flags: [],
        conversations: [
          {
            customer_id: "quiet",
            role: "assistant",
            content: "Baik kak, kalau ada yang mau ditanya boleh banget 😊",
            created_at: HOURS_AGO(200),
          },
        ],
        customers: [{ id: "quiet", name: null, phone_number: "+62810" }],
      }),
    );

    expect(await (await GET(req())).json()).toEqual({ ok: true, flagged: 0 });
    expect(sendPushToAllAdmins).not.toHaveBeenCalled();
  });

  it("does not flag a promise that is still inside the cutoff", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDb({
        orders: [],
        customer_state: [{ customer_id: "recent" }],
        customer_flags: [],
        conversations: [
          {
            customer_id: "recent",
            role: "assistant",
            content: "saya cek dulu ya kak",
            created_at: HOURS_AGO(1),
          },
        ],
        customers: [{ id: "recent", name: null, phone_number: "+62811" }],
      }),
    );

    expect(await (await GET(req())).json()).toEqual({ ok: true, flagged: 0 });
  });

  it("does not treat a customer saying 'cek dulu' as a bot promise", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDb({
        orders: [],
        customer_state: [{ customer_id: "cust" }],
        customer_flags: [],
        conversations: [
          {
            customer_id: "cust",
            role: "user",
            content: "saya cek dulu ya kak, nanti kabari",
            created_at: HOURS_AGO(50),
          },
        ],
        customers: [{ id: "cust", name: null, phone_number: "+62812" }],
      }),
    );

    const body = await (await GET(req())).json();
    // Still flagged — but as a customer waiting, not as an unkept bot promise.
    expect(body.flagged).toBe(1);
    expect(upserted[0].escalation_reason).toContain("Lead menunggu balasan");
    expect(upserted[0].escalation_reason).not.toContain("Bot janji");
  });
});

describe("stalled-leads does not re-nag", () => {
  it("skips a lead already marked needs_human_review", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDb({
        orders: [],
        customer_state: [{ customer_id: "known" }],
        customer_flags: [
          {
            customer_id: "known",
            needs_human_review: true,
            escalated_to_human: false,
          },
        ],
        conversations: [
          {
            customer_id: "known",
            role: "user",
            content: "halo?",
            created_at: HOURS_AGO(80),
          },
        ],
        customers: [{ id: "known", name: null, phone_number: "+62805" }],
      }),
    );

    expect(await (await GET(req())).json()).toEqual({ ok: true, flagged: 0 });
    expect(sendPushToAllAdmins).not.toHaveBeenCalled();
  });

  it("skips a lead a human has already taken over", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDb({
        orders: [],
        customer_state: [{ customer_id: "taken" }],
        customer_flags: [
          {
            customer_id: "taken",
            needs_human_review: false,
            escalated_to_human: true,
          },
        ],
        conversations: [
          {
            customer_id: "taken",
            role: "user",
            content: "halo?",
            created_at: HOURS_AGO(80),
          },
        ],
        customers: [{ id: "taken", name: null, phone_number: "+62806" }],
      }),
    );

    expect(await (await GET(req())).json()).toEqual({ ok: true, flagged: 0 });
  });
});

describe("stalled-leads failure handling", () => {
  it("500s rather than flagging everyone when the orders walk fails", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDb({
        failTable: "orders",
        customer_state: [{ customer_id: "julie" }],
        conversations: [
          {
            customer_id: "julie",
            role: "user",
            content: "?",
            created_at: HOURS_AGO(80),
          },
        ],
      }),
    );

    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(upserted).toHaveLength(0);
    expect(sendPushToAllAdmins).not.toHaveBeenCalled();
  });

  it("keeps going when one upsert fails", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDb({
        orders: [],
        upsertFailsFor: ["bad"],
        customer_state: [{ customer_id: "bad" }, { customer_id: "good" }],
        customer_flags: [],
        conversations: [
          {
            customer_id: "bad",
            role: "user",
            content: "a",
            created_at: HOURS_AGO(90),
          },
          {
            customer_id: "good",
            role: "user",
            content: "b",
            created_at: HOURS_AGO(80),
          },
        ],
        customers: [
          { id: "bad", name: null, phone_number: "+62807" },
          { id: "good", name: null, phone_number: "+62808" },
        ],
      }),
    );

    const body = await (await GET(req())).json();
    expect(body.flagged).toBe(1);
    expect(upserted.map((u) => u.customer_id)).toEqual(["good"]);
    expect(logEdit).toHaveBeenCalledTimes(1);
  });

  it("survives conversation rows with no customer_id, timestamp or content", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDb({
        orders: [],
        customer_state: [{ customer_id: "ragged" }],
        customer_flags: [],
        conversations: [
          {
            customer_id: null,
            role: "user",
            content: "orphan",
            created_at: HOURS_AGO(10),
          },
          {
            customer_id: "ragged",
            role: "user",
            content: "nyata",
            created_at: HOURS_AGO(90),
          },
          {
            customer_id: "ragged",
            role: "user",
            content: null,
            created_at: null,
          },
        ],
        customers: [{ id: "ragged", name: null, phone_number: "+62809" }],
      }),
    );

    const body = await (await GET(req())).json();
    expect(body.flagged).toBe(1);
    // The null-timestamp row must not become "the last message".
    expect(upserted[0].escalation_reason).toContain("nyata");
  });

  it("sends one aggregate push, not one per lead", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDb({
        orders: [],
        customer_state: [
          { customer_id: "a" },
          { customer_id: "b" },
          { customer_id: "c" },
        ],
        customer_flags: [],
        conversations: ["a", "b", "c"].map((id) => ({
          customer_id: id,
          role: "user",
          content: `pesan ${id}`,
          created_at: HOURS_AGO(40),
        })),
        customers: ["a", "b", "c"].map((id) => ({
          id,
          name: null,
          phone_number: `+6281${id}`,
        })),
      }),
    );

    const body = await (await GET(req())).json();
    expect(body.flagged).toBe(3);
    expect(sendPushToAllAdmins).toHaveBeenCalledTimes(1);
    expect((sendPushToAllAdmins as jest.Mock).mock.calls[0][0]).toBe(
      "3 lead belum dibalas",
    );
  });

  it("does not touch the database when nobody is in the ordering state", async () => {
    (createAdminClient as jest.Mock).mockReturnValue(
      makeDb({ orders: [], customer_state: [] }),
    );
    expect(await (await GET(req())).json()).toEqual({ ok: true, flagged: 0 });
    expect(sendPushToAllAdmins).not.toHaveBeenCalled();
  });
});
