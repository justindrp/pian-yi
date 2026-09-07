import { logEdit } from "@/lib/audit/log-edit";
import { changeDeliveryAddress } from "@/lib/orders/change-delivery-address";
import { loadDeadlineHour } from "@/lib/orders/delivery-state";
import { sendPushToAllAdmins } from "@/lib/push/send";

jest.mock("@/lib/orders/delivery-state", () => ({
  // isLocked is the real one: the cutoff is the whole point of the module, and
  // a stubbed lock would re-address food the kitchen already holds the list for.
  ...jest.requireActual("@/lib/orders/delivery-state"),
  loadDeadlineHour: jest.fn(),
}));
jest.mock("@/lib/audit/log-edit", () => ({ logEdit: jest.fn() }));
jest.mock("@/lib/push/send", () => ({
  sendPushToAllAdmins: jest.fn().mockResolvedValue(undefined),
}));

type Row = {
  id: string;
  delivery_date: string;
  meal_type: string;
  address_slot: number;
};

type Customer = {
  address: string | null;
  area: string | null;
  address_2: string | null;
  area_2: string | null;
};

const updates: { id: string; address_slot: number }[] = [];

function makeDb(rows: Row[], customer: Customer | null) {
  const from = (table: string) => {
    if (table === "customers") {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) {
        chain[m] = jest.fn().mockReturnValue(chain);
      }
      chain.maybeSingle = jest
        .fn()
        .mockResolvedValue({ data: customer, error: null });
      return chain;
    }
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in"]) {
      chain[m] = jest.fn().mockReturnValue(chain);
    }
    chain.update = jest.fn((patch: { address_slot: number }) => ({
      eq: jest.fn((_col: string, id: string) => {
        updates.push({ id, address_slot: patch.address_slot });
        return Promise.resolve({ error: null });
      }),
    }));
    // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(resolve);
    return chain;
  };
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  return { from: jest.fn(from) } as any;
}

// Far enough out that no clock this test runs on has passed the deadline.
const OPEN = "2030-03-04";
const LOCKED = "2020-03-04";

const CUSTOMER: Customer = {
  address: "Kost Platinum, Jl. Ki Hajar",
  area: "Gading Serpong",
  address_2: "UPH Gate 2",
  area_2: "Lippo Karawaci",
};

function call(
  db: unknown,
  input: Parameters<typeof changeDeliveryAddress>[0]["input"],
) {
  return changeDeliveryAddress({
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    db: db as any,
    customerId: "cust-1",
    phone: "+628111",
    customerName: "Cindi",
    input,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  updates.length = 0;
  (loadDeadlineHour as jest.Mock).mockResolvedValue(16);
});

describe("changeDeliveryAddress", () => {
  it("moves an unlocked row to the other saved address", async () => {
    const db = makeDb(
      [
        {
          id: "row-1",
          delivery_date: OPEN,
          meal_type: "lunch",
          address_slot: 2,
        },
      ],
      CUSTOMER,
    );

    const res = await call(db, {
      delivery_dates: [OPEN],
      address_slot: 1,
      reason: "mau ke kost",
    });

    expect(res.ok).toBe(true);
    expect(updates).toEqual([{ id: "row-1", address_slot: 1 }]);
    // Nothing else can say who moved it, so the row is written to edit_log.
    expect(logEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: "row-1",
        action: "change_address",
        actor: "system:webhook:change_delivery_address",
      }),
    );
    expect(sendPushToAllAdmins).toHaveBeenCalled();
  });

  // Past the cutoff the kitchen holds the sheet with the old address on it.
  it("refuses a locked date and writes nothing", async () => {
    const db = makeDb(
      [
        {
          id: "row-1",
          delivery_date: LOCKED,
          meal_type: "lunch",
          address_slot: 2,
        },
      ],
      CUSTOMER,
    );

    const res = await call(db, {
      delivery_dates: [LOCKED],
      address_slot: 1,
    });

    expect(res.ok).toBe(false);
    expect(updates).toEqual([]);
    if (!res.ok) expect(res.error).toContain("terkunci");
  });

  // "Jadwal di catatan kami memang sudah begitu kok" was said to Cindi about a
  // row pointed at UPH Gate 2. It is only ever true when the row already is.
  it("reports a row that already goes to that address without writing", async () => {
    const db = makeDb(
      [
        {
          id: "row-1",
          delivery_date: OPEN,
          meal_type: "lunch",
          address_slot: 1,
        },
      ],
      CUSTOMER,
    );

    const res = await call(db, { delivery_dates: [OPEN], address_slot: 1 });

    expect(res.ok).toBe(true);
    expect(updates).toEqual([]);
    if (res.ok) expect(res.message).toContain("Tidak ada yang perlu diubah");
  });

  // A place we have never been given is an admin's job — this tool writes a
  // slot number, it cannot invent an address.
  it("refuses slot 2 when the customer has only one address", async () => {
    const db = makeDb(
      [
        {
          id: "row-1",
          delivery_date: OPEN,
          meal_type: "lunch",
          address_slot: 1,
        },
      ],
      { ...CUSTOMER, address_2: null, area_2: null },
    );

    const res = await call(db, { delivery_dates: [OPEN], address_slot: 2 });

    expect(res.ok).toBe(false);
    expect(updates).toEqual([]);
    if (!res.ok) expect(res.error).toContain("ask_admin_for_help");
  });

  it("refuses a call with no valid date, and one with no slot", async () => {
    const db = makeDb([], CUSTOMER);

    expect((await call(db, { delivery_dates: ["besok"], address_slot: 1 })).ok).toBe(
      false,
    );
    expect((await call(db, { delivery_dates: [OPEN] })).ok).toBe(false);
    expect(updates).toEqual([]);
  });

  it("says nothing changed when the dates have no scheduled row", async () => {
    const db = makeDb([], CUSTOMER);

    const res = await call(db, { delivery_dates: [OPEN], address_slot: 1 });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Tidak ada pengiriman terjadwal");
  });
});
