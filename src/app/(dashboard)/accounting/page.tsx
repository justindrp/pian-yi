import { redirect } from "next/navigation";
import AccountingClient from "@/components/dashboard/accounting-client";
import { getSessionWithRole, isOwner } from "@/lib/supabase/get-role";

export const metadata = { title: "Accounting" };

export default async function AccountingPage() {
  const session = await getSessionWithRole();
  if (!session || !isOwner(session.role)) redirect("/dashboard");

  return <AccountingClient />;
}
