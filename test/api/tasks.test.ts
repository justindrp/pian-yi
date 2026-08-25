import { NextRequest } from "next/server";
import {
  DELETE as deleteTask,
  PATCH as patchTask,
} from "@/app/api/tasks/[id]/route";
import { GET as getTasks, POST as postTask } from "@/app/api/tasks/route";
import { STATUS_RANK, validateTaskInput } from "@/app/api/tasks/validate";
import { logEdit } from "@/lib/audit/log-edit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

jest.mock("@/lib/supabase/server", () => ({ createClient: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/audit/log-edit", () => ({ logEdit: jest.fn() }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Result = { data: unknown; error: unknown };

/**
 * A Supabase query builder stub. Every chainable method returns the chain, so
 * the route's own call order does not matter; `single` and awaiting the chain
 * both resolve to the configured result.
 */
function makeChain(result: Result = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  for (const m of [
    "select",
    "insert",
    "update",
    "delete",
    "eq",
    "order",
    "range",
    "limit",
  ]) {
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

/**
 * `results` is consumed one call to `.from("tasks")` at a time, so a route that
 * reads the row and then writes it can be given a different answer for each.
 */
function mockDb(...results: Result[]) {
  const chains = results.map((r) => makeChain(r));
  let call = 0;
  const from = jest.fn(() => chains[Math.min(call++, chains.length - 1)]);
  (createAdminClient as jest.Mock).mockReturnValue({ from });
  return { from, chains };
}

function signedIn(email = "justin@example.com") {
  (createClient as jest.Mock).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { email } } }) },
  });
}

function signedOut() {
  (createClient as jest.Mock).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: null } }) },
  });
}

function req(method: string, body?: unknown) {
  return new NextRequest("http://localhost/api/tasks", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined
      ? {}
      : {
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
  });
}

const ID = "e8610a7d-219f-4380-9d9d-cfceb468415f";
const params = { params: Promise.resolve({ id: ID }) };

async function json(res: Response) {
  return (await res.json()) as { ok: boolean; error?: string; data?: unknown };
}

beforeEach(() => {
  jest.clearAllMocks();
  signedIn();
});

// ---------------------------------------------------------------------------
// The validator, on its own. These are the inputs that were accepted or that
// reached Postgres as a 500 before validate.ts existed.
// ---------------------------------------------------------------------------

