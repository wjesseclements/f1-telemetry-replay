/**
 * speedOptions.ts — the playback rates the transport offers.
 *
 * Its own module rather than an export from `SpeedControl.tsx` because
 * `react-refresh/only-export-components` is right: a component file that also exports a
 * value loses fast refresh for everything in it. `allowConstantExport` covers primitive
 * constants but not an array, so this is the intended fix rather than a suppression.
 */

/** PLAN.md Slice 5: 0.5 / 1 / 2 / 4x. */
export const SPEED_OPTIONS = [0.5, 1, 2, 4] as const;
