import "@testing-library/jest-dom";

/**
 * The offline law, made mechanical.
 *
 * CLAUDE.md says the app, its tests and CI run offline, with exactly one exception:
 * the app may fetch the repo's own committed gallery assets from its own origin.
 * That exception means there is now real `fetch` code in the app, and therefore a
 * real way for a test to reach the network by accident — a mistyped mock, a
 * component effect nobody expected to fire, a future refactor that moves a fetch.
 *
 * Until this file existed the rule was a promise. This makes it bite: `fetch` is
 * replaced with a stub that throws, so ANY unmocked network call fails loudly and
 * names itself, instead of hanging, silently 404ing, or — worst — quietly
 * succeeding on a machine that happens to be online and failing only in CI.
 *
 * It is the same move as `vite.config.ts`'s per-file coverage threshold and
 * `pytest.ini`'s branch gate: a standard the repo already claimed, converted into
 * something that fails when it is broken.
 *
 * Opting in: a test that means to exercise the gallery path stubs `fetch` itself
 * with `vi.stubGlobal("fetch", …)`. `unstubGlobals` is on in `vite.config.ts`, so
 * the trap is restored after each test without anyone remembering to.
 */
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const target =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  throw new Error(
    `Blocked network call to ${target}.\n` +
      "The app's tests never touch the network (CLAUDE.md). If this test is meant " +
      'to exercise the gallery fetch path, stub it: vi.stubGlobal("fetch", …).',
  );
}) as typeof fetch;