describe("validateTaskInput", () => {
  const create = (input: Record<string, unknown>) =>
    validateTaskInput(input, { titleRequired: true });
  const edit = (input: Record<string, unknown>) =>
    validateTaskInput(input, { titleRequired: false });

  it("accepts a minimal create", () => {
    expect(create({ title: "Ship it" })).toBeNull();
  });

  it("accepts every allowed field at once", () => {
    expect(
      create({
        title: "Cindi — second address missing",
        body: "src/lib/orders/pick-draw-order.ts:12",
        status: "blocked",
        priority: 1,
        area: "calendar",
        assignee: "annie@example.com",
        customer_id: ID,
        order_id: null,
        blocked_on: "Justin",
        due_date: "2026-09-01",
      }),
    ).toBeNull();
  });

  describe("title", () => {
    it("requires one on create", () => {
      expect(create({})).toBe("A task needs a title");
    });

    // The drawer's Save button sends whatever is in the field. A cleared title
    // used to reach Postgres and come back as a not-null violation 500.
    it("rejects a whitespace-only title", () => {
      expect(edit({ title: "   " })).toBe("A task needs a title");
    });

    it("rejects a non-string title", () => {
      expect(create({ title: 12345 })).toBe("A task needs a title");
    });

    // A 5000-character title was stored, broke the table layout, and pushed the
    // list payload to 476KB.
    it("rejects a title over 300 characters", () => {
      expect(create({ title: "x".repeat(301) })).toBe(
        "Title is longer than 300 characters",
      );
    });

    it("allows exactly 300", () => {
      expect(create({ title: "x".repeat(300) })).toBeNull();
    });

    it("does not ask for a title on a status-only edit", () => {
      expect(edit({ status: "done" })).toBeNull();
    });
  });

  describe("status", () => {
    // The quiet one: an unknown status is stored happily and the row then
    // appears in no filter chip on /tasks except "All".
    it("rejects a status outside the allowlist", () => {
      expect(edit({ status: "transcended" })).toBe(
        "Status must be one of open, in_progress, blocked, done",
      );
    });

    it.each(["open", "in_progress", "blocked", "done"])("accepts %s", (s) => {
      expect(edit({ status: s })).toBeNull();
    });

    it("rejects an empty status", () => {
      expect(edit({ status: "" })).toBe(
        "Status must be one of open, in_progress, blocked, done",
      );
    });
  });

  describe("priority", () => {
    it.each([999, -1, 0, 4])("rejects %s", (p) => {
      expect(edit({ priority: p })).toBe("Priority must be 1, 2 or 3");
    });

    it("rejects a fraction", () => {
      expect(edit({ priority: 1.5 })).toBe("Priority must be 1, 2 or 3");
    });

    // Sent as a string it used to be a raw pg 500 rather than a 400.
    it("rejects a numeric string", () => {
      expect(edit({ priority: "2" })).toBe("Priority must be 1, 2 or 3");
    });

    it.each([1, 2, 3])("accepts %s", (p) => {
      expect(edit({ priority: p })).toBeNull();
    });
  });

  describe("linked ids", () => {
    it("rejects a non-uuid customer_id", () => {
      expect(edit({ customer_id: "not-a-uuid" })).toBe(
        "customer_id must be a customer or order id",
      );
    });

    it("rejects a non-uuid order_id", () => {
      expect(edit({ order_id: "12345" })).toBe(
        "order_id must be a customer or order id",
      );
    });

    // Unlinking is how the drawer clears the link, so both must pass.
    it.each([null, ""])("accepts %p as unlinked", (v) => {
      expect(edit({ customer_id: v })).toBeNull();
    });
  });

  describe("due_date", () => {
    it("rejects prose", () => {
      expect(edit({ due_date: "besok" })).toBe("Due date must be YYYY-MM-DD");
    });

    it("rejects a non-ISO order", () => {
      expect(edit({ due_date: "01-09-2026" })).toBe(
        "Due date must be YYYY-MM-DD",
      );
    });

    it("accepts an ISO date and a cleared one", () => {
      expect(edit({ due_date: "2026-09-01" })).toBeNull();
      expect(edit({ due_date: null })).toBeNull();
    });
  });

  it("rejects non-text in the free-text fields", () => {
    expect(edit({ body: { note: "x" } })).toBe("body must be text");
    expect(edit({ area: 7 })).toBe("area must be text");
  });

  it("ignores fields it does not know", () => {
    expect(create({ title: "Ship it", sabotage: true })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

describe("GET /api/tasks", () => {
  it("401s when signed out", async () => {
    signedOut();
    expect((await getTasks()).status).toBe(401);
  });

  // Ordering on the status column sorts it alphabetically, which puts `done`
  // second — ahead of in_progress and open — and buries the live queue.
  it("puts open work first and done last", async () => {
    mockDb({
      data: [
        { id: "1", status: "done" },
        { id: "2", status: "open" },
        { id: "3", status: "blocked" },
        { id: "4", status: "in_progress" },
      ],
      error: null,
    });
    const body = await json(await getTasks());
    expect((body.data as { status: string }[]).map((t) => t.status)).toEqual([
      "blocked",
      "in_progress",
      "open",
      "done",
    ]);
  });

  it("sorts an unknown status to the very end rather than dropping it", async () => {
    mockDb({
      data: [
        { id: "1", status: "legacy" },
        { id: "2", status: "open" },
      ],
      error: null,
    });
    const body = await json(await getTasks());
    expect((body.data as { status: string }[]).map((t) => t.status)).toEqual([
      "open",
      "legacy",
    ]);
  });

  // PostgREST caps one response at 1000 rows and says nothing when it truncates.
  it("pages until a short page comes back", async () => {
    const page = (n: number, status: string) =>
      Array.from({ length: n }, (_, i) => ({ id: `${status}${i}`, status }));
    let call = 0;
    const chain = makeChain();
    // `range` is the last call in the builder, so it is what fetchAllRows
    // awaits: hand back a full page first and a short one second.
    (chain.range as jest.Mock).mockImplementation(() => {
      call += 1;
      return makeChain({
        data: call === 1 ? page(1000, "open") : page(3, "open"),
        error: null,
      });
    });
    (createAdminClient as jest.Mock).mockReturnValue({
      from: jest.fn(() => chain),
    });

    const body = await json(await getTasks());
    expect(call).toBe(2);
    expect((body.data as unknown[]).length).toBe(1003);
  });

  it("500s on a read error", async () => {
    mockDb({ data: null, error: { message: "connection reset" } });
    const res = await getTasks();
    expect(res.status).toBe(500);
    expect((await json(res)).error).toBe("connection reset");
  });
});

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

describe("POST /api/tasks", () => {
  it("401s when signed out", async () => {
    signedOut();
    expect((await postTask(req("POST", { title: "x" }))).status).toBe(401);
  });

  it("400s on a malformed body instead of throwing", async () => {
    const res = await postTask(req("POST", "{not json"));
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("Body is not valid JSON");
  });

  it("400s on a bad status without touching the database", async () => {
    const { from } = mockDb({ data: null, error: null });
    expect((await postTask(req("POST", { title: "x", status: "vibes" }))).status)
      .toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it("defaults status to open and priority to 2", async () => {
    const { chains } = mockDb({
      data: { id: ID, title: "x", status: "open", priority: 2 },
      error: null,
    });
    await postTask(req("POST", { title: "x" }));
    expect((chains[0].insert as jest.Mock).mock.calls[0][0]).toMatchObject({
      status: "open",
      priority: 2,
      done_at: null,
    });
  });

  it("stamps done_at when a task is created done", async () => {
    const { chains } = mockDb({
      data: { id: ID, title: "x", status: "done" },
      error: null,
    });
    await postTask(req("POST", { title: "x", status: "done" }));
    expect(
      (chains[0].insert as jest.Mock).mock.calls[0][0].done_at,
    ).not.toBeNull();
  });

  // Server-controlled fields (CLAUDE.md). A client that sends them is ignored,
  // not obeyed.
  it("never takes id, created_at or done_at from the client", async () => {
    const { chains } = mockDb({ data: { id: ID, title: "x" }, error: null });
    await postTask(
      req("POST", {
        title: "x",
        id: "11111111-1111-1111-1111-111111111111",
        created_at: "1999-01-01",
        updated_at: "1999-01-01",
        done_at: "1999-01-01",
      }),
    );
    const inserted = (chains[0].insert as jest.Mock).mock.calls[0][0];
    expect(inserted.id).toBeUndefined();
    expect(inserted.created_at).toBeUndefined();
    expect(inserted.updated_at).toBeUndefined();
    expect(inserted.done_at).toBeNull();
  });

  // A well-formed uuid that points at no row. The raw constraint sentence
  // helps nobody and reads as our bug rather than the caller's.
  it("turns an FK violation into a 400", async () => {
    mockDb({ data: null, error: { code: "23503", message: 'violates "tasks_customer_id_fkey"' } });
    const res = await postTask(
      req("POST", {
        title: "x",
        customer_id: "11111111-1111-1111-1111-111111111111",
      }),
    );
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe(
      "Linked customer or order does not exist",
    );
  });

  it("logs the create with the signed-in actor", async () => {
    mockDb({
      data: { id: ID, title: "x", status: "open", priority: 2 },
      error: null,
    });
    await postTask(req("POST", { title: "x" }));
    expect(logEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "justin@example.com",
        entityType: "tasks",
        entityId: ID,
        action: "create",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

describe("PATCH /api/tasks/[id]", () => {
  const existing = {
    id: ID,
    title: "Cindi — second address missing",
    status: "open",
    priority: 2,
    body: null,
    area: "calendar",
    assignee: null,
    customer_id: null,
    order_id: null,
    blocked_on: null,
    due_date: null,
    done_at: null,
  };

  it("401s when signed out", async () => {
    signedOut();
    expect(
      (await patchTask(req("PATCH", { status: "done" }), params)).status,
    ).toBe(401);
  });

  it("404s on an id that does not exist", async () => {
    mockDb({ data: null, error: { message: "no rows" } });
    expect((await patchTask(req("PATCH", { status: "done" }), params)).status)
      .toBe(404);
  });

  it("400s on a cleared title, which used to be a not-null 500", async () => {
    const res = await patchTask(req("PATCH", { title: "  " }), params);
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("A task needs a title");
  });

  it("stamps done_at on done and clears it on reopen", async () => {
    const done = mockDb({ data: existing, error: null }, { data: existing, error: null });
    await patchTask(req("PATCH", { status: "done" }), params);
    const update = (done.chains[1].update as jest.Mock).mock.calls[0][0];
    expect(update.status).toBe("done");
    expect(update.done_at).not.toBeNull();

    jest.clearAllMocks();
    signedIn();
    const reopen = mockDb(
      { data: { ...existing, status: "done", done_at: "2026-08-25" }, error: null },
      { data: existing, error: null },
    );
    await patchTask(req("PATCH", { status: "open" }), params);
    expect((reopen.chains[1].update as jest.Mock).mock.calls[0][0].done_at)
      .toBeNull();
  });

  // Mass assignment is the failure mode this guards (CLAUDE.md, "allowlist
  // field updates"). Only the ten editable columns may move.
  it("ignores fields outside the allowlist", async () => {
    const { chains } = mockDb(
      { data: existing, error: null },
      { data: existing, error: null },
    );
    await patchTask(
      req("PATCH", { area: "bot", created_at: "1999-01-01", id: "other" }),
      params,
    );
    const update = (chains[1].update as jest.Mock).mock.calls[0][0];
    expect(update.area).toBe("bot");
    expect(update.created_at).toBeUndefined();
    expect(update.id).toBeUndefined();
  });

  // edit_log is append-only and read as a history. An entry recording no change
  // is noise in it.
  it("writes nothing and logs nothing when no field differs", async () => {
    const { chains } = mockDb({ data: existing, error: null });
    const res = await patchTask(
      req("PATCH", { status: "open", area: "calendar" }),
      params,
    );
    expect(res.status).toBe(200);
    expect(chains[0].update).not.toHaveBeenCalled();
    expect(logEdit).not.toHaveBeenCalled();
  });

  it("logs from/to for each changed field", async () => {
    mockDb({ data: existing, error: null }, { data: existing, error: null });
    await patchTask(req("PATCH", { priority: 1 }), params);
    expect(logEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "update",
        changes: { priority: { from: 2, to: 1 } },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

describe("DELETE /api/tasks/[id]", () => {
  it("401s when signed out", async () => {
    signedOut();
    expect((await deleteTask(req("DELETE"), params)).status).toBe(401);
  });

  // It answered {"ok":true} and wrote an edit_log row with an empty changes
  // object, so a delete of nothing read exactly like a delete of something.
  it("404s on an id that never existed, and logs nothing", async () => {
    mockDb({ data: null, error: null });
    const res = await deleteTask(req("DELETE"), params);
    expect(res.status).toBe(404);
    expect(logEdit).not.toHaveBeenCalled();
  });

  // Tasks are hard-deleted, so the audit entry is the only remaining record.
  it("puts the whole prior row in the audit entry", async () => {
    const row = { id: ID, title: "Ship it", status: "open" };
    mockDb({ data: row, error: null }, { data: null, error: null });
    const res = await deleteTask(req("DELETE"), params);
    expect(res.status).toBe(200);
    expect(logEdit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "delete", changes: { deleted: row } }),
    );
  });
});

describe("STATUS_RANK", () => {
  it("keeps done behind every open state", () => {
    for (const s of ["blocked", "in_progress", "open"]) {
      expect(STATUS_RANK[s]).toBeLessThan(STATUS_RANK.done);
    }
  });
});
