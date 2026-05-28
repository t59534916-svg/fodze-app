// ═══════════════════════════════════════════════════════════════════════
// dev-03 Worker Client — main-thread Promise bridge
//
// Owns the singleton Web Worker instance. Lazy-spawns on first call.
// Exposes:
//   - ensureDev03Worker()      — pre-spawn + load model (call from AppContext)
//   - dev03PredictAsync(input) — single-match predict via worker
//   - dev03PredictBatchAsync(inputs[]) — batch predict (one round-trip)
//   - isDev03WorkerReady()     — synchronous readiness check (state mirror)
//   - terminateDev03Worker()   — for tests + shutdown
//
// Falls back to MAIN-THREAD sync predict when:
//   - SSR / no `Worker` global (Node test runner, server-side render)
//   - Worker spawn throws (CSP / sandbox / disabled)
//
// The fallback path lets tests + golden parity work unchanged.
// ═══════════════════════════════════════════════════════════════════════

import {
  dev03Predict,
  isDev03ModelLoaded,
  type Dev03FeatureInput,
  type Dev03Prediction,
} from "./dev03-runtime";

type WorkerOutMsg =
  | { id: number; type: "init.result"; ok: boolean; ms: number; error?: string; _error?: string }
  | { id: number; type: "predict.result"; prediction: Dev03Prediction | null; _error?: string }
  | { id: number; type: "predictBatch.result"; predictions: (Dev03Prediction | null)[]; _error?: string }
  | { id: number; type: "ping.result"; ready: boolean; _error?: string };

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

// ─── Module-level state (singleton) ──────────────────────────────────

let worker: Worker | null = null;
let workerReady = false;
let workerInitPromise: Promise<boolean> | null = null;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

/** True if we have a live worker AND it confirmed model-loaded. */
export function isDev03WorkerReady(): boolean {
  return workerReady;
}

/** Lazy worker spawn. Idempotent — repeat calls return the cached instance. */
function getOrSpawnWorker(): Worker | null {
  if (worker) return worker;
  // Guard against SSR + test env (no Worker global)
  if (typeof Worker === "undefined") return null;
  try {
    // The `new URL(..., import.meta.url)` pattern is what Next.js/Webpack
    // detects to emit the worker as its own bundle chunk. Module-type
    // worker so ES `import` works inside dev03-worker.ts.
    worker = new Worker(new URL("./dev03-worker.ts", import.meta.url), {
      type: "module",
      name: "dev03",
    });
    worker.onmessage = handleWorkerMessage;
    worker.onerror = handleWorkerError;
  } catch (err) {
    // CSP blocked, sandboxed iframe, or other env-specific block.
    // Fall back to main-thread sync predict.
    console.warn(
      "[dev03-worker-client] Worker spawn failed — falling back to main thread:",
      err instanceof Error ? err.message : err
    );
    worker = null;
  }
  return worker;
}

function handleWorkerMessage(ev: MessageEvent<WorkerOutMsg>): void {
  const msg = ev.data;
  // Bootstrap message — worker just spawned, before init
  if ((msg as { type?: string }).type === "worker.spawned") return;

  if (typeof msg.id !== "number") return;
  const req = pending.get(msg.id);
  if (!req) return;
  pending.delete(msg.id);

  if (msg._error) {
    req.reject(new Error(msg._error));
    return;
  }
  req.resolve(msg);
}

function handleWorkerError(ev: ErrorEvent): void {
  console.error("[dev03-worker-client] Worker error:", ev.message, ev);
  // Reject all pending requests; subsequent calls will respawn / fallback.
  for (const req of pending.values()) {
    req.reject(new Error(`Worker error: ${ev.message}`));
  }
  pending.clear();
  workerReady = false;
  workerInitPromise = null;
  if (worker) {
    try {
      worker.terminate();
    } catch {
      /* ignore */
    }
    worker = null;
  }
}

