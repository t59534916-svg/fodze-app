// Dedicated vitest config for the conformal runtime-calibration driver.
// Keeps the driver OUT of `npm run test` (default glob only matches *.test.ts)
// while still running it through vitest's TS pipeline + the "@" alias.
//   npx vitest run --config tools/backtest/conformal.vitest.config.mts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tools/backtest/conformal_runtime_calibrate.mts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "..", "..", "src") },
  },
});
