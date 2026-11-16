/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SsoButtons from "@/components/auth/SsoButtons";
import AuthLayout from "@/components/auth/AuthLayout";
import { say } from "@/__tests__/helpers/auth-screen";

describe("SsoButtons", () => {
  const mockOnSsoClick = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const ALL = ["google", "apple", "microsoft"] as const;

  it("renders no provider by default — only configured ones are offered (ADR-050 D3)", () => {
    render(<SsoButtons onSsoClick={mockOnSsoClick} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("renders every provider it is given", () => {
    render(<SsoButtons onSsoClick={mockOnSsoClick} enabledProviders={[...ALL]} />);
    for (const p of ALL)
      expect(screen.getByText(say(`sso.continue_with_${p}`))).toBeDefined();
  });

  it("SF-app-047: each provider's mark is drawn, never a private-use character a font may not have", () => {
    const { container } = render(
      <SsoButtons onSsoClick={mockOnSsoClick} enabledProviders={[...ALL]} />
    );
    for (const p of ALL) {
      const mark = container.querySelector(`svg[data-provider-mark="${p}"]`);
      expect(mark).not.toBeNull();
      expect(mark?.getAttribute("aria-hidden")).toBe("true");
    }
    // No character from the Unicode private-use area (U+E000–U+F8FF) anywhere in the buttons.
    const privateUse = [...(container.textContent ?? "")].filter((c) => {
      const cp = c.codePointAt(0)!;
      return cp >= 0xe000 && cp <= 0xf8ff;
    });
    expect(privateUse).toEqual([]);
    // Each button is named by its words alone.
    expect(
      screen.getByRole("button", { name: say("sso.continue_with_apple") })
    ).toBeDefined();
  });

  it("renders only enabled providers", () => {
    render(<SsoButtons onSsoClick={mockOnSsoClick} enabledProviders={["google"]} />);
    expect(screen.getByText(say("sso.continue_with_google"))).toBeDefined();
    expect(screen.queryByText(say("sso.continue_with_apple"))).toBeNull();
    expect(screen.queryByText(say("sso.continue_with_microsoft"))).toBeNull();
  });

  it("calls onSsoClick with provider id, and never submits a form it sits in", async () => {
    const onSubmit = jest.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <SsoButtons onSsoClick={mockOnSsoClick} enabledProviders={["google"]} />
      </form>
    );
    fireEvent.click(screen.getByText(say("sso.continue_with_google")));
    await waitFor(() => expect(mockOnSsoClick).toHaveBeenCalledWith("google"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows connecting state while loading", async () => {
    let resolveClick: () => void;
    const slowClick = jest.fn(
      () =>
        new Promise<void>((r) => {
          resolveClick = r;
        })
    );
    render(<SsoButtons onSsoClick={slowClick} enabledProviders={["google"]} />);
    fireEvent.click(screen.getByText(say("sso.continue_with_google")));
    await waitFor(() => expect(screen.getByText(say("sso.connecting"))).toBeDefined());
    resolveClick!();
    await waitFor(() =>
      expect(screen.getByText(say("sso.continue_with_google"))).toBeDefined()
    );
  });

  it("disables all buttons when disabled prop is true", () => {
    render(
      <SsoButtons
        onSsoClick={mockOnSsoClick}
        disabled={true}
        enabledProviders={[...ALL]}
      />
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);
    buttons.forEach((button) => expect(button.getAttribute("disabled")).not.toBeNull());
  });
});

describe("AuthLayout", () => {
  it("renders children inside the page's main landmark (SF-app-051)", () => {
    render(
      <AuthLayout>
        <div>Test content</div>
      </AuthLayout>
    );
    expect(screen.getByRole("main").textContent).toContain("Test content");
  });

  it("SF-app-051: the brand is two catalogue parts, read as one word", () => {
    render(
      <AuthLayout>
        <div>Content</div>
      </AuthLayout>
    );
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe(say("layout.brand_first") + say("layout.brand_second"));
    expect(screen.getByText(say("layout.brand_second")).className).toMatch(
      /text-blue-400/
    );
  });

  it("E-110: no internal tagline — the code base's names are not shown to a person signing in", () => {
    const { container } = render(
      <AuthLayout>
        <div>Content</div>
      </AuthLayout>
    );
    expect(container.textContent).not.toMatch(
      /Platform Foundation|Foundation as Fabric|Continuous Confidence/
    );
  });
});
