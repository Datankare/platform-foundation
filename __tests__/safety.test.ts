// mockCreate must be declared before jest.mock — Jest hoists mock factories
// and mock-prefixed variables are accessible in hoisted factories
const mockCreate = jest.fn();

jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

import { checkSafety } from "@/lib/safety";

describe("checkSafety — real function", () => {
  beforeEach(() => {
    mockCreate.mockClear();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("returns safe:true for safe content", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"safe": true}' }],
    });
    const result = await checkSafety("Hello, how are you today?");
    expect(result.safe).toBe(true);
  });

  it("returns safe:false with reason for unsafe content", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"safe": false, "reason": "violent content"}' }],
    });
    const result = await checkSafety("violent text here");
    expect(result.safe).toBe(false);
    expect(result.reason).toBe("violent content");
  });

  it("strips markdown code fences from response", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '```json\n{"safe": true}\n```' }],
    });
    const result = await checkSafety("clean text");
    expect(result.safe).toBe(true);
  });

  it("strips plain code fences from response", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '```\n{"safe": false, "reason": "test"}\n```' }],
    });
    const result = await checkSafety("test text");
    expect(result.safe).toBe(false);
  });

  it("fails CLOSED on malformed JSON — returns safe:false", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "not valid json at all" }],
    });
    const result = await checkSafety("some text");
    expect(result.safe).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("returns safe:false on non-text response type (fail-closed)", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "image", source: {} }],
    });
    const result = await checkSafety("some text");
    expect(result.safe).toBe(false);
  });

  it("sanitizes user input — wraps in user_input delimiter", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"safe": true}' }],
    });
    await checkSafety("normal text");
    const callArg = mockCreate.mock.calls[0][0];
    const promptContent = callArg.messages[0].content as string;
    expect(promptContent).toContain("<user_input>");
    expect(promptContent).toContain("</user_input>");
  });

  it("uses claude-haiku model", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"safe": true}' }],
    });
    await checkSafety("test");
    const callArg = mockCreate.mock.calls[0][0];
    expect(callArg.model).toContain("haiku");
  });

  it("requests minimal token output", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"safe": true}' }],
    });
    await checkSafety("test");
    const callArg = mockCreate.mock.calls[0][0];
    expect(callArg.max_tokens).toBeLessThanOrEqual(128);
  });
});
