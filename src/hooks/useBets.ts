"use client";
import { useState, useCallback } from "react";
import { saveBet } from "@/lib/supabase";
import { useApp } from "@/contexts/AppContext";
import type { RawMatch, BetCalc } from "@/types/match";

export function useBets() {
  const { supabase, user, league, effectiveBudget, userBets, refreshBets } = useApp();
  const [placingBet, setPlacingBet] = useState<string | null>(null);

  const handlePlaceBet = useCallback(async (match: RawMatch, bet: BetCalc) => {
    const key = `${league}:${match.home?.name}-${match.away?.name}`.toLowerCase().replace(/\s/g, "");
    setPlacingBet(bet.label);
    await saveBet(supabase, {
      match_key: key, home_team: match.home?.name, away_team: match.away?.name,
      market: bet.label, odds_placed: bet.quote, stake: bet.kelly * effectiveBudget,
      model_prob: bet.pModel, edge: bet.edge, result: "pending",
    }, user.id);
    await refreshBets();
    setPlacingBet(null);
  }, [league, effectiveBudget, user.id, supabase, refreshBets]);

  const settleBet = useCallback(async (betId: string, result: "won" | "lost") => {
    await supabase.from("bets").update({ result, settled_at: new Date().toISOString() }).eq("id", betId);
    await refreshBets();
  }, [supabase, refreshBets]);

  return { userBets, placingBet, handlePlaceBet, settleBet };
}
