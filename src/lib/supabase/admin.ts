import { createClient } from "@supabase/supabase-js";
import { requiredEnv } from "@/lib/env";
import { createTimeoutFetch } from "./timeout-fetch";
import type { Database } from "@/types/database";

export function createAdminClient() {
  return createClient<Database>(
    requiredEnv(
      "NEXT_PUBLIC_SUPABASE_URL",
      process.env.NEXT_PUBLIC_SUPABASE_URL,
    ),
    requiredEnv(
      "SUPABASE_SERVICE_ROLE_KEY",
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    ),
    {
      auth: { autoRefreshToken: false, persistSession: false },
      // Without this a wedged PostgREST hangs the caller until Supabase's
      // gateway gives up at ~125s. See timeout-fetch.ts.
      global: { fetch: createTimeoutFetch() },
    },
  );
}
