import { buildInvoiceSpec } from "@/lib/invoices/send";
import type { Database } from "@/types/database";

jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: jest.fn() }));
jest.mock("@/lib/whatsapp/client");
jest.mock("@/lib/claude/conversation");
jest.mock("@/lib/cache/settings", () => ({
  getSetting: jest.fn(
    async (key: string) =>
      ({
        bank_name: "BCA",
        bank_account_number: "1234567890",
        bank_account_name: "Pian Yi",
        order_deadline_hour: "16",
      })[key],
  ),
}));

type Order = Database["public"]["Tables"]["orders"]["Row"];
type Customer = Database["public"]["Tables"]["customers"]["Row"];

const customer = (over: Partial<Customer>): Customer =>
  ({
    id: "c1",
    name: "Carolin",
    phone_number: "+628123",
    address: "Sky House BSD",
    area: "BSD Baru",
    ...over,
  }) as Customer;

const order = (over: Partial<Order>): Order =>
  ({
    id: "o1",
    customer_id: "c1",
    paid_by_customer_id: null,
    package_size: 6,
    price_per_portion: 29000,
    total_price: 174000,
    size: "s",
    status: "active",
    start_date: "2026-09-01",
    end_date: null,
    amount_paid: 0,
    paid_at: null,
    source: "purchase",
    ...over,
  }) as Order;

const spec = (o: Partial<Order>, people?: { payer?: Customer }) =>
  buildInvoiceSpec({
    order: order(o),
    beneficiary: customer({}),
    payer: people?.payer ?? customer({}),
    number: "INV/PY/2026-09/0001",
    today: "2026-09-01",
  });

describe("buildInvoiceSpec", () => {
  it("stamps LUNAS only when the money actually arrived", async () => {
    const paid = await spec({ paid_at: "2026-08-30T10:00:00Z" });
    expect(paid.paidStamp).toBe("LUNAS");
    expect(paid.balance).toBe("Rp 0");
    expect(paid.payment.join(" ")).toContain("lunas");

    // A payment proof is a screenshot, not a receipt. The status says a picture
    // arrived; only paid_at says the money did.
    const proof = await spec({ status: "payment_proof_received" });
    expect(proof.paidStamp).toBeUndefined();
    expect(proof.balance).toBe("Rp 174.000");
  });

  it("bills an unpaid order to the cutoff the day before the first delivery", async () => {
    // Never the delivery day itself: the unpaid sweep runs at 16.00 on H-1, so
    // an invoice due "1 September" for food on 1 September is already late.
    const unpaid = await spec({});
    expect(unpaid.due).toBe("31 Agustus 2026 pukul 16.00 WIB");
    expect(unpaid.payment[0]).toContain("BCA");
    expect(unpaid.paidLine).toBeUndefined();
  });

  it("carries a partial payment through to the balance", async () => {
    const dp = await spec({ amount_paid: 100000 });
    expect(dp.paidLine).toEqual({
      label: "Sudah dibayar",
      amount: "-Rp 100.000",
    });
    expect(dp.balance).toBe("Rp 74.000");
    expect(dp.paidStamp).toBeUndefined();
  });

  it("bills the payer and ships to the person who eats", async () => {
    const bought = await spec(
      { paid_by_customer_id: "c2" },
      { payer: customer({ id: "c2", name: "Naya", phone_number: "+628999" }) },
    );
    expect(bought.billTo.name).toBe("Naya");
    expect(bought.shipTo.name).toBe("Carolin");
    expect(bought.shipTo.lines).toContain("Sky House BSD");
  });

  it("prices the line off the order, never off the ladder", async () => {
    // A corporate rate and a size-M surcharge both live in price_per_portion,
    // which is locked at creation. Re-deriving either here would print a figure
    // the customer never agreed to.
    const contract = await spec({
      price_per_portion: 35000,
      package_size: 20,
      total_price: 700000,
    });
    expect(contract.items[0].unit).toBe("Rp 35.000");
    expect(contract.items[0].qty).toBe("20 porsi");
    expect(contract.total).toBe("Rp 700.000");
  });
});
