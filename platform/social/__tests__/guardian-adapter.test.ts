/**
 * platform/social/__tests__/guardian-adapter.test.ts
 *
 * Tests for Guardian social screening adapter.
 * Covers: allow, block, escalate, Guardian failure (fail-closed).
 */

// ── Mocks ───────────────────────────────────────────────────────────────

const mockScreen = jest.fn();

jest.mock("@/platform/moderation/guardian", () => ({
  getGuardian: () => ({ screen: mockScreen }),
}));

jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// ── Imports ─────────────────────────────────────────────────────────────

import { createGuardianScreenFn } from "../guardian-adapter";

// ── Tests ───────────────────────────────────────────────────────────────

describe("createGuardianScreenFn", () => {
  let screenFn: ReturnType<typeof createGuardianScreenFn>;

  beforeEach(() => {
    mockScreen.mockReset();
    screenFn = createGuardianScreenFn();
  });

  it("returns null when Guardian allows content", async () => {
    mockScreen.mockResolvedValue({
      action: "allow",
      reasoning: "",
    });

    const result = await screenFn("Study buddies", "group-name");
    expect(result).toBeNull();
  });

  it("returns null when Guardian warns (content passes)", async () => {
    mockScreen.mockResolvedValue({
      action: "warn",
      reasoning: "Borderline but acceptable",
    });

    const result = await screenFn("Edgy group name", "group-name");
    expect(result).toBeNull();
  });

  it("returns error message when Guardian blocks", async () => {
    mockScreen.mockResolvedValue({
      action: "block",
      reasoning: "Contains harassment",
    });

    const result = await screenFn("Offensive name", "group-name");
    expect(result).toBe("Contains harassment");
  });

  it("returns fallback message when block has no reasoning", async () => {
    mockScreen.mockResolvedValue({
      action: "block",
      reasoning: "",
    });

    const result = await screenFn("Bad content", "group-description");
    expect(result).toBe("Content contains prohibited material");
  });

  it("returns error message when Guardian escalates", async () => {
    mockScreen.mockResolvedValue({
      action: "escalate",
      reasoning: "Ambiguous content",
    });

    const result = await screenFn("Ambiguous name", "group-name");
    expect(result).toMatch(/requires review/);
  });

  it("blocks content when Guardian throws (fail-closed P4)", async () => {
    mockScreen.mockRejectedValue(new Error("Guardian unavailable"));

    const result = await screenFn("Any content", "group-name");
    expect(result).toMatch(/temporarily unavailable/);
  });

  it("calls Guardian with 4 args: text, direction, requestId, context", async () => {
    mockScreen.mockResolvedValue({
      action: "allow",
      reasoning: "",
    });

    await screenFn("Test", "group-name");

    expect(mockScreen).toHaveBeenCalledWith(
      "Test",
      "input",
      expect.stringContaining("social-screen-"),
      expect.objectContaining({
        contentType: "social",
        contentRatingLevel: 3,
      })
    );
  });

  it("uses 'input' direction for all social screening", async () => {
    mockScreen.mockResolvedValue({
      action: "allow",
      reasoning: "",
    });

    await screenFn("Test", "group-description");

    expect(mockScreen).toHaveBeenCalledWith(
      "Test",
      "input",
      expect.any(String),
      expect.any(Object)
    );
  });
});
