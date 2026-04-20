import { describe, it, expect } from "vitest";
import {
  parseCsv,
  parseDate,
  numOrNull,
  intOrNull,
  resultFromGoals,
  buildRows,
  decodeBuffer,
} from "../scripts/_lib/football-data-parse.mjs";

describe("parseDate", () => {
  it("parses DD/MM/YYYY → ISO", () => {
    expect(parseDate("12/03/2024")).toBe("2024-03-12");
    expect(parseDate("01/09/2025")).toBe("2025-09-01");
  });

  it("expands DD/MM/YY → 20YY", () => {
    expect(parseDate("12/03/24")).toBe("2024-03-12");
    expect(parseDate("01/09/25")).toBe("2025-09-01");
  });

  it("pads single-digit day and month", () => {
    expect(parseDate("1/9/2025")).toBe("2025-09-01");
  });

  it("returns null on invalid format", () => {
    expect(parseDate("")).toBeNull();
    expect(parseDate(null as unknown as string)).toBeNull();
    expect(parseDate("2025-09-01")).toBeNull();       // ISO-shaped → reject
    expect(parseDate("12-03-2024")).toBeNull();       // wrong separator
    expect(parseDate("12/03")).toBeNull();             // too few parts
    expect(parseDate("abc/xyz/2024")).toBeNull();      // non-digit
  });
});

describe("numOrNull", () => {
  it("parses valid positive odds", () => {
    expect(numOrNull("1.95")).toBe(1.95);
    expect(numOrNull("3.4")).toBe(3.4);
  });

  it("trims whitespace before parsing", () => {
    expect(numOrNull("  2.10  ")).toBe(2.10);
  });

  it("rejects zero, negative, and empty", () => {
    expect(numOrNull("")).toBeNull();
    expect(numOrNull("0")).toBeNull();
    expect(numOrNull("-1.5")).toBeNull();
    expect(numOrNull("NaN")).toBeNull();
    expect(numOrNull(null as unknown as string)).toBeNull();
  });
});

describe("intOrNull", () => {
  it("accepts zero (needed for 0-0 goal results)", () => {
    expect(intOrNull("0")).toBe(0);
  });

  it("parses positive ints", () => {
    expect(intOrNull("3")).toBe(3);
    expect(intOrNull("12")).toBe(12);
  });

  it("returns null on empty / non-numeric", () => {
    expect(intOrNull("")).toBeNull();
    expect(intOrNull(null as unknown as string)).toBeNull();
    expect(intOrNull("abc")).toBeNull();
  });
});

describe("resultFromGoals", () => {
  it("derives H / D / A correctly", () => {
    expect(resultFromGoals(2, 1)).toBe("H");
    expect(resultFromGoals(0, 3)).toBe("A");
    expect(resultFromGoals(1, 1)).toBe("D");
    expect(resultFromGoals(0, 0)).toBe("D");
  });

  it("returns null if either side is null", () => {
    expect(resultFromGoals(null, 2)).toBeNull();
    expect(resultFromGoals(2, null)).toBeNull();
    expect(resultFromGoals(null, null)).toBeNull();
  });
});

describe("parseCsv", () => {
  it("parses header + rows with comma separator", () => {
    const csv = "Date,HomeTeam,AwayTeam,FTHG,FTAG\n12/03/24,Bayern,Dortmund,2,1\n13/03/24,Leipzig,Bochum,3,0";
    const { headers, rows } = parseCsv(csv) as unknown as { headers: string[]; rows: Record<string, string>[] };
    expect(headers).toEqual(["Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG"]);
    expect(rows).toHaveLength(2);
    expect(rows[0].HomeTeam).toBe("Bayern");
    expect(rows[1].FTHG).toBe("3");
  });

  it("strips UTF-8 BOM", () => {
    const csv = "\uFEFFDate,Home\n12/03/24,Bayern";
    const { headers, rows } = parseCsv(csv) as unknown as { headers: string[]; rows: Record<string, string>[] };
    expect(headers[0]).toBe("Date");
    expect(rows[0].Date).toBe("12/03/24");
  });

  it("returns empty on header-only or empty input", () => {
    expect(parseCsv("").rows).toEqual([]);
    expect(parseCsv("Date,Home").rows).toEqual([]);
    expect(parseCsv(null as unknown as string).rows).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const csv = "Date,Home\r\n12/03/24,Bayern\r\n13/03/24,Leipzig";
    const { rows } = parseCsv(csv) as unknown as { rows: Record<string, string>[] };
    expect(rows).toHaveLength(2);
    expect(rows[0].Home).toBe("Bayern");
  });

  it("fills missing trailing cells with empty string", () => {
    const csv = "A,B,C,D\n1,2";   // short row
    const { rows } = parseCsv(csv);
    expect(rows[0]).toEqual({ A: "1", B: "2", C: "", D: "" });
  });
});

