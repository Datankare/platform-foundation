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

import { renderShown, type ShownText } from "@/platform/errors/shown-text";
import { createGuardianScreenFn } from "../guardian-adapter";

// ── Tests ───────────────────────────────────────────────────────────────

/** The refusal as a reader sees it (TASK-209: catalog keys; the words are the same). */
const words = (r: readonly ShownText[] | null): string =>
  (r ?? []).map((t) => renderShown(t)).join(" ");

describe("createGuardianScreenFn", () => {
  let screenFn: ReturnType<typeof createGuardianScreenFn>;

  beforeEach(() => {
    mockScreen.mockReset();
    screenFn = createGuardianScreenFn();
  });

  it("returns null when Guardian allows content", async () => {
    mockScreen.mockResolvedValue({
      action: "allow",
      reasoning: [],
    });

    const result = await screenFn("Study buddies", "group-name");
    expect(result).toBeNull();
  });

  it("returns null when Guardian warns (content passes)", async () => {
    mockScreen.mockResolvedValue({
      action: "warn",
      reasoning: [],
    });

    const result = await screenFn("Edgy group name", "group-name");
    expect(result).toBeNull();
  });

  it("returns error message when Guardian blocks", async () => {
    mockScreen.mockResolvedValue({
      action: "block",
      reasoning: [
        {
          key: "screens.moderation.reasons.blocklist_block",
          params: { categories: "harassment", severity: "high" },
        },
      ],
    });

    const result = await screenFn("Offensive name", "group-name");
    expect(words(result)).toBe(
      "Blocklist hit: harassment (severity: high). Blocked immediately — classifier skipped."
    );
  });

  it("returns fallback message when block has no reasoning", async () => {
    mockScreen.mockResolvedValue({
      action: "block",
      reasoning: [],
    });

    const result = await screenFn("Bad content", "group-description");
    expect(words(result)).toBe("Content contains prohibited material");
  });

  it("returns error message when Guardian escalates", async () => {
    mockScreen.mockResolvedValue({
      action: "escalate",
      reasoning: [],
    });

    const result = await screenFn("Ambiguous name", "group-name");
    expect(words(result)).toBe("Content requires review and cannot be used at this time");
  });

  it("blocks content when Guardian throws (fail-closed P4)", async () => {
    mockScreen.mockRejectedValue(new Error("Guardian unavailable"));

    const result = await screenFn("Any content", "group-name");
    expect(words(result)).toBe(
      "Content screening is temporarily unavailable. Please try again later."
    );
  });

  it("calls Guardian with 4 args: text, direction, requestId, context", async () => {
    mockScreen.mockResolvedValue({
      action: "allow",
      reasoning: [],
    });

    await screenFn("Test", "group-name");

    expect(mockScreen).toHaveBeenCalledWith(
      "Test",
      "input",
      expect.stringContaining("social-screen-"),
      expect.objectContaining({
        contentType: "social",
        contentRatingLevel: 1,
      })
    );
  });

  it("screens at the strictest rating by default, and at a caller's when given (audit D-18)", async () => {
    mockScreen.mockResolvedValue({ action: "allow", reasoning: [] });
    await createGuardianScreenFn()("Name", "group-name");
    expect(mockScreen.mock.calls.at(-1)[3].contentRatingLevel).toBe(1);
    await createGuardianScreenFn(2)("Name", "group-name");
    expect(mockScreen.mock.calls.at(-1)[3].contentRatingLevel).toBe(2);
  });

  it("uses 'input' direction for all social screening", async () => {
    mockScreen.mockResolvedValue({
      action: "allow",
      reasoning: [],
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
