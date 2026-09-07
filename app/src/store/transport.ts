/**
 * transport.ts — discrete state a human changes, and nothing else.
 *
 * CLAUDE.md architecture rule 1 draws the line this file sits on: the live clock
 * belongs to the render loop's ref and is never store or React state, because a
 * store write per animation frame re-renders every subscriber 60 times a second.
 * What lives here is only what changes when a HUMAN does something — play, pause,
 * change speed, scrub, load a replay, pick a car to follow. Those are discrete
 * events, and they are rare.
 *
 * `focusedCarIndex` is the one field here that is not transport, and it is here for
 * the cadence rather than the category: it changes on a keypress or a click, which is
 * the criterion above. Two things settle it against the alternatives.
 *
 *  - **The canvas already has a way to read this store without subscribing.** The
 *    frame callback destructures `getState()`, so focus reaches the renderer as one
 *    more field and zero new subscriptions. Held in React and passed down as a prop it
 *    would re-render `TrackCanvas` on every focus change, which the `commits === 1`
 *    test in `TrackCanvas.test.tsx` exists to forbid.
 *  - **The invariant lives with the data it constrains.** "Focus is a valid index into
 *    the current replay's cars" is enforced inside `setReplay`, atomically, instead of
 *    in an effect somewhere that has to notice the replay changed.
 *
 * `comparisonCarIndex` (Slice 15) rides the same cadence criterion — it changes on a
 * click — but not the same first argument: the render loop never reads it, because the
 * comparison is drawn only in the HUD's SVG trace, not on the canvas. What settles
 * store over `galleryOpen`-style local state is `focusedCarIndex`'s SECOND argument
 * alone: "comparison is a valid index into the current replay's cars, or null" is a
 * replay-coupled invariant, and it is enforced atomically inside `setReplay` rather
 * than in an effect that has to notice the replay changed (`galleryOpen` has no such
 * invariant, which is why it stayed local). It is the same species of state as focus —
 * an identity into `cars[]` — and the pair belongs together.
 *
 * The render loop reads this store with `useTransport.getState()` inside its frame
 * callback rather than subscribing to it, so transport changes never re-render the
 * canvas either. See `src/render/TrackCanvas.tsx`.
 */
import { create } from "zustand";
import type { Replay } from "../engine/schema";
import { prefersReducedMotion } from "./motion";

export interface TransportState {
  /** The validated replay, or `null` before bootstrap has loaded one. */
  replay: Replay | null;
  isPlaying: boolean;
  /** Playback rate multiplier: 1 is real time. */
  speedMult: number;
  /**
   * A pending seek in seconds, or `null` when there is nothing to apply.
   *
   * This is a REQUEST, not a position: the clock it seeks lives in the loop's ref,
   * so a scrub writes the target here and the next frame moves the clock and calls
   * `consumeSeek`. Storing the resulting position instead would put the clock back
   * in the store by the back door.
   */
  seekTarget: number | null;
  /**
   * Which car the presentation follows: an index into `replay.cars`.
   *
   * An INDEX INTO `cars`, deliberately — never a position in the timing tower. The
   * tower sorts itself by gap and reorders whenever cars change places, so a stored
   * row position would silently mean a different car after a resort. `cars[]` order
   * never moves, so this is the car's identity.
   */
  focusedCarIndex: number;
  /**
   * The car overlaid on the focused car's speed trace, or `null` for none.
   *
   * An index into `cars[]` for the same reason `focusedCarIndex` is: the tower
   * resorts, `cars[]` never moves. `null` is the default — a comparison is always an
   * explicit human choice, never derived from the running order, so the overlaid line
   * cannot silently change identity at an overtake. When it coincides with
   * `focusedCarIndex` the value is KEPT and the overlay merely not drawn
   * (self-comparison is meaningless): cycling focus through the field never mutates a
   * deliberate choice, and moving focus off the compared car brings the overlay back.
   */
  comparisonCarIndex: number | null;

  setReplay: (replay: Replay) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  setSpeedMult: (speedMult: number) => void;
  seek: (seconds: number) => void;
  consumeSeek: () => void;
  setFocusedCarIndex: (index: number) => void;
  setComparisonCarIndex: (index: number | null) => void;
}

export const useTransport = create<TransportState>((set) => ({
  replay: null,
  /**
   * Autoplay, unless the user has asked for reduced motion.
   *
   * Read once, when the store module is first imported — deliberately. Re-reading it
   * live would let an OS setting change yank playback away from someone who had just
   * pressed play, so the preference decides where the replay STARTS and the human
   * decides everything after that.
   */
  isPlaying: !prefersReducedMotion(),
  speedMult: 1,
  seekTarget: null,
  focusedCarIndex: 0,
  comparisonCarIndex: null,

  // A new replay is followed from its first car, compared with nothing. Carrying
  // either index over would point at a driver who is not in this file — or off the
  // end of a shorter one.
  setReplay: (replay) =>
    set({ replay, focusedCarIndex: 0, comparisonCarIndex: null }),
  play: () => set({ isPlaying: true }),
  pause: () => set({ isPlaying: false }),
  togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),
  setSpeedMult: (speedMult) => set({ speedMult }),
  seek: (seconds) => set({ seekTarget: seconds }),
  consumeSeek: () => set({ seekTarget: null }),
  setFocusedCarIndex: (focusedCarIndex) => set({ focusedCarIndex }),
  setComparisonCarIndex: (comparisonCarIndex) => set({ comparisonCarIndex }),
}));
