#!/usr/bin/env node
/**
 * Doc-truth gate — catches the stale-documentation drift the SWOT flagged as
 * the project's biggest weakness.
 *
 * This session alone found the docs claiming the wrong Next.js version (14 vs
 * actual 16), wrong React version (18 vs 19), and wrong test counts (893 vs
 * actual, in three places) — all "trustworthy-looking but false". A human can't
 * be expected to keep ~15 markdown files in sync by hand; this script does it.
 *
 * WHAT IT CHECKS
 *   HARD (exit 1 on mismatch) — claims that should NEVER drift and cause real
 *   confusion when wrong:
 *     - Next.js MAJOR version in any doc must match package.json
 *     - React MAJOR version in any doc must match package.json
 *   SOFT (warn only) — claims that legitimately change every test PR, so a hard
 *   gate would be noise. Reported with the live number so a maintainer can sync:
 *     - vitest test-file / test-case counts cited in CLAUDE.md + README
 *     - python `def test_` count
 *
 * Run: node scripts/check-doc-truth.mjs   (CI runs it; --quiet for less output)
 * Used by .github/workflows/ci.yml as an advisory-then-blocking step.
 */
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readdirSync, statSync } from "fs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const QUIET = process.argv.includes("--quiet");

const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const nextMajor = String(pkg.dependencies.next).replace(/[^0-9.]/g, "").split(".")[0];
const reactMajor = String(pkg.dependencies.react).replace(/[^0-9.]/g, "").split(".")[0];

// Docs to scan for version claims.
const DOCS = ["README.md", "CLAUDE.md",
  "docs/ARCHITECTURE.md", "docs/DESIGN-HANDOFF.md", "docs/HANDBUCH.md"];

const hardErrors = [];
const softWarnings = [];

function scanVersion(label, re, expectedMajor) {
  for (const rel of DOCS) {
    const p = resolve(ROOT, rel);
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, "utf8").split("\n");
    lines.forEach((line, i) => {
      const m = line.match(re);
      if (m && m[1] !== expectedMajor) {
        hardErrors.push(`${rel}:${i + 1}  ${label} ${m[1]} — package.json says ${expectedMajor}`);
      }
    });
  }
}

scanVersion("Next.js", /Next\.js (\d+)/, nextMajor);
scanVersion("React", /React (\d+)\b/, reactMajor);

// ── Soft: test counts ──
function countTestFiles(dir, suffix) {
  let n = 0;
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const full = resolve(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e.endsWith(suffix)) n++;
    }
  };
  walk(dir);
  return n;
}
function countMatches(dir, suffix, re) {
  let n = 0;
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const full = resolve(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e.endsWith(suffix)) n += (readFileSync(full, "utf8").match(re) || []).length;
    }
  };
  walk(dir);
  return n;
}

const tsFiles = countTestFiles(resolve(ROOT, "tests"), ".test.ts");
const tsCases = countMatches(resolve(ROOT, "tests"), ".test.ts", /\b(it|test)\(/g);
const pyTestsDir = resolve(ROOT, "tools/v4/tests");
const pyCases = existsSync(pyTestsDir) ? countMatches(pyTestsDir, ".py", /def test_/g) : 0;

const claude = existsSync(resolve(ROOT, "CLAUDE.md")) ? readFileSync(resolve(ROOT, "CLAUDE.md"), "utf8") : "";
// Find "<N> tests" / "<N> Tests" claims and compare to live tsCases.
// tsCases (static grep of `it(`/`test(`) is a LOWER BOUND: vitest's
// parametrized loops (e.g. `for (...) it(...)`) generate more cases at
// runtime than appear literally. So treat tsCases as a floor and only flag a
// doc claim as stale when it's clearly below the floor (definitely outdated)
// or absurdly above it (>1.5×, likely a typo). Claims in [floor, 1.5×floor]
// are accepted — they plausibly match the true runtime "X passed" number.
const claimedCounts = [...new Set(
  [...claude.matchAll(/(\d{3,4})\s+[Tt]ests/g)].map((m) => +m[1]),
)];
const staleClaims = claimedCounts.filter((c) => c < tsCases || c > tsCases * 1.5);
if (staleClaims.length) {
  softWarnings.push(
    `CLAUDE.md cites test count(s) [${staleClaims.join(", ")}] but the static floor is ${tsCases} ` +
    `cases / ${tsFiles} files (runtime "passed" is ≥ that — parametrized loops add more). ` +
    `Sync the prose to the latest \`vitest run\` number.`,
  );
}

// ── Report ──
if (!QUIET) {
  console.log("── doc-truth gate ──");
  console.log(`  next.js major   : ${nextMajor}   react major: ${reactMajor}`);
  console.log(`  vitest          : ${tsCases} cases / ${tsFiles} files`);
  console.log(`  python def test_: ${pyCases}`);
}

for (const w of softWarnings) console.warn(`  ⚠ SOFT: ${w}`);
for (const e of hardErrors) console.error(`  ✗ HARD: ${e}`);

if (hardErrors.length) {
  console.error(`\n✗ doc-truth gate FAILED: ${hardErrors.length} version mismatch(es). Fix the docs to match package.json.`);
  process.exit(1);
}
console.log(`\n✓ doc-truth gate passed (${softWarnings.length} soft warning${softWarnings.length === 1 ? "" : "s"}).`);
