import { TARGET_LANGUAGES } from "@/lib/translate";

describe("Translation Module", () => {
  describe("TARGET_LANGUAGES config", () => {
    it("should have exactly 3 target languages", () => {
      expect(TARGET_LANGUAGES).toHaveLength(3);
    });

    it("should include English", () => {
      const en = TARGET_LANGUAGES.find((l) => l.code === "en");
      expect(en).toBeDefined();
      expect(en?.language).toBe("English");
    });

    it("should include Hindi", () => {
      const hi = TARGET_LANGUAGES.find((l) => l.code === "hi");
      expect(hi).toBeDefined();
      expect(hi?.language).toBe("Hindi");
    });

    it("should include Spanish", () => {
      const es = TARGET_LANGUAGES.find((l) => l.code === "es");
      expect(es).toBeDefined();
      expect(es?.language).toBe("Spanish");
    });

    it("should have required fields on all languages", () => {
      TARGET_LANGUAGES.forEach((lang) => {
        expect(lang.code).toBeTruthy();
        expect(lang.language).toBeTruthy();
        expect(lang.flag).toBeTruthy();
      });
    });
  });
});
