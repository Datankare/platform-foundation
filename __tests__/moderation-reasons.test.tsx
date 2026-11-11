/**
 * @jest-environment jsdom
 */
/**
 * __tests__/moderation-reasons.test.tsx — the moderation pipeline's reasons are catalog keys, and
 * what a moderator or a user reads is unchanged (TASK-209)
 *
 * The Guardian's reasoning, its context factors, a rating level's name, the classifier's notes,
 * the modality, input and image screens' reasons, the profile and social refusals were English
 * composed in TypeScript. Each is now a catalog key and values (platform/moderation/reasons.ts).
 * Each template's words, rendered, are compared here with the English the code composed before —
 * the same expression, kept below as it was — for the same values; a record from before the keys
 * shows the catalog's note and its stored text behind a disclosure; the review assistant's prompt
 * reads the same English.
 *
 * @not-guard: behaviour tests of the catalog's moderation messages against the composed English
 * they replaced; rule F of screen-text-indirect is the guard
 */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { shown, type ShownText } from "@/platform/errors/shown-text";
import {
  reasonText,
  reasonsText,
  recordedFactor,
  recordedReasons,
} from "@/platform/moderation/reasons";
import en from "@/messages/en.json";
import { Recorded } from "@/components/ReviewDashboard/recorded";

const w = (t: ShownText): string => reasonText(t);
const level = {
  child: shown("screens.moderation.levels.child"),
  teen: shown("screens.moderation.levels.teen"),
  adult: shown("screens.moderation.levels.adult"),
  fail_closed: shown("screens.moderation.levels.fail_closed"),
};
// The labels as config.ts and guardian.ts wrote them.
const LABEL = {
  child: "child (under 13)",
  teen: "teen (13–17)",
  adult: "adult (18+)",
  fail_closed: "fail-closed (config unavailable)",
};

