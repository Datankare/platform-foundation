/**
 * __tests__/contract/conformance-coverage.test.ts
 *
 * Meta-test (ADR-027): the conformance convention enforces itself.
 *
 * Walks the LIVE provider registry via getActiveProviders() and asserts every
 * registry slot has a conformance kit in the manifest. Adding a provider slot
 * to platform/providers/registry.ts without a kit turns this red — no late
 * discovery, no unenforced checklist.
 */

import { getActiveProviders } from "@/platform/providers/registry";
import { CONFORMANCE_MANIFEST } from "./contract/manifest";

describe("provider conformance coverage (ADR-027)", () => {
  const registrySlots = Object.keys(getActiveProviders());

  it.each(registrySlots)("registry slot '%s' has a conformance kit", (slot) => {
    const entry = CONFORMANCE_MANIFEST[slot];
    expect(entry).toBeDefined();
    expect(entry.kind).toBe("registry");
    expect(typeof entry.kit).toBe("function");
  });

  it("every manifest entry references a runnable kit", () => {
    for (const entry of Object.values(CONFORMANCE_MANIFEST)) {
      expect(typeof entry.kit).toBe("function");
      expect(["registry", "fabric"]).toContain(entry.kind);
    }
  });

  it("registry entries are in bijection with registry slots", () => {
    const registryEntries = Object.entries(CONFORMANCE_MANIFEST).filter(
      ([, entry]) => entry.kind === "registry"
    );
    expect(registryEntries.length).toBe(registrySlots.length);
  });
});
