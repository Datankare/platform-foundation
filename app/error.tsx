"use client";

/**
 * app/error.tsx — a page that failed to render (TASK-224, SF-app-004)
 *
 * Shown in place of the page (the layout, and so the session, stays): what happened, "Try again"
 * (the framework renders the page again) and the way home. The error is logged as the root error
 * boundary logs it — its message, never the page's data.
 */

import { useEffect } from "react";
import { ProblemPage } from "@/components/app/ui/ProblemPage";
import { renderMessage } from "@/platform/errors/messages";
import { logger } from "@/lib/logger";

export default function PageError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}) {
  useEffect(() => {
    logger.error("A page failed to render", {
      error: error.message,
      route: "app/error",
    });
  }, [error]);
  return (
    <ProblemPage
      title={renderMessage("screens.error_boundary.something_went_wrong")}
      body={renderMessage("screens.error_boundary.page_failed")}
      onRetry={reset}
    />
  );
}
