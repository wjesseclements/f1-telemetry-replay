/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
    coverage: {
      provider: "v8",
      reporter: ["text"],
      // Only the engine is measured. It is the part CLAUDE.md holds to a bar, and
      // scoping the report keeps the failure message about the thing being gated.
      include: ["src/engine/**/*.ts"],
      // The ≥90% bar from CLAUDE.md "Testing", enforced rather than asserted. Glob
      // keys are matched against paths relative to this config's root (app/).
      //
      // `perFile` is what makes it a ratchet. Measured aggregate, one new untested
      // module scores 0% and the other six still carry the average over 90 — the
      // gate passes and the bar quietly erodes, which is the exact failure this is
      // meant to prevent. Per file, every engine module has to stand on its own,
      // which is what "every src/engine/ module has unit tests" actually means.
      // `coverage.all` defaults to true, so an untested module IS measured.
      thresholds: {
        perFile: true,
        "src/engine/**": { lines: 90, branches: 90, functions: 90 },
      },
    },
  },
});