async function rpc<TResp extends WorkerOutMsg>(
  inType: "init" | "predict" | "predictBatch" | "ping",
  payload: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<TResp> {
  const w = getOrSpawnWorker();
  if (!w) throw new Error("Worker unavailable");
  const id = nextRequestId++;
  return new Promise<TResp>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Worker ${inType} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v as TResp);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    w.postMessage({ id, type: inType, ...payload });
  });
}

/**
 * Pre-spawn the worker + init the model. Safe to call from AppContext
 * after the main thread also loads the model — the worker fetches its
 * own copy of /dev03-model.json (HTTP-cached, so no second download).
 *
 * Returns true if the worker reported model loaded successfully.
 * Returns false if Worker is unavailable (tests, SSR) — caller should
 * gracefully fall through to sync `dev03Predict`.
 *
 * Idempotent: repeat calls return the cached init promise.
 */
export async function ensureDev03Worker(): Promise<boolean> {
  if (workerInitPromise) return workerInitPromise;
  workerInitPromise = (async () => {
    try {
      const r = await rpc<{
        id: number;
        type: "init.result";
        ok: boolean;
        ms: number;
        error?: string;
      }>("init", {}, 60_000);
      workerReady = !!r.ok;
      if (r.error) {
        console.warn("[dev03-worker-client] init error:", r.error);
      }
      return workerReady;
    } catch (err) {
      console.warn(
        "[dev03-worker-client] init failed:",
        err instanceof Error ? err.message : err
      );
      workerReady = false;
      return false;
    }
  })();
  return workerInitPromise;
}

/**
 * Predict for a single match via Worker. Falls back to sync main-thread
 * `dev03Predict` if the worker is unavailable (SSR, test env, or if
 * `ensureDev03Worker` was never called).
 *
 * Safe to call in tight loops — postMessage round-trip is microsecond-fast;
 * the heavy tree traversal happens off the React render thread.
 */
export async function dev03PredictAsync(
  input: Dev03FeatureInput,
): Promise<Dev03Prediction | null> {
  // Fast-path: no worker → sync (tests, SSR, fallback)
  if (!worker || !workerReady) {
    // If main thread also has the model loaded, use it.
    if (isDev03ModelLoaded()) return dev03Predict(input);
    return null;
  }
  try {
    const r = await rpc<{ id: number; type: "predict.result"; prediction: Dev03Prediction | null }>(
      "predict",
      { input },
      10_000,
    );
    return r.prediction;
  } catch (err) {
    console.warn(
      "[dev03-worker-client] predict failed — falling back to sync:",
      err instanceof Error ? err.message : err
    );
    if (isDev03ModelLoaded()) return dev03Predict(input);
    return null;
  }
}

/**
 * Batch predict — single round-trip for N matches. Use this when computing
 * a whole matchday so the worker parallelises away from the React thread
 * in one shot (avoids N postMessage round-trips).
 */
export async function dev03PredictBatchAsync(
  inputs: readonly Dev03FeatureInput[],
): Promise<(Dev03Prediction | null)[]> {
  if (inputs.length === 0) return [];
  if (!worker || !workerReady) {
    if (isDev03ModelLoaded()) {
      return inputs.map((i) => dev03Predict(i));
    }
    return inputs.map(() => null);
  }
  try {
    const r = await rpc<{
      id: number;
      type: "predictBatch.result";
      predictions: (Dev03Prediction | null)[];
    }>("predictBatch", { inputs }, 30_000);
    return r.predictions;
  } catch (err) {
    console.warn(
      "[dev03-worker-client] predictBatch failed — falling back to sync:",
      err instanceof Error ? err.message : err
    );
    if (isDev03ModelLoaded()) {
      return inputs.map((i) => dev03Predict(i));
    }
    return inputs.map(() => null);
  }
}

/** Test / shutdown hook. */
export function terminateDev03Worker(): void {
  for (const req of pending.values()) {
    req.reject(new Error("Worker terminated"));
  }
  pending.clear();
  workerReady = false;
  workerInitPromise = null;
  if (worker) {
    try {
      worker.terminate();
    } catch {
      /* ignore */
    }
    worker = null;
  }
}

