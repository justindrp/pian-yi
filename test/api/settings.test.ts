import { NextRequest } from "next/server";
import { PATCH as patchSettings } from "@/app/api/settings/route";
import { PATCH as patchTemplates } from "@/app/api/settings/templates/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

jest.mock("@/lib/supabase/server", () => ({ createClient: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/cache/settings", () => ({ invalidateCache: jest.fn() }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain.single = jest.fn().mockResolvedValue(result);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
  // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
  chain.then = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  chain.catch = (reject: (e: unknown) => unknown) =>
    Promise.resolve(result).catch(reject);
  return chain;
}

type Chain = ReturnType<typeof makeChain>;

function makeDbMock(
  config: Record<string, { data: unknown; error: unknown }> = {},
) {
  const chains: Record<string, Chain> = {};
  const from = jest.fn((table: string) => {
    if (!chains[table])
      chains[table] = makeChain(config[table] ?? { data: null, error: null });
    return chains[table];
  });
  return { from, chains };
}

function patchRequest(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();

  (createClient as jest.Mock).mockResolvedValue({
    auth: {
      getUser: jest.fn().mockResolvedValue({
        data: { user: { id: "u1", email: "admin@example.com" } },
      }),
    },
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PATCH /api/settings", () => {
  test("T1 — upserts welcome_message into settings table", async () => {
    const db = makeDbMock({
      settings: { data: null, error: null },
      edit_log: { data: null, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await patchSettings(
      patchRequest("/api/settings", {
        updates: { welcome_message: "Halo kak!" },
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(db.chains.settings.upsert).toHaveBeenCalledWith(
      { key: "welcome_message", value: "Halo kak!" },
      { onConflict: "key" },
    );
  });
});

describe("PATCH /api/settings/templates", () => {
  test("T2 — updates chatbot_unavailable template", async () => {
    const db = makeDbMock({
      message_templates: { data: null, error: null },
      edit_log: { data: null, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await patchTemplates(
      patchRequest("/api/settings/templates", {
        key: "chatbot_unavailable",
        template: "Maaf bot offline",
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(db.chains.message_templates.update).toHaveBeenCalledWith({
      template: "Maaf bot offline",
    });
    expect(db.chains.message_templates.eq).toHaveBeenCalledWith(
      "key",
      "chatbot_unavailable",
    );
  });
});
