/**
 * platform/auth/__tests__/profile-screening.test.ts
 *
 * Tests for the profile field screening gate.
 * Covers: Guardian screening, length limits, fail-closed, config-driven.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Mocks ───────────────────────────────────────────────────────────────

jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

const mockGetConfig = jest.fn();
const mockGetConfigNumber = jest.fn();

jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: (...args: any[]) => mockGetConfig(...args),
  getConfigNumber: (...args: any[]) => mockGetConfigNumber(...args),
}));

const mockScreenContent = jest.fn();

jest.mock("@/platform/moderation", () => ({
  screenContent: (...args: any[]) => mockScreenContent(...args),
}));

// ── Imports ─────────────────────────────────────────────────────────────

import { screenProfileUpdate } from "../profile-screening";

// ── Helpers ─────────────────────────────────────────────────────────────

const VALID_USER_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function allowGuardian() {
  mockScreenContent.mockResolvedValue({
    action: "allow",
    triggeredBy: "none",
    reasoning: "Content is safe.",
    trajectoryId: "traj-test-1",
    contentType: "profile",
    attributeToUser: true,
    pipelineLatencyMs: 10,
    classifierCostUsd: 0,
  });
}

function blockGuardian(reasoning = "Hate speech detected.") {
  mockScreenContent.mockResolvedValue({
    action: "block",
    triggeredBy: "blocklist",
    reasoning,
    trajectoryId: "traj-test-block",
    contentType: "profile",
    attributeToUser: true,
    pipelineLatencyMs: 15,
    classifierCostUsd: 0.001,
  });
}

function warnGuardian(reasoning = "Mild profanity detected.") {
  mockScreenContent.mockResolvedValue({
    action: "warn",
    triggeredBy: "classifier",
    reasoning,
    trajectoryId: "traj-test-warn",
    contentType: "profile",
    attributeToUser: true,
    pipelineLatencyMs: 12,
    classifierCostUsd: 0.001,
  });
}

function setupDefaultConfig() {
  mockGetConfig.mockImplementation((key: string, defaultValue: any) => {
    if (key === "profile.screened_fields") {
      return Promise.resolve(["displayName", "realName"]);
    }
    return Promise.resolve(defaultValue);
  });
  mockGetConfigNumber.mockImplementation((key: string, defaultValue: number) => {
    if (key === "profile.max_display_name_length") {
      return Promise.resolve(50);
    }
    if (key === "profile.max_real_name_length") {
      return Promise.resolve(100);
    }
    return Promise.resolve(defaultValue);
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("screenProfileUpdate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultConfig();
    allowGuardian();
  });

  // ── Happy path ──────────────────────────────────────────────────────

  it("allows a safe display name", async () => {
    const result = await screenProfileUpdate(
      VALID_USER_ID,
      { displayName: "Alice" },
      "req-1"
    );
    expect(result.allowed).toBe(true);
    expect(result.blockedFields).toHaveLength(0);
    expect(result.trajectoryIds).toHaveLength(1);
    expect(mockScreenContent).toHaveBeenCalledTimes(1);
    expect(mockScreenContent).toHaveBeenCalledWith("Alice", {
      direction: "input",
      requestId: "req-1",
      context: { contentType: "profile", userId: VALID_USER_ID },
    });
  });

  it("allows multiple safe fields", async () => {
    const result = await screenProfileUpdate(
      VALID_USER_ID,
      { displayName: "Alice", realName: "Alice Smith" },
      "req-2"
    );
    expect(result.allowed).toBe(true);
    expect(result.blockedFields).toHaveLength(0);
    expect(result.trajectoryIds).toHaveLength(2);
    expect(mockScreenContent).toHaveBeenCalledTimes(2);
  });

  it("skips non-screened fields without Guardian call", async () => {
    const result = await screenProfileUpdate(
      VALID_USER_ID,
      { timezone: "America/New_York", languagePreference: "fr" },
      "req-3"
    );
    expect(result.allowed).toBe(true);
    expect(result.blockedFields).toHaveLength(0);
    expect(mockScreenContent).not.toHaveBeenCalled();
  });

  it("skips boolean fields without Guardian call", async () => {
    const result = await screenProfileUpdate(
      VALID_USER_ID,
      { emailOptIn: true, pushNotificationsEnabled: false },
      "req-4"
    );
    expect(result.allowed).toBe(true);
    expect(mockScreenContent).not.toHaveBeenCalled();
  });

  it("allows empty update", async () => {
    const result = await screenProfileUpdate(VALID_USER_ID, {}, "req-5");
    expect(result.allowed).toBe(true);
    expect(result.blockedFields).toHaveLength(0);
    expect(mockScreenContent).not.toHaveBeenCalled();
  });

  // ── Guardian blocks ─────────────────────────────────────────────────

  it("blocks display name flagged by Guardian", async () => {
    blockGuardian("Hate speech detected.");
    const result = await screenProfileUpdate(
      VALID_USER_ID,
      { displayName: "offensive-name" },
      "req-6"
    );
    expect(result.allowed).toBe(false);
    expect(result.blockedFields).toEqual(["displayName"]);
    expect(result.reasons.displayName).toMatch(/Hate speech/);
  });

  it("treats Guardian warn as block for profile fields", async () => {
    warnGuardian("Mild profanity detected.");
    const result = await screenProfileUpdate(
      VALID_USER_ID,
      { displayName: "mildly-bad" },
      "req-7"
    );
    expect(result.allowed).toBe(false);
    expect(result.blockedFields).toEqual(["displayName"]);
    expect(result.reasons.displayName).toMatch(/not allowed in profiles/);
  });

  it("blocks one field, allows another in same update", async () => {
    mockScreenContent
      .mockResolvedValueOnce({
        action: "allow",
        triggeredBy: "none",
        reasoning: "Safe.",
        trajectoryId: "traj-1",
        contentType: "profile",
        attributeToUser: true,
        pipelineLatencyMs: 10,
        classifierCostUsd: 0,
      })
      .mockResolvedValueOnce({
        action: "block",
        triggeredBy: "blocklist",
        reasoning: "URL detected.",
        trajectoryId: "traj-2",
        contentType: "profile",
        attributeToUser: true,
        pipelineLatencyMs: 15,
        classifierCostUsd: 0,
      });

    const result = await screenProfileUpdate(
      VALID_USER_ID,
      { displayName: "Alice", realName: "http://evil.com" },
      "req-8"
    );
    expect(result.allowed).toBe(false);
    expect(result.blockedFields).toEqual(["realName"]);
    expect(result.reasons.realName).toMatch(/URL detected/);
    expect(result.trajectoryIds).toHaveLength(2);
  });

  // ── Length limits ───────────────────────────────────────────────────

  it("blocks display name exceeding length limit", async () => {
    const result = await screenProfileUpdate(
      VALID_USER_ID,
      { displayName: "A".repeat(51) },
      "req-9"
    );
    expect(result.allowed).toBe(false);
    expect(result.blockedFields).toEqual(["displayName"]);
    expect(result.reasons.displayName).toMatch(/exceeds maximum length of 50/);
    expect(mockScreenContent).not.toHaveBeenCalled();
  });

  it("blocks real name exceeding length limit", async () => {
    const result = await screenProfileUpdate(
      VALID_USER_ID,
      { realName: "B".repeat(101) },
      "req-10"
    );
    expect(result.allowed).toBe(false);
    expect(result.blockedFields).toEqual(["realName"]);
    expect(result.reasons.realName).toMatch(/exceeds maximum length of 100/);
  });

  it("allows display name at exact limit", async () => {
    const result = await screenProfileUpdate(
      VALID_USER_ID,
      { displayName: "A".repeat(50) },
      "req-11"
    );
    expect(result.allowed).toBe(true);
  });

  // ── Fail-closed ─────────────────────────────────────────────────────

  it("fails closed when Guardian throws", async () => {
    mockScreenContent.mockRejectedValue(new Error("Guardian crashed"));
    const result = await screenProfileUpdate(
      VALID_USER_ID,
      { displayName: "Alice" },
      "req-12"
    );
    expect(result.allowed).toBe(false);
    expect(result.blockedFields).toEqual(["displayName"]);
    expect(result.reasons.displayName).toMatch(/temporarily unavailable/);
  });

  it("fails closed when config unavailable (uses fallback fields)", async () => {
    mockGetConfig.mockRejectedValue(new Error("Config DB down"));
    const result = await screenProfileUpdate(
      VALID_USER_ID,
      { displayName: "Alice" },
      "req-13"
    );
    // Should still screen displayName (it's in the fallback list)
    expect(mockScreenContent).toHaveBeenCalledTimes(1);
    expect(result.allowed).toBe(true);
  });

  // ── Input validation ────────────────────────────────────────────────

  it("rejects invalid userId format", async () => {
    const result = await screenProfileUpdate(
      "not-a-uuid",
      { displayName: "Alice" },
      "req-14"
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons._userId).toMatch(/Invalid user ID/);
    expect(mockScreenContent).not.toHaveBeenCalled();
  });

  it("rejects empty userId", async () => {
    const result = await screenProfileUpdate("", { displayName: "Alice" }, "req-15");
    expect(result.allowed).toBe(false);
    expect(result.reasons._userId).toMatch(/Invalid user ID/);
  });
});
