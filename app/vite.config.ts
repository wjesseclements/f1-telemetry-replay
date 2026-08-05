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
      //
      // Since vitest 4 this line is also what makes an UNTESTED module visible at
      // all: `coverage.all` was removed along with the `test-exclude` dependency
      // that implemented it, and the report now covers only files imported during
      // the run unless `include` says otherwise. Delete this and a module with no
      // test scores nothing instead of scoring 0% — the gate would stop biting
      // silently, which is the failure it exists to prevent.
      include: ["src/engine/**/*.ts"],
      // The ≥90% bar from CLAUDE.md "Testing", enforced rather than asserted. Glob
      // keys are matched against paths relative to this config's root (app/).
      //
      // `perFile` is what makes it a ratchet. Measured aggregate, one new untested
      // module scores 0% and the other six still carry the average over 90 — the
      // gate passes and the bar quietly erodes, which is the exact failure this is
      // meant to prevent. Per file, every engine module has to stand on its own,
      // which is what "every src/engine/ module has unit tests" actually means.
      //
      // The glob key is load-bearing, not decorative: point it at a path that
      // matches nothing and an uncovered engine module passes. Both directions were
      // measured in Slice 10 against the rewritten v4 provider.
      thresholds: {
        perFile: true,
        "src/engine/**": { lines: 90, branches: 90, functions: 90 },
      },
    },
  },
});
