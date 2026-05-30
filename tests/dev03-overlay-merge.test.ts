import { describe, it, expect, vi } from "vitest";
import {
  resolveOverlay,
  mergeDev03Overlay,
  type Dev03OverlayState,
  type MergeableBundle,
} from "@/lib/dev03-overlay-merge";

// Sentinel calc + ctx types — strings, so we can assert which value flows
// where without constructing real MatchCalc objects.
type C = string;
type Ctx = { tag: string };

function bundle(over: Partial<MergeableBundle<C, Ctx>> = {}): MergeableBundle<C, Ctx> {
  return {
    dev03Calc: null,
    blendCalc: null,
    v2Calc: "V2",
    blendCtx: { tag: "ctx" },
    ...over,
  };
}

// Default stub: "blend(dev03,v2)" when both present, else null — mirrors the
// real buildBlendCalc contract (null unless BOTH legs exist).
const blendStub = (d: C | null, v: C | null) => (d && v ? `BLEND(${d},${v})` : null);

describe("resolveOverlay — staleness tag guard", () => {
  it("returns results only when the tag matches the current array", () => {
    const current: unknown[] = [];
    const overlay: Dev03OverlayState<C> = { src: current, results: ["A", "B"] };
    expect(resolveOverlay(overlay, current)).toEqual(["A", "B"]);
  });

  it("returns [] when the tag points at a DIFFERENT (stale) array", () => {
    const oldArr: unknown[] = [];
    const newArr: unknown[] = [];
    const overlay: Dev03OverlayState<C> = { src: oldArr, results: ["STALE"] };
    expect(resolveOverlay(overlay, newArr)).toEqual([]);
  });

  it("returns [] for the initial null-tagged state", () => {
    expect(resolveOverlay({ src: null, results: [] }, [])).toEqual([]);
  });
});

describe("mergeDev03Overlay — async dev-03 fold + blend rebuild", () => {
  it("before overlay lands: dev03Calc + blendCalc null (→ ensemble fallback)", () => {
    const bundles = [bundle()];
    const overlay: Dev03OverlayState<C> = { src: null, results: [] };
    const out = mergeDev03Overlay(bundles, overlay, blendStub);
    expect(out[0]!.dev03Calc).toBeNull();
    expect(out[0]!.blendCalc).toBeNull();
  });

  it("after overlay lands (matching tag): folds dev-03 + builds blend", () => {
    const bundles = [bundle()];
    const overlay: Dev03OverlayState<C> = { src: bundles, results: ["DEV03"] };
    const out = mergeDev03Overlay(bundles, overlay, blendStub);
    expect(out[0]!.dev03Calc).toBe("DEV03");
    expect(out[0]!.blendCalc).toBe("BLEND(DEV03,V2)");
  });

  it("REGRESSION: stale cross-matchday overlay is NOT positionally paired", () => {
    // The exact bug that the tag-guard fixes: a previous matchday's overlay
    // must not fill the new matchday's match i.
    const prevMatchday = [bundle(), bundle()];
    const staleOverlay: Dev03OverlayState<C> = { src: prevMatchday, results: ["WRONG_TEAM_A", "WRONG_TEAM_B"] };
    const newMatchday = [bundle(), bundle()]; // different array reference
    const out = mergeDev03Overlay(newMatchday, staleOverlay, blendStub);
    // No stale dev-03 leaks in; falls back to null (→ ensemble) for both.
    expect(out[0]!.dev03Calc).toBeNull();
    expect(out[1]!.dev03Calc).toBeNull();
    expect(out[0]!.blendCalc).toBeNull();
  });

  it("blend is null when v2 is missing even if dev-03 landed", () => {
    const bundles = [bundle({ v2Calc: null })];
    const overlay: Dev03OverlayState<C> = { src: bundles, results: ["DEV03"] };
    const out = mergeDev03Overlay(bundles, overlay, blendStub);
    expect(out[0]!.dev03Calc).toBe("DEV03");
    expect(out[0]!.blendCalc).toBeNull();
  });

  it("prefers an already-present sync dev03Calc / blendCalc over the overlay", () => {
    const bundles = [bundle({ dev03Calc: "SYNC_DEV03", blendCalc: "SYNC_BLEND" })];
    const overlay: Dev03OverlayState<C> = { src: bundles, results: ["OVERLAY_DEV03"] };
    const out = mergeDev03Overlay(bundles, overlay, blendStub);
    expect(out[0]!.dev03Calc).toBe("SYNC_DEV03");
    expect(out[0]!.blendCalc).toBe("SYNC_BLEND");
  });

  it("null bundles (insufficient xG-history) pass through untouched", () => {
    const bundles = [null, bundle()];
    const overlay: Dev03OverlayState<C> = { src: bundles, results: [null, "DEV03"] };
    const out = mergeDev03Overlay(bundles, overlay, blendStub);
    expect(out[0]).toBeNull();
    expect(out[1]!.dev03Calc).toBe("DEV03");
  });

  it("does not call buildBlend with a stale dev-03 value", () => {
    const spy = vi.fn(blendStub);
    const newMatchday = [bundle()];
    const stale: Dev03OverlayState<C> = { src: [bundle()], results: ["STALE"] };
    mergeDev03Overlay(newMatchday, stale, spy);
    // dev-03 resolves to null (stale dropped) → blend called with (null, V2)
    expect(spy).toHaveBeenCalledWith(null, "V2", { tag: "ctx" });
  });

  it("partial overlay (some slots null): per-match independent fold", () => {
    const bundles = [bundle(), bundle()];
    const overlay: Dev03OverlayState<C> = { src: bundles, results: ["DEV03", null] };
    const out = mergeDev03Overlay(bundles, overlay, blendStub);
    expect(out[0]!.dev03Calc).toBe("DEV03");
    expect(out[0]!.blendCalc).toBe("BLEND(DEV03,V2)");
    expect(out[1]!.dev03Calc).toBeNull();
    expect(out[1]!.blendCalc).toBeNull();
  });
});
