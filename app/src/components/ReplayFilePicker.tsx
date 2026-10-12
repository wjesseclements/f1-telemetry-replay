/**
 * ReplayFilePicker.tsx — loading a real lap into the app.
 *
 * The pipeline produces a JSON file on a human's machine; this is how it gets in.
 * See `src/data/loadReplayFile.ts` for why it is a picker rather than a fetch.
 *
 * Two behaviours are deliberate:
 *
 *  - a failed load KEEPS the replay that is already on screen. Picking the wrong
 *    file should cost you an error message, not the lap you were watching.
 *  - the failure is rendered VERBATIM. `ReplayValidationError.message` is
 *    newline-structured with a `→ at cars[0].samples[3].speed` line per issue, and
 *    those paths are the entire value of it (the Slice 4b rule for `ReplayError`).
 */
import { useId, useState } from "react";
import { loadReplayFile } from "../data/loadReplayFile";
import { useTransport } from "../store/transport";
import { COMPACT_PEER_FOCUS_RING, PEER_FOCUS_RING } from "./focus";
import { OpenFileIcon } from "./icons";
import { TOUCH_TARGET } from "./touchTarget";

export function ReplayFilePicker() {
  const inputId = useId();
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);

  const onChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Re-picking the same file has to re-fire `change`, and it only does if the
    // input's value is cleared first.
    event.target.value = "";
    if (file === undefined) return;

    const result = await loadReplayFile(file);
    if (result.replay === null) {
      setError(result.error);
      setLoaded(null);
      return;
    }

    setError(null);
    setLoaded(file.name);
    const { setReplay, seek } = useTransport.getState();
    setReplay(result.replay);
    // Start the new lap at the line. `isPlaying` is untouched on purpose — the same
    // call Slice 5's scrubber makes, for the same reason: loading a replay is not a
    // statement about whether you wanted playback running.
    seek(0);
  };

  return (
    <div className="ml-auto flex min-w-0 flex-col items-end gap-2">
      {/* `flex` on a short phone (Slice 27, `compact:`): the label is a 44 px icon
          box (`touchTarget.ts`), and an inline-level wrapper would add a line
          box's descender under it. */}
      <div className="compact:flex">
        <input
          id={inputId}
          type="file"
          accept=".json,application/json"
          onChange={onChange}
          // `sr-only`, not `hidden`: the input keeps its place in the tab order and
          // its native Space/Enter activation. The label carries the focus ring.
          className="peer sr-only"
        />
        <label
          htmlFor={inputId}
          className={`cursor-pointer rounded border border-line px-3 py-1.5 font-mono text-xs text-dim transition-colors hover:text-txt compact:flex compact:items-center compact:justify-center compact:p-0 ${TOUCH_TARGET} ${PEER_FOCUS_RING} ${COMPACT_PEER_FOCUS_RING}`}
        >
          {/* The text stays the input's accessible name (sr-only) when the
              PLACEHOLDER icon replaces it on a short phone. */}
          <OpenFileIcon className="hidden compact:block" />
          <span className="compact:sr-only">Load replay JSON</span>
        </label>
      </div>

      {/* On a short phone the confirmation would add a second line to the thin
          header; the meta line beside it already names what is loaded. Kept in
          the DOM for a screen reader. The error below stays visible: it is the
          one message a failed load has. */}
      {loaded !== null && (
        <p className="font-mono text-[11px] text-dim compact:sr-only">
          loaded {loaded}
        </p>
      )}

      {error !== null && (
        <pre
          role="alert"
          className="max-h-40 max-w-xl overflow-auto whitespace-pre-wrap break-words rounded border border-brake bg-panel p-2 text-left font-mono text-[11px] leading-relaxed text-txt"
        >
          {error}
        </pre>
      )}
    </div>
  );
}
