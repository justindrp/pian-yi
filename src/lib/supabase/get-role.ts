import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function getSessionWithRole(): Promise<{
  email: string;
  role: string;
} | null> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user?.email) return null;

  const db = createAdminClient();
  const { data } = await db
    .from("admin_users")
    .select("role")
    .eq("email", session.user.email)
    .single();

  return { email: session.user.email, role: data?.role ?? "admin" };
}

export function isOwner(role: string) {
  return role === "owner";
}
