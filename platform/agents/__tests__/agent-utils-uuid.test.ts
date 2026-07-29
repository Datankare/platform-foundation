/**
 * platform/agents/__tests__/agent-utils-uuid.test.ts
 *
 * generateUuid must satisfy a Postgres `uuid` column — agent_trajectories.id is one.
 */

import { generateUuid, generateId, generateSecureId } from "../utils";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("generateUuid", () => {
  it("produces an RFC 4122 v4 UUID", () => {
    expect(generateUuid()).toMatch(UUID_V4);
  });

  it("produces distinct values", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateUuid()));
    expect(seen.size).toBe(200);
  });

  it("is distinguishable from the hex id generators, which a uuid column rejects", () => {
    expect(generateId()).not.toMatch(UUID_V4);
    expect(generateSecureId()).not.toMatch(UUID_V4);
    expect(generateId()).toHaveLength(16);
    expect(generateSecureId()).toHaveLength(32);
  });
});
