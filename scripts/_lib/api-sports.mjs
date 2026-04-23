// ═══════════════════════════════════════════════════════════════════════
// FODZE — api-sports (v3.football.api-sports.io) thin client
// ═══════════════════════════════════════════════════════════════════════
//
// Free-Tier Constraints (2026):
//   - 100 Requests pro Tag
//   - 10 Requests pro Minute
//   - Nur aktuelle Saison (historischer Backfill gesperrt)
//
// Der Client respektiert beide Limits automatisch:
//   - Parst die Response-Header (x-ratelimit-requests-remaining,
//     X-RateLimit-Remaining) und drosselt bei Bedarf per sleep
//   - Bricht ab wenn Tageskontingent unter `minRemaining` fällt
//
// ENV (in .env.local):
//   API_SPORTS_KEY=xxx      (direkter Account, primäre Route)
//   — ODER —
//   RAPIDAPI_KEY=xxx        (via RapidAPI)
//
// FODZE-League-Key → api-sports league-id mapping unten. Wenn eine ID
// falsch ist sieht man's beim ersten Fetch: response.results === 0.
// ═══════════════════════════════════════════════════════════════════════

const DIRECT_HOST = "https://v3.football.api-sports.io";
const RAPIDAPI_HOST = "https://api-football-v1.p.rapidapi.com/v3";

// FODZE league key → api-sports league-id. Verified against v3 docs.
// If any id misses on first run, fix here and re-run.
export const API_SPORTS_LEAGUE_IDS = {
  bundesliga: 78,
  bundesliga2: 79,
  liga3: 80,
  epl: 39,
  championship: 40,
  league_one: 41,
  league_two: 42,
  la_liga: 140,
  la_liga2: 141,
  serie_a: 135,
  serie_b: 136,
  ligue_1: 61,
  ligue_2: 62,
  eredivisie: 88,
  primeira_liga: 94,
  jupiler_pro: 144,
  super_lig: 203,
  scottish_prem: 179,
  greek_sl: 197,
  // Central-Euro additions (api-sports v3 IDs verified 2026-04)
  austria_bl: 218,      // Österreichische Bundesliga
  swiss_sl: 207,        // Swiss Super League
  eerste_divisie: 89,   // Netherlands 2. Liga
};

export function resolveApiSportsLeagueId(fodzeKey) {
  return API_SPORTS_LEAGUE_IDS[fodzeKey] ?? null;
}

// Saison-Konvention bei api-sports: start-year (2024/25 → 2024).
export function seasonStartYear(now = new Date()) {
  // Euro-Saisons starten ~Juli. Bis Juni zurückrollen auf Vorjahr.
  const m = now.getUTCMonth(); // 0 = Jan
  return m < 6 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
}

// Free-Tier erlaubt aktuell Saisons 2022, 2023, 2024 — NICHT current.
// Für Historical-Backfill nutze 2024 (Saison 2024/25) als default, sonst
// override via --season CLI-Flag.
export const FREE_TIER_SEASONS = [2022, 2023, 2024];
export const FREE_TIER_LATEST = 2024;

// Alias für backwards-compat (kein ruft's intern mehr auf)
export const currentSeasonYear = seasonStartYear;

// ─── Client ──────────────────────────────────────────────────────

// Read api-sports keys from env: supports single `API_SPORTS_KEY` or
// additional `API_SPORTS_KEY_2`, `API_SPORTS_KEY_3`, ... RapidAPI keys
// via `RAPIDAPI_KEY` / `RAPIDAPI_KEY_2`. The client tries the first
// non-exhausted key on every request — when a key's daily quota drops
// below `minRemaining`, we rotate to the next one. Effective daily
// budget = sum of all keys' budgets.
function collectDirectKeysFromEnv() {
  const keys = [];
  if (process.env.API_SPORTS_KEY) keys.push(process.env.API_SPORTS_KEY);
  for (let i = 2; i <= 10; i++) {
    const k = process.env[`API_SPORTS_KEY_${i}`];
    if (k) keys.push(k);
  }
  return keys;
}
function collectRapidKeysFromEnv() {
  const keys = [];
  if (process.env.RAPIDAPI_KEY) keys.push(process.env.RAPIDAPI_KEY);
  for (let i = 2; i <= 10; i++) {
    const k = process.env[`RAPIDAPI_KEY_${i}`];
    if (k) keys.push(k);
  }
  return keys;
}

