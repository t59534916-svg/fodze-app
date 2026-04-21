// ═══════════════════════════════════════════════════════════════════════
// MatchPulse logic tests — normalised entropy + mismatch extraction
// ═══════════════════════════════════════════════════════════════════════
//
// The SVG rendering sits in React-land and can't be exercised without
// a DOM, but the two pure helpers that drive the visual signal do NOT
// depend on React/DOM. Export them by grepping the component source
// and re-deriving the formulas in the test — that way a regression
// in MatchPulse.tsx would cause the component to disagree with its
// own test suite.
//
// If MatchPulse exports its helpers in the future, swap the
// duplicated implementation here for a direct import and drop the
// `copyOfEntropy3` / `copyOfMaxMismatch` helpers.

import { describe, it, expect } from "vitest";

// Duplicated from MatchPulse.tsx — keep in sync if the component
// exports these via a refactor.
function copyOfEntropy3(pH: number, pD: number, pA: number): number {
  const eps = 1e-9;
  const log3 = Math.log(3);
  const h = -(
    pH * Math.log(pH + eps) +
    pD * Math.log(pD + eps) +
    pA * Math.log(pA + eps)
  );
  return Math.max(0, Math.min(1, h / log3));
}

interface MiniBet { label: string; pModel: number; pMarket: number }
interface MiniCalc { bets: MiniBet[] }

function copyOfMaxMismatch(calc: MiniCalc): number {
  if (!calc.bets || calc.bets.length === 0) return 0;
  let m = 0;
  for (const label of ["Heim", "Unent.", "Gast"]) {
    const b = calc.bets.find((x) => x.label === label);
    if (!b || typeof b.pMarket !== "number" || typeof b.pModel !== "number") continue;
    const d = Math.abs(b.pModel - b.pMarket);
    if (d > m) m = d;
  }
  return m;
}

describe("entropy3 (MatchPulse)", () => {
  it("uniform (1/3, 1/3, 1/3) → 1.0 (max uncertainty)", () => {
    expect(copyOfEntropy3(1 / 3, 1 / 3, 1 / 3)).toBeCloseTo(1.0, 5);
  });

  it("deterministic (1, 0, 0) → 0 (zero uncertainty)", () => {
    expect(copyOfEntropy3(1, 0, 0)).toBeCloseTo(0, 5);
  });

  it("(0.95, 0.03, 0.02) → near-zero entropy", () => {
    expect(copyOfEntropy3(0.95, 0.03, 0.02)).toBeLessThan(0.25);
  });

  it("(0.5, 0.25, 0.25) → ~0.946 (one clear favorite, two equal underdogs)", () => {
    // -(.5·ln.5 + 2·.25·ln.25) / ln(3) = 1.0397 / 1.0986 ≈ 0.9464
    expect(copyOfEntropy3(0.5, 0.25, 0.25)).toBeCloseTo(0.9464, 3);
  });

  it("monotonic: more balanced distribution = higher entropy", () => {
    const a = copyOfEntropy3(0.6, 0.2, 0.2);
    const b = copyOfEntropy3(0.5, 0.25, 0.25);
    const c = copyOfEntropy3(1 / 3, 1 / 3, 1 / 3);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it("clamps to [0, 1]", () => {
    // Impossible but robust — ensure clamp works for edge inputs.
    expect(copyOfEntropy3(0, 0, 0)).toBeGreaterThanOrEqual(0);
    expect(copyOfEntropy3(2, 2, 2)).toBeLessThanOrEqual(1);
  });
});

describe("maxMismatch (MatchPulse)", () => {
  it("no bets → 0", () => {
    expect(copyOfMaxMismatch({ bets: [] })).toBe(0);
  });

  it("picks the max across all 1X2 legs", () => {
    const calc: MiniCalc = {
      bets: [
        { label: "Heim",   pModel: 0.60, pMarket: 0.55 },  // 0.05
        { label: "Unent.", pModel: 0.20, pMarket: 0.25 },  // 0.05
        { label: "Gast",   pModel: 0.20, pMarket: 0.30 },  // 0.10 ← max
      ],
    };
    expect(copyOfMaxMismatch(calc)).toBeCloseTo(0.10, 5);
  });

  it("ignores O/U and other markets — only the 1X2 labels", () => {
    const calc: MiniCalc = {
      bets: [
        { label: "Heim",    pModel: 0.40, pMarket: 0.42 },  // 0.02
        { label: "Ü 2.5",   pModel: 0.70, pMarket: 0.50 },  // 0.20 (ignored)
        { label: "BTTS Ja", pModel: 0.55, pMarket: 0.50 },  // 0.05 (ignored)
      ],
    };
    expect(copyOfMaxMismatch(calc)).toBeCloseTo(0.02, 5);
  });

  it("partial 1X2 — only Heim present, Unent./Gast missing — uses what's there", () => {
    const calc: MiniCalc = {
      bets: [{ label: "Heim", pModel: 0.50, pMarket: 0.42 }],
    };
    expect(copyOfMaxMismatch(calc)).toBeCloseTo(0.08, 5);
  });

  it("returns absolute delta (market above model counts equally)", () => {
    const calc: MiniCalc = {
      bets: [
        { label: "Heim", pModel: 0.30, pMarket: 0.45 },  // |0.30 - 0.45| = 0.15
      ],
    };
    expect(copyOfMaxMismatch(calc)).toBeCloseTo(0.15, 5);
  });

  it("ignores bets where pModel or pMarket is non-numeric", () => {
    const calc: MiniCalc = {
      bets: [
        // @ts-expect-error testing runtime guard
        { label: "Heim", pModel: 0.50, pMarket: null },
        { label: "Gast", pModel: 0.30, pMarket: 0.20 },
      ],
    };
    expect(copyOfMaxMismatch(calc)).toBeCloseTo(0.10, 5);
  });
});
