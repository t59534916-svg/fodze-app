import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tools/backtest/engine_calibrated_brier.mts"],
    testTimeout: 120_000,
  },
  resolve: { alias: { "@": path.resolve(__dirname, "../../src") } },
});
