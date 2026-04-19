"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Animates a numeric value from its previous render to the new target
 * over `duration` ms using an ease-out curve. Useful for probability
 * percentages, edge %, stake amounts — anything where a live-feeling
 * tick-up beats an instant-jump.
 *
 * Respects prefers-reduced-motion: returns target immediately when the
 * user has motion disabled (WCAG 2.3.3).
 */
export function useCountUp(target: number, duration = 600): number {
  const [value, setValue] = useState(target);
  const rafRef = useRef<number | null>(null);
  const fromRef = useRef(target);
  const startRef = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || duration <= 0) { setValue(target); return; }

    fromRef.current = value;
    startRef.current = performance.now();

    const tick = (now: number) => {
      const elapsed = now - startRef.current;
      const t = Math.min(1, elapsed / duration);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      const next = fromRef.current + (target - fromRef.current) * eased;
      setValue(next);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration]);

  return value;
}
