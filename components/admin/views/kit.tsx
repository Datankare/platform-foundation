"use client";

/**
 * components/admin/views/kit.tsx — what the governance views share beyond the console's shared
 * parts (TASK-220)
 *
 *   useOutcomes   a view's outcome list: each change adds one, kept until dismissed;
 *   useNewKeys    the rows a read added since the read before (SF-admin-062: a new row was marked
 *                 only by a green background that went after a few seconds — colour only, and
 *                 gone) — marked "New" in words until the next read;
 *   NewBadge      that mark;
 *   useChange     one change at a time: run it on the governed path, add its outcome, read the
 *                 section again when it may have changed something.
 *
 * @module components/admin/views
 */

import React, { useCallback, useState } from "react";
import { renderMessage } from "@/platform/errors/messages";
import { OutcomeList, type OutcomeEntry } from "@/components/admin/ui/Outcome";
import {
  governedOutcome,
  type GovernedAnswer,
  type GovernedOutcomeMore,
} from "@/components/admin/ui/governed";
import { TONE } from "@/components/admin/ui/tokens";
import { adminCall } from "@/components/admin/ui/admin-call";
import { handleRefusal, type Refusal } from "@/platform/errors/refusal";
import { ReadFailed } from "@/components/admin/ui/PanelState";

export function useOutcomes(label: string) {
  const [outcomes, setOutcomes] = useState<OutcomeEntry[]>([]);
  const add = useCallback(
    (entry: OutcomeEntry) => setOutcomes((shown) => [...shown, entry]),
    []
  );
  const list = (
    <OutcomeList
      outcomes={outcomes}
      label={label}
      onDismiss={(id) => setOutcomes((shown) => shown.filter((o) => o.id !== id))}
    />
  );
  return { add, list, outcomes } as const;
}

/**
 * The keys a read added: `read` is the read's answer (a new object per read), `keys` its rows'.
 * The first read marks nothing; each later read marks the keys the read before it lacked, until
 * the read after.
 */
export function useNewKeys(read: unknown, keys: readonly string[]): ReadonlySet<string> {
  // State that follows a prop, adjusted during render (React's pattern), never in an effect.
  const [seen, setSeen] = useState<{
    read: unknown;
    keys: readonly string[];
    added: ReadonlySet<string>;
  }>(() => ({ read, keys, added: new Set() }));
  if (seen.read !== read) {
    const before = new Set(seen.keys);
    const added = new Set(keys.filter((k) => !before.has(k)));
    setSeen({ read, keys, added });
    return added;
  }
  return seen.added;
}

/** "New": a row the latest read added — in words, not colour alone (WCAG 2.2, 1.4.1). */
export function NewBadge() {
  return (
    <span
      data-new-row="true"
      className={`ml-2 inline-block rounded border px-1.5 py-0.5 text-xs ${TONE.applied}`}
    >
      {renderMessage("screens.admin_console.views.new_row")}
    </span>
  );
}

/**
 * One change at a time on a view: `run` sends it (runAdminAction / runConfigAction), its outcome
 * is added, and the section is read again when it may have changed (applied, or a lost commit).
 */
export function useChange(add: (entry: OutcomeEntry) => void, onReload?: () => void) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (
      send: () => Promise<GovernedAnswer>,
      what: string,
      more: GovernedOutcomeMore = {}
    ): Promise<GovernedAnswer> => {
      setBusy(true);
      const answer = await send();
      setBusy(false);
      add(governedOutcome(answer, what, more));
      if (answer.standing === "applied" || (answer.standing === "refused" && answer.lost))
        onReload?.();
      return answer;
    },
    [add, onReload]
  );
  return { busy, run } as const;
}

/** The permission finding an account by its address needs (the Users list's read). */
export const FIND_ACCOUNT_PERMISSION = "admin_manage_users";

/**
 * The account an address names, through the Users list's own search (POST — the address never
 * travels in a URL, TASK-215): found (its id), not found, or the search refused.
 */
export async function findAccountByAddress(
  address: string
): Promise<
  | { readonly found: true; readonly id: string; readonly email: string }
  | { readonly found: false; readonly refusal?: Refusal }
> {
  const wanted = address.trim().toLowerCase();
  const answer = await adminCall("/api/admin/users/search", {
    method: "POST",
    json: { q: wanted, limit: 25 },
  });
  if (!answer.ok) return { found: false, refusal: answer.refusal };
  const users = Array.isArray(answer.body.users) ? answer.body.users : [];
  for (const u of users as { id?: unknown; email?: unknown }[]) {
    if (
      typeof u.id === "string" &&
      typeof u.email === "string" &&
      u.email.toLowerCase() === wanted
    )
      return { found: true, id: u.id, email: u.email };
  }
  return { found: false };
}

/**
 * A read that succeeded but holds no list where one belongs (a body without it, or not a list):
 * said as a failed read — never as an empty list (review 14 L-1; E-4) — with Try again.
 */
export function ListUnreadable({
  panel,
  onRetry,
}: {
  readonly panel: string;
  readonly onRetry?: () => void;
}) {
  return (
    <ReadFailed
      panel={panel}
      refusal={handleRefusal(undefined, {
        message: renderMessage("screens.admin_console.views.not_a_list", { panel }),
      })}
      onRetry={onRetry}
    />
  );
}

/**
 * The element whose `attribute` is `value` — a row's own button, found again when its detail
 * closes (focus goes back to it). Compared as text, so no value needs escaping for a selector.
 */
export function elementWith(attribute: string, value: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[${attribute}]`))
    if (el.getAttribute(attribute) === value) return el;
  return null;
}
