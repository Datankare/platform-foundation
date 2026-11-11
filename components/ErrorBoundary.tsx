"use client";

import React, { Component, ErrorInfo, ReactNode } from "react";
import { logger } from "@/lib/logger";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";

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

      return (
        <div
          role="alert"
          aria-live="assertive"
          className="min-h-screen flex items-center justify-center bg-[#0a0f1e] text-slate-200 font-sans p-8 text-center"
        >
          <div>
            <h1 className="text-2xl font-bold mb-2">{t("something_went_wrong")}</h1>
            <p className="text-slate-400 mb-6">
              {t("an_unexpected_error_occurred_please")}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-6 py-2 bg-blue-700 text-white border-0 rounded-lg cursor-pointer text-sm"
            >
              {t("refresh_page")}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
