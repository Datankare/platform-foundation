"use client";

/**
 * app/global-error.tsx — the root layout itself failed (TASK-224, SF-app-004)
 *
 * The last resort: it replaces the layout, so it writes its own html and body. The same page as
 * every other failure, with "Try again" and the way home.
 */

import { useEffect } from "react";
import { ProblemPage } from "@/components/app/ui/ProblemPage";
import { renderMessage } from "@/platform/errors/messages";
import { logger } from "@/lib/logger";
import "./globals.css";

export default function GlobalError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}) {
  useEffect(() => {
    logger.error("The app's layout failed to render", {
      error: error.message,
      route: "app/global-error",
    });
  }, [error]);
  return (
    <html lang="en">
      <body>
        <ProblemPage
          title={renderMessage("screens.error_boundary.something_went_wrong")}
          body={renderMessage("screens.error_boundary.page_failed")}
          onRetry={reset}
        />
      </body>
    </html>
  );
}
