---
description: Self-review the current slice against repo law before declaring done
---

Review the current slice's work against this checklist, **in order**. Report each
item as PASS / FAIL with evidence (a file:line reference or command output). Do not
summarize the diff instead of reviewing it. A single FAIL means the slice is not
done — fix it and re-run `/review` from the top.

1. **Gates green.** Run `cd app && npm run check` (always from `app/`). Report the
   result of each gate (typecheck, lint, format, test, build). No skipping gates, no
   "should pass".
   - **Check the FULL output for warnings explicitly** — pipe it to a file and
     `grep -ciE 'warn|error'`, or run the gate bare. Never judge a gate from a truncated
     `tail`: a warning above the cut reads as a pass. Report the count, and treat any
     non-zero count as a finding even though it may not fail the build.
     Match `warn`, not `warning`: Prettier prints `[warn]` and ESLint prints `warning`,
     so the narrower pattern silently misses half of them.

2. **Scope.** Run `git diff --stat main...HEAD`. Every touched file must fall within
   the active slice's stated scope in PLAN.md. List any file outside it and STOP —
   revert it or flag it to the human; do not justify it after the fact.

3. **Architecture rules.** Re-read CLAUDE.md "Architecture rules" and check the diff
   against every numbered rule this slice touches. Confirm explicitly, at minimum:
   - no clock or per-frame values in React/store state; no `setState` per frame
   - `cars` handled as an array everywhere; no single-car special cases
   - `src/engine/` contains zero React/DOM/canvas imports
   - all replay JSON crosses through the Zod schema; nothing consumes raw JSON
   - **Disable inventory.** List every `eslint-disable` / `@ts-expect-error` /
     `@ts-ignore` / `any` added in the diff, each with the justification written at its
     site. **Report this even when the count is zero** — "0 disables" is the finding.
     A disable must be targeted and cite the rule it protects; loosening a rule in
     `eslint.config.js` instead of suppressing at the call site is a FAIL.

4. **No new dependencies** unless the slice spec explicitly lists them. Check
   `git diff main...HEAD -- app/package.json` and report any additions.

5. **Tests are real.** Every new test must assert behavior — values, error messages,
   boundary conditions — not mere existence/rendering. Flag any test that would still
   pass if the feature's logic were deleted. Confirm tests use the committed fixture
   and never the network.

6. **No prototype leakage.** Confirm nothing imports from `prototype/` and no
   React/state/clock patterns were copied from it (constants/palette values are fine).

7. **Docs current.** If this slice changed a command, rule, or decision, confirm
   CLAUDE.md / PLAN.md / PRD.md were updated in the same diff. Tick the slice's
   checkbox in PLAN.md only if every item above passed.

Finish with a one-paragraph verdict: done / not done, and the single riskiest thing
a human reviewer should look at first in the PR.
