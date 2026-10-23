/**
 * platform/auth/age.ts — age from a date of birth, and what it requires (COPPA)
 *
 * No server imports: the sign-up age gate (components/auth/AgeGate.tsx) and the server's record
 * (platform/auth/coppa.ts) use this one calculation. The gate had its own copy, in the browser's
 * local time; two copies of a compliance rule can disagree (TASK-144).
 *
 * @module platform/auth
 */

export interface AgeVerificationResult {
  isMinor: boolean;
  age: number;
  requiresParentalConsent: boolean;
  contentRatingLevel: number;
}

const MINOR_AGE_THRESHOLD = 13;
const TEEN_AGE_THRESHOLD = 18;

/** Hours between UTC and the earliest (UTC−12) and latest (UTC+14) calendar dates in use. */
const EARLIEST_ZONE_HOURS = -12;
const LATEST_ZONE_HOURS = 14;

function calendarDateAt(now: Date, offsetHours: number): [number, number, number] {
  const t = new Date(now.getTime() + offsetHours * 3_600_000);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

/**
 * Age in whole years from a calendar date of birth (YYYY-MM-DD) — never overstated (TASK-144).
 *
 * The age gate decides who needs parental consent, so the answer must not depend on the host's
 * time zone or the hour: it used the server's local date, so on a host west of UTC a child was
 * one day older than they are on the day before their birthday. The age is taken as of the
 * earliest calendar date anywhere (UTC−12), so a birthday counts only once it has arrived
 * everywhere. A date that is not a real calendar date, or later than today anywhere (UTC+14), is
 * refused — never read as an adult.
 */
export function calculateAge(dateOfBirth: string, now: Date = new Date()): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!m) throw new RangeError("dateOfBirth must be a calendar date, YYYY-MM-DD");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const real = new Date(Date.UTC(y, mo - 1, d));
  if (
    real.getUTCFullYear() !== y ||
    real.getUTCMonth() !== mo - 1 ||
    real.getUTCDate() !== d
  ) {
    throw new RangeError("dateOfBirth is not a real calendar date");
  }
  const [ly, lm, ld] = calendarDateAt(now, LATEST_ZONE_HOURS);
  if (y > ly || (y === ly && (mo > lm || (mo === lm && d > ld)))) {
    throw new RangeError("dateOfBirth is in the future");
  }
  const [ty, tm, td] = calendarDateAt(now, EARLIEST_ZONE_HOURS);
  let age = ty - y;
  if (tm < mo || (tm === mo && td < d)) age--;
  return Math.max(0, age);
}

/**
 * Determine age verification result and content rating level.
 *
 * Content rating levels:
 * 1 = strictest (under 13, COPPA applies)
 * 2 = moderate (13-17, teen content)
 * 3 = standard (18+, full content)
 */
export function evaluateAge(
  dateOfBirth: string,
  now: Date = new Date()
): AgeVerificationResult {
  const age = calculateAge(dateOfBirth, now);

  if (age < MINOR_AGE_THRESHOLD) {
    return {
      isMinor: true,
      age,
      requiresParentalConsent: true,
      contentRatingLevel: 1,
    };
  }

  if (age < TEEN_AGE_THRESHOLD) {
    return {
      isMinor: true,
      age,
      requiresParentalConsent: false,
      contentRatingLevel: 2,
    };
  }

  return {
    isMinor: false,
    age,
    requiresParentalConsent: false,
    contentRatingLevel: 3,
  };
}
