import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { FeaturedPanel } from "./components/FeaturedPanel";
import { COMPACT_FOCUS_RING, FOCUS_RING } from "./components/focus";
import { Hud } from "./components/Hud";
import { GalleryIcon } from "./components/icons";
import { ReplayError } from "./components/ReplayError";
import { ReplayFilePicker } from "./components/ReplayFilePicker";
import { ScenarioEvents } from "./components/ScenarioEvents";
import { StatusBanner } from "./components/StatusBanner";
import { SpeedLegend } from "./components/SpeedLegend";
import { TOUCH_TARGET } from "./components/touchTarget";
import { TransportBar } from "./components/TransportBar";
import { useTransportKeys } from "./keyboard/useTransportKeys";
import { TrackCanvas } from "./render/TrackCanvas";
import { useTransport } from "./store/transport";

const GALLERY_PANEL_ID = "featured-replays";

/**
 * On the shortest landscape phones (`fulltrack:`, tailwind.config.js; Safari's
 * 724x257) the page is a grid instead of a column, so the header can sit above
 * the tower rather than across the top of the screen:
 *
 *     track | header
 *     track | tower        the track cell spans both rows: the full height
 *     transport bar        from the top of the screen to the transport bar.
 *
 * The second column is the tower's own width below `md` (`side:w-64` in Hud.tsx,
 * 16rem), written out so the header's one row cannot widen it; the rows are the
 * header's height, the rest, and the transport bar's. DOM order, and with it the
 * tab order, is unchanged: header, track, tower, transport bar. The wrapper that
 * puts the track and the tower side by side elsewhere is `display: contents`
 * here, so its two children are the grid's.
 *
 * Only with a replay on screen: the error and the no-replay states have no tower
 * to sit above, and keep the header across the top.
 */
const FULL_TRACK_GRID =
  "fulltrack:grid fulltrack:grid-cols-[minmax(0,1fr)_16rem] fulltrack:grid-rows-[auto_minmax(0,1fr)_auto]";
/**
 * The header in that grid: the top of the second column, ruled off from the
 * track like the tower under it. 4 px padding and gaps (8 elsewhere on a short
 * phone) keep it one 44 px row in the 256 px column: the title is 144.4 px and
 * the two boxes 44 each, 248.4 px of a 239 px content box with 8 px, so the
 * header wrapped to 96 px and the tower lost another 52; with 4 px they take
 * 240.4 of 247 (measured in Chrome, SF Mono).
 */
const FULL_TRACK_HEADER =
  "fulltrack:col-start-2 fulltrack:row-start-1 fulltrack:gap-x-1 fulltrack:border-l fulltrack:border-line fulltrack:px-1";

export interface AppProps {
  /**
   * A bootstrap load failure, or `null`. A prop rather than store state: the
   * transport store holds discrete transport state and nothing else, and this is
   * decided once before the first render and never changes.
   */
  bootstrapError?: string | null;
}

