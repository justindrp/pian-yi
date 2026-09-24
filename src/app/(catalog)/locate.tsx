"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

/** Set once per tab session, so "Semua area" does not bounce straight back. */
const ASKED = "kl-located";
const EVENT = "kl-locate";

type State = "idle" | "locating" | "far" | "denied" | "failed";

/** ~100 m. Enough to pick an area; less than the phone knows. */
const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Asks for the visitor's location when the home page opens (`auto`), and again
 * whenever the picker's "Gunakan lokasi saya" fires `kl-locate`. A match goes
 * to that area's page; anything else leaves the list as it is and says why.
 * A refusal on open says nothing: the visitor chose, and the picker is right
 * there. Only a refusal after pressing the button gets a note, since otherwise
 * the button would appear to do nothing.
 */
export function Locator({
  auto,
  chatHref,
}: {
  auto: boolean;
  chatHref: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<State>("idle");

  const locate = useCallback(
    (manual: boolean) => {
      if (!("geolocation" in navigator)) {
        if (manual) setState("failed");
        return;
      }
      setState("locating");
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          try {
            const res = await fetch("/api/catalog/locate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                lat: round(pos.coords.latitude),
                lng: round(pos.coords.longitude),
              }),
            });
            const json = (await res.json()) as {
              ok: boolean;
              data?: { slug: string } | null;
            };
            if (!json.ok) setState("failed");
            else if (json.data) router.replace(`/area/${json.data.slug}`);
            else setState("far");
          } catch {
            setState("failed");
          }
        },
        (err) => {
          if (err.code === err.PERMISSION_DENIED) {
            setState(manual ? "denied" : "idle");
          } else {
            setState(manual ? "failed" : "idle");
          }
        },
        { timeout: 10_000, maximumAge: 600_000 },
      );
    },
    [router],
  );

  useEffect(() => {
    if (!auto) return;
    try {
      if (sessionStorage.getItem(ASKED)) return;
      sessionStorage.setItem(ASKED, "1");
    } catch {
      // No storage means no way to stop the bounce; the picker still works.
      return;
    }
    locate(false);
  }, [auto, locate]);

  useEffect(() => {
    const on = () => locate(true);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [locate]);

  if (state === "idle") return null;
  return (
    <p className="kl-locate" role="status">
      {state === "locating" && "Mencari lokasi kakak…"}
      {state === "far" && (
        <>
          Belum ada dapur partner yang antar ke lokasi kakak.{" "}
          <a href={chatHref}>Tanya lewat WhatsApp</a>
        </>
      )}
      {state === "denied" &&
        "Izin lokasi ditolak. Aktifkan di pengaturan browser, atau pilih area di atas."}
      {state === "failed" && "Lokasi belum terbaca. Pilih area di atas."}
    </p>
  );
}

/** The picker's first entry: close the list and ask again. */
export function LocateItem() {
  return (
    <button
      type="button"
      className="kl-area-locate"
      onClick={(e) => {
        e.currentTarget.closest("details")?.removeAttribute("open");
        window.dispatchEvent(new Event(EVENT));
      }}
    >
      Gunakan lokasi saya
    </button>
  );
}
