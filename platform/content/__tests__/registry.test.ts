/**
 * registry.test.ts — ADR-037 step 1: the content-type registry + mandatory-fallback guard.
 */
import type { ContentType } from "@/platform/content";
import {
  registerContentType,
  getContentType,
  hasContentType,
  listContentTypes,
  resetContentTypes,
} from "@/platform/content";

interface DemoInput {
  readonly topic: string;
}
interface DemoContent {
  readonly headline: string;
}

const demo = (name: string): ContentType<DemoInput, DemoContent> => ({
  name,
  agentId: "content-demo-host",
  build: (input) => ({
    tier: "fast",
    messages: [{ role: "user", content: input.topic }],
    maxTokens: 128,
  }),
  parse: (raw) => ({ headline: raw }),
  schema: {
    type: "object",
    properties: { headline: { type: "string" } },
    required: ["headline"],
    additionalProperties: false,
  },
  renderFallback: () => ({ headline: "—" }),
  toScreenText: (content) => content.headline,
});

beforeEach(() => resetContentTypes());

describe("content-type registry (ADR-037 D1/D3)", () => {
  it("registers and retrieves a content type", () => {
    expect(hasContentType("demo")).toBe(false);
    registerContentType(demo("demo"));
    expect(hasContentType("demo")).toBe(true);
    expect(getContentType("demo")).toBeDefined();
    expect(listContentTypes()).toEqual(["demo"]);
  });

  it("returns undefined for an unregistered name", () => {
    expect(getContentType("missing")).toBeUndefined();
  });

  it("refuses a content type without a static-template fallback (D3)", () => {
    const noFallback = {
      ...demo("no-fallback"),
      renderFallback: undefined as unknown as ContentType<
        DemoInput,
        DemoContent
      >["renderFallback"],
    };
    expect(() => registerContentType(noFallback)).toThrow(/fallback/i);
    expect(hasContentType("no-fallback")).toBe(false);
  });

  it("refuses a duplicate registration", () => {
    registerContentType(demo("dup"));
    expect(() => registerContentType(demo("dup"))).toThrow(/already registered/i);
  });

  it("resetContentTypes clears the registry", () => {
    registerContentType(demo("x"));
    resetContentTypes();
    expect(listContentTypes()).toEqual([]);
  });
});
