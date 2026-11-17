"use client";

/**
 * components/app/ui/ProblemPage.tsx — the one page for "this is not here" and "this went wrong"
 * (TASK-224, SF-app-004)
 *
 * An unknown address showed the framework's own English 404 on a white page; a page that failed
 * to render was replaced by "Refresh page" and nothing else — no way home. One dark page for
 * every such case (app/not-found.tsx, app/error.tsx, app/global-error.tsx and the root error
 * boundary): its heading, what happened in a sentence, and what can be done — try again where
 * trying again can help, and always the home page.
 *
 * @module components/app/ui
 */

import React from "react";
import { renderMessage } from "@/platform/errors/messages";
import { BUTTON, SURFACE, TEXT } from "@/components/admin/ui/tokens";

export function ProblemPage({
  title,
  body,
  onRetry,
  retryLabel,
}: {
  readonly title: string;
  readonly body: string;
  /** Offered only where trying again can help (a render that failed). */
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
}) {
  return (
    <main
      className={`flex min-h-screen items-center justify-center px-4 py-10 ${SURFACE.page}`}
    >
      <div className={`w-full max-w-md p-6 text-center ${SURFACE.panel}`}>
        <h1 className={`mb-2 text-2xl font-bold ${TEXT.strong}`}>{title}</h1>
        <p className={`mb-6 text-sm ${TEXT.quiet}`}>{body}</p>
        <div className="flex flex-wrap justify-center gap-2">
          {onRetry ? (
            <button type="button" onClick={onRetry} className={BUTTON.primary}>
              {retryLabel ?? renderMessage("screens.error_boundary.try_again")}
            </button>
          ) : null}
          {/* A full navigation: the app's state may be what failed. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full load, never the client router: the state that failed is left behind */}
          <a href="/" className={onRetry ? BUTTON.quiet : BUTTON.primary}>
            {renderMessage("screens.error_boundary.home")}
          </a>
        </div>
      </div>
    </main>
  );
}
