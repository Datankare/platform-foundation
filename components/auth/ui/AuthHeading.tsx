"use client";

/**
 * components/auth/ui/AuthHeading.tsx — a sign-in step's heading, which takes focus when the step
 * opens (TASK-222, SF-app-041)
 *
 * Moving from sign-in to "Create account", to a reset code, to two-step verification replaced
 * the card's content while focus stayed on a button that was gone: a screen-reader user heard
 * nothing of the new step, and a keyboard user started again from the top of the page. Every
 * step's heading is an AuthHeading: when the page has moved to a step (not on the page's first
 * load, which leaves focus where the browser puts it), the heading takes focus on mount, so the
 * step's name is read and Tab continues inside it.
 *
 * @module components/auth/ui
 */

import React, { createContext, useContext, useEffect, useRef } from "react";
import { AUTH_HEADING } from "./styles";

/** True once the page has moved to another step: a step's heading then takes focus. */
export const StepMoved = createContext(false);

export function AuthHeading({ children }: { readonly children: React.ReactNode }) {
  const moved = useContext(StepMoved);
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (moved) ref.current?.focus();
  }, [moved]);
  return (
    <h2 ref={ref} tabIndex={-1} data-auth-heading="" className={AUTH_HEADING}>
      {children}
    </h2>
  );
}
