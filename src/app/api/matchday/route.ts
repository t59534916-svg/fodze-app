import { NextRequest, NextResponse } from "next/server";

// Error-code contract (additive to `error` string for backward compat —
// MatchdayContext throws on `result.error`, keeps working either way):
//   NO_KEY          — config missing, frontend falls back to manual mode
//   BAD_REQUEST     — malformed body or missing league param
//   UPSTREAM_ERROR  — Claude API returned non-2xx or unparseable JSON
//   INTERNAL        — uncaught server error
//
// Status codes follow the code (401 for config, 400 bad request, 502 upstream,
// 500 internal) — previously everything was 200-or-500 even for distinct cases.

type ApiError = { error: string; errorCode: string; message?: string };

const err = (code: string, message: string, status: number) =>
  NextResponse.json<ApiError>({ error: message, errorCode: code, message }, { status });

export async function POST(req: NextRequest) {
  // Body-parse safety: malformed JSON was crashing the route.
  let league: string | undefined;
  try {
    const body = await req.json();
    league = body?.league;
  } catch {
    return err("BAD_REQUEST", "Ungültiges Request-Body JSON.", 400);
  }
  if (!league || typeof league !== "string") {
    return err("BAD_REQUEST", "Liga-Parameter fehlt oder ungültig.", 400);
  }

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    // Kept at 200 — frontend graceful fallback to manual mode depends on it.
    return NextResponse.json<ApiError>({
      error: "NO_KEY",
      errorCode: "NO_KEY",
      message: "Claude API Key nicht konfiguriert. Nutze den manuellen Modus.",
    }, { status: 200 });
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

    if (!resp.ok) {
      // Surface upstream status but don't leak headers or body — Claude
      // errors sometimes include raw internal prompts.
      console.error(`[api/matchday] Claude API HTTP ${resp.status}`);
      return err("UPSTREAM_ERROR", `Claude API antwortet mit ${resp.status}.`, 502);
    }

    const data = await resp.json();
    const text = data.content
      ?.filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n") || "";

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return err("UPSTREAM_ERROR", "Keine strukturierten Daten erhalten.", 502);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(jsonMatch[0].replace(/```json|```/g, "").trim());
    } catch {
      return err("UPSTREAM_ERROR", "Antwort konnte nicht geparst werden.", 502);
    }
    return NextResponse.json(parsed);

  } catch (e: any) {
    // Log full error server-side, return sanitized message to client.
    console.error("[api/matchday] Internal error:", e);
    return err("INTERNAL", "Serverfehler bei der Anfrage.", 500);
  }
}

// Check if Claude API is configured — callers read `d.hasKey === true`
export async function GET() {
  const hasKey = !!process.env.CLAUDE_API_KEY;
  return NextResponse.json({ hasKey });
}
