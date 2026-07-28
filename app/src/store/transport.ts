/**
 * transport.ts — discrete transport state, and nothing else.
 *
 * CLAUDE.md architecture rule 1 draws the line this file sits on: the live clock
 * belongs to the render loop's ref and is never store or React state, because a
 * store write per animation frame re-renders every subscriber 60 times a second.
 * What lives here is only what changes when a HUMAN does something — play, pause,
 * change speed, scrub, load a replay. Those are discrete events, and they are rare.
 *
 * The render loop reads this store with `useTransport.getState()` inside its frame
 * callback rather than subscribing to it, so transport changes never re-render the
 * canvas either. See `src/render/TrackCanvas.tsx`.
 */
import { create } from "zustand";
import type { Replay } from "../engine/schema";

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

  setReplay: (replay: Replay) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  setSpeedMult: (speedMult: number) => void;
  seek: (seconds: number) => void;
  consumeSeek: () => void;
}

export const useTransport = create<TransportState>((set) => ({
  replay: null,
  // Autoplay by default. Slice 4b makes this conditional on prefers-reduced-motion.
  isPlaying: true,
  speedMult: 1,
  seekTarget: null,

  setReplay: (replay) => set({ replay }),
  play: () => set({ isPlaying: true }),
  pause: () => set({ isPlaying: false }),
  togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),
  setSpeedMult: (speedMult) => set({ speedMult }),
  seek: (seconds) => set({ seekTarget: seconds }),
  consumeSeek: () => set({ seekTarget: null }),
}));
