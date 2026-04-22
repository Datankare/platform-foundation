/**
 * __tests__/moderation-context.test.ts — Context evaluation tests
 *
 * Tests: severity reduction per content type, ai-output attribution,
 * user history factors, language context.
 */

import { evaluateContext, reduceSeverity } from "@/platform/moderation/context";
import type { ScreeningContext } from "@/platform/moderation/types";

// Mock platform config
jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: jest.fn(async (key: string, defaultValue: unknown) => {
    const configMap: Record<string, unknown> = {
      "moderation.translation_severity_reduction": 1,
      "moderation.transcription_severity_reduction": 1,
      "moderation.extraction_severity_reduction": 1,
    };
    return configMap[key] ?? defaultValue;
  }),
}));

// ---------------------------------------------------------------------------
// reduceSeverity
// ---------------------------------------------------------------------------

describe("reduceSeverity", () => {
  it("reduces high by 1 to medium", () => {
    expect(reduceSeverity("high", 1)).toBe("medium");
  });

  it("reduces medium by 1 to low", () => {
    expect(reduceSeverity("medium", 1)).toBe("low");
  });

  it("does not reduce below low", () => {
    expect(reduceSeverity("low", 1)).toBe("low");
  });

  it("critical reduced by 1 gives high", () => {
    expect(reduceSeverity("critical", 1)).toBe("high");
  });

  it("critical never reduces below medium", () => {
    expect(reduceSeverity("critical", 3)).toBe("medium");
  });

  it("returns same severity for reduction of 0", () => {
    expect(reduceSeverity("high", 0)).toBe("high");
  });

  it("handles reduction of 2", () => {
    expect(reduceSeverity("high", 2)).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// evaluateContext
// ---------------------------------------------------------------------------

describe("evaluateContext", () => {
  it("returns no reduction for generation content", async () => {
    const ctx: ScreeningContext = { contentType: "generation" };
    const result = await evaluateContext(ctx);

    expect(result.severityReduction).toBe(0);
    expect(result.attributeToUser).toBe(true);
  });

  it("returns severity reduction for translation content", async () => {
    const ctx: ScreeningContext = { contentType: "translation" };
    const result = await evaluateContext(ctx);

    expect(result.severityReduction).toBe(1);
    expect(result.factors).toEqual(
      expect.arrayContaining([expect.stringContaining("translation-content")])
    );
  });

  it("returns severity reduction for transcription content", async () => {
    const ctx: ScreeningContext = { contentType: "transcription" };
    const result = await evaluateContext(ctx);

    expect(result.severityReduction).toBe(1);
  });

  it("returns severity reduction for extraction content", async () => {
    const ctx: ScreeningContext = { contentType: "extraction" };
    const result = await evaluateContext(ctx);

    expect(result.severityReduction).toBe(1);
  });

  it("does not attribute strikes for ai-output", async () => {
    const ctx: ScreeningContext = { contentType: "ai-output" };
    const result = await evaluateContext(ctx);

    expect(result.attributeToUser).toBe(false);
    expect(result.factors).toEqual(
      expect.arrayContaining([expect.stringContaining("strikes not attributed")])
    );
  });

  it("records clean-history factor for users with long clean record", async () => {
    const ctx: ScreeningContext = {
      contentType: "generation",
      userHistory: {
        totalScreenings: 500,
        recentFlags: 0,
        activeStrikes: 0,
      },
    };
    const result = await evaluateContext(ctx);

    expect(result.factors).toEqual(
      expect.arrayContaining([expect.stringContaining("clean-history")])
    );
  });

  it("records repeat-flags factor for users with 3+ recent flags", async () => {
    const ctx: ScreeningContext = {
      contentType: "generation",
      userHistory: {
        totalScreenings: 50,
        recentFlags: 5,
        activeStrikes: 2,
      },
    };
    const result = await evaluateContext(ctx);

    expect(result.factors).toEqual(
      expect.arrayContaining([expect.stringContaining("repeat-flags")])
    );
  });

  it("records language context when languages are provided", async () => {
    const ctx: ScreeningContext = {
      contentType: "translation",
      sourceLanguage: "ar",
      targetLanguage: "en",
    };
    const result = await evaluateContext(ctx);

    expect(result.factors).toEqual(
      expect.arrayContaining([expect.stringContaining("ar → en")])
    );
  });

  it("does not reduce severity for profile content", async () => {
    const ctx: ScreeningContext = { contentType: "profile" };
    const result = await evaluateContext(ctx);

    expect(result.severityReduction).toBe(0);
  });

  it("does not reduce severity for social content", async () => {
    const ctx: ScreeningContext = { contentType: "social" };
    const result = await evaluateContext(ctx);

    expect(result.severityReduction).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F6: Unknown contentType validation
// ---------------------------------------------------------------------------

describe("evaluateContext — unknown contentType (F6)", () => {
  it("returns safe defaults for unknown content type", async () => {
    const ctx = { contentType: "bogus" as ScreeningContext["contentType"] };
    const result = await evaluateContext(ctx);

    expect(result.severityReduction).toBe(0);
    expect(result.attributeToUser).toBe(true);
    expect(result.factors).toEqual(
      expect.arrayContaining([expect.stringContaining("unknown-content-type")])
    );
  });
});