describe("buildRows", () => {
  const headers = ["Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG", "PSCH", "PSCD", "PSCA", "PSC>2.5", "PSC<2.5", "PSCAHH", "PSCAHA", "AHh"];

  function makeRow(vals: Partial<Record<string, string>>): Record<string, string> {
    const base: Record<string, string> = {};
    for (const h of headers) base[h] = vals[h] ?? "";
    return base;
  }

  it("produces one output row per valid input row", () => {
    const csvRows = [
      makeRow({ Date: "12/03/24", HomeTeam: "Bayern", AwayTeam: "Dortmund", FTHG: "3", FTAG: "1", PSCH: "1.55", PSCD: "4.2", PSCA: "6.0", "PSC>2.5": "1.72", "PSC<2.5": "2.22" }),
    ];
    const { rows, skipped } = buildRows("bundesliga", "2324", csvRows);
    expect(skipped).toBe(0);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.match_key).toBe("bundesliga|Bayern|Dortmund|2024-03-12");
    expect(r.psch).toBe(1.55);
    expect(r.pscd).toBe(4.2);
    expect(r.psca).toBe(6.0);
    expect(r.psc_over25).toBe(1.72);
    expect(r.ft_result).toBe("H");
    expect(r.ft_goals_h).toBe(3);
    expect(r.ft_goals_a).toBe(1);
    expect(r.source).toBe("football-data.co.uk");
  });

  it("skips rows missing team names or date", () => {
    const csvRows = [
      makeRow({ Date: "12/03/24", HomeTeam: "", AwayTeam: "Dortmund", PSCH: "1.5" }),
      makeRow({ Date: "", HomeTeam: "Bayern", AwayTeam: "Dortmund", PSCH: "1.5" }),
      makeRow({ Date: "12/03/24", HomeTeam: "Bayern", AwayTeam: "Dortmund", PSCH: "1.5" }),
    ];
    const { rows, skipped } = buildRows("bundesliga", "2324", csvRows);
    expect(rows).toHaveLength(1);
    expect(skipped).toBe(2);
  });

  it("skips rows with no Pinnacle Closing columns at all", () => {
    const csvRows = [
      makeRow({ Date: "12/03/24", HomeTeam: "Bayern", AwayTeam: "Dortmund", FTHG: "2", FTAG: "1" }),
    ];
    const { rows, skipped } = buildRows("bundesliga", "2324", csvRows);
    expect(rows).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it("keeps rows with partial Pinnacle Closing (only PSCH present)", () => {
    const csvRows = [
      makeRow({ Date: "12/03/24", HomeTeam: "Bayern", AwayTeam: "Dortmund", PSCH: "1.55" }),
    ];
    const { rows } = buildRows("bundesliga", "2324", csvRows);
    expect(rows).toHaveLength(1);
    expect(rows[0].psch).toBe(1.55);
    expect(rows[0].pscd).toBeNull();
  });

  it("ft_result is null when goals are missing", () => {
    const csvRows = [
      makeRow({ Date: "12/03/24", HomeTeam: "Bayern", AwayTeam: "Dortmund", PSCH: "1.55" }),
    ];
    const { rows } = buildRows("bundesliga", "2324", csvRows);
    expect(rows[0].ft_result).toBeNull();
    expect(rows[0].ft_goals_h).toBeNull();
  });

  it("match_key is stable and idempotent", () => {
    const csvRows = [
      makeRow({ Date: "12/03/24", HomeTeam: "Bayern", AwayTeam: "Dortmund", PSCH: "1.55" }),
    ];
    const { rows: r1 } = buildRows("bundesliga", "2324", csvRows);
    const { rows: r2 } = buildRows("bundesliga", "2324", csvRows);
    expect(r1[0].match_key).toBe(r2[0].match_key);
  });

  it("accepts AHCh as fallback for ah_line", () => {
    const csvRows = [
      { Date: "12/03/24", HomeTeam: "Bayern", AwayTeam: "Dortmund", PSCH: "1.55", AHCh: "-1.25" } as Record<string, string>,
    ];
    const { rows } = buildRows("bundesliga", "2324", csvRows);
    expect(rows[0].ah_line).toBe(-1.25);
  });
});

describe("decodeBuffer", () => {
  it("decodes Windows-1252 diacritics (umlauts)", () => {
    // Windows-1252 bytes for "Köln": 0x4B 0xF6 0x6C 0x6E
    const bytes = new Uint8Array([0x4B, 0xF6, 0x6C, 0x6E]);
    expect(decodeBuffer(bytes)).toBe("Köln");
  });

  it("decodes plain ASCII unchanged", () => {
    const bytes = new TextEncoder().encode("Bayern Munich");
    expect(decodeBuffer(bytes)).toBe("Bayern Munich");
  });
});
