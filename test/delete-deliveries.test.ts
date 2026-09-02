import { loadCustomerSchedule } from "@/lib/orders/customer-schedule";
import { deleteDeliveries } from "@/lib/orders/delete-deliveries";
import { deleteDelivery, loadDeadlineHour } from "@/lib/orders/delivery-state";
import { sendPushToAllAdmins } from "@/lib/push/send";

jest.mock("@/lib/orders/customer-schedule", () => ({
  loadCustomerSchedule: jest.fn(),
}));
jest.mock("@/lib/orders/delivery-state", () => ({
  // isLocked is the real one: the whole point of the module is the cutoff, and
  // a stubbed lock would let a test pass over food the kitchen is cooking.
  ...jest.requireActual("@/lib/orders/delivery-state"),
  deleteDelivery: jest.fn(),
  loadDeadlineHour: jest.fn(),
}));
jest.mock("@/lib/push/send", () => ({
  sendPushToAllAdmins: jest.fn().mockResolvedValue(undefined),
}));

type Row = {
  id: string;
  delivery_date: string;
  meal_type: string;
  portions: number;
};

function makeDb(rows: Row[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in"]) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  // biome-ignore lint/suspicious/noThenProperty: supabase query builder is thenable
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolve);
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  return { from: jest.fn(() => chain) } as any;
}

// Far enough out that no clock this test runs on has passed their deadline.
const OPEN = "2030-03-04";
const OPEN_2 = "2030-03-05";
const LOCKED = "2020-03-04";

function call(
  db: unknown,
  input: Parameters<typeof deleteDeliveries>[0]["input"],
) {
  return deleteDeliveries({
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    db: db as any,
    customerId: "cust-1",
    phone: "+628111",
    customerName: "Nadya",
    input,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (loadDeadlineHour as jest.Mock).mockResolvedValue(16);
  (loadCustomerSchedule as jest.Mock).mockResolvedValue({ unbooked: 3 });
  (deleteDelivery as jest.Mock).mockImplementation(({ id }: { id: string }) =>
    Promise.resolve({ id, delivery_date: OPEN }),
  );
});

test("no valid date writes nothing", async () => {
  const res = await call(makeDb([]), { delivery_dates: ["besok"] });
  expect(res.ok).toBe(false);
  expect(deleteDelivery).not.toHaveBeenCalled();
});

test("a date with nothing on it is not a cancellation", async () => {
  const res = await call(makeDb([]), { delivery_dates: [OPEN] });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toContain("belum ada");
  expect(deleteDelivery).not.toHaveBeenCalled();
});

test("an open date is deleted and the balance is quoted back", async () => {
  const res = await call(
    makeDb([
      { id: "d1", delivery_date: OPEN, meal_type: "lunch", portions: 1 },
    ]),
    { delivery_dates: [OPEN], reason: "mau ganti ke malam" },
  );
  expect(res.ok).toBe(true);
  expect(deleteDelivery).toHaveBeenCalledTimes(1);
  expect((deleteDelivery as jest.Mock).mock.calls[0][0]).toMatchObject({
    id: "d1",
    actor: "system:webhook:delete_deliveries",
  });
  if (res.ok) {
    expect(res.message).toContain(OPEN);
    expect(res.message).toContain("3");
  }
});

test("a locked date is refused, not deleted", async () => {
  const res = await call(
    makeDb([
      { id: "d1", delivery_date: LOCKED, meal_type: "lunch", portions: 1 },
    ]),
    { delivery_dates: [LOCKED] },
  );
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toContain("terkunci");
  expect(deleteDelivery).not.toHaveBeenCalled();
});

test("a partly locked run deletes what it can and names what it did not", async () => {
  const res = await call(
    makeDb([
      { id: "d1", delivery_date: LOCKED, meal_type: "lunch", portions: 1 },
      { id: "d2", delivery_date: OPEN, meal_type: "lunch", portions: 1 },
    ]),
    { delivery_dates: [LOCKED, OPEN] },
  );
  expect(res.ok).toBe(true);
  expect(deleteDelivery).toHaveBeenCalledTimes(1);
  if (res.ok) {
    expect(res.message).toContain("TIDAK dibatalkan");
    expect(res.message).toContain(LOCKED);
  }
});

test("the meal the customer is keeping is left alone", async () => {
  const res = await call(
    makeDb([
      { id: "d1", delivery_date: OPEN, meal_type: "lunch", portions: 1 },
      { id: "d2", delivery_date: OPEN_2, meal_type: "dinner", portions: 1 },
    ]),
    { delivery_dates: [OPEN, OPEN_2], meal_type: "lunch" },
  );
  expect(res.ok).toBe(true);
  expect(deleteDelivery).toHaveBeenCalledTimes(1);
  expect((deleteDelivery as jest.Mock).mock.calls[0][0]).toMatchObject({
    id: "d1",
  });
});

test("half of a keduanya row cannot be removed by deleting it", async () => {
  const res = await call(
    makeDb([{ id: "d1", delivery_date: OPEN, meal_type: "both", portions: 2 }]),
    { delivery_dates: [OPEN], meal_type: "lunch" },
  );
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toContain("ask_admin_for_help");
  expect(deleteDelivery).not.toHaveBeenCalled();
});

test("a delete that throws is reported as failed and pushed", async () => {
  (deleteDelivery as jest.Mock).mockRejectedValue(new Error("boom"));
  const res = await call(
    makeDb([
      { id: "d1", delivery_date: OPEN, meal_type: "lunch", portions: 1 },
    ]),
    { delivery_dates: [OPEN] },
  );
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toContain("Gagal");
  expect(sendPushToAllAdmins).toHaveBeenCalled();
});
