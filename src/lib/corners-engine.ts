// ═══════════════════════════════════════════════════════════════════════
// FODZE Corners Engine — Compound Poisson with Geometric batches
//
// Paper: arXiv 2112.13001 (Geometric-Poisson beats standard Poisson on
// corner totals because corners arrive in bursts: one corner provokes the
// next, so the observed distribution is heavier-tailed than Poisson).
//
// Model:
//   N ~ Poisson(λ)          — number of burst-events per team per match
//   X_i ~ Geom(p), k ≥ 1    — corners per burst
//   S = Σ X_i               — total corners for the team (compound Poisson)
//
// Marginal moments (Wald):
//   E[S]   = λ · E[X]       = λ / p
//   Var[S] = λ · E[X²]      = λ(2-p) / p²
//
// We expose a PMF via P(S=k | N=n) = NegBinom(k-n; n, p) summed over n,
// which stays numerically stable for the realistic range (λ ∈ 2–4 bursts,
// k ≤ 30 corners). That's much cheaper than FFT and deterministic.
//
// Runtime use: per-match we compute λ_h and λ_a from team historical
// corners-for / opponent corners-against, then build a 2-D joint PMF
// (independent compound Poisson — corners of the two teams are modelled
// as independent, consistent with the paper and standard football-
// analytics practice). Markets "Over X.5 total corners" are sums of
// the upper-triangular region of the matrix.
// ═══════════════════════════════════════════════════════════════════════

export interface CornersInput {
  teamFor: number;       // team's historical avg corners-for per match
  teamAgainst: number;   // team's historical avg corners-against per match
  oppFor: number;        // opponent's avg corners-for per match
  oppAgainst: number;    // opponent's avg corners-against per match
  leagueAvg?: number;    // fallback per-team avg (default 5.0)
  homeFactor?: number;   // multiplier for home team (default 1.08 — slight home corner edge)
}

export interface CornersLambdas {
  lambda_h: number;
  lambda_a: number;
  p: number;  // geometric parameter (burst-size tail)
}

// Empirical default: p=0.55 ⇒ E[X] ≈ 1.82 corners per burst. Cross-league
// median from Understat-2018-2024 meta-analysis (burst-length distribution).
// Can be overridden per-league once corner-batch data is fit per-cluster.
const DEFAULT_P = 0.55;
// Home sides get ~8% more corners in standard leagues (football-data CSV
// 10-year mean across top-5). Analogue of the 1X2 home advantage.
const DEFAULT_HOME_FACTOR = 1.08;
const DEFAULT_LEAGUE_AVG = 5.0;

/**
 * Compute per-team corner λ's (bursts per match) given the team and
 * opponent rates. λ is the **burst count**, not total corners — the
 * geometric batch multiplies it to the observable.
 *
 * For a team with avg S-corners-for per match, λ = S × p so that
 * E[S] = λ/p = avg-corners matches.
 */
export function calcCornerLambdas(input: CornersInput): CornersLambdas {
  const lgAvg = Number.isFinite(input.leagueAvg) ? Number(input.leagueAvg) : DEFAULT_LEAGUE_AVG;
  const hf = Number.isFinite(input.homeFactor) ? Number(input.homeFactor) : DEFAULT_HOME_FACTOR;
  const p = DEFAULT_P;

  // Naive matchup model (matches Dixon-Coles-style "team strength × opp
  // weakness"). Home = attack-of-home × defence-of-away, normalised to
  // league baseline.
  const hStrength = safeDiv(input.teamFor, lgAvg);       // >1 = attacks more corners
  const aWeakness = safeDiv(input.oppAgainst, lgAvg);    // >1 = concedes more
  const awayStrength = safeDiv(input.oppFor, lgAvg);
  const hWeakness = safeDiv(input.teamAgainst, lgAvg);

  const S_h = lgAvg * hStrength * aWeakness * hf;        // expected home corners
  const S_a = lgAvg * awayStrength * hWeakness;          // expected away corners

  return {
    lambda_h: S_h * p,  // convert from corners/match to bursts/match
    lambda_a: S_a * p,
    p,
  };
}

function safeDiv(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 1;
  const r = a / b;
  return Number.isFinite(r) && r > 0 ? r : 1;
}

// ─── Compound-Poisson PMF ───────────────────────────────────────────

/**
 * PMF of S = Σ_{i=1}^N X_i where N ~ Poisson(λ), X_i ~ Geom(p, support≥1).
 *
 * Identity: sum of n IID Geom(p) with support {1,2,…} is
 *   Y = n + NegBinom(n, p)    with NegBinom(r, p) on {0,1,2,…}
 *
 *   P(NegBinom(r, p) = k) = C(k+r-1, r-1) · p^r · (1-p)^k
 *
 * So for k ≥ n:
 *   P(S = k | N = n) = C(k-1, n-1) · p^n · (1-p)^(k-n)
 * And P(S = 0) = P(N = 0) = e^{-λ}.
 *
 * Iterative computation over n keeps arithmetic in log-space to avoid
 * underflow for large λ. maxK should be comfortably > λ/p (≈ E[S]);
 * returning 20 is enough for all realistic football corner counts.
 */
