/**
 * __tests__/singleton-key-coverage.test.ts
 *
 * resetProviders() clears providerSingletonKeys(): the core's CORE_PROVIDER_SINGLETON_KEYS and
 * each registered module slot's declared singletonKeys (ADR-054 D4). Those lists are maintained
 * by hand, so a singleton added later and forgotten is a singleton that leaks between tests —
 * the same failure the auth provider had, where reset appeared to work only because
 * jest.resetModules() was doing the clearing.
 *
 * This is a SOURCE assertion. The alternative — registering everything and checking what
 * clears — needs a live provider registry and proves less: a key can be cleared correctly and
 * still be missing from the list if nothing happened to register it in that run.
 *
 * It deliberately does NOT assert that PROVIDER_SINGLETON_KEYS matches ProviderSelections.
 * Those sets differ for good reasons and an equality assertion would be false.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { providerSingletonKeys } from "@/platform/providers/registry";
import { getModules } from "@/platform/modules";

const mm = require("../scripts/module-manifest.cjs");
const MANIFEST = mm.loadManifest();

// The core's keys and the registered modules' slot keys (jest.setup registers the app's modules).
const PROVIDER_SINGLETON_KEYS = providerSingletonKeys();

/**
 * Whether a source file's keys are this app's: a core file, or a registered module's. A module the
 * app does not register declares keys nothing resets — they are checked against the module's own
 * definition instead (__tests__/module-manifest.test.ts).
 */
const REGISTERED = new Set(getModules().map((m) => m.id));
function inThisApp(rel: string): boolean {
  const owner: string | null = mm.zoneOf(MANIFEST, rel);
  return owner === null || REGISTERED.has(owner);
}

const ROOT = process.cwd();

/**
 * Keys that exist but are not provider slots, so resetProviders() must NOT clear them.
 * Each needs a reason: an unexplained exemption is how a list stops being trustworthy.
 */
const EXEMPT: Record<string, string> = {
  "platform.agents.workflows.v1":
    "The AUX workflow registry (ADR-030). Cleared by resetWorkflowRegistry(), not by initProviders() — it is not a provider slot.",
  "platform.observability.state":
    "Observability is initialised by instrumentation.ts, not by initProviders(). It has its own resetObservability().",
  "platform.providers.initialized":
    "The registry's own flag. resetProviders() clears it directly, before clearing the slots.",
  "platform.adaptive.registry":
    "The adaptive behavior registry (ADR-036). Cleared by resetAdaptiveBehaviors(), not by initProviders() — it is not a provider slot.",
  "platform.adaptive.memory":
    "Within-session adaptive memory (ADR-036 D5). Cleared by resetAdaptiveMemory(), not by initProviders() — it is not a provider slot.",
  "platform.content.registry":
    "The content-type registry (ADR-037). Cleared by resetContentTypes(), not by initProviders() — it is not a provider slot.",
  "platform.data.pools":
    "The database connection pools (ADR-053 D4). Closed by closeDataPools(), which ends their connections; clearing the slot would leak them.",
  "platform.rag.kbRegistry":
    "knowledge-base registry (ADR-042); one registry Map per worker, globalThis-anchored.",
  "platform.jobs.appRegistry":
    "The app's own job kinds (ADR-056 D2). Registered at boot and cleared by resetJobRegistry(), not by initProviders() — it is not a provider slot.",
  "platform.observability.boot":
    "What instrumentation.ts recorded of this instance's boot (ADR-056 D4). Reset by resetBootState(); a provider reset is not a reboot.",
  "platform.observability.shutdown":
    "Whether this instance is stopping and whether its signal handlers are installed (ADR-055 D5). Reset by resetShutdownState(); a provider reset is not a restart.",
  "platform.observability.inFlight":
    "The count of requests and job handlers in flight (ADR-055 D5): the stop waits for it. Reset by resetInFlight(); a provider reset must not forget a request still running.",
  "platform.observability.healthMemo":
    "The health routes' shared probe run and each probe's last reported status (review finding 16). Reset with resetObservability(); not a provider slot.",
  "platform.jobs.hung":
    "Job handlers still running past their time, whose leases the runner keeps (ADR-056 D2). Drained by settleHungJobs(); forgetting one would let its job be retried beside it.",
  "platform.modules.registered":
    "The app's registered modules (ADR-054 D4). Registered before initProviders() and cleared by resetModuleRegistry(), never by resetProviders() — the module set outlives a provider reset.",
};

function singletonKeysDeclaredInSource(): string[] {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.includes(".test.")) continue;
      if (!inThisApp(p.slice(ROOT.length + 1))) continue;
      const src = readFileSync(p, "utf-8");
      // `const SOMETHING_KEY = "platform.x.y";` — the shape every conversion produced.
      for (const m of src.matchAll(/const\s+\w*KEY\s*=\s*"(platform\.[\w.]+)"/g)) {
        found.add(m[1]);
      }
    }
  };
  walk(join(ROOT, "platform"));
  return [...found].sort();
}

describe("singleton key coverage", () => {
  const declared = singletonKeysDeclaredInSource();

  it("finds the keys it means to (self-test before any absence counts)", () => {
    // An absence check that passes because it found nothing is indistinguishable from a
    // clean result — Gotcha 64.
    expect(declared.length).toBeGreaterThan(15);
    expect(declared).toContain("platform.agents.trajectoryStore");
  });

  it("accounts for every declared key: reset list or explicit exemption", () => {
    const unaccounted = declared.filter(
      (k) => !PROVIDER_SINGLETON_KEYS.includes(k) && !(k in EXEMPT)
    );
    expect(unaccounted).toEqual([]);
  });

  it("lists no key that does not exist in the source", () => {
    // The other direction: a stale entry in the reset list clears nothing and misleads
    // anyone reading it as an inventory.
    const stale = PROVIDER_SINGLETON_KEYS.filter((k) => !declared.includes(k));
    expect(stale).toEqual([]);
  });

  it("has no duplicate entries", () => {
    expect(new Set(PROVIDER_SINGLETON_KEYS).size).toBe(PROVIDER_SINGLETON_KEYS.length);
  });

  it("gives every exemption a reason", () => {
    const unexplained = Object.entries(EXEMPT)
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([k]) => k);
    expect(unexplained).toEqual([]);
  });
});
