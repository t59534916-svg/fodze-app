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

IMPORTANT: You are ONLY responsible for UNSTRUCTURED TEXT data:
- Fixtures (which teams play, kickoff times)
- Injuries and suspensions (from transfermarkt.de, kicker.de)
- Yellow card risks (players on 4 yellows)
- Match context (derby, new manager, relegation battle, etc.)
- Referee and their card average
- Tags: DERBY, ROTATION, SANDWICH, NEUER-TRAINER (if applicable)

You are NOT responsible for xG data. Leave xg_h8, xga_h8, xg_a8, xga_a8 as 0.
xG data is loaded separately from Supabase (deterministic pipeline, not LLM).

DO NOT include betting odds. DO NOT try to compute or estimate xG values.

RESPOND ONLY AS JSON:
{
  "league": "${league}",
  "matchday": "Spieltag XX",
  "date": "YYYY-MM-DD",
  "matches": [
    {
      "home": {"name": "Team A", "xg_h8": 0, "xga_h8": 0, "games": 8, "form": "W W D L W", "injuries": "Player (injury)", "yellow_risk": "Player on 4 yellows", "notes": ""},
      "away": {"name": "Team B", "xg_a8": 0, "xga_a8": 0, "games": 8, "form": "L W W D W", "injuries": "", "yellow_risk": "", "notes": ""},
      "tags": ["DERBY"],
      "context": "Brief context",
      "referee": "Name, avg X cards/game",
      "kickoff": "YYYY-MM-DD HH:MM"
    }
  ],
  "data_confidence": "MEDIUM",
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
