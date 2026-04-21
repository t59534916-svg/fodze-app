import { describe, it, expect, vi } from "vitest";
import { loadTeamXGHistoryAsOf, loadLeagueXGHistoryAsOf } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Minimal chainable mock of PostgREST query builder ──────────────
// The query builder in supabase-js is thenable-compatible: every method
// returns `this` until the terminal one, which resolves a { data, error }
// Promise. This mock records every method call so tests can assert that
// the as-of loader added the .lt("match_date", cutoff) filter — that's
// the one non-negotiable invariant: no future rows can leak in.

interface MockCall {
  method: string;
  args: unknown[];
}

function createMockClient(result: { data?: unknown[]; error?: { message: string } } = {}) {
  const calls: MockCall[] = [];
  const builder: any = {};

  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return builder;
  };

  for (const method of ["select", "eq", "ilike", "lt", "gt", "lte", "gte", "order", "limit"]) {
    builder[method] = record(method);
  }
  // The terminal call is whatever triggers `.then` — for supabase-js
  // the builder itself is thenable. We implement that here so `await
  // query` resolves to { data, error }.
  builder.then = (onFulfilled: (value: unknown) => void) => {
    return Promise.resolve({ data: result.data ?? [], error: result.error ?? null }).then(onFulfilled);
  };

  const client = {
    from: (table: string) => {
      calls.push({ method: "from", args: [table] });
      return builder;
    },
  } as unknown as SupabaseClient;

  return { client, calls };
}


describe("loadTeamXGHistoryAsOf", () => {
  it("applies the cutoff date via .lt('match_date', ...)", async () => {
    const { client, calls } = createMockClient({ data: [] });
    await loadTeamXGHistoryAsOf(client, "Bayern Munich", "bundesliga", "home", "2024-03-22", 8);

    // The exact-match path must include the cutoff filter.
    const lts = calls.filter(c => c.method === "lt");
    expect(lts.length).toBeGreaterThan(0);
    expect(lts[0].args).toEqual(["match_date", "2024-03-22"]);
  });

  it("returns reversed data when the exact match hits", async () => {
    const rows = [
      { team: "Bayern Munich", match_date: "2024-02-20", xg: 2.1 },
      { team: "Bayern Munich", match_date: "2024-01-15", xg: 1.4 },
    ];
    const { client } = createMockClient({ data: rows });
    const result = await loadTeamXGHistoryAsOf(client, "Bayern Munich", "bundesliga", "home", "2024-03-22");

    // Loader queries ORDER BY match_date DESC, then reverses — so caller
    // gets oldest-first. Verifies the standard reverse() is applied on
    // the as-of path same as on the non-cutoff loader.
    expect(result.map((r: any) => r.match_date)).toEqual(["2024-01-15", "2024-02-20"]);
  });

  it("falls back to fuzzy search AND applies the cutoff to the fallback", async () => {
    // Return empty on exact match so the fuzzy branch kicks in.
    let callIndex = 0;
    const calls: MockCall[] = [];
    const builder: any = {};
    for (const method of ["select", "eq", "ilike", "lt", "order", "limit"]) {
      builder[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return builder;
      };
    }
    builder.then = (onFulfilled: (value: unknown) => void) => {
      callIndex++;
      // First terminal call (exact match) returns empty; second (fuzzy) too —
      // we just need the mock to not throw. The assertion is on the call log.
      return Promise.resolve({ data: [], error: null }).then(onFulfilled);
    };
    const client = {
      from: (_t: string) => { calls.push({ method: "from", args: [_t] }); return builder; },
    } as unknown as SupabaseClient;

    await loadTeamXGHistoryAsOf(client, "Hannover 96", "bundesliga", "home", "2024-03-22");
    void callIndex;

    // Expect exactly two .lt('match_date', …) calls: one in the exact path,
    // one in the fuzzy fallback. Both must carry the same cutoff.
    const lts = calls.filter(c => c.method === "lt");
    expect(lts.length).toBe(2);
    expect(lts[0].args).toEqual(["match_date", "2024-03-22"]);
    expect(lts[1].args).toEqual(["match_date", "2024-03-22"]);
    // Fuzzy branch must use ilike with the longest distinctive token.
    const ilikes = calls.filter(c => c.method === "ilike");
    expect(ilikes.length).toBe(1);
    expect(ilikes[0].args[0]).toBe("team");
    expect(String(ilikes[0].args[1])).toContain("hannover");
  });

  it("skips fuzzy fallback when the team name yields no usable tokens", async () => {
    const calls: MockCall[] = [];
    const builder: any = {};
    for (const method of ["select", "eq", "ilike", "lt", "order", "limit"]) {
      builder[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return builder;
      };
    }
    builder.then = (onFulfilled: (value: unknown) => void) =>
      Promise.resolve({ data: [], error: null }).then(onFulfilled);
    const client = {
      from: (_t: string) => { calls.push({ method: "from", args: [_t] }); return builder; },
    } as unknown as SupabaseClient;

    // Name made entirely of filtered-out abbreviations ("fc sv") → no probe.
    const rows = await loadTeamXGHistoryAsOf(client, "fc sv", "bundesliga", "home", "2024-03-22");
    expect(rows).toEqual([]);
    // Only the exact-match branch should have run; no ilike call.
    expect(calls.filter(c => c.method === "ilike").length).toBe(0);
  });

  it("returns [] when the exact-match query errors out", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = createMockClient({ error: { message: "boom" } });
    const result = await loadTeamXGHistoryAsOf(client, "Foo", "bundesliga", "home", "2024-03-22");
    expect(result).toEqual([]);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe("loadLeagueXGHistoryAsOf", () => {
  it("applies both .gte(seasonStart) AND .lt(cutoff)", async () => {
    const { client, calls } = createMockClient({ data: [] });
    await loadLeagueXGHistoryAsOf(client, "bundesliga", "2024-03-22", "2023-08-01");

    const gtes = calls.filter(c => c.method === "gte");
    const lts = calls.filter(c => c.method === "lt");
    expect(gtes[0].args).toEqual(["match_date", "2023-08-01"]);
    expect(lts[0].args).toEqual(["match_date", "2024-03-22"]);

    // Must fix venue=home so each match appears exactly once
    const eqs = calls.filter(c => c.method === "eq");
    expect(eqs.some(e => e.args[0] === "venue" && e.args[1] === "home")).toBe(true);
  });

  it("orders ascending (caller walks the data chronologically)", async () => {
    const { client, calls } = createMockClient({ data: [] });
    await loadLeagueXGHistoryAsOf(client, "bundesliga", "2024-03-22");

    const orders = calls.filter(c => c.method === "order");
    expect(orders.length).toBe(1);
    expect(orders[0].args[0]).toBe("match_date");
    // Second arg is the options object { ascending: true }
    expect((orders[0].args[1] as { ascending: boolean }).ascending).toBe(true);
  });

  it("defaults the season start to 2017-08-01 when not supplied", async () => {
    const { client, calls } = createMockClient({ data: [] });
    await loadLeagueXGHistoryAsOf(client, "bundesliga", "2024-03-22");

    const gtes = calls.filter(c => c.method === "gte");
    expect(gtes[0].args).toEqual(["match_date", "2017-08-01"]);
  });
});
