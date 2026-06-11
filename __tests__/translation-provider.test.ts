/**
 * TranslationProvider interface contract — mock arm.
 * Runs the synced conformance kit (ADR-027) against MockTranslateProvider.
 */

import { runTranslationProviderContract } from "./contract/translation-provider-contract";
import { MockTranslateProvider } from "@/platform/translation/mock-translate";

describe("TranslationProvider contract — mock provider", () => {
  runTranslationProviderContract({
    makeProvider: () => new MockTranslateProvider(),
  });
});
