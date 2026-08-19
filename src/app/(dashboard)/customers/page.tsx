import { Suspense } from "react";
import CustomersClient from "@/components/dashboard/customers-client";

export default function CustomersPage() {
  // Filters, sort and visible columns are read from the query string, and
  // useSearchParams() suspends during prerender.
  return (
    <Suspense fallback={null}>
      <CustomersClient />
    </Suspense>
  );
}
