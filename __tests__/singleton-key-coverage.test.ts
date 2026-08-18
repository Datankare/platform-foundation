/**
 * __tests__/singleton-key-coverage.test.ts
 *
 * resetProviders() clears the keys listed in PROVIDER_SINGLETON_KEYS. That list is maintained
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
import { PROVIDER_SINGLETON_KEYS } from "@/platform/providers/registry";

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
