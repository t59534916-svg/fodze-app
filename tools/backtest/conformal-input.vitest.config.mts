import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tools/backtest/conformal_gate_input_check.mts"],
  },
  resolve: { alias: { "@": path.resolve(__dirname, "..", "..", "src") } },
});
