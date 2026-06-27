// One-time script: upload price list + Dapur 2 menu images to Supabase storage
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const db = createClient(supabaseUrl, serviceRoleKey);

async function uploadAndSave(filePath: string, storagePath: string, settingKey: string) {
  const buf = readFileSync(filePath);

  const { error: uploadErr } = await db.storage
    .from("menu")
    .upload(storagePath, buf, { contentType: "image/jpeg", upsert: true });

  if (uploadErr) throw new Error(`Upload failed for ${storagePath}: ${uploadErr.message}`);

  const { data } = db.storage.from("menu").getPublicUrl(storagePath);
  const url = data.publicUrl;
  console.log(`Uploaded ${storagePath} → ${url}`);

  const { error: settingErr } = await db
    .from("settings")
    .upsert({ key: settingKey, value: url }, { onConflict: "key" });

  if (settingErr) throw new Error(`Setting upsert failed for ${settingKey}: ${settingErr.message}`);
  console.log(`Saved setting ${settingKey}`);
}

async function main() {
  await uploadAndSave(
    "/Users/justin/Downloads/Pian Yi/Pian Yi Catering - Price List V2.jpeg",
    "price-list-v2.jpeg",
    "price_list_image_url",
  );

  await uploadAndSave(
    "/Users/justin/Downloads/Pian Yi/Pian Yi Catering - Menu Batch 38 V2.jpeg",
    "menu-batch-38-v2.jpeg",
    "weekly_menu_image_url_dapur2",
  );

  console.log("Done.");
}

main().catch((err) => { console.error(err); process.exit(1); });
