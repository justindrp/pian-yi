import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#ea580c",
          borderRadius: 7,
        }}
      >
        {/* Bowl shape */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 1,
          }}
        >
          {/* Steam lines */}
          <div style={{ display: "flex", gap: 3, marginBottom: 1 }}>
            <div
              style={{
                width: 2,
                height: 4,
                background: "rgba(255,255,255,0.7)",
                borderRadius: 1,
              }}
            />
            <div
              style={{
                width: 2,
                height: 5,
                background: "rgba(255,255,255,0.7)",
                borderRadius: 1,
                marginTop: -1,
              }}
            />
            <div
              style={{
                width: 2,
                height: 4,
                background: "rgba(255,255,255,0.7)",
                borderRadius: 1,
              }}
            />
          </div>
          {/* Bowl body */}
          <div
            style={{
              width: 18,
              height: 10,
              background: "white",
              borderRadius: "0 0 10px 10px",
              position: "relative",
            }}
          />
          {/* Bowl base */}
          <div
            style={{
              width: 12,
              height: 2,
              background: "white",
              borderRadius: 1,
            }}
          />
        </div>
      </div>
    ),
    { ...size },
  );
}
