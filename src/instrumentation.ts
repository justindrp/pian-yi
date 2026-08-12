// Runs once when a Next.js server instance boots. This is where the in-app job
// scheduler is started; see src/lib/cron/scheduler.ts for why the schedules
// live in the app rather than in separate Railway cron services.
export async function register(): Promise<void> {
  // Also called for the edge runtime, where timers and the Supabase admin
  // client are not available.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startScheduler } = await import("@/lib/cron/scheduler");
  startScheduler();
}
