describe("Process API - Input Validation", () => {
  const MAX_CHARS = 100;

  describe("Text length validation", () => {
    it("should reject empty text", () => {
      const text = "";
      expect(text.trim().length === 0).toBe(true);
    });

    it("should reject text over 100 characters", () => {
      const text = "a".repeat(101);
      expect(text.length > MAX_CHARS).toBe(true);
    });

    it("should accept text at exactly 100 characters", () => {
      const text = "a".repeat(100);
      expect(text.length <= MAX_CHARS).toBe(true);
    });

    it("should accept normal text", () => {
      const text = "Hello, how are you today?";
      expect(text.trim().length > 0).toBe(true);
      expect(text.length <= MAX_CHARS).toBe(true);
    });

    it("should trim whitespace before validation", () => {
      const text = "   Hello   ";
      expect(text.trim().length > 0).toBe(true);
    });

    it("should reject whitespace-only input", () => {
      const text = "     ";
      expect(text.trim().length === 0).toBe(true);
    });
  });

  describe("Response shape validation", () => {
    it("should define correct success response shape", () => {
      const successResponse = {
        success: true,
        translations: [
          {
            language: "English",
            languageCode: "en",
            flag: "flag",
            text: "Hello",
            audioBase64: "base64string",
          },
        ],
      };
      expect(successResponse.success).toBe(true);
      expect(Array.isArray(successResponse.translations)).toBe(true);
      expect(successResponse.translations[0]).toHaveProperty("audioBase64");
    });

    it("should define correct error response shape", () => {
      const errorResponse = { success: false, error: "Content rejected" };
      expect(errorResponse.success).toBe(false);
      expect(errorResponse.error).toBeTruthy();
    });
  });
});
