/**
 * curator-content.test.ts — ADR-037 step 4: Curator as the reference content type.
 *
 * Tests curator-content's own responsibilities: the content-type definition, the no-activity
 * short-circuit (no LLM call — P12), pass-through of the framework's screened result, and boot
 * registration. The generation loop itself (screening, fail-closed) is exercised by
 * platform/content/__tests__/loop.test.ts, so generateContent is mocked here.
 */
jest.mock("@/platform/content/loop", () => {
  const actual = jest.requireActual("@/platform/content/loop");
  return { ...actual, generateContent: jest.fn() };
});

import { generateContent } from "@/platform/content/loop";
import {
  hasContentType,
  listContentTypes,
  resetContentTypes,
} from "@/platform/content/registry";
import {
  CURATOR_CONTENT_TYPE,
  generateCuratorDigest,
  registerSocialContentTypes,
} from "@/platform/social/content/curator-content";
import type { CuratorInput, DigestItem } from "@/prompts/social/curator-v1";

const gen = generateContent as jest.Mock;

const INPUT: CuratorInput = {
  groupName: "Trailblazers",
  userId: "u1",
  recentActivity: ["Alex posted a route", "Sam joined"],
};
const ITEM: DigestItem = {
  title: "New route",
  summary: "Alex shared a trail",
  priority: "high",
};

beforeEach(() => {
  gen.mockReset();
  resetContentTypes();
});

describe("Curator content type (ADR-037 step 4)", () => {
  it("generates the digest through the framework and returns the screened content", async () => {
    gen.mockResolvedValue({ content: [ITEM], usedFallback: false, trajectoryId: "t1" });

    const digest = await generateCuratorDigest(INPUT);

    expect(digest).toEqual([ITEM]);
    expect(gen).toHaveBeenCalledWith(
      CURATOR_CONTENT_TYPE,
      INPUT,
      expect.objectContaining({ type: "group", id: "Trailblazers" })
    );
  });

  it("short-circuits to an empty digest when there is no activity (no generation)", async () => {
    const digest = await generateCuratorDigest({ ...INPUT, recentActivity: [] });

    expect(digest).toEqual([]);
    expect(gen).not.toHaveBeenCalled();
  });

  it("passes through the empty fallback when the framework fell back (e.g. screening blocked)", async () => {
    gen.mockResolvedValue({
      content: [],
      usedFallback: true,
      fallbackReason: "screening-blocked",
      trajectoryId: "t1",
    });

    const digest = await generateCuratorDigest(INPUT);

    expect(digest).toEqual([]);
  });

  it("builds the curator request from the prompt (fast tier, budgeted)", () => {
    const req = CURATOR_CONTENT_TYPE.build(INPUT);
    expect(req.tier).toBe("fast");
    expect(req.maxTokens).toBe(512);
    expect(req.temperature).toBe(0.3);
    expect(typeof req.messages[0].content).toBe("string");
    expect(req.messages[0].content).toContain("Trailblazers");
  });

  it("parses a digest, renders an empty fallback, and screens the joined text", () => {
    const parsed = CURATOR_CONTENT_TYPE.parse(
      '[{"title":"T","summary":"S","priority":"low"}]'
    );
    expect(parsed).toEqual([{ title: "T", summary: "S", priority: "low" }]);
    expect(CURATOR_CONTENT_TYPE.renderFallback(INPUT)).toEqual([]);
    expect(CURATOR_CONTENT_TYPE.toScreenText([ITEM])).toContain(
      "New route\nAlex shared a trail"
    );
  });

  it("registerSocialContentTypes registers 'curator' and is idempotent", () => {
    expect(hasContentType("curator")).toBe(false);
    registerSocialContentTypes();
    registerSocialContentTypes();
    expect(hasContentType("curator")).toBe(true);
    expect(listContentTypes().filter((n) => n === "curator")).toHaveLength(1);
  });
});
