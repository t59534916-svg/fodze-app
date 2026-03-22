import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { league } = await req.json();

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "NO_KEY", message: "Claude API Key nicht konfiguriert. Nutze den manuellen Modus." }, { status: 200 });
  }

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{
          role: "user",
          content: `Find ALL matches for the next upcoming matchday in ${league}.

Search sofascore.com, fotmob.com, understat.com for fixtures and xG statistics.
Search transfermarkt.de for injuries and suspensions.

CRITICAL – xG data format:
- xg_h8 = SUM of xG scored by home team in their last 8 HOME games (NOT average, NOT all games, ONLY home games)
- xga_h8 = SUM of xGA conceded by home team in their last 8 HOME games
- xg_a8 = SUM of xG scored by away team in their last 8 AWAY games
- xga_a8 = SUM of xGA conceded by away team in their last 8 AWAY games
- Expected range: 5.0–20.0 (these are SUMS over 8 games, NOT per-game averages of 0.8–2.5)

Also provide: form (W/D/L), injuries, suspensions, yellow card risks, context, referee.

DO NOT include betting odds.

RESPOND ONLY AS JSON:
{
  "league": "${league}",
  "matchday": "Spieltag XX",
  "date": "YYYY-MM-DD",
  "matches": [
    {
      "home": {"name": "Team A", "xg_h8": 12.5, "xga_h8": 7.2, "games": 8, "form": "W W D L W", "injuries": "Player (injury)", "yellow_risk": "Player on 4 yellows", "notes": ""},
      "away": {"name": "Team B", "xg_a8": 9.0, "xga_a8": 11.5, "games": 8, "form": "L W W D W", "injuries": "", "yellow_risk": "", "notes": ""},
      "tags": ["DERBY"],
      "context": "Brief context",
      "referee": "Name, avg X cards/game",
      "kickoff": "15:30"
    }
  ],
  "data_confidence": "HIGH/MEDIUM/LOW",
  "sources": ["source1", "source2"]
}`
        }],
      }),
    });

    const data = await resp.json();
    const text = data.content
      ?.filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n") || "";

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ error: "Keine strukturierten Daten erhalten" }, { status: 502 });
    }

    const parsed = JSON.parse(jsonMatch[0].replace(/```json|```/g, "").trim());
    return NextResponse.json(parsed);

  } catch (e: any) {
    console.error("Claude API error:", e);
    return NextResponse.json({ error: e.message || "API-Fehler" }, { status: 500 });
  }
}

// Check if Claude API is configured
export async function GET() {
  const hasKey = !!process.env.CLAUDE_API_KEY;
  return NextResponse.json({ hasKey });
}
