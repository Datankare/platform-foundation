/**
 * platform/translation/module.ts — The translation module (ADR-054 D2)
 *
 * Translation providers and language tables, the translation slot (TRANSLATION_PROVIDER), the
 * "translate" goal, consent and account-status feature and the "translation" moderation content
 * type. Its files — including the older lib/translate.ts and lib/tts.ts behind /api/process and
 * the demo UI, retired onto these providers in Sprint 7S — are listed in
 * platform/modules/manifest.json.
 *
 * @module platform/translation
 */

import { definePlatformModule } from "@/platform/modules/define";
import { getGoogleApiKeySetting } from "@/shared/config/apiKeys";

export const TRANSLATION_MODULE = definePlatformModule({
  id: "translation",
  providers: [
    {
      slot: "translation",
      envVar: "TRANSLATION_PROVIDER",
      values: ["google", "mock"],
      defaultValue: "mock",
      singletonKeys: [],
      // The provider is constructed where it is used; boot only reports a missing key.
      init: (selection, { env, warn }) => {
        if (selection === "google" && !getGoogleApiKeySetting(env)) {
          warn(
            "TRANSLATION_PROVIDER=google but GOOGLE_API_KEY missing — translations will fail"
          );
        }
      },
    },
  ],
  goals: ["translate"],
  consentFeatures: ["translate"],
  accountStatusFeatures: ["translate"],
  // Translating existing content: severity may be reduced (moderation.translation_severity_reduction).
  moderationContentTypes: [{ name: "translation", severityReduction: true }],
  kits: ["__tests__/contract/translation-provider-contract.ts"],
});
