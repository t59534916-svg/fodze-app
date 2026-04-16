// ═══════════════════════════════════════════════════════════════════════
// FODZE Bet Share Card — Canvas 2D renderer for shareable bet slips
//
// Renders a 1080×1350 (Instagram 4:5) branded image from a PlacedBet.
// No external dependencies — pure Canvas 2D API.
//
// Usage:
//   const blob = await renderBetCard(bet);
//   // Share via Web Share API or download
// ═══════════════════════════════════════════════════════════════════════

import type { PlacedBet } from "@/types/match";
import { color } from "@/styles/tokens";
import { fmtEuro, fmtDateLong, fmtDateSlug } from "@/lib/format";
import { marketLabel } from "@/lib/market-labels";
import { betProfit } from "@/lib/bet-metrics";

// Color palette picked off the design tokens. Re-exported as `C` so the
// drawing code below stays terse (`C.gold` vs `color.gold`). Canvas 2D only
// accepts string color values — no theming at runtime.
const C = {
  leather: color.leather,
  leather2: color.leather2,
  leather3: color.leather3,
  gold: color.gold,
  goldLight: color.goldLight,
  goldShine: color.goldShine,
  goldDark: color.goldDark,
  text: color.text,
  textMuted: color.textMuted,
  textFaint: color.textFaint,
  value: color.value,
  warn: color.warn,
};

const W = 1080;
const H = 1350;

// ─── Primitive drawing helpers ──────────────────────────────────────

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawCorners(ctx: CanvasRenderingContext2D) {
  // Art deco corner marks — visual hook matching the /goldilocks + AppShell style
  ctx.save();
  ctx.strokeStyle = C.goldDark;
  ctx.lineWidth = 3;
  const m = 40; // margin
  const L = 60; // corner arm length
  // TL
  ctx.beginPath();
  ctx.moveTo(m, m + L);
  ctx.lineTo(m, m);
  ctx.lineTo(m + L, m);
  ctx.stroke();
  // TR
  ctx.beginPath();
  ctx.moveTo(W - m - L, m);
  ctx.lineTo(W - m, m);
  ctx.lineTo(W - m, m + L);
  ctx.stroke();
  // BL
  ctx.beginPath();
  ctx.moveTo(m, H - m - L);
  ctx.lineTo(m, H - m);
  ctx.lineTo(m + L, H - m);
  ctx.stroke();
  // BR
  ctx.beginPath();
  ctx.moveTo(W - m - L, H - m);
  ctx.lineTo(W - m, H - m);
  ctx.lineTo(W - m, H - m - L);
  ctx.stroke();
  ctx.restore();
}

function drawCenteredText(
  ctx: CanvasRenderingContext2D,
  text: string,
  y: number,
  font: string,
  color: string,
) {
  ctx.save();
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, W / 2, y);
  ctx.restore();
}

function drawGoldGradientText(
  ctx: CanvasRenderingContext2D,
  text: string,
  y: number,
  font: string,
) {
  ctx.save();
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  // Measure to build the gradient across the text width only
  const metrics = ctx.measureText(text);
  const tw = metrics.width;
  const tx1 = W / 2 - tw / 2;
  const tx2 = W / 2 + tw / 2;

  const grad = ctx.createLinearGradient(tx1, 0, tx2, 0);
  grad.addColorStop(0, C.goldDark);
  grad.addColorStop(0.25, C.goldLight);
  grad.addColorStop(0.5, C.goldShine);
  grad.addColorStop(0.75, C.gold);
  grad.addColorStop(1, C.goldDark);

  ctx.fillStyle = grad;
  ctx.fillText(text, W / 2, y);
  ctx.restore();
}

// Wrap long team names across two lines if needed (returns 1 or 2 lines)
function wrapTeamName(
  ctx: CanvasRenderingContext2D,
  name: string,
  maxWidth: number,
): string[] {
  if (ctx.measureText(name).width <= maxWidth) return [name];
  const words = name.split(/\s+/);
  if (words.length < 2) return [name];
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
}

// ─── Main renderer ──────────────────────────────────────────────────

