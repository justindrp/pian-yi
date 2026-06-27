import { NextRequest } from "next/server";
import { GET, POST, PATCH } from "@/app/api/deliveries/proofs/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sendDeliveryPhotoToCustomer } from "@/lib/claude/photo-matcher";
import { compressUploadedImage } from "@/lib/images/compress";

jest.mock("@/lib/supabase/server", () => ({ createClient: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/claude/photo-matcher", () => ({
  sendDeliveryPhotoToCustomer: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/images/compress", () => ({
  compressUploadedImage: jest.fn().mockResolvedValue({
    buffer: Buffer.from("compressed-jpeg"),
    contentType: "image/jpeg",
    extension: "jpg",
  }),
}));

// ---------------------------------------------------------------------------
// Helpers (same mock-chain pattern as test/api/manual-image.test.ts)
// ---------------------------------------------------------------------------

function makeChain(result: { data: unknown; error: unknown } = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "insert", "upsert", "update", "delete", "eq", "neq", "or", "not", "lt", "gt", "gte", "lte", "in", "limit", "order", "is"]) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain.single = jest.fn().mockResolvedValue(result);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
  // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
  chain.then = (resolve: (v: unknown) => unknown, _reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve);
  chain.catch = (reject: (e: unknown) => unknown) => Promise.resolve(result).catch(reject);
  return chain;
}

type Chain = ReturnType<typeof makeChain>;

function makeDbMock(config: Record<string, { data: unknown; error: unknown }> = {}) {
  const chains: Record<string, Chain> = {};
  const storageMock = {
    upload: jest.fn().mockResolvedValue({ error: null }),
    getPublicUrl: jest.fn().mockReturnValue({ data: { publicUrl: "https://supabase.test/public/delivery-proofs/manual/img.jpg" } }),
    createSignedUrl: jest.fn().mockResolvedValue({ data: { signedUrl: "https://supabase.test/signed/img.jpg" }, error: null }),
  };
  const from = jest.fn((table: string) => {
    if (!chains[table]) chains[table] = makeChain(config[table] ?? { data: null, error: null });
    return chains[table];
  });
  return { from, chains, storage: { from: jest.fn().mockReturnValue(storageMock) }, storageMock };
}

function makeFile(name = "photo.jpg", type = "image/jpeg"): File {
  return new File([Buffer.from("fake-image-bytes")], name, { type });
}

function makePostRequest(fields: Record<string, string | File | null>) {
  const formData = new Map(Object.entries(fields));
  const req = new NextRequest("http://localhost/api/deliveries/proofs", { method: "POST" });
  (req as unknown as { formData: () => Promise<unknown> }).formData = jest
    .fn()
    .mockResolvedValue({ get: (k: string) => formData.get(k) ?? null });
  return req;
}

function makePatchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/deliveries/proofs", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  (createClient as jest.Mock).mockResolvedValue({
    auth: {
      getUser: jest.fn().mockResolvedValue({ data: { user: { id: "u1", email: "admin@example.com" } } }),
    },
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/deliveries/proofs", () => {
  test("T1 — stamps received_at to the selected delivery date", async () => {
    const db = makeDbMock({ delivery_proofs: { data: { id: "proof-1" }, error: null } });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(makePostRequest({ customer_id: "cust-1", subcontractor_id: "sub-1", date: "2026-06-27", file: makeFile() }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(compressUploadedImage).toHaveBeenCalledWith(expect.any(Buffer));
    expect(db.storageMock.upload).toHaveBeenCalledWith(
      expect.stringMatching(/\.jpg$/),
      Buffer.from("compressed-jpeg"),
      { contentType: "image/jpeg", upsert: false },
    );
    // Proof must land on the admin's selected date, not always "today"
    expect(db.chains.delivery_proofs.insert).toHaveBeenCalledWith(
      expect.objectContaining({ received_at: "2026-06-27T12:00:00.000Z", status: "admin_uploaded" }),
    );
  });

  test("T2 — missing customer_id returns 400", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(makePostRequest({ customer_id: null, date: "2026-06-27", file: makeFile() }));
    expect(res.status).toBe(400);
    expect(db.storageMock.upload).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/deliveries/proofs", () => {
  test("T3 — send sets status manually_sent + matched_customer_id + sent_to_customer_at + sent_by", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await PATCH(makePatchRequest({ id: "proof-1", action: "send", customer_id: "cust-9" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(sendDeliveryPhotoToCustomer).toHaveBeenCalledWith("proof-1", "cust-9");
    expect(db.chains.delivery_proofs.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "manually_sent",
        matched_customer_id: "cust-9",
        sent_to_customer_at: expect.any(String),
        sent_by: "admin@example.com",
      }),
    );
  });

  test("T4 — unmatch sets status unmatched", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await PATCH(makePatchRequest({ id: "proof-1", action: "unmatch" }));
    expect(res.status).toBe(200);
    expect(db.chains.delivery_proofs.update).toHaveBeenCalledWith({ status: "unmatched" });
  });
});

describe("auth guard", () => {
  test("T5 — unauthenticated GET and POST return 401", async () => {
    (createClient as jest.Mock).mockResolvedValue({ auth: { getUser: jest.fn().mockResolvedValue({ data: { user: null } }) } });

    const getRes = await GET(new NextRequest("http://localhost/api/deliveries/proofs?date=2026-06-27"));
    expect(getRes.status).toBe(401);

    const postRes = await POST(makePostRequest({ customer_id: "cust-1", date: "2026-06-27", file: makeFile() }));
    expect(postRes.status).toBe(401);
  });
});
