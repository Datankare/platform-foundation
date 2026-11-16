"use client";

/**
 * components/admin/ui/Ref.tsx — a person, or a thing, where a screen used to show an id
 * (TASK-216, SCREEN-FINDINGS P8)
 *
 * Eleven places showed a hex id where a name belongs. A person is shown by name, else address,
 * else what they are ("an erased account") — components/admin/people.ts turns what the routes
 * send into those words — and the id is a detail: shown only while "Show details" is on.
 *
 * @module components/admin/ui
 */

import React from "react";
import { personText, type PersonRef as Person } from "@/components/admin/people";
import { TEXT } from "./tokens";

/** An id as a detail: nothing unless details are shown; then whole, wrapping. */
export function IdDetail({
  id,
  show,
}: {
  readonly id: string | null | undefined;
  readonly show: boolean;
}) {
  if (!show || !id) return null;
  return (
    <span className={`break-all font-mono text-xs ${TEXT.faint}`} data-id-detail="true">
      {id}
    </span>
  );
}

export function PersonRef({
  person,
  name,
  id,
  showId = false,
  withRole = false,
}: {
  /** The account as a route names it: its address (null once erased) and whether erased. */
  readonly person: Person | null | undefined;
  /** The account's display name, when the route sends one: shown first. */
  readonly name?: string | null;
  readonly id?: string | null;
  readonly showId?: boolean;
  readonly withRole?: boolean;
}) {
  const text = name?.trim() || personText(person, withRole);
  return (
    <span className="min-w-0 break-words" data-person="true">
      {text}
      {showId && id ? (
        <>
          {" "}
          <IdDetail id={id} show />
        </>
      ) : null}
    </span>
  );
}