export async function renderBetCard(bet: PlacedBet): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  // ─── Background: leather radial gradient ──────────────────────────
  const bg = ctx.createRadialGradient(W / 2, 0, 0, W / 2, H / 2, H);
  bg.addColorStop(0, C.leather3);
  bg.addColorStop(0.6, C.leather2);
  bg.addColorStop(1, C.leather);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Subtle gold noise overlay (stipple for "leather" texture)
  ctx.save();
  ctx.globalAlpha = 0.025;
  ctx.fillStyle = C.gold;
  // Deterministic stipple based on (x*y) hash — same image every render
  for (let i = 0; i < 1200; i++) {
    const x = ((i * 9301 + 49297) % 233280) / 233280 * W;
    const y = ((i * 4567 + 31071) % 179424) / 179424 * H;
    ctx.fillRect(x, y, 1, 1);
  }
  ctx.restore();

  // ─── Corner frame ─────────────────────────────────────────────────
  drawCorners(ctx);

  // ─── Brand header ─────────────────────────────────────────────────
  // Wordmark "FODZE" with gold gradient
  drawGoldGradientText(
    ctx,
    "FODZE",
    170,
    "700 72px Georgia, 'Times New Roman', serif",
  );
  // Tagline
  drawCenteredText(
    ctx,
    "QUANTITATIVE VALUE BETTING",
    210,
    "500 18px -apple-system, Inter, sans-serif",
    C.textFaint,
  );
  // Divider
  ctx.save();
  ctx.strokeStyle = C.goldDark;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(W / 2 - 80, 240);
  ctx.lineTo(W / 2 + 80, 240);
  ctx.stroke();
  ctx.restore();

  // ─── Slip label ───────────────────────────────────────────────────
  drawCenteredText(
    ctx,
    "WETTSCHEIN",
    285,
    "700 20px -apple-system, Inter, sans-serif",
    C.gold,
  );

  // ─── Match teams ──────────────────────────────────────────────────
  const teamFont = "700 56px Georgia, 'Times New Roman', serif";
  ctx.font = teamFont;
  const maxTeamWidth = W - 160;
  const homeLines = wrapTeamName(ctx, bet.home_team || "", maxTeamWidth);
  const awayLines = wrapTeamName(ctx, bet.away_team || "", maxTeamWidth);

  let y = 370;
  for (const line of homeLines) {
    drawCenteredText(ctx, line, y, teamFont, C.text);
    y += 64;
  }
  drawCenteredText(
    ctx,
    "vs",
    y + 4,
    "400 32px Georgia, 'Times New Roman', serif",
    C.textFaint,
  );
  y += 56;
  for (const line of awayLines) {
    drawCenteredText(ctx, line, y, teamFont, C.text);
    y += 64;
  }

  // League + date
  const dateStr = fmtDateLong(bet.placed_at);
  const meta = dateStr ? `FODZE · ${dateStr}` : "FODZE";
  drawCenteredText(
    ctx,
    meta,
    y + 20,
    "500 20px -apple-system, Inter, sans-serif",
    C.textFaint,
  );

  // ─── Pick box ─────────────────────────────────────────────────────
  const boxY = 750;
  const boxH = 170;
  const boxPad = 80;
  ctx.save();
  roundedRect(ctx, boxPad, boxY, W - boxPad * 2, boxH, 14);
  ctx.fillStyle = "rgba(212, 184, 106, 0.08)";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = C.gold;
  ctx.stroke();
  ctx.restore();

  // Market label (normalizes legacy "h"/"d"/"a" and "Ü2.5" variants)
  drawCenteredText(
    ctx,
    marketLabel(bet.market, "long"),
    boxY + 58,
    "700 34px -apple-system, Inter, sans-serif",
    C.gold,
  );
  // Odds
  drawCenteredText(
    ctx,
    `@ ${Number(bet.odds_placed).toFixed(2)}`,
    boxY + 125,
    "700 50px Georgia, 'Times New Roman', serif",
    C.goldShine,
  );

  // ─── Metrics row: Einsatz · Modell · Edge ─────────────────────────
  const mRowY = 1000;
  const colW = (W - 160) / 3;
  const cols = [
    {
      label: "EINSATZ",
      value: fmtEuro(Number(bet.stake)),
    },
    {
      label: "MODELL",
      value:
        bet.model_prob != null
          ? `${(bet.model_prob * 100).toFixed(1)}%`
          : "—",
    },
    {
      label: "EDGE",
      value:
        bet.edge != null
          ? `${bet.edge >= 0 ? "+" : ""}${(bet.edge * 100).toFixed(1)}%`
          : "—",
    },
  ];
  ctx.save();
  for (let i = 0; i < cols.length; i++) {
    const cx = 80 + colW * i + colW / 2;
    ctx.font = "600 16px -apple-system, Inter, sans-serif";
    ctx.fillStyle = C.textFaint;
    ctx.textAlign = "center";
    ctx.fillText(cols[i].label, cx, mRowY);
    ctx.font = "700 38px Georgia, 'Times New Roman', serif";
    ctx.fillStyle = C.text;
    ctx.fillText(cols[i].value, cx, mRowY + 48);
  }
  ctx.restore();

  // ─── Result badge ─────────────────────────────────────────────────
  const won = bet.result === "won";
  const lost = bet.result === "lost";
  if (won || lost) {
    const resultY = 1110;
    const resultH = 130;
    const resultColor = won ? C.value : C.warn;
    const profit = betProfit(bet);

    ctx.save();
    roundedRect(ctx, boxPad, resultY, W - boxPad * 2, resultH, 14);
    ctx.fillStyle = won ? "rgba(106, 173, 85, 0.12)" : "rgba(224, 112, 112, 0.12)";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = resultColor;
    ctx.stroke();
    ctx.restore();

    drawCenteredText(
      ctx,
      won ? "GEWONNEN" : "VERLOREN",
      resultY + 50,
      "700 28px -apple-system, Inter, sans-serif",
      resultColor,
    );
    drawCenteredText(
      ctx,
      fmtEuro(profit, true),
      resultY + 100,
      "700 42px Georgia, 'Times New Roman', serif",
      resultColor,
    );
  } else {
    // Pending — show "AUSSTEHEND" in muted style
    drawCenteredText(
      ctx,
      "AUSSTEHEND",
      1170,
      "700 28px -apple-system, Inter, sans-serif",
      C.textMuted,
    );
  }

  // ─── Footer ───────────────────────────────────────────────────────
  drawCenteredText(
    ctx,
    "Dixon-Coles · Bivariate Poisson · Isotonic Calibration",
    1280,
    "500 16px -apple-system, Inter, sans-serif",
    C.textFaint,
  );
  drawCenteredText(
    ctx,
    "Sportwetten = Glücksspiel · spielen-mit-verantwortung.de",
    1306,
    "500 14px -apple-system, Inter, sans-serif",
    C.textFaint,
  );

  // ─── Export ───────────────────────────────────────────────────────
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Canvas toBlob failed"))),
      "image/png",
      0.95,
    );
  });
}

// ─── Share helper: Web Share API + download fallback ────────────────

export type ShareResult = "shared" | "downloaded" | "cancelled";

export async function shareBetCard(bet: PlacedBet): Promise<ShareResult> {
  const blob = await renderBetCard(bet);
  const safeName = `${bet.home_team}-${bet.away_team}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const filename = `fodze-${safeName || "bet"}-${fmtDateSlug(bet.placed_at)}.png`;

  // Try Web Share API (mobile Safari, Chrome Android, modern desktop Chrome)
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  if (nav && typeof nav.share === "function" && typeof nav.canShare === "function") {
    try {
      const file = new File([blob], filename, { type: "image/png" });
      if (nav.canShare({ files: [file] })) {
        await nav.share({
          files: [file],
          title: `${bet.home_team} vs ${bet.away_team}`,
          text: "Via FODZE",
        });
        return "shared";
      }
    } catch (err) {
      // User cancelled the native share sheet — surface distinct status
      // so callers don't misreport "Geteilt ✓" for a no-op.
      if ((err as Error)?.name === "AbortError") return "cancelled";
      // Any other failure: fall through to download
    }
  }

  // Fallback: trigger a download
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Safari can still write the file
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "downloaded";
}
