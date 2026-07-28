import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "coverage"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    files: ["**/*.{test,spec}.{ts,tsx}", "src/test/**"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    // scripts/ runs under node (vite-node), not in a browser. Without this the
    // validator's `process`/`console` would lint as undefined globals — and a lint
    // error there is exactly the kind of thing that silently stops being checked.
    files: ["scripts/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // CLAUDE.md rule 4: src/engine/ is pure and headless — no React/DOM/canvas.
    // Enforce the React/react-dom ban here (DOM/canvas are globals, not imports).
    files: ["src/engine/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              message: "src/engine/ must be pure and headless (no React).",
            },
            {
              name: "react-dom",
              message: "src/engine/ must be pure and headless (no react-dom).",
            },
          ],
          patterns: [
            {
              group: ["react", "react/*", "react-dom", "react-dom/*"],
              message: "src/engine/ must be pure and headless (no React).",
            },
          ],
        },
      ],
    },
  },
);
