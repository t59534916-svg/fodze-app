import { defineConfig } from "vitest/config"; import path from "node:path";
export default defineConfig({ test: { environment: "node", include: ["tools/backtest/_dev03_calib.mts"] },
  resolve: { alias: { "@": path.resolve(__dirname, "..", "..", "src") } } });
