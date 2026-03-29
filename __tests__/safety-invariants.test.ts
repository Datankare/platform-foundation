/**
 * Architectural invariant tests — safety.ts
 *
 * Control 5: Every error handling path gets a test, including
 * paths that seem unlikely. These tests enforce ADR-005's
 * fail-closed requirement at the code level.
 */

const mockCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

import { checkSafety } from "@/lib/safety";

describe("safety.ts — fail-closed invariants", () => {
  afterEach(() => {
    mockCreate.mockReset();
  });

  it("returns unsafe when Claude returns a non-text content block", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", id: "x", name: "y", input: {} }],
    });
    const result = await checkSafety("test input");
    expect(result.safe).toBe(false);
  });

  it("returns unsafe when Claude returns empty content array", async () => {
    mockCreate.mockResolvedValueOnce({ content: [] });
    const result = await checkSafety("test input");
    expect(result.safe).toBe(false);
  });

  it("returns unsafe when JSON parse fails", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "not json at all" }],
    });
    const result = await checkSafety("test input");
    expect(result.safe).toBe(false);
  });

  it("returns safe only when Claude explicitly says safe:true", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"safe": true}' }],
    });
    const result = await checkSafety("hello world");
    expect(result.safe).toBe(true);
  });

  it("returns unsafe with reason when Claude says safe:false", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"safe": false, "reason": "violent content"}' }],
    });
    const result = await checkSafety("violent text");
    expect(result.safe).toBe(false);
    expect(result.reason).toBe("violent content");
  });
});
