# CLAUDE.md

F1 telemetry replay: a static React/TS web app that animates F1 cars around a circuit
from FastF1 data. PRD.md holds the detail; this file holds the law.

## Stack

- App: Vite + React 18 + TypeScript, Zustand, Tailwind + CSS vars, Canvas 2D.
- Schema/validation: Zod (one schema, also the TS type via `z.infer`).
- Tests: Vitest + React Testing Library. Lint: ESLint + Prettier.
- Pipeline: Python 3.10+, FastF1 3.8+ (separate `pipeline/`, emits JSON).

## Commands

- Dev: `cd app && npm run dev`
- Typecheck: `cd app && npm run typecheck`
- Lint: `cd app && npm run lint`
- Test: `cd app && npm run test` (CI: `npm run test -- --run`)
- Build: `cd app && npm run build`
- **All gates: `cd app && npm run check`** (typecheck + lint + test + build; the
  definition-of-done command — run this, not the four individually)
- Pipeline (needs network — human's machine, never CI): `cd pipeline && python
  build_replay.py --year 2024 --gp Monza --session Q --driver VER --out
  ../app/public/data/monza_ver.json`. It validates its own output through the app's
  real schema before exiting; load the result with the app's "Load replay JSON" picker.
- Pipeline tests (no network, gated in CI): `cd pipeline && pytest`
- Validate any replay JSON by hand: `cd app && npm run validate:replay -- <file>`

## Architecture rules (non-negotiable — see PRD §Load-bearing decisions)

1. **One clock, in a ref, never in React/store state.** A single `requestAnimationFrame`
   loop owns the live clock. Store holds only discrete transport state (isPlaying,
   speedMult, seekTarget, replay). HUD reads an interpolated snapshot at **≤30fps**.
   Never setState per animation frame. Never subscribe the canvas to per-frame updates.
2. **`cars` is always an array.** Never branch on car count; never special-case one car.
3. **Uniform-time samples; O(1) lookup** via `index = clock * sampleRateHz`. No scanning.
4. **`src/engine/` is pure and headless** — no React, DOM, or canvas imports there.
   All time/geometry/interpolation/color/alignment logic lives there and is unit-tested.
5. **Multi-car alignment uses `SessionTime`,** not per-lap `Time` (v2).
6. **Resampling by channel type:** continuous (Speed, X, Y, RPM) interpolate;
   discrete (nGear, DRS, Brake) forward-fill.
7. **The Zod schema is the single contract.** The loader validates all replay JSON
   against it and fails loudly on mismatch. Pipeline output must conform.
8. **Indicators (DRS) are optional and season-dependent — never core fields.**
   DRS is removed in 2026 and F1 publishes no active-aero/ERS replacement, so the
   `DRS` channel is all-zeros for 2026+. The HUD renders a DRS indicator only when the
   data actually carries one; the app never branches on year. Don't build features on
   active aero, Overtake Mode, Boost, or ERS — that data does not exist publicly. For
   pre-2026 data, isolate the (undocumented) DRS integer mapping in one function.

## Code style

- TypeScript strict. No `any` without a comment justifying it.
- Engine functions are pure: inputs → outputs, no side effects, no globals.
- Design tokens as CSS custom properties; no hard-coded hex scattered in components.
- Small modules; one responsibility each. Name by what it does, not how it's built.

## Testing

- Every `src/engine/` module has Vitest unit tests. **≥90% lines/branches/functions is
  enforced, not aspirational** — a `perFile` vitest coverage threshold on
  `src/engine/**` in `app/vite.config.ts`, run by `npm run check` and by CI. Per file,
  not aggregate: a new untested module scores 0% and fails on its own rather than
  hiding behind the average. Tests ship with the module, not in a later cleanup.
- Cover: O(1) lookup correctness, interpolation at boundaries/wrap, rotation/fit math,
  speed→color stops, schema acceptance + rejection, (v2) session-time alignment.
- Tests use the committed `src/engine/__fixtures__/sample-lap.json` — **never the
  network.** App, tests, and CI must run fully offline.
- A slice is not done until `npm run check` is green.

## Gotchas

- `npm audit` criticals in vitest/vite are dev-toolchain only, unreachable as configured
  (no `@vitest/ui`); resolved by the toolchain slice — don't panic-fix.

## Workflow

- Read PLAN.md and CLAUDE.md at the start of each session; implement the next unchecked
  slice only. One slice per session; `/clear` between slices.
- Self-verify with `npm run check` before declaring done.
- Self-review the diff before declaring done by running the `/review` command
  (`.claude/commands/review.md`) and reporting its checklist results.
- If a direction is wrong, stop and say so rather than absorbing a bad instruction.
- **Flag consequences** of an instruction instead of silently complying.
- Auto-merge (squash) may be enabled without asking on PRs whose full content was
  pre-approved in-session; any PR containing an undiscussed decision sits for review.

## Branching & release (trunk-based CD)

- Short-lived branch per slice off `main`; open a PR early. Never commit to `main`
  directly — the ruleset rejects it.
- Pushing a branch triggers a Vercel **preview** + the `verify` CI check; merging to
  `main` ships **production**. `main` stays releasable at all times.
- **Squash-merge only** (linear history). The PR title becomes the squash commit, so
  write it as a Conventional Commit: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`.
- The required status check is the CI job named **`verify`** — do not rename that job;
  `.github/ruleset.json` references it by that exact string.
- Rollback = revert the merge commit; Vercel restores the prior production deployment.
- Repo CD rules are config-as-code: `.github/ruleset.json` applied via
  `scripts/setup-repo.sh`. Don't reconfigure them ad hoc.

## Git

- Commit per slice with a descriptive message. **Never commit red** (failing build/tests).
- **Never `git push` unless asked.** Never force-push.
- `.gitignore` is committed first; never commit `node_modules/`, `dist/`,
  `app/public/data/*` (generated), `.f1cache/`, `pipeline/.venv/`, or any `.env*`.

## Deploy

- Vercel owns deployment via its GitHub integration (Root Directory = `app`). **Do not
  write deploy scripts or a deploy workflow.** GitHub Actions (`.github/workflows/ci.yml`)
  is the quality gate only: typecheck + lint + test + build. Merges to `main` deploy to
  production; branches/PRs get Vercel preview URLs.

## Human-only boundary

Accounts, credentials, tokens, domains, the GitHub repo, and deploy/host setup are the
human's job. Don't ask for tokens or try to automate these.

## prototype/ (reference-only — do not emulate)

`prototype/TelemetryReplay.jsx` predates the architecture rules above and violates
several of them by design (it is a single-file prototype). Use it only to port visual
constants (palette / `THERMAL` stops, bucketing) and as a reference for intended
look-and-feel. **Never import from it and never copy its React/state/clock patterns.**
Its synthetic generator is fixture/dev material, not production code. Delete the
directory once Slices 4–5 have extracted what they need.

## Out of scope (defend)

No live streaming, no backend, no WebGL/3D in v1, no auth, no ML/predictions.
v1 = one car, one lap. Race replay is v2 on the same engine and schema.
