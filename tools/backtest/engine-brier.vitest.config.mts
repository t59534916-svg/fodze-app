import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tools/backtest/engine_calibrated_brier.mts"],
  },
  resolve: { alias: { "@": path.resolve(__dirname, "..", "..", "src") } },
});
