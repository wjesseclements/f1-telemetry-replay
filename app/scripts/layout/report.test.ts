import { Report } from "./report";

describe("Report", () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(line);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 0 only when every row passed", () => {
    const passing = new Report();
    passing.record("1440x900", "B", "canvas height", true, "803.0 px");
    expect(passing.print()).toBe(0);

    const failing = new Report();
    failing.record("375x812", "B", "canvas height", true, "300.0 px");
    failing.record("375x812", "C", "panel visible height", false, "32.0 px");
    expect(failing.print()).toBe(1);
  });

  it("never passes a run in which nothing was asserted", () => {
    expect(new Report().print()).toBe(1);
    expect(lines[lines.length - 1]).toMatch(/^no assertions ran/);
  });

  it("prints once: rows recorded after an abort printed are dropped", () => {
    const report = new Report();
    report.record("375x812", "A", "panel heading row visible", false, "y=…");
    report.print();
    const printed = lines.length;

    report.record("1280x720", "*", "viewport ran", false, "client closed");
    report.note("late note");
    expect(report.isSealed).toBe(true);
    report.print();
    expect(lines.slice(printed).join("\n")).not.toMatch(/1280x720|late note/);
  });

  it("puts the measured numbers on every row", () => {
    const report = new Report();
    report.record("375x812", "B", "canvas height", false, "0.0 px (min 243.6)");
    report.print();
    expect(lines.find((l) => l.startsWith("375x812"))).toMatch(
      /B scenario\s+canvas height\s+FAIL\s+0\.0 px \(min 243\.6\)$/,
    );
  });
});
