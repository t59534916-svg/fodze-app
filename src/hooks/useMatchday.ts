"use client";
import { useMatchdayContext } from "@/contexts/MatchdayContext";

// Thin wrapper — all state now lives in MatchdayContext
// Existing consumers (page.tsx, matchday/page.tsx, combos/page.tsx) keep working
export function useMatchday() {
  return useMatchdayContext();
}
