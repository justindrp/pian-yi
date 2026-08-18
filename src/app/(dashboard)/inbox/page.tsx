import InboxClient from "@/components/dashboard/inbox-client";
import { getSessionWithRole, isOwner } from "@/lib/supabase/get-role";

export default async function InboxPage() {
  const session = await getSessionWithRole();
  return <InboxClient canTakeOver={isOwner(session?.role ?? "admin")} />;
}
