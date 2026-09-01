import { NextRequest } from "next/server";
import { POST } from "@/app/api/inbox/takeover/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole } from "@/lib/supabase/get-role";

jest.mock("@/lib/supabase/get-role", () => ({
  getSessionWithRole: jest.fn(),
  isOwner: (role: string) => role === "owner",
}));
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));

function makeChain(
  result: { data: unknown; error: unknown } = { data: null, error: null },
) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "select",
    "insert",
    "upsert",
    "update",
    "delete",
    "eq",
    "neq",
    "or",
    "not",
    "lt",
    "gt",
    "gte",
    "lte",
    "in",
    "limit",
    "order",
    "is",
  ];
  for (const method of methods) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  chain.single = jest.fn().mockResolvedValue(result);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
  // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
  chain.then = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function makeDbMock(
  config: Record<string, { data: unknown; error: unknown }> = {},
) {
  const chains: Record<string, ReturnType<typeof makeChain>> = {};
  const from = jest.fn((table: string) => {
    if (!chains[table]) {
      chains[table] = makeChain(config[table] ?? { data: null, error: null });
    }
    return chains[table];
  });
  return { from, chains };
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/inbox/takeover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function signedInAs(role: "owner" | "admin") {
  (getSessionWithRole as jest.Mock).mockResolvedValue({
    email: `${role}@example.com`,
    role,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  signedInAs("owner");
});

describe("POST /api/inbox/takeover", () => {
  test("clears pending bot response when taking over", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(
      postRequest({ customer_id: "cust-1", escalated: true }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(db.chains.customer_flags.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        customer_id: "cust-1",
        escalated_to_human: true,
        escalation_reason: "Manual takeover",
        last_human_activity_at: expect.any(String),
        hold_until: expect.any(String),
        pending_bot_response: false,
        pending_bot_question: null,
      }),
    );
  });

  // The menu is the whole of it: a hold long enough to be forgotten is the
  // state the auto-resume sweep exists to clear.
  test("rejects a hold duration that is not on the menu", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(
      postRequest({ customer_id: "cust-1", escalated: true, hold_minutes: 90 }),
    );

    expect(res.status).toBe(400);
    expect(db.from).not.toHaveBeenCalled();
  });

  test("rejects takeover by a non-owner", async () => {
    signedInAs("admin");
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(
      postRequest({ customer_id: "cust-1", escalated: true }),
    );

    expect(res.status).toBe(403);
    expect(db.from).not.toHaveBeenCalled();
  });

  // Handing a thread back to the bot is the safe direction and stays open to
  // every admin — the inbox draft flow calls it to clear a stale takeover.
  test("allows a non-owner to resume the bot", async () => {
    signedInAs("admin");
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(
      postRequest({ customer_id: "cust-1", escalated: false }),
    );

    expect(res.status).toBe(200);
    expect(db.chains.customer_flags.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        customer_id: "cust-1",
        escalated_to_human: false,
        escalation_reason: null,
        last_human_activity_at: null,
        hold_until: null,
      }),
    );
  });
});
