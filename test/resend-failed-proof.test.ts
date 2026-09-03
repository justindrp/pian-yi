import { sendDeliveryPhotoToCustomer } from "@/lib/claude/photo-matcher";
import { resendFailedProofs } from "@/lib/deliveries/resend-failed-proof";
import { createAdminClient } from "@/lib/supabase/admin";

jest.mock("@/lib/supabase/admin");
jest.mock("@/lib/claude/photo-matcher", () => ({
  sendDeliveryPhotoToCustomer: jest.fn().mockResolvedValue(undefined),
}));

const CUSTOMER_ID = "c0000000-0000-4000-8000-000000000001";
const PROOF_URL =
  "https://x.supabase.co/storage/v1/object/public/delivery-proofs/forwarded/2026-09-03/a.jpg";
const MENU_URL = "https://x.supabase.co/storage/v1/object/public/menus/w36.jpg";

type Row = { media_url: string | null; whatsapp_status: string | null };

/** conversations returns `rows`; delivery_proofs resolves the URL to an id. */
function mockDb(rows: Row[], proofIds: Record<string, string> = {}) {
  const from = jest.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    let wantedUrl = "";
    for (const method of ["select", "order", "limit", "gte", "lt"])
      chain[method] = () => chain;
    chain.eq = (col: string, value: string) => {
      if (col === "image_url") wantedUrl = value;
      return chain;
    };
    chain.maybeSingle = async () => ({
      data: proofIds[wantedUrl] ? { id: proofIds[wantedUrl] } : null,
      error: null,
    });
    // biome-ignore lint/suspicious/noThenProperty: mimics the PostgREST query builder
    chain.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: table === "conversations" ? rows : [], error: null });
    return chain;
  });
  (createAdminClient as jest.Mock).mockReturnValue({ from });
}

beforeEach(() => jest.clearAllMocks());

describe("resendFailedProofs", () => {
  // 2026-09-03: Clairine's photo was pushed at 19:07 while her window was shut,
  // failed on 131042, and nothing retried it. She wrote in at 19:15 — which is
  // what reopened the window — and was told we had nothing.
  it("resends a photo whose first send failed", async () => {
    mockDb([{ media_url: PROOF_URL, whatsapp_status: "failed" }], {
      [PROOF_URL]: "proof-1",
    });
    expect(await resendFailedProofs(CUSTOMER_ID)).toBe(1);
    expect(sendDeliveryPhotoToCustomer).toHaveBeenCalledWith(
      "proof-1",
      CUSTOMER_ID,
    );
  });

  it("does not resend a photo the customer already has", async () => {
    mockDb(
      [
        { media_url: PROOF_URL, whatsapp_status: "failed" },
        { media_url: PROOF_URL, whatsapp_status: "delivered" },
      ],
      { [PROOF_URL]: "proof-1" },
    );
    expect(await resendFailedProofs(CUSTOMER_ID)).toBe(0);
    expect(sendDeliveryPhotoToCustomer).not.toHaveBeenCalled();
  });

  it("ignores a failed image that is not a delivery photo", async () => {
    mockDb([{ media_url: MENU_URL, whatsapp_status: "failed" }]);
    expect(await resendFailedProofs(CUSTOMER_ID)).toBe(0);
    expect(sendDeliveryPhotoToCustomer).not.toHaveBeenCalled();
  });

  it("sends one message for a photo that failed twice", async () => {
    mockDb(
      [
        { media_url: PROOF_URL, whatsapp_status: "failed" },
        { media_url: PROOF_URL, whatsapp_status: "failed" },
      ],
      { [PROOF_URL]: "proof-1" },
    );
    expect(await resendFailedProofs(CUSTOMER_ID)).toBe(1);
    expect(sendDeliveryPhotoToCustomer).toHaveBeenCalledTimes(1);
  });
});
