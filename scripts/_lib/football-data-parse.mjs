// ═══════════════════════════════════════════════════════════════════════
// FODZE football-data.co.uk CSV parse helpers
//
// Shared between scripts/backfill-football-data-co-uk.mjs and the unit-test
// suite (tests/football-data-parse.test.ts). All functions are pure and
// deterministic — no fs, no network, no Supabase.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Decode a binary buffer (Uint8Array | Buffer) from Windows-1252 to UTF-16.
 * Full-ICU Node (default prebuilt binary) handles 'windows-1252' directly;
 * minimal builds fall back to 'latin1', which is a close-enough superset
 * for Western-European diacritics used in football team names.
 */
export function decodeBuffer(buf) {
  try {
    return new TextDecoder("windows-1252").decode(buf);
  } catch {
    return Buffer.from(buf).toString("latin1");
  }
}

/**
 * Minimal CSV parser — splits on commas, trims cells, strips UTF-8 BOM.
 * football-data.co.uk CSVs never quote team names, so we don't handle
 * quoted fields (keeping parsing trivial and fast).
 *
 * Returns { headers: string[], rows: Record<string,string>[] }.
 * Missing cells become "" (not null) so callers can check emptiness
 * with a simple `if (!cell)` check.
 */
// Strip surrounding double-quotes from a CSV cell (if present) and
// un-escape the CSV-standard `""` → `"` inside the quoted region.
// Only quotes on the FULL outside are treated as delimiters — stray
// quotes in the middle (very rare in our inputs) are kept as-is.
function unquoteCell(s) {
  if (s == null) return "";
  const t = String(s).trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/""/g, '"');
  }
  return t;
}

// Split a CSV line respecting quoted fields (which may contain commas).
// Keeps leading/trailing quotes on returned cells — unquoteCell then
// strips them. Handles RFC-4180 `""` escape for literal quote inside.
function splitCsvLine(line) {
  const out = [];
  let buf = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        buf += '""'; i++;
      } else if (ch === '"') {
        inQuotes = false; buf += ch;
      } else {
        buf += ch;
      }
    } else {
      if (ch === '"') { inQuotes = true; buf += ch; }
      else if (ch === ",") { out.push(buf); buf = ""; }
      else buf += ch;
    }
  }
  out.push(buf);
  return out;
}

export function parseCsv(text) {
  const clean = (text ?? "").replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length < 2) return { headers: [], rows: [] };
  // Headers: quoted-aware split + unquote. football-data.co.uk has no
  // quotes → passthrough. worldfootballR/R-export has quotes around every
  // field → stripped here so downstream lookups `r.Min_Playing` work.
  const headers = splitCsvLine(lines[0]).map(unquoteCell);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = unquoteCell(vals[j] ?? "");
    }
    rows.push(row);
  }
  return { headers, rows };
}

/**
 * Parse "DD/MM/YYYY" or "DD/MM/YY" → "YYYY-MM-DD".
 * Two-digit years default to 20YY (football-data.co.uk CSVs only go
 * back to 1993; the 2-digit edge cases all resolve correctly within
 * that window when prefixed with "20").
 *
 * Returns null on format mismatch (caller typically skips the row).
 */
export function parseDate(ddmmyyyy) {
  if (!ddmmyyyy) return null;
  const parts = ddmmyyyy.split("/");
  if (parts.length !== 3) return null;
  const [d, m, y] = parts;
  if (!/^\d{1,2}$/.test(d) || !/^\d{1,2}$/.test(m) || !/^\d{2}(\d{2})?$/.test(y)) return null;
  const year = y.length === 4 ? y : `20${y}`;
  return `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/**
 * Parse a CSV cell into a positive number, or null if empty/invalid/≤0.
 * Odds cells with "0", "", "NaN", or garbage all collapse to null so the
 * Supabase NUMERIC NULL columns land correctly.
 */
export function numOrNull(s) {
  if (s == null) return null;
  const trimmed = String(s).trim();
  if (!trimmed) return null;
  const n = parseFloat(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Parse a CSV cell into a signed finite number, or null. Unlike numOrNull,
 * this accepts 0 and negative values — used for Asian Handicap lines
 * (AHh/AHCh are often negative, e.g. -1.25 means the home side gives 1.25
 * goals of handicap).
 */
export function numOrNullSigned(s) {
  if (s == null) return null;
  const trimmed = String(s).trim();
  if (!trimmed) return null;
  const n = parseFloat(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a CSV cell into an integer, or null. Used for FT goal counts —
 * 0 is a VALID return here (unlike numOrNull which rejects 0 as an odd).
 */
export function intOrNull(s) {
  if (s == null) return null;
  const trimmed = String(s).trim();
  if (!trimmed) return null;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * "H" / "D" / "A" from home- vs away-goals; null if either input is null.
 */
export function resultFromGoals(h, a) {
  if (h == null || a == null) return null;
  if (h > a) return "H";
  if (h < a) return "A";
  return "D";
}

/**
 * Transform football-data.co.uk CSV rows into odds_closing_history upsert
 * payloads. Rows without team names, without a parseable date, or without
 * ANY Pinnacle Closing 1X2 column are filtered (they add no signal).
 *
 * Returns { rows, skipped } where `skipped` counts rejected CSV rows so
 * the caller can log coverage accurately.
 */
export function buildRows(league, season, csvRows) {
  const out = [];
  let skipped = 0;
  for (const r of csvRows) {
    const home = (r.HomeTeam || r.Home || "").trim();
    const away = (r.AwayTeam || r.Away || "").trim();
    const date = parseDate(r.Date || "");
    if (!home || !away || !date) { skipped++; continue; }

    const psch = numOrNull(r.PSCH);
    const pscd = numOrNull(r.PSCD);
    const psca = numOrNull(r.PSCA);
    if (psch == null && pscd == null && psca == null) { skipped++; continue; }

    const fth = intOrNull(r.FTHG);
    const fta = intOrNull(r.FTAG);
    const match_key = `${league}|${home}|${away}|${date}`;

    out.push({
      match_key,
      league,
      match_date: date,
      home_team: home,
      away_team: away,
      psch, pscd, psca,
      psc_over25: numOrNull(r["PSC>2.5"]),
      psc_under25: numOrNull(r["PSC<2.5"]),
      pscahh: numOrNull(r.PSCAHH),
      pscaha: numOrNull(r.PSCAHA),
      ah_line: numOrNullSigned(r.AHCh) ?? numOrNullSigned(r.AHh),
      ft_result: resultFromGoals(fth, fta),
      ft_goals_h: fth,
      ft_goals_a: fta,
      source: "football-data.co.uk",
    });
  }
  return { rows: out, skipped };
}
