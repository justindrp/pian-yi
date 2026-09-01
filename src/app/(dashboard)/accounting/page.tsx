import { redirect } from "next/navigation";
import { Suspense } from "react";
import AccountingClient from "@/components/dashboard/accounting-client";
import { getSessionWithRole, isOwner } from "@/lib/supabase/get-role";

export const metadata = { title: "Accounting" };

export default async function AccountingPage() {
  const session = await getSessionWithRole();
  if (!session || !isOwner(session.role)) redirect("/dashboard");

  // AccountingClient keeps the tab, date range and selected account in the
  // URL, so it reads useSearchParams and needs a Suspense boundary to avoid
  // opting the whole route into client-side rendering at build time.
  return (
    <Suspense>
      <AccountingClient />
    </Suspense>
  );
}