describe("every moderation template reads as the English it replaced (TASK-209)", () => {
  it("the content-rating levels", () => {
    for (const k of Object.keys(LABEL) as (keyof typeof LABEL)[])
      expect(w(level[k])).toBe(LABEL[k]);
  });

  it("the context factors (context.ts)", () => {
    const contentType = "translation";
    const reduction = 2;
    const sourceLanguage = "ar";
    const targetLanguage = undefined as string | undefined;
    const pairs: [ShownText, string][] = [
      [
        shown("screens.moderation.factors.unknown_content_type"),
        "unknown-content-type: treated as generation",
      ],
      [
        shown("screens.moderation.factors.severity_reduced", {
          contentType,
          reduction: String(reduction),
        }),
        `${contentType}-content: severity reduced by ${reduction}`,
      ],
      [
        shown("screens.moderation.factors.ai_output"),
        "ai-output: strikes not attributed to user",
      ],
      [
        shown("screens.moderation.factors.clean_history"),
        "clean-history: user has long clean record",
      ],
      [
        shown("screens.moderation.factors.repeat_flags"),
        "repeat-flags: 3+ flags in last 24h",
      ],
      [
        shown("screens.moderation.factors.language_context", {
          source: sourceLanguage ?? "auto",
          target: targetLanguage ?? "unknown",
        }),
        `language-context: ${sourceLanguage ?? "auto"} → ${targetLanguage ?? "unknown"}`,
      ],
    ];
    for (const [t, old] of pairs) expect(w(t)).toBe(old);
  });

  it("the Guardian's reasons (guardian.ts), one by one and joined", () => {
    const confidence = 0.4321;
    const factors = [
      shown("screens.moderation.factors.ai_output"),
      shown("screens.moderation.factors.clean_history"),
    ];
    const oldFactors = [
      "ai-output: strikes not attributed to user",
      "clean-history: user has long clean record",
    ];
    const matches = [{ category: "hate" }, { category: "self_harm" }];
    const thresholds = {
      escalateBelow: 0.5,
      blockSeverity: "medium",
      warnSeverity: "low",
    };
    const pairs: [ShownText, string][] = [
      [
        shown("screens.moderation.reasons.empty_text"),
        "Empty text — no content to screen.",
      ],
      [
        shown("screens.moderation.reasons.context", { factors }),
        `Context: ${oldFactors.join("; ")}.`,
      ],
      [
        shown("screens.moderation.reasons.blocklist_block", {
          categories: matches.map((m) => m.category).join(", "),
          severity: "critical",
        }),
        `Blocklist hit: ${matches.map((m) => m.category).join(", ")} (severity: critical). Blocked immediately — classifier skipped.`,
      ],
      [
        shown("screens.moderation.reasons.declined"),
        "Classifier declined to assess the content (declined) — withheld for human review.",
      ],
      [
        shown("screens.moderation.reasons.unavailable"),
        "Classifier unavailable — content withheld at every rating level (fail-closed).",
      ],
      [
        shown("screens.moderation.reasons.unreadable"),
        "Classifier answer unreadable — withheld for human review at every rating level (fail-closed).",
      ],
      [
        shown("screens.moderation.reasons.safe", { confidence: confidence.toFixed(2) }),
        `Classifier: safe (confidence ${confidence.toFixed(2)}).`,
      ],
      [
        shown("screens.moderation.reasons.low_blocklist"),
        `Low-severity blocklist match — warning applied.`,
      ],
      [
        shown("screens.moderation.reasons.config_unavailable"),
        "Config unavailable — using fail-closed thresholds.",
      ],
      [
        shown("screens.moderation.reasons.severity_adjusted", {
          from: "high",
          to: "medium",
          contentType: "translation",
          reduction: String(1),
        }),
        `Severity adjusted: high → medium (translation context, -${1}).`,
      ],
      [
        shown("screens.moderation.reasons.escalate_confidence", {
          confidence: confidence.toFixed(2),
          threshold: String(thresholds.escalateBelow),
          level: level.teen,
        }),
        `Confidence ${confidence.toFixed(2)} below threshold ${thresholds.escalateBelow} for ${LABEL.teen} — escalating for human review.`,
      ],
      [
        shown("screens.moderation.reasons.block_threshold", {
          severity: "high",
          threshold: thresholds.blockSeverity,
          level: level.child,
        }),
        `Adjusted severity high ≥ block threshold ${thresholds.blockSeverity} for ${LABEL.child}.`,
      ],
      [
        shown("screens.moderation.reasons.warn_threshold", {
          severity: "low",
          threshold: thresholds.warnSeverity,
          level: level.fail_closed,
        }),
        `Adjusted severity low ≥ warn threshold ${thresholds.warnSeverity} for ${LABEL.fail_closed}.`,
      ],
      [
        shown("screens.moderation.reasons.allowed", {
          severity: "low",
          level: level.adult,
        }),
        `Adjusted severity low below warn threshold for ${LABEL.adult} — allowed.`,
      ],
      [
        shown("screens.moderation.reasons.run_incomplete"),
        "Screening run did not complete — escalated for human review (fail-closed).",
      ],
    ];
    for (const [t, old] of pairs) expect(w(t)).toBe(old);
    // The reasons joined as the Guardian joined its parts (reasonParts.join(" ")).
    expect(reasonsText(pairs.map(([t]) => t))).toBe(
      pairs.map(([, old]) => old).join(" ")
    );
  });
});

