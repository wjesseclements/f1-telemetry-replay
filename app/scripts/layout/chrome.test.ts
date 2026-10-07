import { chromeArgs, needsNoSandbox } from "./chrome";

describe("chromeArgs", () => {
  it("keeps the resolver rule in force: no proxy can carry a request past it", () => {
    const args = chromeArgs("/tmp/profile", {}, "darwin");
    expect(args).toContain(
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
    );
    expect(args).toContain("--no-proxy-server");
    expect(args.some((a) => a.startsWith("--proxy-server"))).toBe(false);
  });

  it("drops the sandbox on a Linux CI runner only", () => {
    expect(chromeArgs("/p", { CI: "true" }, "linux")).toContain("--no-sandbox");
    expect(chromeArgs("/p", {}, "linux")).not.toContain("--no-sandbox");
    expect(chromeArgs("/p", { CI: "true" }, "darwin")).not.toContain(
      "--no-sandbox",
    );
  });
});

describe("needsNoSandbox", () => {
  it("is narrow: GitHub Actions' exact CI=true, on Linux", () => {
    expect(needsNoSandbox({ CI: "true" }, "linux")).toBe(true);
    expect(needsNoSandbox({ CI: "1" }, "linux")).toBe(false);
    expect(needsNoSandbox({ CI: "" }, "linux")).toBe(false);
    expect(needsNoSandbox({ CI: "true" }, "win32")).toBe(false);
  });
});
