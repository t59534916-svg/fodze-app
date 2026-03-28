// ═══════════════════════════════════════════════════════════════════
// FODZE FULL MATCHDAY ANALYSIS — 22.03.2026
// Dixon-Coles bivariate Poisson · rho=-0.05 · MAX_GOALS=15
// ═══════════════════════════════════════════════════════════════════

const RHO = -0.05, MAX_GOALS = 15;

function poissonPMF(k, lam) {
  if (lam <= 0) return k === 0 ? 1 : 0;
  let logP = -lam + k * Math.log(lam);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function buildMatrix(lamH, lamA) {
  const n = MAX_GOALS;
  const mx = Array.from({length:n}, ()=>Array(n).fill(0));
  for (let i=0;i<n;i++) for (let j=0;j<n;j++)
    mx[i][j] = poissonPMF(i,lamH) * poissonPMF(j,lamA);
  if (lamH>0 && lamA>0) {
    mx[0][0] *= Math.max(0, 1-lamH*lamA*RHO);
    mx[1][0] *= Math.max(0, 1+lamA*RHO);
    mx[0][1] *= Math.max(0, 1+lamH*RHO);
    mx[1][1] *= Math.max(0, 1-RHO);
  }
  let sum=0;
  for (const r of mx) for (const v of r) sum+=v;
  if (sum>0) for (const r of mx) for (let j=0;j<n;j++) r[j]/=sum;
  return mx;
}

function q(mx,cond) {
  let p=0;
  for (let i=0;i<mx.length;i++) for (let j=0;j<mx.length;j++)
    if (cond(i,j)) p+=mx[i][j];
  return p;
}

function grade(edge) {
  if (edge >= 0.08) return 'A';
  if (edge >= 0.05) return 'B';
  if (edge >= 0.03) return 'C';
  if (edge >= 0) return 'D';
  return 'F';
}

function analyzeMatch(m) {
  const avg = m.avg, hf = m.hf;
  const hApg = m.hGoals/m.hGames, hDpg = m.hConc/m.hGames;
  const aApg = m.aGoals/m.aGames, aDpg = m.aConc/m.aGames;
  const lamH = avg * (hApg/avg) * (aDpg/avg) * hf;
  const lamA = avg * (aApg/avg) * (hDpg/avg);
  const mx = buildMatrix(lamH, lamA);
  const H = q(mx,(i,j)=>i>j), D = q(mx,(i,j)=>i===j), A = q(mx,(i,j)=>i<j);
  const O25 = q(mx,(i,j)=>i+j>2), O15 = q(mx,(i,j)=>i+j>1), O35 = q(mx,(i,j)=>i+j>3);
  const BTTS = q(mx,(i,j)=>i>0&&j>0);
  const scores = [];
  for (let i=0;i<=5;i++) for (let j=0;j<=5;j++) scores.push({s:i+':'+j, p:mx[i][j]});
  scores.sort((a,b)=>b.p-a.p);
  return { lamH, lamA, H, D, A, O25, U25:1-O25, O15, O35, BTTS, topScores: scores.slice(0,3) };
}

function findValue(modelP, bookOdds, marketName) {
  if (!bookOdds) return null;
  const impliedP = 1/bookOdds;
  const edge = modelP - impliedP;
  const ev = (modelP * (bookOdds-1)) - (1-modelP);
  const kelly = edge > 0 ? (edge / (bookOdds-1)) : 0;
  const qKelly = Math.min(kelly * 0.25, 0.05);
  return { market: marketName, modelP, bookOdds, fairOdds: +(1/modelP).toFixed(2), impliedP, edge, ev, grade: grade(edge), kelly: qKelly };
}

// ═══════════════════════════════════════════════════════════════════
// DATA SOURCE KEY:
//   xG = Understat last-8 home/away xG (real expected goals)
//   (Tore) = Goals as proxy (no xG available for 2.BL / 3.Liga)
//   hGames/aGames = 8 for xG rolling window, actual games for Tore
// ═══════════════════════════════════════════════════════════════════

const matches = [
  // === BUNDESLIGA (avg=1.38, hf=1.28) — REAL xG from Understat ===
  { name: 'Mainz vs Eintracht Frankfurt', league: 'BL', time: '15:30',
    avg:1.38, hf:1.28,
    // Mainz HOME xG8=20.4, xGA8=9.1 | Frankfurt AWAY xG8=9.2, xGA8=16.4
    hGames:8, hGoals:20.4, hConc:9.1,
    aGames:8, aGoals:9.2, aConc:16.4,
    odds: { H:2.05, D:3.60, A:3.40, O25:1.75, U25:2.10, BTTS_Y:1.55 },
    ctx: 'Mainz P7 (42P) vs Frankfurt P4 (49P) | Rhein-Main Derby | xG'
  },
  { name: 'St. Pauli vs SC Freiburg', league: 'BL', time: '17:30',
    avg:1.38, hf:1.28,
    // St.Pauli HOME xG8=6.4, xGA8=11.3 | Freiburg AWAY xG8=8.0, xGA8=17.4
    hGames:8, hGoals:6.4, hConc:11.3,
    aGames:8, aGoals:8.0, aConc:17.4,
    odds: { H:2.65, D:3.30, A:2.70, O25:2.00, U25:1.85, BTTS_Y:1.70 },
    ctx: 'St. Pauli P15 (27P, Abstieg) vs Freiburg P8 (40P) | xG'
  },
  { name: 'Augsburg vs VfB Stuttgart', league: 'BL', time: '19:30',
    avg:1.38, hf:1.28,
    // Augsburg HOME xG8=12.4, xGA8=11.3 | Stuttgart AWAY xG8=14.5, xGA8=15.6
    hGames:8, hGoals:12.4, hConc:11.3,
    aGames:8, aGoals:14.5, aConc:15.6,
    odds: { H:3.40, D:3.80, A:1.96, O25:1.65, U25:2.25, BTTS_Y:1.49 },
    ctx: 'Augsburg P13 (30P) vs Stuttgart P5 (45P) | xG'
  },
  // === 2. BUNDESLIGA (avg=1.35, hf=1.29) — GOALS as proxy (no xG) ===
  { name: 'Bochum vs Holstein Kiel', league: '2BL', time: '13:30',
    avg:1.35, hf:1.29,
    // Bochum HOME: 13gp, 21GF, 15GA | Kiel AWAY: 13gp, 15GF, 24GA (FBref)
    hGames:13, hGoals:21, hConc:15,
    aGames:13, aGoals:15, aConc:24,
    odds: { H:2.03, D:3.40, A:3.80, O25:1.90, U25:1.95, BTTS_Y:1.65 },
    ctx: 'Bochum P10 (33P) vs Kiel P17 (25P) | Tore-Proxy'
  },
  { name: 'F. Duesseldorf vs Hertha BSC', league: '2BL', time: '13:30',
    avg:1.35, hf:1.29,
    // Duesseldorf HOME: 13gp, 13GF, 17GA | Hertha AWAY: 12gp, 23GF, 16GA (FBref)
    hGames:13, hGoals:13, hConc:17,
    aGames:12, aGoals:23, aConc:16,
    odds: { H:1.72, D:3.70, A:4.80, O25:1.70, U25:2.10, BTTS_Y:1.53 },
    ctx: 'Duesseldorf P11 (31P) vs Hertha P6 (41P) | Tore-Proxy'
  },
  { name: 'Pr. Muenster vs 1. FC Magdeburg', league: '2BL', time: '13:30',
    avg:1.35, hf:1.29,
    // Muenster HOME: 13gp, 18GF, 19GA | Magdeburg AWAY: 13gp, 20GF, 23GA (FBref)
    hGames:13, hGoals:18, hConc:19,
    aGames:13, aGoals:20, aConc:23,
    odds: { H:2.80, D:3.30, A:2.55, O25:1.85, U25:2.00, BTTS_Y:1.60 },
    ctx: 'Muenster P16 (26P, Abstieg) vs Magdeburg P18 (24P, Abstieg) | Tore-Proxy'
  },
  // === 3. LIGA (avg=1.40, hf varies) — GOALS as proxy (no xG) ===
  { name: 'Hoffenheim II vs VfL Osnabrueck', league: '3L', time: '13:30',
    avg:1.40, hf:1.22,
    hGames:14, hGoals:18, hConc:22,
    aGames:14, aGoals:21, aConc:16,
    odds: { H:4.50, D:4.00, A:1.70, O25:1.60, U25:2.30, BTTS_Y:1.55 },
    ctx: 'Hoffenheim II P15 (35P, LLWLL) vs Osnabrueck P1 (58P, WWWWW) | Tore-Proxy'
  },
  { name: 'MSV Duisburg vs 1860 Muenchen', league: '3L', time: '16:30',
    avg:1.40, hf:1.31,
    hGames:14, hGoals:25, hConc:12,
    aGames:14, aGoals:16, aConc:18,
    odds: { H:1.90, D:3.50, A:4.00, O25:1.80, U25:2.00, BTTS_Y:1.65 },
    ctx: 'Duisburg P6 (51P) vs 1860 P7 (49P) | 23k+ Zuschauer | Tore-Proxy'
  },
  { name: 'Viktoria Koeln vs RW Essen', league: '3L', time: '19:30',
    avg:1.40, hf:1.22,
    hGames:15, hGoals:20, hConc:18,
    aGames:14, aGoals:20, aConc:20,
    odds: { H:3.20, D:3.40, A:2.20, O25:1.70, U25:2.15, BTTS_Y:1.55 },
    ctx: 'Viktoria Koeln P13 (38P, LLL) vs RWE P5 (52P, WW) | Tore-Proxy'
  },
  // === PREMIER LEAGUE (avg=1.35, hf varies) — REAL xG from Understat ===
  { name: 'Newcastle vs Sunderland', league: 'EPL', time: '13:00',
    avg:1.35, hf:1.35,
    // Newcastle HOME xG8=18.2, xGA8=13.4 | Sunderland AWAY xG8=7.0, xGA8=14.7
    hGames:8, hGoals:18.2, hConc:13.4,
    aGames:8, aGoals:7.0, aConc:14.7,
    odds: { H:1.67, D:3.80, A:5.00, O25:1.65, U25:2.25, BTTS_Y:1.70 },
    ctx: 'Newcastle P4 (54P) vs Sunderland P14 (34P) | TYNE-WEAR DERBY | xG'
  },
  { name: 'Aston Villa vs West Ham', league: 'EPL', time: '15:15',
    avg:1.35, hf:1.22,
    // Villa HOME xG8=12.0, xGA8=10.3 | West Ham AWAY xG8=11.4, xGA8=16.8
    hGames:8, hGoals:12.0, hConc:10.3,
    aGames:8, aGoals:11.4, aConc:16.8,
    odds: { H:1.55, D:4.20, A:6.00, O25:1.60, U25:2.35, BTTS_Y:1.65 },
    ctx: 'Aston Villa P6 (47P) vs West Ham P17 (26P, Abstieg) | xG'
  },
  { name: 'Tottenham vs Nottm Forest', league: 'EPL', time: '15:15',
    avg:1.35, hf:1.22,
    // Spurs HOME xG8=11.7, xGA8=14.7 | Forest AWAY xG8=8.1, xGA8=15.4
    hGames:8, hGoals:11.7, hConc:14.7,
    aGames:8, aGoals:8.1, aConc:15.4,
    odds: { H:2.40, D:3.50, A:2.90, O25:1.60, U25:2.35, BTTS_Y:1.55 },
    ctx: 'Spurs P9 (40P) vs Forest P3 (55P) | Top-4 Race | xG'
  },
  // === LA LIGA (avg=1.25, hf varies) — REAL xG from Understat ===
  { name: 'Barcelona vs Rayo Vallecano', league: 'LL', time: '14:00',
    avg:1.25, hf:1.35,
    // Barca HOME xG8=24.9, xGA8=8.2 | Rayo AWAY xG8=7.3, xGA8=15.9
    hGames:8, hGoals:24.9, hConc:8.2,
    aGames:8, aGoals:7.3, aConc:15.9,
    odds: { H:1.25, D:7.20, A:10.00, O25:1.45, U25:2.75, BTTS_Y:1.80 },
    ctx: 'Barcelona P1 (66P) vs Rayo P13 (35P) | xG'
  },
  { name: 'Celta Vigo vs Alaves', league: 'LL', time: '16:15',
    avg:1.25, hf:1.30,
    // Celta HOME xG8=13.5, xGA8=10.5 | Alaves AWAY xG8=10.5, xGA8=14.9
    hGames:8, hGoals:13.5, hConc:10.5,
    aGames:8, aGoals:10.5, aConc:14.9,
    odds: { H:1.95, D:3.35, A:4.40, O25:2.10, U25:1.75, BTTS_Y:1.85 },
    ctx: 'Celta Vigo P11 (36P) vs Alaves P18 (24P, Abstieg) | xG'
  },
  { name: 'Athletic Club vs Real Betis', league: 'LL', time: '18:30',
    avg:1.25, hf:1.35,
    // Athletic HOME xG8=14.6, xGA8=7.8 | Betis AWAY xG8=11.6, xGA8=10.8
    hGames:8, hGoals:14.6, hConc:7.8,
    aGames:8, aGoals:11.6, aConc:10.8,
    odds: { H:2.19, D:3.20, A:3.50, O25:2.00, U25:1.85, BTTS_Y:1.70 },
    ctx: 'Athletic Club P5 (48P) vs Betis P7 (43P) | xG'
  },
];

const allBets = [];

for (const m of matches) {
  const r = analyzeMatch(m);
  const valueBets = [
    findValue(r.H, m.odds.H, '1 (Heim)'),
    findValue(r.D, m.odds.D, 'X (Remis)'),
    findValue(r.A, m.odds.A, '2 (Gast)'),
    findValue(r.O25, m.odds.O25, 'Ue2.5'),
    findValue(r.U25, m.odds.U25, 'U2.5'),
    findValue(r.BTTS, m.odds.BTTS_Y, 'BTTS Ja'),
  ].filter(v => v && v.edge > 0.02);

  console.log('');
  console.log('='.repeat(70));
  console.log(`  ${m.name} (${m.time}) [${m.league}]`);
  console.log(`  ${m.ctx}`);
  console.log('-'.repeat(70));
  console.log(`  LamH=${r.lamH.toFixed(2)}  LamA=${r.lamA.toFixed(2)}  |  Top: ${r.topScores.map(s=>s.s+'('+Math.round(s.p*100)+'%)').join(' ')}`);
  console.log('-'.repeat(70));

  const rows = [
    ['Heim',  r.H,    m.odds.H],
    ['Remis', r.D,    m.odds.D],
    ['Gast',  r.A,    m.odds.A],
    ['Ue2.5', r.O25,  m.odds.O25],
    ['U2.5',  r.U25,  m.odds.U25],
    ['BTTS',  r.BTTS, m.odds.BTTS_Y],
  ];

  console.log('  Markt    Modell   Fair    Buch    Edge     EV    Grade');
  for (const [name, mp, bo] of rows) {
    const ip = 1/bo;
    const edge = mp - ip;
    const ev = mp*(bo-1)-(1-mp);
    const g = grade(edge);
    const marker = edge >= 0.03 ? ' <-- VALUE' : '';
    console.log(`  ${name.padEnd(8)} ${(mp*100).toFixed(1).padStart(5)}%  ${(1/mp).toFixed(2).padStart(5)}   ${bo.toFixed(2).padStart(5)}   ${(edge*100).toFixed(1).padStart(5)}%  ${(ev*100).toFixed(0).padStart(4)}%   ${g}${marker}`);
  }

  if (valueBets.length > 0) {
    console.log('  ---');
    console.log('  VALUE BETS:');
    for (const vb of valueBets) {
      console.log(`    > ${vb.market} @ ${vb.bookOdds}  Edge=${(vb.edge*100).toFixed(1)}% EV=${(vb.ev*100).toFixed(0)}% [${vb.grade}] 1/4Kelly=${(vb.kelly*100).toFixed(1)}%`);
      allBets.push({ match: m.name, time: m.time, league: m.league, ...vb });
    }
  } else {
    console.log('  --- KEINE VALUE BETS ---');
  }
}

console.log('\n');
console.log('='.repeat(70));
console.log('  TOP VALUE BETS (Ranked by Edge)');
console.log('='.repeat(70));

allBets.sort((a,b) => b.edge - a.edge);

for (let i=0; i<allBets.length; i++) {
  const b = allBets[i];
  console.log(`  ${i+1}. [${b.grade}] ${b.match} > ${b.market} @ ${b.bookOdds} (Edge ${(b.edge*100).toFixed(1)}%, EV ${(b.ev*100).toFixed(0)}%, 1/4K ${(b.kelly*100).toFixed(1)}%)`);
}

console.log('');
console.log('  Grade: A>=8% edge | B=5-8% | C=3-5% | D<3% | F=negative');
console.log('  Kelly: Quarter-Kelly, capped at 5% bankroll');
console.log('='.repeat(70));
