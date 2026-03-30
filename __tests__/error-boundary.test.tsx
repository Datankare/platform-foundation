/**
 * @jest-environment jsdom
 */
/**
 * ErrorBoundary component tests.
 *
 * Verifies:
 * - Renders children normally when no error
 * - Catches render errors and shows fallback UI
 * - Custom fallback prop is used when provided
 * - Logs errors via the structured logger
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import ErrorBoundary from "@/components/ErrorBoundary";

// Mock the logger
jest.mock("@/lib/logger", () => ({
  logger: {
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { logger } from "@/lib/logger";

// Component that throws during render
function ThrowingComponent({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error("Test render error");
  }
  return <div>Normal content</div>;
}

// Suppress console.error for expected errors in tests
const originalConsoleError = console.error;
beforeAll(() => {
  console.error = jest.fn();
});
afterAll(() => {
  console.error = originalConsoleError;
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("ErrorBoundary", () => {
  it("renders children when no error occurs", () => {
    render(
      <ErrorBoundary>
        <div>Hello world</div>
      </ErrorBoundary>
    );

    expect(screen.getByText("Hello world")).toBeDefined();
  });

  it("renders default fallback when child throws", () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText("Something went wrong")).toBeDefined();
    expect(
      screen.getByText("An unexpected error occurred. Please refresh the page.")
    ).toBeDefined();
    expect(screen.getByText("Refresh Page")).toBeDefined();
  });

  it("renders custom fallback when provided", () => {
    render(
      <ErrorBoundary fallback={<div>Custom error message</div>}>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText("Custom error message")).toBeDefined();
  });

  it("logs the error via structured logger", () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(logger.error).toHaveBeenCalledWith(
      "React render error caught by ErrorBoundary",
      expect.objectContaining({
        error: "Test render error",
        route: "components/ErrorBoundary",
      })
    );
  });

  it("has role=alert on fallback for accessibility", () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByRole("alert")).toBeDefined();
  });
});
