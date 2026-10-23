/**
 * platform/auth/__tests__/age.test.ts — age is never overstated, on any host (TASK-144)
 *
 * The age gate decides who needs parental consent (COPPA). Hostile cases: the day before a 13th
 * birthday in every time zone, the hour around midnight UTC, impossible and future dates, and a
 * host whose time zone is not UTC.
 */

import { calculateAge, evaluateAge } from "@/platform/auth/age";

const at = (iso: string) => new Date(iso);
const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe("calculateAge", () => {
  it("counts a birthday only once it has arrived everywhere (UTC−12)", () => {
    // 13th birthday is 2026-10-23. At 11:59 UTC on the 23rd it is still the 22nd at UTC−12.
    expect(calculateAge("2013-10-23", at("2026-10-23T11:59:00Z"))).toBe(12);
    expect(calculateAge("2013-10-23", at("2026-10-23T12:00:00Z"))).toBe(13);
    expect(calculateAge("2013-10-23", at("2026-10-22T23:00:00Z"))).toBe(12);
  });

  it.each([
    "UTC",
    "America/Los_Angeles",
    "Asia/Kolkata",
    "Pacific/Kiritimati",
    "Etc/GMT+12",
  ])("gives the same answer whatever the host's time zone (%s)", (tz) => {
    process.env.TZ = tz;
    expect(calculateAge("2013-10-23", at("2026-10-23T05:00:00Z"))).toBe(12);
    expect(calculateAge("2013-10-23", at("2026-10-24T05:00:00Z"))).toBe(13);
    expect(calculateAge("2000-02-29", at("2026-03-01T12:00:00Z"))).toBe(26);
  });

  it("born today anywhere is 0, never negative", () => {
    expect(calculateAge("2026-10-24", at("2026-10-23T11:00:00Z"))).toBe(0); // already the 24th at UTC+14
    expect(calculateAge("2026-10-23", at("2026-10-23T00:30:00Z"))).toBe(0);
  });

  it.each([
    ["not a date", "abc"],
    ["a timestamp", "2013-10-23T00:00:00Z"],
    ["no padding", "2013-1-5"],
    ["an impossible day", "2013-02-30"],
    ["month 13", "2013-13-01"],
    ["a non-leap 29 Feb", "2023-02-29"],
  ])("refuses %s", (_label, dob) => {
    expect(() => calculateAge(dob, at("2026-10-23T12:00:00Z"))).toThrow(RangeError);
  });

  it("refuses a date later than today anywhere", () => {
    expect(() => calculateAge("2026-10-25", at("2026-10-23T12:00:00Z"))).toThrow(
      /future/
    );
  });
});

describe("evaluateAge", () => {
  it("the evening before a 13th birthday (US time) still requires parental consent", () => {
    // 2026-10-23 20:00 in New York is already the 24th in UTC.
    const r = evaluateAge("2013-10-24", at("2026-10-24T00:00:00Z"));
    expect(r).toEqual({
      isMinor: true,
      age: 12,
      requiresParentalConsent: true,
      contentRatingLevel: 1,
    });
    expect(
      evaluateAge("2013-10-24", at("2026-10-24T12:00:00Z")).requiresParentalConsent
    ).toBe(false);
  });

  it("never reads an invalid date as an adult — it throws", () => {
    expect(() => evaluateAge("not-a-date")).toThrow(RangeError);
  });
});

describe("agent budget day (TASK-144)", () => {
  it.each(["UTC", "Asia/Kolkata", "America/Los_Angeles"])(
    "is the UTC date on a host in %s",
    async (tz) => {
      process.env.TZ = tz;
      const { BudgetTracker } = await import("@/platform/agents/budget-tracker");
      const tracker = Object.create(BudgetTracker.prototype) as InstanceType<
        typeof BudgetTracker
      >;
      expect(tracker.getCurrentPeriod(at("2026-10-23T23:30:00Z"))).toBe("2026-10-23");
      expect(tracker.getCurrentPeriod(at("2026-10-24T00:30:00Z"))).toBe("2026-10-24");
    }
  );
});
