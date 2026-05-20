import { createAdminClient } from "@/lib/supabase/admin";

interface CacheData {
  settings: Record<string, string>;
  pricingTiers: Record<number, number>;
  templates: Record<string, string>;
  loadedAt: number;
}

let cache: CacheData | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<CacheData> {
  const db = createAdminClient();

  const [settingsRes, pricingRes, templatesRes] = await Promise.all([
    db.from("settings").select("key, value"),
    db.from("pricing_tiers").select("portions, price_per_portion"),
    db.from("message_templates").select("key, template"),
  ]);

  const settings: Record<string, string> = {};
  for (const row of settingsRes.data ?? []) settings[row.key] = row.value;

  const pricingTiers: Record<number, number> = {};
  for (const row of pricingRes.data ?? [])
    pricingTiers[row.portions] = row.price_per_portion;

  const templates: Record<string, string> = {};
  for (const row of templatesRes.data ?? []) templates[row.key] = row.template;

  return { settings, pricingTiers, templates, loadedAt: Date.now() };
}

async function getCache(): Promise<CacheData> {
  if (!cache) {
    cache = await load();
    if (!refreshTimer) {
      refreshTimer = setInterval(async () => {
        try {
          cache = await load();
        } catch (err) {
          console.error("[settings-cache] refresh failed:", err);
        }
      }, 60_000);
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

export function invalidateCache(): void {
  cache = null;
}
