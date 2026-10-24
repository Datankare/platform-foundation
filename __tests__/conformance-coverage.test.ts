/**
 * __tests__/conformance-coverage.test.ts
 *
 * Meta-test (ADR-027): the conformance convention enforces itself.
 *
 * Walks the LIVE provider registry via getActiveProviders() and asserts every
 * registry slot has a conformance kit — the core's in the core manifest
 * (./contract/manifest.ts), a module's in that module's kit manifest. Adding a
 * provider slot without a kit turns this red — no late discovery, no unenforced
 * checklist.
 *
 * ADR-054 D4: the core manifest imports no module kit. Each registered module's kit
 * manifest is found through platform/modules/manifest.json (`kitManifest`) and composed
 * here, by path — the composition the core manifest used to do by import.
 */

import { join } from "path";
import { getActiveProviders } from "@/platform/providers/registry";
import { getModules } from "@/platform/modules";
import { CONFORMANCE_MANIFEST, type ConformanceEntry } from "./contract/manifest";

const { loadManifest } = require("../scripts/module-manifest.cjs");

interface ManifestModule {
  readonly kits: readonly string[];
  readonly kitManifest: string | null;
}
const MODULE_MANIFEST: { modules: Record<string, ManifestModule> } = loadManifest();

/** A module's kit manifest, loaded by the path manifest.json lists (none: an empty one). */
function moduleConformance(id: string): Readonly<Record<string, ConformanceEntry>> {
  const path = MODULE_MANIFEST.modules[id]?.kitManifest;
  if (!path) return {};
  const loaded: { MODULE_CONFORMANCE: Record<string, ConformanceEntry> } = require(
    join(process.cwd(), path)
  );
  return loaded.MODULE_CONFORMANCE;
}

type OwnedEntry = ConformanceEntry & { readonly owner: string };

/** The core manifest, then each registered module's; a key twice is a defect, never an override. */
function composedManifest(): Record<string, OwnedEntry> {
  const out: Record<string, OwnedEntry> = {};
  for (const [key, entry] of Object.entries(CONFORMANCE_MANIFEST)) {
    out[key] = { ...entry, owner: "core" };
  }
  for (const mod of getModules()) {
    for (const [key, entry] of Object.entries(moduleConformance(mod.id))) {
      if (out[key]) throw new Error(`${mod.id} redeclares conformance entry ${key}`);
      out[key] = { ...entry, owner: mod.id };
    }
  }
  return out;
}

describe("provider conformance coverage (ADR-027)", () => {
  const registrySlots = Object.keys(getActiveProviders());
  const manifest = composedManifest();

  it.each(registrySlots)("registry slot '%s' has a conformance kit", (slot) => {
    const entry = manifest[slot];
    expect(entry).toBeDefined();
    expect(entry.kind).toBe("registry");
    expect(typeof entry.kit).toBe("function");
  });

  it("every manifest entry references a runnable kit", () => {
    for (const entry of Object.values(manifest)) {
      expect(typeof entry.kit).toBe("function");
      expect(["registry", "fabric"]).toContain(entry.kind);
    }
  });

  it("registry entries are in bijection with registry slots", () => {
    const registryEntries = Object.entries(manifest).filter(
      ([, entry]) => entry.kind === "registry"
    );
    expect(registryEntries.map(([k]) => k).sort()).toEqual([...registrySlots].sort());
  });

  it("the core manifest covers exactly the core's slots; each module's, exactly its own", () => {
    const owners = new Map<string, string>();
    for (const mod of getModules()) {
      for (const slot of mod.providers) owners.set(slot.slot, mod.id);
    }
    for (const [key, entry] of Object.entries(manifest)) {
      if (entry.kind !== "registry") continue;
      expect([key, entry.owner]).toEqual([key, owners.get(key) ?? "core"]);
    }
  });

  it("each module's definition lists the kits manifest.json lists for it", () => {
    for (const mod of getModules()) {
      expect([mod.id, [...mod.kits].sort()]).toEqual([
        mod.id,
        [...(MODULE_MANIFEST.modules[mod.id]?.kits ?? [])].sort(),
      ]);
    }
  });

  it("a module with provider slots names a kit manifest", () => {
    for (const mod of getModules()) {
      if (mod.providers.length === 0) continue;
      expect([mod.id, MODULE_MANIFEST.modules[mod.id]?.kitManifest]).toEqual([
        mod.id,
        expect.any(String),
      ]);
    }
  });
});
