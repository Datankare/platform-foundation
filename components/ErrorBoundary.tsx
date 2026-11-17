"use client";

import React, { Component, ErrorInfo, ReactNode } from "react";
import { logger } from "@/lib/logger";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { ProblemPage } from "@/components/app/ui/ProblemPage";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.error_boundary.${key}`, values);

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Root-level error boundary — catches render errors in any child component.
 * Displays a user-friendly fallback instead of a white screen.
 * Logs the error via the structured logger.
 *
 * Control 5 / Standard 7: Resilience — predictable failure, never a white screen.
 */
export default class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    logger.error("React render error caught by ErrorBoundary", {
      error: error.message,
      route: "components/ErrorBoundary",
    });
    // Log component stack separately at debug level
    if (errorInfo.componentStack) {
      logger.debug("Component stack", {
        route: "components/ErrorBoundary",
      });
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // The one problem page (SF-app-004): what happened, Refresh page, and the way home — a
      // render error no longer leaves only a refresh.
      return (
        <div role="alert">
          <ProblemPage
            title={t("something_went_wrong")}
            body={t("an_unexpected_error_occurred_please")}
            onRetry={() => window.location.reload()}
            retryLabel={t("refresh_page")}
          />
        </div>
      );
    }

    return this.props.children;
  }
}
