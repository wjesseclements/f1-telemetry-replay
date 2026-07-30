/**
 * ReplayError.tsx — the load failure, shown rather than swallowed.
 *
 * The message is rendered VERBATIM and in full. `parseReplay` already does the work
 * of saying what is wrong and exactly where (`z.prettifyError` gives one line per
 * issue plus a `→ at cars[0].samples[3].speed` path line); summarising it here, or
 * truncating it, or replacing it with "something went wrong — see console" would
 * throw away the only thing that makes a pipeline/schema mismatch fixable without a
 * debugger. Hence `<pre>`: the message is newline-structured and the structure is
 * load-bearing.
 */

export interface ReplayErrorProps {
  /** `ReplayValidationError.message`, unmodified. */
  message: string;
}

export function ReplayError({ message }: ReplayErrorProps) {
  return (
    <section
      role="alert"
      aria-labelledby="replay-error-title"
      className="flex h-full flex-col items-center justify-center gap-4 p-6"
    >
      <div className="max-w-2xl rounded-lg border border-line bg-panel p-5">
        <h2
          id="replay-error-title"
          className="font-mono text-sm font-bold tracking-[0.15em] text-brake"
        >
          REPLAY FAILED TO LOAD
        </h2>
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-txt">
          {message}
        </pre>
        <p className="mt-4 text-xs leading-relaxed text-dim">
          The replay data does not match the schema. This is a data problem, not
          a network one — the app ships with its replay and never fetches. Each
          line above names the field that failed; rebuild the file with the
          pipeline, or open a different lap with Load replay JSON.
        </p>
      </div>
    </section>
  );
}
