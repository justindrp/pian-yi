import { NextRequest } from "next/server";
import { POST } from "@/app/api/inbox/manual-image/route";
import { compressUploadedImage } from "@/lib/images/compress";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sendImageMessageById, uploadMediaToMeta } from "@/lib/whatsapp/client";

jest.mock("@/lib/supabase/server", () => ({ createClient: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/images/compress", () => ({
  compressUploadedImage: jest.fn().mockResolvedValue({
    buffer: Buffer.from("compressed-jpeg"),
    contentType: "image/jpeg",
    extension: "jpg",
  }),
}));
jest.mock("@/lib/whatsapp/client", () => ({
  uploadMediaToMeta: jest.fn().mockResolvedValue("meta-media-id-123"),
  sendImageMessageById: jest.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChain(result: { data: unknown; error: unknown } = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "select", "insert", "upsert", "update", "delete",
    "eq", "neq", "or", "not", "lt", "gt", "gte", "lte", "in",
    "limit", "order", "is",
  ];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain.single = jest.fn().mockResolvedValue(result);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
  // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  chain.catch = (reject: (e: unknown) => unknown) =>
    Promise.resolve(result).catch(reject);
  return chain;
}

type Chain = ReturnType<typeof makeChain>;

function makeDbMock(config: Record<string, { data: unknown; error: unknown }> = {}) {
  const chains: Record<string, Chain> = {};
  const storageMock = {
    upload: jest.fn().mockResolvedValue({ error: null }),
    getPublicUrl: jest.fn().mockReturnValue({ data: { publicUrl: "https://supabase.test/public/menu-images/inbox/cust-1/img.jpg" } }),
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

function makeRequest(fields: Record<string, string | File | null>) {
  const formData = new Map(Object.entries(fields));
  const req = new NextRequest("http://localhost/api/inbox/manual-image", { method: "POST" });
  (req as unknown as { formData: () => Promise<unknown> }).formData = jest
    .fn()
    .mockResolvedValue({ get: (k: string) => formData.get(k) ?? null });
  return req;
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

describe("POST /api/inbox/manual-image", () => {
  test("T1 — uploads to Meta by ID, inserts conversation row, stamps last_human_activity_at", async () => {
    const db = makeDbMock({
      customers: { data: { phone_number: "+6281234567890" }, error: null },
      conversations: { data: { id: "conv-1" }, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(makeRequest({ customer_id: "cust-1", file: makeFile(), caption: "Ini menunya" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);

    // Must upload buffer to Meta and send by media ID (not by URL)
    expect(compressUploadedImage).toHaveBeenCalledWith(expect.any(Buffer));
    expect(db.storageMock.upload).toHaveBeenCalledWith(
      expect.stringMatching(/\.jpg$/),
      Buffer.from("compressed-jpeg"),
      { contentType: "image/jpeg", upsert: false },
    );
    expect(uploadMediaToMeta).toHaveBeenCalledWith(Buffer.from("compressed-jpeg"), "image/jpeg");
    expect(sendImageMessageById).toHaveBeenCalledWith("+6281234567890", "meta-media-id-123", "Ini menunya");

    // Must save public URL to conversations for display
    expect(db.chains.conversations.insert).toHaveBeenCalledWith(
      expect.objectContaining({ message_type: "image", model_used: "human" }),
    );

    // Must stamp last_human_activity_at
    expect(db.chains.customer_flags.update).toHaveBeenCalledWith(
      expect.objectContaining({ last_human_activity_at: expect.any(String) }),
    );
  });

  test("T2 — missing customer_id returns 400, WhatsApp not called", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(makeRequest({ customer_id: null, file: makeFile() }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(uploadMediaToMeta).not.toHaveBeenCalled();
    expect(sendImageMessageById).not.toHaveBeenCalled();
  });

  test("T3 — missing file returns 400, WhatsApp not called", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(makeRequest({ customer_id: "cust-1", file: null }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(uploadMediaToMeta).not.toHaveBeenCalled();
  });

  test("T4 — unknown customer returns 404", async () => {
    const db = makeDbMock({
      customers: { data: null, error: { message: "No rows found" } },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await POST(makeRequest({ customer_id: "ghost", file: makeFile() }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.ok).toBe(false);
    expect(sendImageMessageById).not.toHaveBeenCalled();
  });

  test("T5 — Meta upload failure returns 502 with error message", async () => {
    const db = makeDbMock({
      customers: { data: { phone_number: "+6281234567890" }, error: null },
    });
    (createAdminClient as jest.Mock).mockReturnValue(db);
    (uploadMediaToMeta as jest.Mock).mockRejectedValueOnce(new Error("Meta API 503"));

    const res = await POST(makeRequest({ customer_id: "cust-1", file: makeFile() }));
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/Meta API 503/);
    expect(sendImageMessageById).not.toHaveBeenCalled();
  });

  test("T7 — unauthenticated returns 401", async () => {
    (createClient as jest.Mock).mockResolvedValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: null } }),
      },
    });

    const res = await POST(makeRequest({ customer_id: "cust-1", file: makeFile() }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.ok).toBe(false);
  });
});
