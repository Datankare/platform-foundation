/**
 * Sprint 5 — GDPR tests
 *
 * Tests pure functions that don't require Supabase:
 * - Deletion module registration
 * - Export module registration
 */

import {
  registerDeletionModule,
  getDeletionModules,
  type DeletionModule,
} from "@/platform/auth/gdpr-deletion";
import {
  registerExportModule,
  getExportModules,
  type ExportModule,
} from "@/platform/auth/data-export";

// ── Deletion Module Registration Tests ──────────────────────────────────

describe("deletion module registration", () => {
  it("registers and retrieves a deletion module", () => {
    const mod: DeletionModule = {
      moduleName: "test-module",
      description: "Test deletion module",
      tables: ["test_table"],
      softDelete: async () => ({ success: true }),
      hardPurge: async () => ({ success: true }),
    };

    registerDeletionModule(mod);
    const modules = getDeletionModules();
    expect(modules.some((m) => m.moduleName === "test-module")).toBe(true);
  });

  it("replaces module with same name", () => {
    const mod1: DeletionModule = {
      moduleName: "replace-test",
      description: "Original",
      tables: ["t1"],
      softDelete: async () => ({ success: true }),
      hardPurge: async () => ({ success: true }),
    };

    const mod2: DeletionModule = {
      moduleName: "replace-test",
      description: "Replacement",
      tables: ["t2"],
      softDelete: async () => ({ success: true }),
      hardPurge: async () => ({ success: true }),
    };

    registerDeletionModule(mod1);
    registerDeletionModule(mod2);

    const modules = getDeletionModules();
    const found = modules.filter((m) => m.moduleName === "replace-test");
    expect(found).toHaveLength(1);
    expect(found[0].description).toBe("Replacement");
  });

  it("getDeletionModules returns a copy", () => {
    const modules1 = getDeletionModules();
    const modules2 = getDeletionModules();
    expect(modules1).not.toBe(modules2);
  });
});

// ── Export Module Registration Tests ────────────────────────────────────

describe("export module registration", () => {
  it("registers and retrieves an export module", () => {
    const mod: ExportModule = {
      moduleName: "test-export",
      description: "Test export module",
      collectData: async () => ({ data: { key: "value" } }),
    };

    registerExportModule(mod);
    const modules = getExportModules();
    expect(modules.some((m) => m.moduleName === "test-export")).toBe(true);
  });

  it("replaces module with same name", () => {
    const mod1: ExportModule = {
      moduleName: "export-replace",
      description: "Original",
      collectData: async () => ({ data: {} }),
    };

    const mod2: ExportModule = {
      moduleName: "export-replace",
      description: "Replacement",
      collectData: async () => ({ data: {} }),
    };

    registerExportModule(mod1);
    registerExportModule(mod2);

    const modules = getExportModules();
    const found = modules.filter((m) => m.moduleName === "export-replace");
    expect(found).toHaveLength(1);
    expect(found[0].description).toBe("Replacement");
  });

  it("getExportModules returns a copy", () => {
    const modules1 = getExportModules();
    const modules2 = getExportModules();
    expect(modules1).not.toBe(modules2);
  });
});
