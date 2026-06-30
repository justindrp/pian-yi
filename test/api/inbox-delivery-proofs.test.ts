import { NextRequest } from "next/server";
import { GET } from "@/app/api/inbox/delivery-proofs/[...path]/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

jest.mock("@/lib/supabase/server", () => ({ createClient: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));

function makeDbMock() {
  const storageMock = {
    createSignedUrl: jest.fn().mockResolvedValue({
      data: { signedUrl: "https://supabase.test/storage/v1/object/sign/delivery-proofs/manual/2026-06-30/cust-1/img.jpg" },
      error: null,
    }),
  };

  return {
    storage: { from: jest.fn().mockReturnValue(storageMock) },
    storageMock,
  };
}

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

describe("GET /api/inbox/delivery-proofs/[...path]", () => {
  test("T1 — signs delivery proof path and redirects", async () => {
    const db = makeDbMock();
    (createAdminClient as jest.Mock).mockReturnValue(db);

    const res = await GET(new NextRequest("http://localhost/api/inbox/delivery-proofs/manual/2026-06-30/cust-1/img.jpg"), {
      params: Promise.resolve({ path: ["manual", "2026-06-30", "cust-1", "img.jpg"] }),
    });

    expect(res.status).toBe(307);
    expect(db.storage.from).toHaveBeenCalledWith("delivery-proofs");
    expect(db.storageMock.createSignedUrl).toHaveBeenCalledWith("manual/2026-06-30/cust-1/img.jpg", 3600);
    expect(res.headers.get("location")).toBe("https://supabase.test/storage/v1/object/sign/delivery-proofs/manual/2026-06-30/cust-1/img.jpg");
  });

  test("T2 — unauthenticated returns 401", async () => {
    (createClient as jest.Mock).mockResolvedValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: null } }),
      },
    });

    const res = await GET(new NextRequest("http://localhost/api/inbox/delivery-proofs/manual/2026-06-30/cust-1/img.jpg"), {
      params: Promise.resolve({ path: ["manual", "2026-06-30", "cust-1", "img.jpg"] }),
    });

    expect(res.status).toBe(401);
  });
});