export function createApiSportsClient({
  directKeys,
  rapidKeys,
  minRemaining = 5,       // rotate to next key when daily drops below this
  // Per-Minute-Rate-Limits (api-sports v3, Stand 2026-04-24):
  //   Free  = 10 r/m    → 7000ms buffer = ~8.5 r/m  ← wir (Default)
  //   Pro   = 300 r/m   → 220ms
  //   Ultra = 450 r/m   → 140ms
  //   Mega  = 900 r/m   → 70ms
  // Die Doku WARNT ausdrücklich vor permanenten Firewall-Blocks bei
  // Überschreitung. Default auf sicherem Free-Tier-Abstand; ein
  // zahlender Account kann `perMinuteBuffer: 220` explizit setzen.
  perMinuteBuffer = 7000,
  verbose = false,
} = {}) {
  const dKeys = Array.isArray(directKeys) ? directKeys : (directKeys ? [directKeys] : collectDirectKeysFromEnv());
  const rKeys = Array.isArray(rapidKeys)  ? rapidKeys  : (rapidKeys  ? [rapidKeys]  : collectRapidKeysFromEnv());
  if (dKeys.length === 0 && rKeys.length === 0) {
    throw new Error("Missing API_SPORTS_KEY (or RAPIDAPI_KEY) in env");
  }
  const useDirect = dKeys.length > 0;
  const host = useDirect ? DIRECT_HOST : RAPIDAPI_HOST;
  const activeKeys = useDirect ? dKeys : rKeys;

  const keyHeaders = (k) => useDirect
    ? { "x-apisports-key": k }
    : {
        "x-rapidapi-key": k,
        "x-rapidapi-host": "api-football-v1.p.rapidapi.com",
      };

  // Per-key state: tracks dailyRemaining so we can rotate on exhaustion
  const keyStates = activeKeys.map((k, i) => ({
    keyId: i,
    dailyRemaining: null,
    minuteRemaining: null,
    exhausted: false,
  }));

  const state = {
    requestsDone: 0,
    dailyRemaining: null,   // aggregated view: min of non-exhausted keys
    minuteRemaining: null,
    lastHeadersAt: 0,
    quotaExhausted: false,
    activeKeyId: 0,
    totalKeys: activeKeys.length,
  };

  function pickNextKey() {
    // Find first non-exhausted key, starting from activeKeyId
    for (let i = 0; i < keyStates.length; i++) {
      const idx = (state.activeKeyId + i) % keyStates.length;
      if (!keyStates[idx].exhausted) return idx;
    }
    return -1;
  }

  const log = (...args) => { if (verbose) console.log("[api-sports]", ...args); };

  async function sleep(ms) {
    if (ms <= 0) return;
    await new Promise(r => setTimeout(r, ms));
  }

  async function request(path, params = {}) {
    // Find an active key; if all exhausted → global quota-exhausted
    const keyIdx = pickNextKey();
    if (keyIdx === -1) {
      state.quotaExhausted = true;
      return { ok: false, error: "quota-exhausted", data: null };
    }
    state.activeKeyId = keyIdx;
    const currentKey = activeKeys[keyIdx];
    const ks = keyStates[keyIdx];

    // Pre-check: this key's remaining
    if (ks.dailyRemaining != null && ks.dailyRemaining < minRemaining) {
      ks.exhausted = true;
      log(`key #${keyIdx} daily ≤ ${minRemaining} — rotate`);
      return request(path, params);
    }
    // Per-Minute-Bremse (per key)
    if (ks.minuteRemaining != null && ks.minuteRemaining <= 1) {
      log(`key #${keyIdx} per-minute erreicht — warte 60s`);
      await sleep(60_000);
      ks.minuteRemaining = null;
    }

    const qs = new URLSearchParams(params).toString();
    const url = `${host}${path}${qs ? `?${qs}` : ""}`;
    const start = Date.now();
    let res;
    try {
      res = await fetch(url, { headers: keyHeaders(currentKey) });
    } catch (e) {
      return { ok: false, error: `network: ${e.message}`, data: null };
    }

    const rem = res.headers.get("x-ratelimit-requests-remaining");
    const minRem = res.headers.get("x-ratelimit-remaining");
    if (rem != null) ks.dailyRemaining = parseInt(rem, 10);
    if (minRem != null) ks.minuteRemaining = parseInt(minRem, 10);

    // Aggregated view: min daily remaining across non-exhausted keys
    const liveDailies = keyStates.filter(s => !s.exhausted && s.dailyRemaining != null).map(s => s.dailyRemaining);
    state.dailyRemaining = liveDailies.length > 0 ? Math.min(...liveDailies) : ks.dailyRemaining;
    state.minuteRemaining = ks.minuteRemaining;
    state.lastHeadersAt = Date.now();
    state.requestsDone++;

    if (res.status === 429) {
      log(`key #${keyIdx} 429 rate-limit — mark exhausted, rotate`);
      ks.exhausted = true;
      return request(path, params);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `${res.status}: ${body.slice(0, 200)}`, data: null };
    }

    const json = await res.json();
    if (json.errors && ((Array.isArray(json.errors) && json.errors.length) ||
                        (typeof json.errors === "object" && Object.keys(json.errors).length))) {
      // api-sports signalisiert erschöpftes Tagesbudget NICHT über 429,
      // sondern über 200 OK mit errors.requests = "You have reached...".
      // Mark key as exhausted + rotate statt den Fehler als plan-error
      // durchzureichen.
      const errs = json.errors;
      const isReqLimit = (typeof errs === "object" && !Array.isArray(errs) && errs.requests) ||
                        (Array.isArray(errs) && errs.some(e => typeof e === "string" && /reached the request limit/i.test(e)));
      if (isReqLimit) {
        log(`key #${keyIdx} request-limit via body — mark exhausted, rotate`);
        ks.exhausted = true;
        return request(path, params);
      }
      return { ok: false, error: `api-errors: ${JSON.stringify(json.errors)}`, data: null };
    }

    await sleep(perMinuteBuffer);
    log(`${path} ${res.status} · ${json.results ?? "?"} results · ` +
        `key=${keyIdx} daily=${ks.dailyRemaining ?? "?"} minute=${ks.minuteRemaining ?? "?"} · ` +
        `${Date.now() - start}ms`);
    return { ok: true, error: null, data: json };
  }

  // ─── High-level helpers ────────────────────────────────────────

  async function getFixtures({ league, season, from, to, date, status }) {
    const params = { league: String(league), season: String(season) };
    if (from) params.from = from;
    if (to) params.to = to;
    if (date) params.date = date;
    if (status) params.status = status;
    return request("/fixtures", params);
  }

  async function getFixtureStatistics(fixtureId) {
    return request("/fixtures/statistics", { fixture: String(fixtureId) });
  }

  async function getInjuries({ league, season, date }) {
    const params = { league: String(league), season: String(season) };
    if (date) params.date = date;
    return request("/injuries", params);
  }

  async function getStandings({ league, season }) {
    return request("/standings", { league: String(league), season: String(season) });
  }

  async function getLineups(fixtureId) {
    return request("/fixtures/lineups", { fixture: String(fixtureId) });
  }

  return {
    request,
    getFixtures,
    getFixtureStatistics,
    getInjuries,
    getStandings,
    getLineups,
    state, // zum Inspizieren (requestsDone, dailyRemaining, ...)
  };
}

