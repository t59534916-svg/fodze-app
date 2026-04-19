"use client";
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/contexts/AppContext";
import { useMatchday } from "@/hooks/useMatchday";
import AppShell from "@/components/layout/AppShell";
import ComboBuilder from "@/components/ComboBuilder";

const STORAGE_KEY = "fodze-combo-state";

function loadFromSession<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    // Convert arrays back to Sets where needed
    if (parsed.selectedIds) parsed.selectedIds = new Set(parsed.selectedIds);
    if (parsed.bankerIds) parsed.bankerIds = new Set(parsed.bankerIds);
    return parsed;
  } catch (err) {
    // Corrupted sessionStorage value — wipe it so the next save starts
    // clean, and fall back to defaults. Log for diagnosis.
    console.warn("[FODZE] combo state restore failed:", (err as Error).message);
    try { sessionStorage.removeItem(key); } catch { /* storage disabled */ }
    return fallback;
  }
}

function saveToSession(key: string, state: any) {
  try {
    sessionStorage.setItem(key, JSON.stringify({
      ...state,
      selectedIds: Array.from(state.selectedIds),
      bankerIds: Array.from(state.bankerIds),
    }));
  } catch (err) {
    // Quota exceeded or storage disabled (private browsing). Non-fatal —
    // combo state just won't persist across reloads.
    console.warn("[FODZE] combo state save failed:", (err as Error).message);
  }
}

export default function CombosPage() {
  const router = useRouter();
  const { effectiveBudget } = useApp();
  const { comboLegs } = useMatchday();

  const [loaded, setLoaded] = useState(false);
  const [comboSelectedIds, setComboSelectedIds] = useState<Set<string>>(new Set());
  const [comboBankerIds, setComboBankerIds] = useState<Set<string>>(new Set());
  const [comboCustomLegs, setComboCustomLegs] = useState<any[]>([]);
  const [comboCustomCounter, setComboCustomCounter] = useState(0);
  const [comboSelectedSystem, setComboSelectedSystem] = useState<string | null>(null);

  // Restore from sessionStorage on mount
  useEffect(() => {
    const saved = loadFromSession<any>(STORAGE_KEY, null);
    if (saved) {
      setComboSelectedIds(saved.selectedIds || new Set());
      setComboBankerIds(saved.bankerIds || new Set());
      setComboCustomLegs(saved.customLegs || []);
      setComboCustomCounter(saved.customCounter || 0);
      setComboSelectedSystem(saved.selectedSystem || null);
    }
    setLoaded(true);
  }, []);

  // Save to sessionStorage on every change
  useEffect(() => {
    if (!loaded) return;
    saveToSession(STORAGE_KEY, {
      selectedIds: comboSelectedIds,
      bankerIds: comboBankerIds,
      customLegs: comboCustomLegs,
      customCounter: comboCustomCounter,
      selectedSystem: comboSelectedSystem,
    });
  }, [loaded, comboSelectedIds, comboBankerIds, comboCustomLegs, comboCustomCounter, comboSelectedSystem]);

  return (
    <AppShell>
      <ComboBuilder
        availableLegs={comboLegs}
        budget={effectiveBudget}
        onBack={() => router.push("/matchday")}
        selectedIds={comboSelectedIds}
        setSelectedIds={setComboSelectedIds}
        bankerIds={comboBankerIds}
        setBankerIds={setComboBankerIds}
        customLegs={comboCustomLegs}
        setCustomLegs={setComboCustomLegs}
        customCounter={comboCustomCounter}
        setCustomCounter={setComboCustomCounter}
        selectedSystem={comboSelectedSystem}
        setSelectedSystem={setComboSelectedSystem}
      />
    </AppShell>
  );
}
