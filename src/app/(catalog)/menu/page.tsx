import { permanentRedirect } from "next/navigation";

// The kitchen list moved to katerloka.com itself on 2026-09-24. Kept so a link
// shared during the preview still lands; each kitchen stays at /menu/[dapur].
export default function MenuPage() {
  permanentRedirect("/");
}
