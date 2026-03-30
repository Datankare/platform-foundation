/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SsoButtons from "@/components/auth/SsoButtons";
import AuthLayout from "@/components/auth/AuthLayout";

describe("SsoButtons", () => {
  const mockOnSsoClick = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders all three provider buttons by default", () => {
    render(<SsoButtons onSsoClick={mockOnSsoClick} />);
    expect(screen.getByText("Continue with Google")).toBeDefined();
    expect(screen.getByText("Continue with Apple")).toBeDefined();
    expect(screen.getByText("Continue with Microsoft")).toBeDefined();
  });

  it("renders only enabled providers", () => {
    render(<SsoButtons onSsoClick={mockOnSsoClick} enabledProviders={["google"]} />);
    expect(screen.getByText("Continue with Google")).toBeDefined();
    expect(screen.queryByText("Continue with Apple")).toBeNull();
    expect(screen.queryByText("Continue with Microsoft")).toBeNull();
  });

  it("calls onSsoClick with provider id", async () => {
    render(<SsoButtons onSsoClick={mockOnSsoClick} />);
    fireEvent.click(screen.getByText("Continue with Google"));

    await waitFor(() => {
      expect(mockOnSsoClick).toHaveBeenCalledWith("google");
    });
  });

  it("shows connecting state while loading", async () => {
    let resolveClick: () => void;
    const slowClick = jest.fn(
      () =>
        new Promise<void>((r) => {
          resolveClick = r;
        })
    );
    render(<SsoButtons onSsoClick={slowClick} />);
    fireEvent.click(screen.getByText("Continue with Google"));

    await waitFor(() => {
      expect(screen.getByText("Connecting...")).toBeDefined();
    });

    resolveClick!();
    await waitFor(() => {
      expect(screen.getByText("Continue with Google")).toBeDefined();
    });
  });

  it("disables all buttons when disabled prop is true", () => {
    render(<SsoButtons onSsoClick={mockOnSsoClick} disabled={true} />);
    const buttons = screen.getAllByRole("button");
    buttons.forEach((button) => {
      expect(button.getAttribute("disabled")).not.toBeNull();
    });
  });
});

describe("AuthLayout", () => {
  it("renders children inside the layout", () => {
    render(
      <AuthLayout>
        <div>Test content</div>
      </AuthLayout>
    );
    expect(screen.getByText("Test content")).toBeDefined();
  });

  it("renders PLAYFORM title by default", () => {
    render(
      <AuthLayout>
        <div>Content</div>
      </AuthLayout>
    );
    expect(screen.getByText("PLAY")).toBeDefined();
    expect(screen.getByText("FORM")).toBeDefined();
  });

  it("renders custom title", () => {
    render(
      <AuthLayout title="MY APP">
        <div>Content</div>
      </AuthLayout>
    );
    expect(screen.getByText("MY APP")).toBeDefined();
  });

  it("renders subtitle", () => {
    render(
      <AuthLayout subtitle="Custom Subtitle">
        <div>Content</div>
      </AuthLayout>
    );
    expect(screen.getByText("Custom Subtitle")).toBeDefined();
  });

  it("renders footer tagline", () => {
    render(
      <AuthLayout>
        <div>Content</div>
      </AuthLayout>
    );
    expect(
      screen.getByText("Foundation as Fabric · Continuous Confidence")
    ).toBeDefined();
  });
});
