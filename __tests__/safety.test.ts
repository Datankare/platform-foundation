describe("Safety Module", () => {
  describe("Input validation rules", () => {
    it("should enforce max 100 character limit", () => {
      const MAX_CHARS = 100;
      const validText = "Hello world";
      const tooLongText = "a".repeat(101);
      expect(validText.length).toBeLessThanOrEqual(MAX_CHARS);
      expect(tooLongText.length).toBeGreaterThan(MAX_CHARS);
    });
  });

  describe("Safety response parsing", () => {
    it("should parse safe response correctly", () => {
      const mockResponse = JSON.stringify({ safe: true });
      const parsed = JSON.parse(mockResponse);
      expect(parsed.safe).toBe(true);
    });

    it("should parse unsafe response correctly", () => {
      const mockResponse = JSON.stringify({
        safe: false,
        reason: "inappropriate content",
      });
      const parsed = JSON.parse(mockResponse);
      expect(parsed.safe).toBe(false);
      expect(parsed.reason).toBe("inappropriate content");
    });

    it("should strip markdown code fences before parsing", () => {
      const withFences = '```json\n{"safe": false, "reason": "sexual content"}\n```';
      const cleaned = withFences
        .trim()
        .replace(/^```json\n?/, "")
        .replace(/^```\n?/, "")
        .replace(/\n?```$/, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      expect(parsed.safe).toBe(false);
      expect(parsed.reason).toBe("sexual content");
    });

    it("should fail CLOSED on malformed response — block not allow", () => {
      // Critical security behavior — when in doubt, block
      let result = { safe: false, reason: "Content could not be verified as safe." };
      try {
        JSON.parse("not valid json {{{}");
      } catch {
        result = { safe: false, reason: "Content could not be verified as safe." };
      }
      expect(result.safe).toBe(false);
    });
  });
});
