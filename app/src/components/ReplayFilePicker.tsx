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
import { PEER_FOCUS_RING } from "./focus";

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
      <div>
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
          className={`cursor-pointer rounded border border-line px-3 py-1.5 font-mono text-xs text-dim transition-colors hover:text-txt ${PEER_FOCUS_RING}`}
        >
          Load replay JSON
        </label>
      </div>

      {loaded !== null && (
        <p className="font-mono text-[11px] text-dim">loaded {loaded}</p>
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
