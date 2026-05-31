import { defineConfig } from "vitest/config"; import path from "node:path";
export default defineConfig({ test: { environment: "node", include: ["tools/backtest/engine_per_row_calib.mts"] },
  resolve: { alias: { "@": path.resolve(__dirname, "..", "..", "src") } } });
