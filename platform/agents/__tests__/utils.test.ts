/**
 * platform/agents/__tests__/utils.test.ts
 *
 * Tests for shared agent utilities.
 *
 * generateId/generateSecureId are cryptographically secure (globalThis.crypto) — they
 * back session ids, audit keys, and trajectory ids, so the format and entropy are
 * part of the contract, not an implementation detail.
 */

import { generateId, generateSecureId, SECURE_ID_BYTES } from "../utils";

describe("generateId", () => {
  it("returns a non-empty lowercase hex string", () => {
    const id = generateId();
    expect(typeof id).toBe("string");
    expect(id).toMatch(/^[0-9a-f]+$/);
  });

  it("returns 8 bytes (16 hex chars) of entropy", () => {
    expect(generateId()).toHaveLength(16);
  });

  it("returns different IDs on successive calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe("generateSecureId", () => {
  it("returns 16 bytes (32 hex chars) — 128 bits", () => {
    const id = generateSecureId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).toHaveLength(SECURE_ID_BYTES * 2);
  });

  it("returns different IDs on successive calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSecureId()));
    expect(ids.size).toBe(100);
  });

  it("does not collide with generateId's length (distinguishable formats)", () => {
    expect(generateSecureId().length).not.toBe(generateId().length);
  });
});
