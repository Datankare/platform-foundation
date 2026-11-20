/**
 * ModerationStore interface contract — reference arm (ADR-027), and the in-memory store's
 * tenant partitions (ADR-053 D8). The Postgres arm is __tests__/db/moderation-store.db.test.ts.
 */
import { runModerationStoreContract } from "./contract/moderation-store-contract";
import { runTenantIsolationContract } from "./contract/tenant-isolation-contract";
import {
  memoryTenant,
  moderationAuditIsolation,
} from "./helpers/moderation-isolation-fixtures";
import { InMemoryModerationStore } from "@/platform/moderation/store";

describe("ModerationStore contract — in-memory store", () => {
  runModerationStoreContract({
    makeStore: () => new InMemoryModerationStore(),
  });

  runTenantIsolationContract({
    name: "memory moderation audits",
    makeStore: () => new InMemoryModerationStore(),
    createTenant: memoryTenant,
    ...moderationAuditIsolation(),
    failsClosedWithoutTenant: false,
  });
});

// ───── a classifier output over the stored-JSON bound (platform TASK-229, review TA-a-4; T14) ─────

import {
  storedClassifierJson,
  withClassifierOutputKept,
} from "@/platform/moderation/store";

describe("T14: a classifier's output over the bound is kept as not kept; the decision stays", () => {
  it("within the bound: stored as it is", () => {
    const out = { safe: true, score: 0.5 };
    expect(storedClassifierJson(out, "content_safety_audit.classifier_output")).toBe(out);
    const result = { action: "allow", classifierOutput: out };
    expect(withClassifierOutputKept(result, "review_queue.moderation_result")).toBe(
      result
    );
  });

  it("[guard] over it: the marker; a result keeps its decision and says the output was not kept", () => {
    expect(
      storedClassifierJson({ p: 1e-30 }, "content_safety_audit.classifier_output")
    ).toEqual({
      _omitted: { code: "request.json_number_out_of_range" },
    });
    const kept = withClassifierOutputKept(
      { action: "block", severity: "high", classifierOutput: { p: 1e-30 } } as {
        action: string;
        severity: string;
        classifierOutput?: unknown;
        classifierOutputNotKept?: unknown;
      },
      "review_queue.moderation_result"
    );
    expect(kept).toEqual({
      action: "block",
      severity: "high",
      classifierOutputNotKept: { code: "request.json_number_out_of_range" },
    });
  });
});
