/**
 * @jest-environment jsdom
 */
/**
 * Review 14 L-1 — an admin panel whose read was answered 503 says "unavailable — could not read",
 * never an empty list.
 *
 * The agent-registry and capability-mapping views showed "No agents registered" / "No mappings
 * configured" when the route answered 503 (the page dropped the failed read and the view read
 * nothing as empty), and the routes answered [] for a malformed stored value. Now the page keeps a
 * 503 as the PANEL_UNAVAILABLE marker and shows PanelUnavailable (catalog strings, a retry); the
 * two views tell "not read yet", "unavailable" and "empty" apart; and every state passes axe's
 * WCAG 2.2 AA rules. (The routes' 503 for a malformed value: __tests__/admin-thin-routes.test.ts.)
 */
import React from "react";
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
jest.mock("@/platform/auth/context", () => ({
  ...jest.requireActual("@/platform/auth/context"),
  useAuth: () => ({ signOut: jest.fn(async () => undefined) }),
}));

import AdminPage from "@/app/admin/page";
import {
  CapabilityMappingDataView,
  TrustedAgentsDataView,
} from "@/components/admin/AdminDataViews";
import {
  isPanelUnavailable,
  PANEL_UNAVAILABLE,
  PanelUnavailable,
} from "@/components/admin/PanelUnavailable";
import { renderMessage } from "@/platform/errors/messages";

// axe-core is installed with @axe-core/playwright (the e2e audits); here it runs in jsdom.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const axe = require("axe-core");

async function noViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag22aa"] },
    // jsdom has no layout or canvas: contrast is the e2e audit's.
    rules: { "color-contrast": { enabled: false } },
  });
  expect(results.violations.map((v: { id: string }) => v.id)).toEqual([]);
}

const UNAVAILABLE = renderMessage("screens.admin_console.unavailable_title");

describe("PanelUnavailable", () => {
  it("says the panel could not be read — from the catalog — and offers a retry", async () => {
    const onRetry = jest.fn();
    const { container } = render(
      <PanelUnavailable panel="Trusted agents" onRetry={onRetry} />
    );
    expect(screen.getByRole("alert")).toHaveTextContent(UNAVAILABLE);
    expect(UNAVAILABLE).toBe("Unavailable — could not read");
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Trusted agents could not be read just now.*not an empty list/
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Try reading Trusted agents again" })
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
    await noViolations(container);
  });
  it("without a retry, no button", () => {
    render(<PanelUnavailable panel="X" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("isPanelUnavailable recognises only the marker", () => {
    expect(isPanelUnavailable(PANEL_UNAVAILABLE)).toBe(true);
    for (const v of [
      undefined,
      null,
      {},
      { agents: [] },
      "unavailable",
      { unavailable: "yes" },
    ])
      expect(isPanelUnavailable(v)).toBe(false);
  });
});

describe.each([
  [
    "TrustedAgentsDataView",
    TrustedAgentsDataView,
    "agents",
    "No agents registered.",
    [["agent:a", { owner: "o", scopes: ["s"], status: "active" }]],
    "agent:a",
  ],
  [
    "CapabilityMappingDataView",
    CapabilityMappingDataView,
    "mappings",
    "No mappings configured.",
    [["summarize", ["translate"]]],
    "summarize",
  ],
] as const)("%s", (_name, View, field, emptyText, rows, shown) => {
  it("not read yet: loading — never 'none'", () => {
    render(<View data={undefined} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText(emptyText)).toBeNull();
  });
  it.each([
    ["answered 503", PANEL_UNAVAILABLE],
    ["a body without the list", {}],
    ["the list not a list", { [field]: "x" }],
    ["null", null],
  ])("%s: unavailable — never 'none'", async (_label, data) => {
    const { container } = render(<View data={data} />);
    expect(screen.getByRole("alert")).toHaveTextContent(UNAVAILABLE);
    expect(screen.queryByText(emptyText)).toBeNull();
    await noViolations(container);
  });
  it("an empty list: 'none', from the catalog", async () => {
    const { container } = render(<View data={{ [field]: [] }} />);
    expect(screen.getByText(emptyText)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    await noViolations(container);
  });
  it("a list: its rows", async () => {
    const { container } = render(<View data={{ [field]: rows }} />);
    expect(screen.getByText(shown)).toBeInTheDocument();
    await noViolations(container);
  });
});

describe("the admin console keeps a 503 as 'unavailable'", () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("the first panel is read at once; its 503 is shown as unavailable, and a retry reads it again", async () => {
    let usersStatus = 503;
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/api/admin/session")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ roleName: "super_admin", permissions: ["*"] }),
        };
      }
      if (u.includes("/api/admin/users")) {
        return usersStatus === 503
          ? {
              ok: false,
              status: 503,
              json: async () => ({ code: "service.unavailable" }),
            }
          : { ok: true, status: 200, json: async () => ({ users: [] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    render(<AdminPage />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(UNAVAILABLE));
    usersStatus = 200;
    fireEvent.click(screen.getByRole("button", { name: /^Try reading .* again$/ }));
    await waitFor(() => expect(screen.queryByText(UNAVAILABLE)).toBeNull());
    expect(
      fetchMock.mock.calls.filter(([u]) => String(u).includes("/api/admin/users")).length
    ).toBe(2);
  });
});
