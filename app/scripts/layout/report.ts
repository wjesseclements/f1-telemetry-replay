/**
 * report.ts — the PASS/FAIL table, and the rule that it is printed once.
 *
 * Every assertion lands here with the numbers it measured, because a bare FAIL
 * sends someone back into a browser to find out by how much. `print` SEALS the
 * report: an aborted run prints what it had measured at the moment of the abort,
 * and whatever the still-unwinding run records afterwards (a command rejected by
 * the teardown it triggered, say) is not news and is not printed twice.
 */

/** A: first load · B: the largest scenario · C: gallery reopened · *: whole run */
export type StateKey = "A" | "B" | "C" | "*";

const STATE_NAMES: Record<StateKey, string> = {
  A: "A first load",
  B: "B scenario",
  C: "C reopened",
  "*": "* whole run",
};

interface Row {
  viewport: string;
  state: StateKey;
  assertion: string;
  pass: boolean;
  measured: string;
}

export class Report {
  private readonly rows: Row[] = [];
  private readonly notes: string[] = [];
  private sealed = false;

  constructor(private readonly startedAt: number = performance.now()) {}

  record(
    viewport: string,
    state: StateKey,
    assertion: string,
    pass: boolean,
    measured: string,
  ): void {
    if (this.sealed) return;
    this.rows.push({ viewport, state, assertion, pass, measured });
  }

  /** Context that is not an assertion: a stale build, a page exception. */
  note(text: string): void {
    if (this.sealed) return;
    this.notes.push(text);
  }

  get isSealed(): boolean {
    return this.sealed;
  }

  /**
   * Print the table, the notes and the totals, then seal. Returns the exit code
   * the rows earn: 0 only when there is at least one row and every row passed.
   */
  print(): number {
    this.sealed = true;
    if (this.rows.length > 0) this.printTable();
    for (const note of this.notes) console.log(`NOTE ${note}`);
    const failed = this.rows.filter((r) => !r.pass).length;
    const seconds = ((performance.now() - this.startedAt) / 1000).toFixed(1);
    console.log(
      this.rows.length === 0
        ? `no assertions ran · runtime ${seconds} s`
        : `\n${this.rows.length - failed}/${this.rows.length} passed, ${failed} failed · runtime ${seconds} s`,
    );
    return failed === 0 && this.rows.length > 0 ? 0 : 1;
  }

  private printTable(): void {
    const header = ["viewport", "state", "assertion", "result", "measured"];
    const body = this.rows.map((r) => [
      r.viewport,
      STATE_NAMES[r.state],
      r.assertion,
      r.pass ? "PASS" : "FAIL",
      r.measured,
    ]);
    const widths = header.map((h, i) =>
      Math.max(h.length, ...body.map((cells) => cells[i].length)),
    );
    const line = (cells: string[]) =>
      cells
        .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i])))
        .join("  ");
    console.log(line(header));
    console.log(line(widths.map((w) => "-".repeat(w))));
    for (const cells of body) console.log(line(cells));
  }
}
