/**
 * Jest setup — runs after the test framework is installed, before each suite
 * (setupFilesAfterEnv).
 *
 * - Silences the structured logger (tests that verify logging mock console
 *   explicitly).
 * - Clears Sentry's version-keyed global carrier after every test file. Sentry
 *   (v10) pins `__SENTRY__` to the real worker `globalThis`, so once any suite
 *   initializes it the carrier survives across test files sharing a worker.
 *   jest's global-leak guard then installs a self-referential setter on the
 *   version-keyed property (e.g. `__SENTRY__["10.49.0"]`), and the next suite's
 *   environment boot recurses into `RangeError: Maximum call stack size
 *   exceeded`. The victim suite roves with file scheduling, so the gate was
 *   only green by luck. Sentry recreates the carrier lazily, so deleting it at
 *   end-of-file is safe and makes the gate deterministic.
 */
process.env.LOG_LEVEL = "silent";

afterAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.__SENTRY__) {
    delete g.__SENTRY__;
  }
});
