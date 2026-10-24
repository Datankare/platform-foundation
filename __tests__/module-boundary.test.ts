/**
 * __tests__/module-boundary.test.ts — The core never imports a module (ADR-054 D3), in CI
 *
 * Walks every import in the tree (helpers/import-graph.ts — the same edges the boundary survey
 * of October 2026 counted: declarations, import(), require(), jest.mock and requireActual) and
 * classifies both ends by platform/modules/manifest.json:
 *
 *   - a core file may import no module file, test or kit — except the composition roots
 *     (platform/modules/app-modules.ts, app-home.tsx), whose purpose is to compose the app;
 *   - a module's file (its zone, or one of its tests or kits) may import the core, the module
 *     and the modules it declares in dependsOn — nothing else.
 *
 * Production and test files are reported separately; both must be empty. The lint rule enforces
 * the same boundary at edit time; this is the whole-tree check that cannot be switched off by a
 * lint configuration change.
 *
 * Self-tests first (Gotcha 64): the scanner must see the tree, every import form, and a breach,
 * before an empty result is trusted.
 */

import {
  importGraph,
  isTestFile,
  sourceFiles,
  specifiersIn,
  type ImportEdge,
} from "./helpers/import-graph";

const mm = require("../scripts/module-manifest.cjs");
const MANIFEST = mm.loadManifest();

interface Breach {
  readonly kind: "PROD" | "TEST";
  readonly from: string;
  readonly fromOwner: string;
  readonly to: string;
  readonly toOwner: string;
  readonly specifier: string;
}

/** The breach an edge is, or null when the boundary allows it. */
function breachOf(edge: ImportEdge): Breach | null {
  const toOwner: string | null = mm.ownerOf(MANIFEST, edge.to);
  if (toOwner === null) return null; // the core is importable from everywhere
  if (mm.isCompositionRoot(MANIFEST, edge.from)) return null;
  const fromOwner: string | null = mm.ownerOf(MANIFEST, edge.from);
  if (fromOwner !== null && mm.mayImport(MANIFEST, fromOwner, toOwner)) return null;
  return {
    kind: isTestFile(edge.from) ? "TEST" : "PROD",
    from: edge.from,
    fromOwner: fromOwner ?? "core",
    to: edge.to,
    toOwner,
    specifier: edge.specifier,
  };
}

const describeBreach = (b: Breach): string =>
  `${b.kind} ${b.fromOwner} → ${b.toOwner}: ${b.from} imports ${b.specifier}`;

describe("core/module boundary (ADR-054 D3)", () => {
  const files = sourceFiles();
  const edges = importGraph(files);
  const breaches = edges.map(breachOf).filter((b): b is Breach => b !== null);

  it("self-test: sees the tree and its imports", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(edges.length).toBeGreaterThan(3000);
    expect(files).toContain("platform/providers/registry.ts");
    expect(files).toContain("platform/social/module.ts");
  });

  it("self-test: finds every import form", () => {
    const source = [
      'import a from "@/a";',
      'import type { B } from "./b";',
      'export { c } from "../c";',
      'const d = await import("@/d");',
      'const e = require("./e");',
      'jest.mock("@/f", () => ({}));',
      'const g = jest.requireActual("@/g");',
      'const h = jest.requireMock("@/h");',
      'const pkg = require("typescript");',
    ].join("\n");
    expect(specifiersIn("x.ts", source)).toEqual([
      "@/a",
      "./b",
      "../c",
      "@/d",
      "./e",
      "@/f",
      "@/g",
      "@/h",
      "typescript",
    ]);
  });

  it("self-test: a core file importing a module is a breach; a composition root's is not", () => {
    const core: ImportEdge = {
      from: "platform/agents/registry.ts",
      specifier: "@/platform/social",
      to: "platform/social/index.ts",
    };
    expect(breachOf(core)).toMatchObject({
      kind: "PROD",
      fromOwner: "core",
      toOwner: "social",
    });
    expect(breachOf({ ...core, from: "__tests__/agent-types.test.ts" })).toMatchObject({
      kind: "TEST",
    });
    expect(breachOf({ ...core, from: "platform/modules/app-modules.ts" })).toBeNull();
    // A module importing a module it does not declare.
    expect(
      breachOf({
        from: "platform/voice/pipeline.ts",
        specifier: "@/platform/social/types",
        to: "platform/social/types.ts",
      })
    ).toMatchObject({ fromOwner: "voice", toOwner: "social" });
    // A declared dependency, and a module's own test.
    expect(
      breachOf({
        from: "platform/voice/pipeline.ts",
        specifier: "@/platform/translation/types",
        to: "platform/translation/types.ts",
      })
    ).toBeNull();
    expect(
      breachOf({
        from: "__tests__/social-store.test.ts",
        specifier: "@/platform/social/memory-social-store",
        to: "platform/social/memory-social-store.ts",
      })
    ).toBeNull();
    // A module's kit is the module's too.
    expect(
      breachOf({
        from: "__tests__/contract/manifest.ts",
        specifier: "./social-store-contract",
        to: "__tests__/contract/social-store-contract.ts",
      })
    ).toMatchObject({ fromOwner: "core", toOwner: "social" });
  });

  it("no production file crosses the boundary", () => {
    expect(breaches.filter((b) => b.kind === "PROD").map(describeBreach)).toEqual([]);
  });

  it("no test file crosses the boundary (a core test that tests a module is listed as the module's)", () => {
    expect(breaches.filter((b) => b.kind === "TEST").map(describeBreach)).toEqual([]);
  });

  it("only the composition roots import modules from the core, and each is a seam", () => {
    const rootsImportingModules = new Set(
      edges
        .filter((e) => mm.zoneOf(MANIFEST, e.from) === null && mm.ownerOf(MANIFEST, e.to))
        .map((e) => e.from)
        .filter((f) => !isTestFile(f))
    );
    expect([...rootsImportingModules].sort()).toEqual(
      [...MANIFEST.compositionRoots].sort()
    );
  });
});
