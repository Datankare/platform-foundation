/**
 * platform/auth/session-lifetimes.ts — idle and absolute lifetimes (ADR-057 D5)
 *
 * The governed defaults, and the bounds the code holds whatever a row says. Hostile: a setting
 * of zero, a negative one, a huge one, text, NaN, a configuration that cannot be read — none
 * gives a session without an end.
 */

const mockGetConfigNumber = jest.fn();
jest.mock("@/platform/auth/platform-config", () => ({
  getConfigNumber: (...args: unknown[]) => mockGetConfigNumber(...args),
}));

import {
  ABSOLUTE_MAX_SECONDS,
  ABSOLUTE_MIN_SECONDS,
  IDLE_MAX_SECONDS,
  IDLE_MIN_SECONDS,
  SESSION_LIFETIME_KEYS,
  sessionDeadlines,
  sessionExpiry,
  sessionLifetimes,
} from "@/platform/auth/session-lifetimes";

const defaults = () =>
  mockGetConfigNumber.mockImplementation(
    async (_key: string, fallback: number) => fallback
  );
const all = (value: unknown) => mockGetConfigNumber.mockImplementation(async () => value);

beforeEach(() => {
  jest.clearAllMocks();
  defaults();
});

describe("defaults (the owner's decision of 2026-11-12)", () => {
  it("a user: 7 days idle, 30 days absolute", async () => {
    await expect(sessionLifetimes("user")).resolves.toEqual({
      idleSeconds: 7 * 86400,
      absoluteSeconds: 30 * 86400,
    });
  });
  it("staff: 30 minutes idle, 12 hours absolute", async () => {
    await expect(sessionLifetimes("staff")).resolves.toEqual({
      idleSeconds: 1800,
      absoluteSeconds: 43200,
    });
  });
  it("a guest: no idle limit, 24 hours absolute", async () => {
    await expect(sessionLifetimes("guest")).resolves.toEqual({
      idleSeconds: null,
      absoluteSeconds: 86400,
    });
  });
  it("each audience reads its own settings", async () => {
    await sessionLifetimes("staff");
    expect(mockGetConfigNumber.mock.calls.map((c) => c[0]).sort()).toEqual([
      SESSION_LIFETIME_KEYS.staffAbsolute,
      SESSION_LIFETIME_KEYS.staffIdle,
    ]);
  });
});

describe("bounds", () => {
  it.each([0, -1, 1, 899])("an idle setting of %p is raised to 15 minutes", async (v) => {
    all(v);
    expect((await sessionLifetimes("staff")).idleSeconds).toBe(IDLE_MIN_SECONDS);
    expect((await sessionLifetimes("staff")).absoluteSeconds).toBe(ABSOLUTE_MIN_SECONDS);
  });
  it.each([1e12, Number.MAX_SAFE_INTEGER])(
    "a setting of %p is lowered to the maximum",
    async (v) => {
      all(v);
      await expect(sessionLifetimes("user")).resolves.toEqual({
        idleSeconds: IDLE_MAX_SECONDS,
        absoluteSeconds: ABSOLUTE_MAX_SECONDS,
      });
      expect((await sessionLifetimes("guest")).absoluteSeconds).toBe(
        ABSOLUTE_MAX_SECONDS
      );
    }
  );
  it.each([NaN, Infinity, "3600", null, undefined, {}])(
    "a setting of %p is the default, never no limit",
    async (v) => {
      all(v);
      await expect(sessionLifetimes("staff")).resolves.toEqual({
        idleSeconds: 1800,
        absoluteSeconds: 43200,
      });
    }
  );
  it("a configuration that cannot be read gives the defaults", async () => {
    mockGetConfigNumber.mockRejectedValue(new Error("database down"));
    await expect(sessionLifetimes("user")).resolves.toEqual({
      idleSeconds: 7 * 86400,
      absoluteSeconds: 30 * 86400,
    });
  });
  it("a fraction is floored", async () => {
    all(1800.9);
    expect((await sessionLifetimes("staff")).idleSeconds).toBe(1800);
  });
});

describe("when a session ends", () => {
  const life = { idleSeconds: 1800, absoluteSeconds: 43200 };
  const t0 = 1_800_000_000_000;
  it("live inside both limits", () => {
    expect(
      sessionExpiry({ createdAt: t0, lastSeenAt: t0 }, life, t0 + 1_799_999)
    ).toBeNull();
  });
  it("idle at exactly the limit", () => {
    expect(sessionExpiry({ createdAt: t0, lastSeenAt: t0 }, life, t0 + 1_800_000)).toBe(
      "idle"
    );
  });
  it("use moves the idle limit, never the absolute one", () => {
    const used = { createdAt: t0, lastSeenAt: t0 + 43_000_000 };
    expect(sessionExpiry(used, life, t0 + 43_100_000)).toBeNull();
    expect(sessionExpiry(used, life, t0 + 43_200_000)).toBe("absolute");
    expect(sessionDeadlines(used, life)).toEqual({
      idleAt: t0 + 43_000_000 + 1_800_000,
      absoluteAt: t0 + 43_200_000,
    });
  });
  it("a guest has no idle limit, and still ends", () => {
    const guest = { idleSeconds: null, absoluteSeconds: 86400 };
    expect(
      sessionExpiry({ createdAt: t0, lastSeenAt: t0 }, guest, t0 + 86_399_999)
    ).toBeNull();
    expect(sessionExpiry({ createdAt: t0, lastSeenAt: t0 }, guest, t0 + 86_400_000)).toBe(
      "absolute"
    );
    expect(sessionDeadlines({ createdAt: t0, lastSeenAt: t0 }, guest).idleAt).toBeNull();
  });
  it("a clock set back does not revive a session past its absolute limit", () => {
    expect(
      sessionExpiry({ createdAt: t0, lastSeenAt: t0 + 99_000_000 }, life, t0 + 50_000_000)
    ).toBe("absolute");
  });
});
