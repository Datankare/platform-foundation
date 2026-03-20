import {
  canSubmitText,
  getCharState,
  MAX_CHARACTERS,
  canClearText,
} from "@/lib/inputValidation";

describe("SpikeApp — Component Behavior", () => {
  describe("MAX_CHARACTERS constant", () => {
    it("should be exactly 100", () => {
      expect(MAX_CHARACTERS).toBe(100);
    });
  });

  describe("getCharState", () => {
    it("should return correct state for empty string", () => {
      const state = getCharState("");
      expect(state.charCount).toBe(0);
      expect(state.charsLeft).toBe(100);
      expect(state.isOverLimit).toBe(false);
      expect(state.isEmpty).toBe(true);
    });

    it("should return correct state for normal text", () => {
      const state = getCharState("Hello world");
      expect(state.charCount).toBe(11);
      expect(state.charsLeft).toBe(89);
      expect(state.isOverLimit).toBe(false);
      expect(state.isEmpty).toBe(false);
    });

    it("should return correct state at exactly 100 characters", () => {
      const text = "a".repeat(100);
      const state = getCharState(text);
      expect(state.charCount).toBe(100);
      expect(state.charsLeft).toBe(0);
      expect(state.isOverLimit).toBe(false);
      expect(state.isEmpty).toBe(false);
    });

    it("should return correct state at 101 characters — over limit", () => {
      const text = "a".repeat(101);
      const state = getCharState(text);
      expect(state.charCount).toBe(101);
      expect(state.charsLeft).toBe(-1);
      expect(state.isOverLimit).toBe(true);
      expect(state.isEmpty).toBe(false);
    });

    it("should treat whitespace-only as empty", () => {
      const state = getCharState("     ");
      expect(state.isEmpty).toBe(true);
    });

    it("should show negative charsLeft when over limit", () => {
      const text = "a".repeat(110);
      const state = getCharState(text);
      expect(state.charsLeft).toBe(-10);
    });
  });

  describe("canSubmitText", () => {
    it("should return true for valid text not loading", () => {
      expect(canSubmitText("Hello world", false)).toBe(true);
    });

    it("should return false when loading", () => {
      expect(canSubmitText("Hello world", true)).toBe(false);
    });

    it("should return false for empty string", () => {
      expect(canSubmitText("", false)).toBe(false);
    });

    it("should return false for whitespace only", () => {
      expect(canSubmitText("     ", false)).toBe(false);
    });

    it("should return false for text over 100 characters", () => {
      expect(canSubmitText("a".repeat(101), false)).toBe(false);
    });

    it("should return true at exactly 100 characters", () => {
      expect(canSubmitText("a".repeat(100), false)).toBe(true);
    });

    it("should return false when both over limit AND loading", () => {
      expect(canSubmitText("a".repeat(101), true)).toBe(false);
    });

    it("should return false when empty AND loading", () => {
      expect(canSubmitText("", true)).toBe(false);
    });

    it("should not submit text that is exactly whitespace at limit", () => {
      expect(canSubmitText(" ".repeat(100), false)).toBe(false);
    });
  });

  describe("canClearText", () => {
    it("should return true when text exists and not loading", () => {
      expect(canClearText("Hello", false)).toBe(true);
    });

    it("should return false when text is empty", () => {
      expect(canClearText("", false)).toBe(false);
    });

    it("should return false when loading", () => {
      expect(canClearText("Hello", true)).toBe(false);
    });

    it("should return true even when text is over limit", () => {
      expect(canClearText("a".repeat(101), false)).toBe(true);
    });

    it("should return false when empty and loading", () => {
      expect(canClearText("", true)).toBe(false);
    });
  });
});