describe("every other moderation template reads as the English it replaced (TASK-209)", () => {
  it("the classifier's notes (classify-v1.ts, classifier.ts, lib/safety.ts)", () => {
    const problems = ["reason is not text", "unknown category"];
    const pairs: [ShownText, string][] = [
      [
        shown("screens.moderation.classifier.not_object"),
        "Classifier answer is not a JSON object",
      ],
      [
        shown("screens.moderation.classifier.unparsable"),
        "Failed to parse classifier response",
      ],
      [shown("screens.moderation.classifier.missing_safe"), "Missing 'safe' field"],
      [
        shown("screens.moderation.classifier.unreadable", {
          problems: [
            shown("screens.moderation.problems.reason_not_text"),
            shown("screens.moderation.problems.unknown_category"),
          ],
        }),
        `Classifier answer not fully readable (${problems.join("; ")})`,
      ],
      [
        shown("screens.moderation.classifier.unexpected_type"),
        "Classifier returned unexpected response type",
      ],
      [shown("screens.moderation.classifier.unavailable"), "Classifier unavailable"],
      [shown("screens.moderation.classifier.declined"), "declined"],
      [
        shown("screens.moderation.classifier.pipeline_action", { action: "escalate" }),
        `Pipeline action: escalate`,
      ],
      [
        shown("screens.moderation.classifier.filter_block", {
          matches: ["a", "b"].join(", "),
        }),
        `Blocked by content filter: ${["a", "b"].join(", ")}`,
      ],
      [shown("screens.moderation.problems.categories_missing"), "categories missing"],
      [
        shown("screens.moderation.problems.confidence_invalid"),
        "confidence missing or outside 0–1",
      ],
      [
        shown("screens.moderation.problems.severity_invalid"),
        "severity missing or unknown",
      ],
      [
        shown("screens.moderation.problems.safe_contradiction"),
        "a safe verdict with categories or a severity above low",
      ],
    ];
    for (const [t, old] of pairs) expect(w(t)).toBe(old);
  });

  it("the modality, input and image screens (screen-modality.ts, screen-input.ts, image-generation.ts)", () => {
    const axes = [
      { axis: "nsfw", action: "allow" },
      { axis: "real-person", action: "escalate" },
    ];
    const UNCONFIGURED = "no classifier configured";
    const failed = "fail-closed: the screen did not complete (the detail is in the log)";
    const pairs: [ShownText, string][] = [
      [
        shown("screens.moderation.modality.hard_refuse"),
        "hard-refuse invariant (non-configurable)",
      ],
      [
        shown("screens.moderation.modality.axes", {
          axes: axes.map((a) => `${a.axis}=${a.action}`).join(", "),
        }),
        `axes: ${axes.map((a) => `${a.axis}=${a.action}`).join(", ")}`,
      ],
      [shown("screens.moderation.modality.unconfigured"), `withheld: ${UNCONFIGURED}`],
      [shown("screens.moderation.modality.failed"), failed],
      [
        shown("screens.moderation.modality.input_withheld", {
          modality: "image",
          action: "escalate",
          reason: shown("screens.moderation.modality.unconfigured"),
        }),
        `image input escalate: withheld: ${UNCONFIGURED}`,
      ],
      [
        shown("screens.moderation.image.failed", {
          error: shown("screens.records.effect_failed"),
        }),
        `generation failed: the call failed (the detail is in the log)`,
      ],
      [
        shown("screens.moderation.image.indeterminate"),
        "generation indeterminate — awaiting reconciliation",
      ],
      [
        shown("screens.moderation.image.withheld", {
          action: "block",
          reason: shown("screens.moderation.modality.hard_refuse"),
        }),
        `generated image block: hard-refuse invariant (non-configurable)`,
      ],
      [
        shown("screens.moderation.image.no_approval"),
        "no approval to commit this generation",
      ],
      [shown("screens.moderation.image.committed_approved"), "committed (approved)"],
      [shown("screens.moderation.image.committed_low"), "committed (low risk)"],
      [shown("screens.moderation.image.held"), "high-risk generation held for Confirm"],
      [
        shown("screens.moderation.image.held_synthetic"),
        "high-risk generation held for Confirm (synthetic reference input)",
      ],
    ];
    for (const [t, old] of pairs) expect(w(t)).toBe(old);
  });

  it("the profile and social refusals (profile-screening.ts, guardian-adapter.ts)", () => {
    const field = "displayName";
    const limit = 50;
    const pairs: [ShownText, string][] = [
      [shown("screens.moderation.profile.not_text", { field }), `${field} must be text.`],
      [
        shown("screens.moderation.profile.too_long", { field, limit: String(limit) }),
        `${field} exceeds maximum length of ${limit} characters.`,
      ],
      [
        shown("screens.moderation.profile.not_allowed", { field }),
        `${field} contains content that is not allowed in profiles.`,
      ],
      [
        shown("screens.moderation.profile.unavailable"),
        "Profile update temporarily unavailable. Please try again.",
      ],
      [
        shown("screens.moderation.profile.not_field", { field }),
        `${field} is not a profile field.`,
      ],
      [
        shown("screens.moderation.profile.visibility", { field }),
        `${field} must be private, friends or public.`,
      ],
      [
        shown("screens.moderation.profile.boolean", { field }),
        `${field} must be true or false.`,
      ],
      [
        shown("screens.moderation.profile.language"),
        "languagePreference must be a language code.",
      ],
      [
        shown("screens.moderation.profile.timezone"),
        "timezone must be a time zone name.",
      ],
      [
        shown("screens.moderation.profile.avatar_https"),
        "avatarUrl must be an https address.",
      ],
      [
        shown("screens.moderation.profile.avatar_credentials"),
        "avatarUrl must not contain credentials.",
      ],
      [
        shown("screens.moderation.profile.avatar_public_host"),
        "avatarUrl must name a public host.",
      ],
      [
        shown("screens.moderation.profile.avatar_port"),
        "avatarUrl must use the standard port.",
      ],
      [shown("screens.moderation.profile.invalid_user"), "Invalid user ID format"],
      [
        shown("screens.moderation.social.prohibited"),
        "Content contains prohibited material",
      ],
      [
        shown("screens.moderation.social.needs_review"),
        "Content requires review and cannot be used at this time",
      ],
      [
        shown("screens.moderation.social.unavailable"),
        "Content screening is temporarily unavailable. Please try again later.",
      ],
    ];
    for (const [t, old] of pairs) expect(w(t)).toBe(old);
  });

  it("covers every moderation message the catalog has", () => {
    const keys: string[] = [];
    const walk = (n: unknown, path: string): void => {
      if (typeof n === "string") keys.push(path);
      else if (n && typeof n === "object")
        for (const [k, v] of Object.entries(n)) walk(v, `${path}.${k}`);
    };
    walk(en.screens.moderation, "screens.moderation");
    // Every key above is one of these; the list of templates is the catalog's, exactly.
    expect(keys.length).toBe(
      Object.values(en.screens.moderation).reduce((n, g) => n + Object.keys(g).length, 0)
    );
    for (const k of keys)
      expect(reasonText({ key: k as `screens.${string}` })).not.toBe(k);
  });
});

