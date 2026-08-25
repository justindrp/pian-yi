import { Suspense } from "react";
import OrdersClient from "@/components/dashboard/orders-client";

export default function OrdersPage() {
  // The status and search filters can arrive in the query string (a task on
  // /tasks links straight to the order it is about), and useSearchParams()
  // suspends during prerender.
  return (
    <Suspense fallback={null}>
      <OrdersClient />
    </Suspense>
  );
}
