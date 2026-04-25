/**
 * platform/agents/__tests__/utils.test.ts
 *
 * Tests for shared agent utilities.
 */

import { generateId } from "../utils";

describe("generateId", () => {
  it("returns a non-empty string", () => {
    const id = generateId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  it("returns different IDs on successive calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    // With 100 random IDs, collisions are astronomically unlikely
    expect(ids.size).toBeGreaterThan(95);
  });

  it("returns IDs of consistent length", () => {
    const id = generateId();
    expect(id.length).toBeGreaterThanOrEqual(6);
    expect(id.length).toBeLessThanOrEqual(8);
  });
});