describe("a reason recorded before the keys (TASK-209, N-108's fallback)", () => {
  it("reads as the catalog's note, its stored text kept for a disclosure", () => {
    expect(recordedReasons("Blocked by a moderator by hand.")).toEqual({
      text: "A reason recorded before reasons were coded.",
      stored: "Blocked by a moderator by hand.",
    });
    expect(recordedReasons([shown("screens.moderation.reasons.declined")])).toEqual({
      text: "Classifier declined to assess the content (declined) — withheld for human review.",
    });
    expect(recordedFactor("a factor a person wrote").stored).toBe(
      "a factor a person wrote"
    );
    expect(recordedFactor(shown("screens.moderation.factors.ai_output"))).toEqual({
      text: "ai-output: strikes not attributed to user",
    });
  });

  it("on the review dashboard: the words, or the note with the stored text behind a disclosure", () => {
    render(
      <div>
        <p data-testid="keys">
          <Recorded
            {...recordedReasons([shown("screens.moderation.reasons.low_blocklist")])}
          />
        </p>
        <p data-testid="legacy">
          <Recorded {...recordedReasons("Blocked by a moderator by hand.")} />
        </p>
      </div>
    );
    expect(screen.getByTestId("keys").textContent).toBe(
      "Low-severity blocklist match — warning applied."
    );
    const legacy = screen.getByTestId("legacy");
    expect(legacy.textContent).toContain("A reason recorded before reasons were coded.");
    const summary = screen.getByText("Show the stored text");
    fireEvent.click(summary);
    expect(legacy.textContent).toContain("Blocked by a moderator by hand.");
  });
});
