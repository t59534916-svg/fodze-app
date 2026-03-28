"use client";

export default function Logo({ size = 30 }: { size?: number }) {
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img src="/icon-192.png" alt="RvL Labs" width={size} height={size} style={{
      borderRadius: size > 40 ? 12 : 8,
      filter: "drop-shadow(0 0 6px rgba(212,184,106,0.25))",
    }} />
  );
}
