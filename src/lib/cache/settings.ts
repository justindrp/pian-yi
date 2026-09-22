import type { ExcludedNeighborhood } from "@/lib/subcontractors/coverage";
import { createAdminClient } from "@/lib/supabase/admin";

interface CacheData {
  settings: Record<string, string>;
  pricingTiers: Record<number, number>;
  templates: Record<string, string>;
  activeInstructions: string[];
  neighborhoods: Record<string, string[]>;
  excludedNeighborhoods: ExcludedNeighborhood[];
  /** The mark these contents were loaded against. Null when it could not be read. */
  watermark: string | null;
  loadedAt: number;
}

let cache: CacheData | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * One string that changes whenever anything this cache holds changes
 * (migration 129). 166 bytes against the 20,621 the five selects below cost,
 * and one request rather than five.
 *
 * Returns null when it cannot be read, which is deliberately *not* the same as
 * "unchanged": an unreachable database or a deploy that lands ahead of the
 * migration falls back to reloading every minute, which is what this file did
 * before. A watermark that fails closed would serve a frozen price list.
 */
async function readWatermark(
  db: ReturnType<typeof createAdminClient>,
): Promise<string | null> {
  try {
    const { data, error } = await db.rpc("settings_cache_watermark");
    if (error || typeof data !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

async function load(): Promise<CacheData> {
  const db = createAdminClient();

  // Read the mark *before* the data. A write that lands mid-load then shows up
  // as a moved mark on the next tick and gets picked up. Reading it afterwards
  // would stamp the cache with a mark newer than its own contents, and that
  // write would never be loaded at all.
  const watermark = await readWatermark(db);

  const [
    settingsRes,
    pricingRes,
    templatesRes,
    instructionsRes,
    neighborhoodsRes,
  ] = await Promise.all([
    db.from("settings").select("key, value"),
    db
      .from("pricing_tiers")
      .select("portions, price_per_portion")
      .is("subcontractor_id", null),
    db.from("message_templates").select("key, template"),
    db.from("chatbot_instructions").select("instruction").eq("is_active", true),
    db.from("area_neighborhoods").select("area, name, excluded").order("name"),
  ]);

  const settings: Record<string, string> = {};
  for (const row of settingsRes.data ?? []) settings[row.key] = row.value;

  const pricingTiers: Record<number, number> = {};
  for (const row of pricingRes.data ?? [])
    pricingTiers[row.portions] = row.price_per_portion;

  const templates: Record<string, string> = {};
  for (const row of templatesRes.data ?? []) templates[row.key] = row.template;

  const activeInstructions = (instructionsRes.data ?? []).map(
    (r) => r.instruction,
  );

  // The two lists are disjoint on purpose. An excluded neighbourhood must
  // never appear in the per-area list the prompt renders as "neighborhoods we
  // serve", and must still be a name the bot recognises — see `exclusionFor()`.
  const neighborhoods: Record<string, string[]> = {};
  const excludedNeighborhoods: ExcludedNeighborhood[] = [];
  for (const row of neighborhoodsRes.data ?? []) {
    if (row.excluded) {
      excludedNeighborhoods.push({ area: row.area, name: row.name });
      continue;
    }
    if (!neighborhoods[row.area]) neighborhoods[row.area] = [];
    neighborhoods[row.area].push(row.name);
  }

  return {
    settings,
    pricingTiers,
    templates,
    activeInstructions,
    neighborhoods,
    excludedNeighborhoods,
    watermark,
    loadedAt: Date.now(),
  };
}

/**
 * The 60-second tick. It used to reload five tables unconditionally — 28 MB a
 * day, 849 MB a month, spent almost entirely on re-reading bytes identical to
 * the ones already in memory, because settings change a few times a week and
 * this runs 1,440 times a day. Now it asks whether anything moved first and
 * only pays the 20 KB when the answer is yes.
 */
async function refreshIfStale(): Promise<void> {
  try {
    const mark = await readWatermark(createAdminClient());
    if (mark !== null && cache && mark === cache.watermark) return;
    cache = await load();
  } catch (err) {
    console.error("[settings-cache] refresh failed:", err);
  }
}

async function getCache(): Promise<CacheData> {
  if (!cache) {
    cache = await load();
    if (!refreshTimer) {
      refreshTimer = setInterval(() => {
        void refreshIfStale();
      }, 60_000);
      // Unref'd so a CLI script can exit. The server is kept alive by its own
      // HTTP listener, so this changes nothing in production — but a one-shot
      // script (`pnpm review-leads`) that reads a single setting otherwise
      // hangs forever on a timer it has no use for.
      refreshTimer.unref?.();
    }
  }
  return cache;
}

export async function getSetting(key: string): Promise<string> {
  const c = await getCache();
  return c.settings[key] ?? "";
}

export async function getPricingTier(portions: number): Promise<number> {
  const c = await getCache();
  return c.pricingTiers[portions] ?? 0;
}

export async function getTemplate(key: string): Promise<string> {
  const c = await getCache();
  return c.templates[key] ?? "";
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const c = await getCache();
  return c.settings;
}

export async function getAllPricingTiers(): Promise<Record<number, number>> {
  const c = await getCache();
  return c.pricingTiers;
}

export async function getAllTemplates(): Promise<Record<string, string>> {
  const c = await getCache();
  return c.templates;
}

export async function getActiveInstructions(): Promise<string[]> {
  const c = await getCache();
  return c.activeInstructions;
}

export async function getNeighborhoods(): Promise<Record<string, string[]>> {
  const c = await getCache();
  return c.neighborhoods;
}

export async function getExcludedNeighborhoods(): Promise<
  ExcludedNeighborhood[]
> {
  const c = await getCache();
  return c.excludedNeighborhoods;
}

export function invalidateCache(): void {
  cache = null;
}