// ─── Stats-Parser ────────────────────────────────────────────────
//
// api-sports /fixtures/statistics response shape (v3):
//   response: [
//     { team: { id, name }, statistics: [{ type, value }, ...] },
//     ...  // one block per team
//   ]
//
// Wichtigste type-Werte: "Shots on Goal", "Shots off Goal", "Total Shots",
// "Blocked Shots", "Shots insidebox", "Shots outsidebox", "Fouls",
// "Corner Kicks", "Offsides", "Ball Possession", "Yellow Cards",
// "Red Cards", "Goalkeeper Saves", "Total passes", "Passes accurate",
// "Passes %", "expected_goals".
//
// `expected_goals` wird seit 2022 für die meisten Top-Ligen + manche
// Nebenligen geliefert (free-tier inklusive). Wenn null, dann hat
// api-sports kein xG für diese Liga → fallback auf shots-model.

const STAT_KEY_MAP = {
  "Shots on Goal": "shots_on_target",
  "Shots off Goal": "shots_off_target",
  "Total Shots": "shots_total",
  "Blocked Shots": "shots_blocked",
  "Shots insidebox": "shots_inside_box",
  "Shots outsidebox": "shots_outside_box",
  "Fouls": "fouls",
  "Corner Kicks": "corners",
  "Offsides": "offsides",
  "Ball Possession": "possession_pct",
  "Yellow Cards": "yellow_cards",
  "Red Cards": "red_cards",
  "Goalkeeper Saves": "gk_saves",
  "Total passes": "passes_total",
  "Passes accurate": "passes_accurate",
  "Passes %": "pass_pct",
  "expected_goals": "xg",
};

/**
 * Parse fixture-statistics response in a per-team dict.
 * Returns { [teamId]: { shots_on_target: n, shots_total: n, xg: n, ... } }
 *
 * Numeric coercion: "58%" → 58, "0.73" → 0.73, "3" → 3. Null stays null
 * (missing values are meaningful — don't synthesize).
 */
export function parseFixtureStatistics(response) {
  if (!response || !Array.isArray(response.response)) return {};
  const out = {};
  for (const block of response.response) {
    const teamId = block?.team?.id;
    if (!teamId) continue;
    const stats = {};
    for (const s of block.statistics || []) {
      const key = STAT_KEY_MAP[s.type];
      if (!key) continue;
      stats[key] = normalizeStatValue(s.value);
    }
    out[teamId] = {
      teamName: block.team?.name ?? null,
      stats,
    };
  }
  return out;
}

function normalizeStatValue(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  // Prozent-Werte wie "58%" → 58
  if (trimmed.endsWith("%")) {
    const n = parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(n) ? n : null;
  }
  const n = parseFloat(trimmed);
  return Number.isFinite(n) ? n : null;
}
