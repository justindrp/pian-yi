import { sendPushToAllAdmins } from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";

// Circuit breaker (module-level, in-memory)
const breaker = {
  failures: 0,
  lastFailure: 0,
  openUntil: 0,
};

export function isCircuitOpen(): boolean {
  return Date.now() < breaker.openUntil;
}

export function recordSuccess(): void {
  breaker.failures = 0;
}

export async function recordFailure(): Promise<void> {
  breaker.failures++;
  breaker.lastFailure = Date.now();
  if (breaker.failures >= 5 && Date.now() - breaker.lastFailure < 60_000) {
    breaker.openUntil = Date.now() + 5 * 60 * 1000;
    await sendPushToAllAdmins(
      "Claude circuit breaker open",
      "Too many API errors",
      "/settings",
      "high",
    ).catch(console.error);
  }
}

// Rate limit check
export async function checkRateLimit(
  customerId: string,
): Promise<{ allowed: boolean; reason?: string }> {
  const db = createAdminClient();
  const { data: row } = await db
    .from("customer_rate_limits")
    .select("*")
    .eq("customer_id", customerId)
    .single();

  if (!row) return { allowed: true };

  const today = new Date().toDateString();
  const lastReset = row.last_reset_at
    ? new Date(row.last_reset_at).toDateString()
    : null;

  if (today !== lastReset) {
    await db
      .from("customer_rate_limits")
      .update({
        daily_message_count: 0,
        daily_token_count: 0,
        minute_message_count: 0,
        last_reset_at: new Date().toISOString(),
      })
      .eq("customer_id", customerId);
    return { allowed: true };
  }

  // Reset per-minute counter if last message was more than 60s ago
  const lastMessageAt = row.last_message_at
    ? new Date(row.last_message_at).getTime()
    : 0;
  const minuteExpired = Date.now() - lastMessageAt > 60_000;
  if (minuteExpired && (row.minute_message_count ?? 0) > 0) {
    await db
      .from("customer_rate_limits")
      .update({ minute_message_count: 0 })
      .eq("customer_id", customerId);
    row.minute_message_count = 0;
  }

  if ((row.daily_message_count ?? 0) >= 20)
    return { allowed: false, reason: "daily_limit" };
  if ((row.minute_message_count ?? 0) >= 5)
    return { allowed: false, reason: "minute_limit" };
  if ((row.daily_token_count ?? 0) >= 100_000)
    return { allowed: false, reason: "token_limit" };

  await db
    .from("customer_rate_limits")
    .update({
      daily_message_count: (row.daily_message_count ?? 0) + 1,
      minute_message_count: (row.minute_message_count ?? 0) + 1,
      last_message_at: new Date().toISOString(),
    })
    .eq("customer_id", customerId);

  return { allowed: true };
}

export async function updateTokenCount(
  customerId: string,
  tokens: number,
): Promise<void> {
  const db = createAdminClient();
  const { data: row } = await db
    .from("customer_rate_limits")
    .select("daily_token_count")
    .eq("customer_id", customerId)
    .single();

  if (!row) return;

  await db
    .from("customer_rate_limits")
    .update({ daily_token_count: (row.daily_token_count ?? 0) + tokens })
    .eq("customer_id", customerId);
}

// Prompt injection detection
const injectionPatterns = [
  /repeat.{0,20}\d{3,}/i,
  /x\s*\d{4,}/i,
  /ignore (previous|all|your) instructions/i,
  /forget your/i,
  /\[system\]/i,
];

export function detectInjection(message: string): boolean {
  return (
    injectionPatterns.some((p) => p.test(message)) || message.length > 2000
  );
}

// Echo detection
export async function detectEcho(
  customerId: string,
  newReply: string,
): Promise<boolean> {
  const db = createAdminClient();
  const { data } = await db
    .from("conversations")
    .select("content")
    .eq("customer_id", customerId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  return data?.content === newReply;
}
