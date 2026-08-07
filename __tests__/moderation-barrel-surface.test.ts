/**
 * __tests__/moderation-barrel-surface.test.ts
 *
 * The public API of platform/moderation, asserted exactly. Same rationale as the agents
 * barrel: an export removed or accidentally added is a contract change nothing currently
 * notices, and the re-export getters are only covered when something imports through the
 * barrel.
 */

import * as moderation from "@/platform/moderation";

const EXPECTED_EXPORTS = [
  "Guardian",
  "InMemoryModerationStore",
  "InMemoryReviewQueueStore",
  "SupabaseModerationStore",
  "SupabaseReviewQueueStore",
  "buildAuditRecord",
  "claimItem",
  "classify",
  "compilePatterns",
  "evaluateContext",
  "getDefaultPatterns",
  "getGuardian",
  "getModerationStore",
  "getQueue",
  "getQueueStats",
  "getReviewQueueStore",
  "hashInput",
  "loadBlocklistOnlySurfaces",
  "loadContentRatingThresholds",
  "loadSeverityReduction",
  "loadStrikeThresholds",
  "logModerationAudit",
  "reduceSeverity",
  "releaseExpiredClaims",
  "resetGuardian",
  "resetModerationStore",
  "resetReviewQueueStore",
  "resolveItem",
  "scanBlocklist",
  "screenContent",
  "setGuardian",
  "setModerationStore",
  "setReviewQueueStore",
  "submitAppeal",
  "submitForReview",
  "unclaimItem",
  "validatePattern",
].sort();

describe("platform/moderation — public API surface", () => {
  it("exports exactly the expected names", () => {
    const actual = Object.keys(moderation).sort();
    expect(actual).toEqual(EXPECTED_EXPORTS);
  });

  it("every export is defined — the getters resolve", () => {
    for (const name of EXPECTED_EXPORTS) {
      expect((moderation as Record<string, unknown>)[name]).toBeDefined();
    }
  });
});