export default function App({ bootstrapError = null }: AppProps) {
  // A discrete value: it changes when a replay is loaded, not per frame.
  const replay = useTransport((s) => s.replay);

  /**
   * Whether the featured-replay panel is open, and the toggle that owns it.
   *
   * Local React state, NOT the transport store. `focusedCarIndex` earned its place
   * in that store because the render loop reads it inside the frame callback; this
   * is read only by React, so putting it there would widen the store for nothing.
   *
   * Open on first paint: the boot fixture is a synthetic oval, and the three
   * scenario titles are the pitch. It never reopens itself after that.
   */
  const [galleryOpen, setGalleryOpen] = useState(true);
  const galleryToggleRef = useRef<HTMLButtonElement>(null);

  /**
   * Close, and put focus back where it came from.
   *
   * Every close route goes through here — the panel's own button, Escape, and
   * choosing a scenario — so a keyboard visitor lands back on the toggle rather
   * than at the top of the document. That is the behaviour that silently rots, so
   * `App.test.tsx` asserts it on all three routes.
   *
   * The close is committed synchronously (`flushSync`) BEFORE the focus call. On
   * a phone the open panel holds the header inert (`usePhoneModal`, Slice 26),
   * and an inert button cannot take focus; the commit that unmounts the panel is
   * the one that wakes the header. Batched, the focus call ran first and focus
   * fell to the document body.
   */
  const closeGallery = () => {
    flushSync(() => setGalleryOpen(false));
    galleryToggleRef.current?.focus();
  };

  // App itself subscribes to NOTHING per-frame. `Hud` and `TransportBar` own their own
  // telemetry subscriptions, which is what keeps their 30 Hz re-renders away from
  // `TrackCanvas` — a subscription up here would re-render the canvas with them.
  useTransportKeys(replay);

  // Whether the replay's layout is on screen: the one with a tower column for
  // the header to sit above on the shortest phones (`FULL_TRACK_GRID`).
  const replayShown = bootstrapError === null && replay !== null;

  return (
    // `h-dvh`, not `h-screen`: `100vh` on mobile browsers is the viewport WITHOUT the
    // retracting address bar, so the transport bar sat under it until you scrolled.
    <main
      className={`flex h-dvh flex-col bg-bg text-txt ${replayShown ? FULL_TRACK_GRID : ""}`}
    >
      {/* On a short phone (`compact:`, tailwind.config.js: any phone held
          sideways, or one held upright up to 800 px tall) the header is one thin
          row, 44 px instead of 54 (landscape) or 82–138 (upright, where it
          wrapped): no vertical padding, a smaller title, and the two buttons as
          44 px icon boxes, the ruled touch-target floor (`touchTarget.ts`). Every
          control keeps its place in the tab order and its name. It still wraps,
          which only a failed load's error box makes it do (measured: a no-wrap
          row pushed that box off a 375 px screen). On the shortest landscape
          phones it moves above the tower column (`FULL_TRACK_HEADER`). */}
      <header
        className={`flex flex-wrap items-baseline gap-x-3 gap-y-2 px-4 py-3 compact:items-center compact:gap-x-2 compact:px-2 compact:py-0 ${replayShown ? FULL_TRACK_HEADER : ""}`}
      >
        <h1 className="font-mono text-sm font-bold tracking-[0.2em] compact:shrink-0 compact:text-xs compact:tracking-[0.15em]">
          TELEMETRY REPLAY
        </h1>
        {/* On a wide screen (5:4 and up), a short one (at most 700 px tall) or
            an upright phone whose header is a thin row (under 640 px wide and at
            most 800 px tall), `onerow:` in tailwind.config.js, this line takes
            whatever the title's
            row leaves and truncates its tail. The tail is the driver list, the
            tower already lists every driver, and the full line stays in the DOM.
            Wrapped, 22 drivers cost the track 52–68 px of a 360–412 px landscape
            phone and 56 px of a 375x667 one (Slice 25). `min-w-24` keeps it from
            being squeezed to "M…": with under 6rem left beside the title it
            moves to a line of its own instead. The controls still wrap when they
            alone cannot fit. Above the tower column (`fulltrack:`) there is no
            room for it at all, and it is dropped from view (ruled 2026-10-12;
            the tower lists every driver); a screen reader still reads it. */}
        {replay !== null && (
          <p className="font-mono text-xs text-dim onerow:min-w-24 onerow:flex-1 onerow:truncate compact:min-w-0 fulltrack:sr-only">
            {replay.meta.event} · {replay.meta.session} ·{" "}
            {replay.cars.map((car) => car.driver).join(" ")}
          </p>
        )}
        {/* The way back into the gallery once it has been dismissed. Same control
            that closes it, so there is one place to look. */}
        <button
          ref={galleryToggleRef}
          type="button"
          onClick={() => (galleryOpen ? closeGallery() : setGalleryOpen(true))}
          aria-expanded={galleryOpen}
          aria-controls={GALLERY_PANEL_ID}
          // No `title` tooltip: a touch browser shows none, and wherever the
          // label is visible it would only repeat it. A desktop window at most
          // 480 px tall is `compact:` too, and there the icon has no tooltip.
          className={`rounded border border-line px-3 py-1.5 font-mono text-xs text-dim transition-colors hover:text-txt compact:flex compact:shrink-0 compact:items-center compact:justify-center compact:p-0 ${TOUCH_TARGET} ${FOCUS_RING} ${COMPACT_FOCUS_RING}`}
        >
          <GalleryIcon className="hidden compact:block" />
          <span className="compact:sr-only">Featured replays</span>
        </button>

        {/* The way a real lap from the pipeline gets in. The committed fixture stays
            the default, so the app still boots with zero network. */}
        <ReplayFilePicker />
      </header>

      {bootstrapError !== null ? (
        <div className="min-h-0 flex-1">
          <ReplayError message={bootstrapError} />
        </div>
      ) : replay !== null ? (
        <>
          {/* The track and the numbers sit side by side (`side:`) when there is
              width for the sidebar or the screen is wide rather than tall (5:4 and
              up, `tailwind.config.js`), and stack otherwise. `min-h-0`/`min-w-0` on
              the canvas cell in BOTH directions: a flex item defaults to its
              content's minimum size, and the canvas would otherwise refuse to shrink
              and push the HUD off screen. On the shortest landscape phones the
              wrapper steps aside (`contents`) and the track cell spans the
              page grid's top two rows (`FULL_TRACK_GRID`). */}
          <div className="flex min-h-0 flex-1 flex-col side:flex-row fulltrack:contents">
            <div className="relative min-h-0 min-w-0 flex-1 fulltrack:col-start-1 fulltrack:row-span-2 fulltrack:row-start-1">
              {/* The canvas is memoised, so mounting and unmounting the panel
                  beside it does not re-render it — the replay animates behind the
                  scrim without interruption. Pinned in `App.test.tsx`. On a
                  phone the panel and the event card cover the whole screen from
                  here: `fixed`, not moved (`components/overlay.ts`). */}
              <TrackCanvas replay={replay} />
              <SpeedLegend />
              {/* The abnormal-flag strip and the narrated-moment overlay
                  (Slice 17): siblings of the canvas with their own ≤30 Hz
                  telemetry subscriptions, exactly like Hud — App itself still
                  subscribes to nothing per-frame. The banner sits under the
                  panel and the card (z-5 vs z-10): narration outranks signage. */}
              <StatusBanner replay={replay} />
              <ScenarioEvents />
              {galleryOpen && (
                <FeaturedPanel id={GALLERY_PANEL_ID} onClose={closeGallery} />
              )}
            </div>
            <Hud replay={replay} />
          </div>
          <TransportBar replay={replay} />
        </>
      ) : (
        // Defensive: `main.tsx` sets either a replay or a bootstrap error before the
        // first render, so this is the state that should not happen. It still says
        // what to do rather than just what is missing.
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <p className="max-w-sm text-center font-mono text-xs leading-relaxed text-dim">
            No replay loaded. Open a lap with{" "}
            <span className="text-txt">Load replay JSON</span> above — any file
            the pipeline built.
          </p>
        </div>
      )}
    </main>
  );
}
