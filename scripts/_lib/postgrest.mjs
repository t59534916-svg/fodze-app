// ═══════════════════════════════════════════════════════════════════════
// scripts/_lib/postgrest.mjs
// Small shared helpers for hand-rolled PostgREST URL construction in the
// .mjs cron scripts (which can't import the Supabase JS client without
// pulling all of @supabase/supabase-js into a Node-script bundle).
//
// Keep this file lean. If it grows past ~5 functions, consider just
// pulling in @supabase/postgrest-js directly.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build a single value for use inside a PostgREST `=in.(...)` filter.
 *
 * PostgREST lexes the in-list as comma-separated tokens; values containing
 * commas, quotes, or backslashes must be double-quoted with `"` and any
 * literal `"` or `\` escaped with a backslash. The result still needs URL
 * encoding before going into the URL.
 *
 * Escape order matters: escape PostgREST specials FIRST (we're producing
 * a PostgREST lexer token), THEN URL-encode the whole thing. If you
 * URL-encode first, `encodeURIComponent` will replace `"` with `%22` so
 * the escape pass sees nothing left to escape — and PostgREST then decodes
 * the URL back to a raw `"` and parses it as a quote terminator → broken
 * lex with no error from our side.
 *
 *   inEscape('foo,bar')   → '"foo,bar"'          (after URL-encode: %22foo%2Cbar%22)
 *   inEscape('he said "hi"') → '"he said \\"hi\\""'
 *
 * Use it like:
 *   const ids = keys.map(inEscape).join(",");
 *   const url = `?match_key=in.(${encodeURIComponent(ids)})`;
 *
 * @param {string} value
 * @returns {string} A quoted, PostgREST-escaped token (NOT URL-encoded yet).
 */
export function inEscape(value) {
  return `"${String(value).replace(/[\\"]/g, (c) => "\\" + c)}"`;
}

/**
 * Build a PostgREST `=in.(...)` filter expression from an array of values.
 * Handles both PostgREST escaping AND URL-encoding in one call. The caller
 * just concatenates the result into the URL.
 *
 *   buildInFilter("match_key", ["a", "b,c"])
 *     → 'match_key=in.(%22a%22%2C%22b%5C%2Cc%22)'
 *
 * @param {string} column   PostgREST column name (assumed safe, not encoded)
 * @param {Iterable<string>} values
 * @returns {string} The full `<column>=in.(<encoded list>)` fragment.
 */
export function buildInFilter(column, values) {
  const tokens = [...values].map(inEscape).join(",");
  return `${column}=in.(${encodeURIComponent(tokens)})`;
}
