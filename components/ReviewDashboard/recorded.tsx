/**
 * components/ReviewDashboard/recorded.tsx — a recorded moderation reason as a moderator reads it
 * (TASK-209)
 */
import React from "react";
import { renderShown, shown, type ShownText } from "@/platform/errors/shown-text";
import { recordedFactor } from "@/platform/moderation/reasons";
import { StoredText } from "@/components/admin/ui/Stored";

/**
 * A recorded reason as a moderator reads it (TASK-209): the catalog's words, or — for a record
 * from before the keys — the catalog's note that it predates them, its stored text behind a
 * disclosure (the evidence, never the screen's words; as a job's uncoded failure, N-108).
 */
export function Recorded({
  text,
  stored,
}: {
  readonly text: string;
  readonly stored?: string;
}) {
  if (stored === undefined) return <>{text}</>;
  return (
    <>
      {text}{" "}
      <StoredText
        text={stored}
        show={renderShown(shown("screens.moderation.legacy.show"))}
      />
    </>
  );
}

/** A chain's description or conclusion: a key's words, or a text recorded before (Recorded). */
export function shownOrStored(value: ShownText | string): {
  text: string;
  stored?: string;
} {
  return typeof value === "string" ? recordedFactor(value) : { text: renderShown(value) };
}
