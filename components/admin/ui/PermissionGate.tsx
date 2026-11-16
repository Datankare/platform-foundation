"use client";

/**
 * components/admin/ui/PermissionGate.tsx — a control the server would refuse is not offered, or
 * is shown disabled with the reason (TASK-216; SECOND-WAVE-STATUS S7 "Permission gating")
 *
 * Screens offered buttons to admins the route refuses: Approve to the requester, a dual-control
 * change to someone without the safety tier. One gate, two honest answers:
 *
 *   allowed            the control;
 *   refused, a reason  the control disabled, with the reason beside it and tied to it
 *                      (aria-describedby) — for a control a person expects to find, so they
 *                      learn why it is not theirs;
 *   refused, none      nothing: the control is not rendered.
 *
 * Display only. The route checks the permission itself whatever this shows.
 *
 * @module components/admin/ui
 */

import React, { useId } from "react";
import { renderMessage } from "@/platform/errors/messages";
import { permissionLabel } from "./labels";
import { TEXT } from "./tokens";

/** "Needs the permission “Manage users”." — by the permission's name, never its code. */
export function needsPermission(code: string): string {
  return renderMessage("screens.admin_console.ui.gate.needs_permission", {
    permission: permissionLabel(code),
  });
}

export function GatedButton({
  allowed,
  reason,
  children,
  ...button
}: Omit<React.ComponentProps<"button">, "type"> & {
  readonly allowed: boolean;
  /** Why it is refused, in words; none: the control is not shown at all. */
  readonly reason?: string | null;
}) {
  const id = useId();
  if (allowed)
    return (
      <button type="button" {...button}>
        {children}
      </button>
    );
  if (!reason) return null;
  return (
    <span className="inline-flex min-w-0 flex-col gap-1" data-gated="true">
      <button
        type="button"
        {...button}
        disabled
        aria-describedby={id}
        onClick={undefined}
      >
        {children}
      </button>
      <span id={id} className={`text-xs ${TEXT.faint}`}>
        {reason}
      </span>
    </span>
  );
}
