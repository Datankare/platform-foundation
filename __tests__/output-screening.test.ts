/**
 * __tests__/output-screening.test.ts — lib/output-screening (audit D-17)
 *
 * Shared by the platform and its apps (TASK-204, N-47). The routes' cases are in their own
 * tests; these are the helper's: what is collected from a structured output (bounded), one
 * screening call for many texts, nothing to screen is allowed without a call, and a refusal or an
 * outage withholds (fail closed).
 */

jest.mock("@/lib/safety", () => ({ checkOutputSafety: jest.fn() }));
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { checkOutputSafety } from "@/lib/safety";
import { logger } from "@/lib/logger";
import { isOutputAllowed, textsOf, translatedTexts } from "@/lib/output-screening";

const screen = checkOutputSafety as jest.Mock;
const ctx = { requestId: "r1", route: "/api/test" };

beforeEach(() => {
  screen.mockReset();
  (logger.info as jest.Mock).mockClear();
});

describe("textsOf", () => {
  it("collects every non-blank string of a structured output, in order", () => {
    expect(
      textsOf({ a: "one", b: [" ", "two", { c: "three", d: 4, e: null }], f: true })
    ).toEqual(["one", "two", "three"]);
    expect(textsOf(undefined)).toEqual([]);
    expect(textsOf("solo")).toEqual(["solo"]);
  });

  it("hostile: a deep or huge output is bounded (no unbounded work)", () => {
    let deep: unknown = "bottom";
    for (let i = 0; i < 50; i++) deep = { next: deep };
    expect(textsOf(deep)).toEqual([]);
    expect(textsOf(Array.from({ length: 10_000 }, (_, i) => `t${i}`))).toHaveLength(200);
  });
});

describe("translatedTexts", () => {
  it("takes the translated text of each result, ignoring malformed entries", () => {
    expect(
      translatedTexts([
        { translated: "hola" },
        { translated: 3 },
        {},
        { translated: "salut" },
      ])
    ).toEqual(["hola", "salut"]);
  });
});

describe("isOutputAllowed", () => {
  it("nothing to screen is allowed without a call", async () => {
    await expect(isOutputAllowed([], ctx)).resolves.toBe(true);
    await expect(isOutputAllowed(["  ", ""], ctx)).resolves.toBe(true);
    expect(screen).not.toHaveBeenCalled();
  });

  it("screens many texts in one call, as output", async () => {
    screen.mockResolvedValue({ safe: true });
    await expect(isOutputAllowed(["a", "b"], ctx)).resolves.toBe(true);
    expect(screen).toHaveBeenCalledTimes(1);
    expect(screen).toHaveBeenCalledWith("a\nb", { requestId: "r1" });
  });

  it("hostile: a refusal withholds, and its reason goes to the log only", async () => {
    const reasons = [{ key: "screens.moderation.reasons.low_blocklist" }];
    screen.mockResolvedValue({ safe: false, reasons });
    await expect(isOutputAllowed(["x"], ctx)).resolves.toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      "Output withheld by content screening",
      expect.objectContaining({ reasons, route: "/api/test" })
    );
  });

  it("hostile: a screen that throws withholds (fail closed)", async () => {
    screen.mockRejectedValue(new Error("classifier down"));
    await expect(isOutputAllowed(["x"], ctx)).resolves.toBe(false);
    screen.mockRejectedValue("not an error");
    await expect(isOutputAllowed(["x"], ctx)).resolves.toBe(false);
  });
});
