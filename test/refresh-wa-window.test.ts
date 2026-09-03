import type { NextRequest } from "next/server";
import { GET } from "@/app/api/cron/refresh-wa-window/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTextMessage } from "@/lib/whatsapp/client";

jest.mock("@/lib/supabase/admin");
jest.mock("@/lib/whatsapp/client", () => ({
  sendTextMessage: jest.fn().mockResolvedValue("wamid.1"),
  sendTextTemplate: jest.fn().mockResolvedValue("wamid.2"),
  isOutsideWindowError: () => false,
}));

const HOUR = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();

/**
 * `conversations` answers with `inbound`, filtered the way PostgREST would;
 * `customers` answers with whatever ids the route asked for.
 */
function mockDb(inbound: { customer_id: string; created_at: string }[]) {
  const queried: string[] = [];
  const from = jest.fn((table: string) => {
    queried.push(table);
    let gte = "";
    let lte = "";
    let gt = "";
    let ids: string[] = [];
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.limit = () => chain;
    chain.gte = (_c: string, v: string) => {
      gte = v;
      return chain;
    };
    chain.lte = (_c: string, v: string) => {
      lte = v;
      return chain;
    };
    chain.gt = (_c: string, v: string) => {
      gt = v;
      return chain;
    };
    chain.in = (_c: string, v: string[]) => {
      ids = v;
      return chain;
    };
    // biome-ignore lint/suspicious/noThenProperty: mimics the PostgREST query builder
    chain.then = (resolve: (v: unknown) => unknown) => {
      if (table === "customers")
        return resolve({
          data: ids.map((id) => ({
            id,
            phone_number: `+62${id}`,
            name: id,
          })),
          error: null,
        });
      const rows = inbound.filter(
        (r) =>
          (!gte || r.created_at >= gte) &&
          (!lte || r.created_at <= lte) &&
          (!gt || r.created_at > gt),
      );
      return resolve({ data: rows, error: null });
    };
    return chain;
  });
  (createAdminClient as jest.Mock).mockReturnValue({ from });
  return queried;
}

function request(): NextRequest {
  return new Request("http://localhost/api/cron/refresh-wa-window", {
    headers: { "x-cron-secret": "s3cret" },
  }) as unknown as NextRequest;
}

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  jest.clearAllMocks();
});

describe("refresh-wa-window", () => {
  // The nudge used to be aimed off `customer_rate_limits.last_message_at`, a
  // counter that is not stamped on the first message of a customer's day.
  // Clairine Aurelia's read 2026-09-01 while she had written on the 2nd and the
  // 3rd, so she was never nudged and her window lapsed.
  it("reads the last inbound off conversations", async () => {
    const queried = mockDb([{ customer_id: "c1", created_at: ago(20) }]);
    const res = await GET(request());
    expect(await res.json()).toEqual({ ok: true, sent: 1 });
    expect(queried).toContain("conversations");
    expect(queried).not.toContain("customer_rate_limits");
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("skips a customer who has written since the band", async () => {
    mockDb([
      { customer_id: "c1", created_at: ago(20) },
      { customer_id: "c1", created_at: ago(2) },
    ]);
    const res = await GET(request());
    expect(await res.json()).toEqual({ ok: true, sent: 0 });
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("nudges a customer once however many times they wrote in the band", async () => {
    mockDb([
      { customer_id: "c1", created_at: ago(20) },
      { customer_id: "c1", created_at: ago(19) },
      { customer_id: "c1", created_at: ago(13) },
    ]);
    const res = await GET(request());
    expect(await res.json()).toEqual({ ok: true, sent: 1 });
  });

  it("leaves a window that is already shut to the manual number", async () => {
    mockDb([{ customer_id: "c1", created_at: ago(30) }]);
    const res = await GET(request());
    expect(await res.json()).toEqual({ ok: true, sent: 0 });
  });

  it("refuses an unauthenticated call", async () => {
    mockDb([]);
    const res = await GET(
      new Request("http://localhost/api/cron/refresh-wa-window", {
        headers: { "x-cron-secret": "wrong" },
      }) as unknown as NextRequest,
    );
    expect(res.status).toBe(401);
  });
});