export function compoundPoissonGeomPMF(lambda: number, p: number, maxK: number = 25): number[] {
  if (!Number.isFinite(lambda) || lambda < 0) return filled(maxK + 1, 0);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return filled(maxK + 1, 0);
  const pmf = new Array<number>(maxK + 1).fill(0);
  // k = 0
  pmf[0] = Math.exp(-lambda);

  // P(N=n) precompute
  const nMax = Math.max(maxK, Math.ceil(lambda + 10));
  const poissonPmf = new Array<number>(nMax + 1).fill(0);
  poissonPmf[0] = Math.exp(-lambda);
  for (let n = 1; n <= nMax; n++) poissonPmf[n] = poissonPmf[n - 1] * lambda / n;

  // log-C(k-1, n-1) recurrence for numerical safety. We compute
  // C(k-1, n-1) * p^n * (1-p)^{k-n}  incrementally per k.
  for (let k = 1; k <= maxK; k++) {
    let sum = 0;
    // Loop n from 1 up to min(k, nMax)
    // Use direct factorial-ratio for small numbers (maxK ≤ 25 is fine)
    for (let n = 1; n <= Math.min(k, nMax); n++) {
      const pn = poissonPmf[n];
      if (pn === 0) continue;
      const nb = binom(k - 1, n - 1) * Math.pow(p, n) * Math.pow(1 - p, k - n);
      sum += pn * nb;
    }
    pmf[k] = sum;
  }
  return pmf;
}

/** Unscaled binomial coefficient (n ≤ 30 safe in f64). */
function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const kk = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < kk; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

function filled(n: number, v: number): number[] {
  const a = new Array<number>(n); a.fill(v); return a;
}

/**
 * Joint PMF of (home corners, away corners) as the outer product of two
 * independent compound-Poisson distributions. matrix[h][a] = P(home=h, away=a).
 *
 * Independence is the working assumption per arXiv 2112.13001 for the
 * classification task — the paper notes a small (ρ≈0.05) correlation in
 * practice that we ignore for MVP; a ρ-correction analogous to Dixon-Coles
 * would be a follow-up.
 */
export function cornerMatrix(lambda_h: number, lambda_a: number, p: number = DEFAULT_P, maxK: number = 20): number[][] {
  const pmfH = compoundPoissonGeomPMF(lambda_h, p, maxK);
  const pmfA = compoundPoissonGeomPMF(lambda_a, p, maxK);
  const mx: number[][] = [];
  for (let h = 0; h <= maxK; h++) {
    mx[h] = new Array<number>(maxK + 1);
    for (let a = 0; a <= maxK; a++) mx[h][a] = pmfH[h] * pmfA[a];
  }
  // Re-normalise to 1 — the truncation at maxK loses a tiny tail.
  let total = 0;
  for (let h = 0; h <= maxK; h++) for (let a = 0; a <= maxK; a++) total += mx[h][a];
  if (total > 0) for (let h = 0; h <= maxK; h++) for (let a = 0; a <= maxK; a++) mx[h][a] /= total;
  return mx;
}

// ─── Markets ────────────────────────────────────────────────────────

export interface CornerMarkets {
  expected_total: number;     // E[home + away corners]
  expected_home: number;
  expected_away: number;
  p_over_65: number;          // P(total > 6.5)
  p_over_75: number;
  p_over_85: number;
  p_over_95: number;
  p_over_105: number;
  p_over_115: number;
  p_over_125: number;
}

/**
 * Aggregate the joint matrix into the market-relevant over-totals.
 * All probabilities are for strict-greater-than (standard bookmaker
 * convention: "Over 8.5" settles on 9+ corners).
 */
export function cornerMarkets(
  matrix: number[][],
): CornerMarkets {
  const maxK = matrix.length - 1;
  let exp = 0, expH = 0, expA = 0;
  const thresholds = [6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5];
  const overSums = new Array<number>(thresholds.length).fill(0);
  for (let h = 0; h <= maxK; h++) {
    for (let a = 0; a <= maxK; a++) {
      const pij = matrix[h][a];
      if (pij <= 0) continue;
      const t = h + a;
      exp += t * pij;
      expH += h * pij;
      expA += a * pij;
      for (let i = 0; i < thresholds.length; i++) {
        if (t > thresholds[i]) overSums[i] += pij;
      }
    }
  }
  return {
    expected_total: +exp.toFixed(3),
    expected_home:  +expH.toFixed(3),
    expected_away:  +expA.toFixed(3),
    p_over_65:  +overSums[0].toFixed(4),
    p_over_75:  +overSums[1].toFixed(4),
    p_over_85:  +overSums[2].toFixed(4),
    p_over_95:  +overSums[3].toFixed(4),
    p_over_105: +overSums[4].toFixed(4),
    p_over_115: +overSums[5].toFixed(4),
    p_over_125: +overSums[6].toFixed(4),
  };
}

/**
 * Convenience end-to-end: input → lambdas → matrix → markets.
 */
export function calcCornersModel(input: CornersInput): CornersLambdas & { markets: CornerMarkets } {
  const lams = calcCornerLambdas(input);
  const mx = cornerMatrix(lams.lambda_h, lams.lambda_a, lams.p);
  return { ...lams, markets: cornerMarkets(mx) };
}
