import { createAdminClient } from "@/lib/supabase/admin";

async function getData() {
  const db = createAdminClient();
  const [settingsRes, pricingRes, templatesRes] = await Promise.all([
    db.from("settings").select("*").order("key"),
    db.from("pricing_tiers").select("*").order("portions"),
    db.from("message_templates").select("*").order("key"),
  ]);
  return {
    settings: settingsRes.data ?? [],
    pricingTiers: pricingRes.data ?? [],
    templates: templatesRes.data ?? [],
  };
}

export default async function SettingsPage() {
  const { settings, pricingTiers, templates } = await getData();

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold text-gray-900">Settings</h1>

      <Section title="General Settings">
        <Table
          rows={settings.map((s) => ({
            key: s.key,
            value: s.value,
            note: s.description ?? "",
          }))}
        />
      </Section>

      <Section title="Pricing Tiers">
        <Table
          rows={pricingTiers.map((t) => ({
            key: `${t.portions} porsi`,
            value: `Rp ${t.price_per_portion.toLocaleString("id-ID")}/porsi`,
            note: "",
          }))}
        />
      </Section>

      <Section title="Message Templates">
        <div className="space-y-3">
          {templates.map((t) => (
            <div key={t.key} className="p-4 bg-gray-50 rounded-lg">
              <div className="flex items-center gap-2 mb-1">
                <code className="text-xs text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded">
                  {t.key}
                </code>
                {t.description && (
                  <span className="text-xs text-gray-400">{t.description}</span>
                )}
              </div>
              <p className="text-sm text-gray-700">{t.template}</p>
            </div>
          ))}
        </div>
      </Section>

      <p className="text-xs text-gray-400">
        Settings editing will be available in Phase 2.
      </p>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-gray-700 mb-3">{title}</h2>
      {children}
    </div>
  );
}

function Table({
  rows,
}: {
  rows: { key: string; value: string; note: string }[];
}) {
  return (
    <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50">
            <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 w-1/3">
              Key
            </th>
            <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 w-1/3">
              Value
            </th>
            <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500">
              Description
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-gray-50 last:border-0">
              <td className="px-4 py-2.5">
                <code className="text-xs text-gray-600">{row.key}</code>
              </td>
              <td className="px-4 py-2.5 text-gray-800 text-xs">{row.value}</td>
              <td className="px-4 py-2.5 text-gray-400 text-xs">{row.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
