// ═══════════════════════════════════════════════════════════════════════
// dev-03 Web Worker — off-main-thread LightGBM inference
//
// Spawned by `src/lib/dev03-worker-client.ts` (singleton, lazy).
//
// Protocol (postMessage shape):
//   In:  { id, type: "init" }                        — fetch + load model
//   In:  { id, type: "predict", input }              — single match
//   In:  { id, type: "predictBatch", inputs[] }      — batched matches
//   In:  { id, type: "ping" }                        — health check
//   Out: { id, type: "init.result"        , ok, ms } | { ..., error }
//   Out: { id, type: "predict.result"     , prediction }
//   Out: { id, type: "predictBatch.result", predictions[] }
//   Out: { id, type: "ping.result"        , ready }
//
// Worker imports the SYNC dev03-runtime — this is what gives us the
// off-main-thread parallelism: the heavy tree traversal happens here
// while React stays responsive on the main thread. The runtime in this
// thread is byte-identical to the main-thread copy (same TS module);
// only the model state is private to this worker instance.
// ═══════════════════════════════════════════════════════════════════════

/// <reference lib="webworker" />

import {
  loadDev03Model,
  isDev03ModelLoaded,
  dev03Predict,
  type Dev03FeatureInput,
  type Dev03Prediction,
  type Dev03Model_FullPayload,
} from "./dev03-runtime";

declare const self: DedicatedWorkerGlobalScope;

type InMsg =
  | { id: number; type: "init" }
  | { id: number; type: "predict"; input: Dev03FeatureInput }
  | { id: number; type: "predictBatch"; inputs: readonly Dev03FeatureInput[] }
  | { id: number; type: "ping" };

type OutMsg =
  | { id: number; type: "init.result"; ok: boolean; ms: number; error?: string }
  | { id: number; type: "predict.result"; prediction: Dev03Prediction | null }
  | { id: number; type: "predictBatch.result"; predictions: (Dev03Prediction | null)[] }
  | { id: number; type: "ping.result"; ready: boolean };

async function handleInit(): Promise<{ ok: boolean; ms: number; error?: string }> {
  const t0 = performance.now();
  try {
    if (isDev03ModelLoaded()) {
      // Already loaded — re-init is idempotent
      return { ok: true, ms: Math.round(performance.now() - t0) };
    }
    // Fetch the same artifact AppContext fetched — HTTP cache makes this
    // essentially free (no second network hit; just a second JSON.parse).
    const resp = await fetch("/dev03-model.json", { cache: "force-cache" });
    if (!resp.ok) {
      return { ok: false, ms: Math.round(performance.now() - t0), error: `HTTP ${resp.status}` };
    }
    const json = (await resp.json()) as Dev03Model_FullPayload;
    const ok = loadDev03Model(json);
    return { ok, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return {
      ok: false,
      ms: Math.round(performance.now() - t0),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  if (!msg || typeof msg.id !== "number" || typeof msg.type !== "string") return;

  let out: OutMsg;
  try {
    switch (msg.type) {
      case "init": {
        const r = await handleInit();
        out = { id: msg.id, type: "init.result", ...r };
        break;
      }
      case "predict": {
        const prediction = dev03Predict(msg.input);
        out = { id: msg.id, type: "predict.result", prediction };
        break;
      }
      case "predictBatch": {
        const predictions: (Dev03Prediction | null)[] = new Array(msg.inputs.length);
        for (let i = 0; i < msg.inputs.length; i++) {
          predictions[i] = dev03Predict(msg.inputs[i]);
        }
        out = { id: msg.id, type: "predictBatch.result", predictions };
        break;
      }
      case "ping": {
        out = { id: msg.id, type: "ping.result", ready: isDev03ModelLoaded() };
        break;
      }
      default: {
        // exhaustiveness guard
        const _exhaustive: never = msg;
        void _exhaustive;
        return;
      }
    }
    self.postMessage(out);
  } catch (err) {
    // Last-resort: emit a synthetic error result so the client Promise
    // doesn't hang. Client side will reject(err.message).
    self.postMessage({
      id: msg.id,
      type: `${msg.type}.result`,
      _error: err instanceof Error ? err.message : String(err),
    });
  }
};

// Signal readiness to the client (it ignores this if init hasn't been
// requested; useful for tooling that wants to detect a live worker).
self.postMessage({ id: 0, type: "worker.spawned" });

export {}; // make this a module
