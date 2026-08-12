/**
 * __tests__/tool-boundary-coverage.test.ts
 *
 * TASK-064. Every registered config tool must have a boundary classification.
 *
 * An unlisted tool is the only way executeConfigTool's fallback fires, and the fallback now
 * records as "commitment" — conservative, but a guess. The point of this test is that nobody
 * should reach the guess: adding a tool and forgetting the map is the drift it prevents.
 *
 * At the time of writing the two sets match exactly, so this is a guard rather than a fix.
 */

import { CONFIG_TOOLS } from "@/platform/admin/config-handlers";
import { TOOL_BOUNDARIES } from "@/platform/admin/types";

describe("tool boundary coverage", () => {
  it("finds the tools it means to (self-test before any absence counts)", () => {
    // Gotcha 64: an absence check that passes because it found nothing proves nothing.
    expect(CONFIG_TOOLS.length).toBeGreaterThan(5);
  });

  it("classifies every registered tool", () => {
    const unclassified = CONFIG_TOOLS.map((t) => t.id).filter(
      (id) => !TOOL_BOUNDARIES[id]
    );
    expect(unclassified).toEqual([]);
  });

  it("classifies nothing that is not a registered tool", () => {
    // A stale entry is not dangerous, but it misleads anyone reading the map as an
    // inventory of what exists.
    const registered = new Set(CONFIG_TOOLS.map((t) => t.id));
    const orphaned = Object.keys(TOOL_BOUNDARIES).filter((id) => !registered.has(id));
    expect(orphaned).toEqual([]);
  });

  it("uses only the kernel's boundary vocabulary", () => {
    const valid = new Set(["cognition", "commitment"]);
    const invalid = Object.entries(TOOL_BOUNDARIES)
      .filter(([, b]) => !valid.has(b))
      .map(([id, b]) => `${id}: ${b}`);
    expect(invalid).toEqual([]);
  });

  it("records every write tool as a commitment", () => {
    // The classification that matters: a tool that changes state must not be recorded as
    // cognition, or it sits below the governance a commitment receives.
    const writes = [
      "update_config",
      "request_approval",
      "approve_change",
      "reject_change",
    ];
    const misclassified = writes.filter((id) => TOOL_BOUNDARIES[id] !== "commitment");
    expect(misclassified).toEqual([]);
  });
});
