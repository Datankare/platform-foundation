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

// ADR-039: agents are registered at init in production (registerPlatformAgents).
// Mirror that once per test file so any code path that runs an agent via the runtime
// resolves it — matching prod and keeping this out of every individual suite.
import { registerPlatformAgents } from "@/platform/agents/agent-configs";
import { registerAdaptiveReference } from "@/platform/adaptive/bootstrap";
import { resetSingleton } from "@/platform/kernel/singleton";
import { registerModules } from "@/platform/modules/registry";

// ADR-054 D4: the app's modules are registered at boot in production (instrumentation.ts), before
// anything reads a core list. Mirror that here, at load time rather than in beforeAll, because
// suites enumerate registered lists while they are being defined (the eval meta-test builds one
// describe per registered suite). The modules' code is loaded in an isolated module registry: a
// suite's own jest.mock of a module's dependencies must still apply to the copy the suite
// imports, which it would not if this file had already loaded it (the ADR-037 step-4 finding).
// The registered set lives in the globalThis carrier, so both copies see it. A suite that needs
// the modules built from its own mocked copies re-registers them (resetModuleRegistry first).
//
// PF_TEST_MODULES=none registers nothing instead: the suites then run as an app that uses no
// module (npm run test:core — the core's own tests, which must pass without one, ADR-054 §4).
// Nothing rather than an empty set, so a test that boots through a composition root
// (instrumentation.ts) can still register the app's list.
if (process.env.PF_TEST_MODULES !== "none") {
  jest.isolateModules(() => {
    const { APP_MODULES } = require("@/platform/modules/app-modules");
    registerModules(APP_MODULES);
  });
}

beforeAll(() => {
  registerPlatformAgents();
  registerAdaptiveReference();
});

// ADR-052: every test starts with no rate-limit history. Routes are rate limited, and tests
// in one file share a network address ("unknown"), so counts would otherwise carry from one
// test into the next. A test about limits counts within itself. The singleton is cleared by
// key, not through platform/rate-limit, so that importing here never loads the limiter modules
// ahead of a test file's own jest.mock of their dependencies.
beforeEach(() => {
  resetSingleton("platform.rateLimit.limiter");
});

afterAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.__SENTRY__) {
    delete g.__SENTRY__;
  }
});
