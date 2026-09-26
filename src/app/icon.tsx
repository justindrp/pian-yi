import { ImageResponse } from "next/og";
import { BRAND, LOCKUP } from "@/lib/brand/logo";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

// The avatar: the tray alone, white on a cabai disc (docs/DESIGN_SYSTEM.md).
// The tray occupies x 0–67, y 20–108 of the lockup's box.
export default function Icon() {
  const { cx, cy, r } = LOCKUP.rice;
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: BRAND.cabai,
        borderRadius: "50%",
      }}
    >
      <svg width={17} height={22} viewBox="0 20 67 88" aria-hidden="true">
        <path fillRule="evenodd" fill="#FFFFFF" d={LOCKUP.tray} />
        <circle cx={cx} cy={cy} r={r} fill="#FFFFFF" />
      </svg>
    </div>,
    { ...size },
  );
}
