/**
 * bootstrap.test.ts — the reference knowledge base is registered on the boot path (ADR-042).
 */
import { registerRagReference, CURATOR_REFERENCE_KB } from "../bootstrap";
import { hasKnowledgeBase, getKnowledgeBase, resetKnowledgeBases } from "../kb-registry";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

describe("registerRagReference", () => {
  beforeEach(() => resetKnowledgeBases());

  it("registers the curator reference KB (shared, no boundary)", () => {
    expect(hasKnowledgeBase(CURATOR_REFERENCE_KB.id)).toBe(false);
    registerRagReference();
    const kb = getKnowledgeBase(CURATOR_REFERENCE_KB.id);
    expect(kb?.isolationLevel).toBe("shared");
    expect(kb?.boundary).toEqual([]);
  });

  it("is idempotent (safe to call more than once)", () => {
    registerRagReference();
    expect(() => registerRagReference()).not.toThrow();
    expect(hasKnowledgeBase(CURATOR_REFERENCE_KB.id)).toBe(true);
  });
});
