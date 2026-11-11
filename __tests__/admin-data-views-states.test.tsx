/**
 * @jest-environment jsdom
 */

/**
 * TASK-204 (N-41): the admin console's read views, now inside coverage — the states the section
 * tests did not reach: a role or group that arrives while the view is open is marked, then not;
 * a blocked account and its blocker by address (an id only when no account is named); the approval
 * policy with no policy, no rules and rules; the capabilities and their mapping, each with nothing,
 * something, not read yet and not readable.
 */

import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  ApprovalPolicyDataView,
  AuditDataView,
  CapabilitiesDataView,
  CapabilityMappingDataView,
  EntitlementsDataView,
  PasswordPolicyDataView,
  PerAccountRestrictionsDataView,
  RolesDataView,
} from "@/components/admin/AdminDataViews";
import { renderMessage } from "@/platform/errors/messages";
import { ADMIN_HIGHLIGHT_DURATION_SECONDS } from "@/shared/config/limits";

const pa = (key: string) => renderMessage(`screens.admin_console.per_account.${key}`);

describe("a row that arrives while the view is open", () => {
  afterEach(() => jest.useRealTimers());

  const role = (id: string) => ({
    id,
    name: id,
    displayName: id.toUpperCase(),
    permissions: [],
    createdAt: "2026-10-29T14:05:00.000Z",
    updatedAt: "2026-10-29T14:05:00.000Z",
  });

  it("is marked for the highlight's time, the rows already there are not", () => {
    jest.useFakeTimers();
    const { rerender } = render(<RolesDataView data={{ roles: [role("a")] }} />);
    const rowOf = (text: string) => screen.getByText(text).closest("tr") as HTMLElement;
    expect(rowOf("A").className).not.toContain("bg-green-900/30");
    // The same rows again: nothing new.
    rerender(<RolesDataView data={{ roles: [role("a")] }} />);
    expect(rowOf("A").className).not.toContain("bg-green-900/30");
    rerender(<RolesDataView data={{ roles: [role("a"), role("b")] }} />);
    expect(rowOf("B").className).toContain("bg-green-900/30");
    expect(rowOf("A").className).not.toContain("bg-green-900/30");
    act(() => {
      jest.advanceTimersByTime(ADMIN_HIGHLIGHT_DURATION_SECONDS * 1000);
    });
    expect(rowOf("B").className).not.toContain("bg-green-900/30");
    // A row removed: nothing to mark.
    rerender(<RolesDataView data={{ roles: [role("b")] }} />);
    expect(rowOf("B").className).not.toContain("bg-green-900/30");
  });

  it("an entitlement group too", () => {
    jest.useFakeTimers();
    const group = (id: string) => ({
      id,
      code: id,
      displayName: `Group ${id}`,
      permissions: [],
    });
    const { container, rerender } = render(
      <EntitlementsDataView data={{ groups: [group("g1")] }} />
    );
    expect(container.querySelectorAll(".bg-green-900\\/30")).toHaveLength(0);
    rerender(<EntitlementsDataView data={{ groups: [group("g1"), group("g2")] }} />);
    expect(container.querySelectorAll(".bg-green-900\\/30")).toHaveLength(1);
  });
});

describe("PerAccountRestrictionsDataView", () => {
  it("nothing blocked: says so", () => {
    render(<PerAccountRestrictionsDataView data={{ restrictions: [] }} />);
    expect(screen.getByText(pa("empty"))).toBeDefined();
    render(<PerAccountRestrictionsDataView data={null} />);
    expect(screen.getAllByText(pa("empty"))).toHaveLength(2);
  });

  it("[hostile] the account and who blocked it by address; an id only when no account is named", () => {
    render(
      <PerAccountRestrictionsDataView
        data={{
          restrictions: [
            {
              user_id: "u-1",
              user: { email: "leaver@example.test" },
              feature: "can_translate",
              reason: "Repeated abuse of the feature",
              created_by: "a-1",
              created_by_account: { email: "admin@example.test", role: "admin" },
            },
            {
              user_id: "u-2",
              user: null,
              feature: "can_play",
              reason: null,
              created_by: null,
              created_by_account: null,
            },
          ],
        }}
      />
    );
    expect(screen.getByText(/leaver@example\.test/)).toBeDefined();
    expect(screen.getByText(/admin@example\.test/)).toBeDefined();
    expect(screen.queryByText(/\bu-1\b|\ba-1\b/)).toBeNull();
    expect(
      screen.getByText(renderMessage("screens.admin_console.people.id", { id: "u-2" }))
    ).toBeDefined();
    // No reason, and no blocker named: each cell says none.
    expect(pa("none")).toBe(renderMessage("screens.admin_console.audit.none"));
    expect(screen.getAllByText(pa("none"))).toHaveLength(2);
  });
});

describe("ApprovalPolicyDataView", () => {
  it("no policy read", () => {
    render(<ApprovalPolicyDataView data={{}} />);
    expect(screen.getByText("No policy loaded.")).toBeDefined();
  });

  it("a policy with no rules: the default approver handles every action", () => {
    render(
      <ApprovalPolicyDataView data={{ policy: { version: 3, default: "admin" } }} />
    );
    expect(screen.getByText(/Version 3/)).toBeDefined();
    expect(screen.getByText("admin")).toBeDefined();
    expect(screen.getByText(/No rules/)).toBeDefined();
  });

  it("its rules, an empty effect list read as any", () => {
    render(
      <ApprovalPolicyDataView
        data={{
          policy: {
            version: 4,
            default: "admin",
            rules: [
              {
                maxRisk: "low",
                effects: ["stateWrite", "external"],
                requiredApprover: "user",
              },
              { maxRisk: "high", requiredApprover: "super_admin" },
            ],
          },
        }}
      />
    );
    expect(screen.getByText("stateWrite, external")).toBeDefined();
    expect(screen.getByText("any")).toBeDefined();
    expect(screen.getByText("super_admin")).toBeDefined();
  });
});

describe("CapabilitiesDataView", () => {
  it("none registered", () => {
    render(<CapabilitiesDataView data={{ goals: "x" }} />);
    expect(screen.getByText("No capabilities registered.")).toBeDefined();
  });

  it("each goal's steps, cost and requirement; a missing one as a dash", () => {
    render(
      <CapabilitiesDataView
        data={{
          goals: [
            {
              goal: "translate",
              endpoint: "/api/process",
              steps: [{ intent: "detect" }, { intent: "translate" }],
              estimatedCostUSD: 0.0123,
              requiredCapability: "can_translate",
            },
            { goal: "noop", endpoint: "/api/noop" },
          ],
        }}
      />
    );
    expect(screen.getByText("detect → translate")).toBeDefined();
    expect(screen.getByText("$0.0123")).toBeDefined();
    expect(screen.getByText("$0.0000")).toBeDefined();
    expect(screen.getByText("can_translate")).toBeDefined();
    expect(screen.getByText("—")).toBeDefined();
  });
});

describe("CapabilityMappingDataView", () => {
  it("not read yet is loading, not readable is unavailable — never 'no mappings'", () => {
    const none = renderMessage("screens.admin_console.no_mappings");
    const { rerender } = render(<CapabilityMappingDataView data={undefined} />);
    expect(
      screen.getByText(renderMessage("screens.admin_console.loading"))
    ).toBeDefined();
    expect(screen.queryByText(none)).toBeNull();
    rerender(<CapabilityMappingDataView data={{ mappings: "x" }} />);
    expect(screen.queryByText(none)).toBeNull();
    rerender(<CapabilityMappingDataView data={{ mappings: [] }} />);
    expect(screen.getByText(none)).toBeDefined();
  });

  it("each capability and its features", () => {
    render(
      <CapabilityMappingDataView
        data={{
          mappings: [
            ["translate", ["can_translate", "can_play"]],
            ["empty", null],
          ],
        }}
      />
    );
    expect(screen.getByText("can_translate, can_play")).toBeDefined();
    expect(screen.getByText("empty")).toBeDefined();
  });
});

describe("the views with nothing read, and the rest of their rows", () => {
  it("each says what it has when its data is missing — never a crash, never a stale row", () => {
    render(<RolesDataView data={null} />);
    expect(screen.getByText(/No roles found/)).toBeDefined();
    render(<AuditDataView data={null} />);
    expect(
      screen.getByText(renderMessage("screens.admin_console.audit.empty"))
    ).toBeDefined();
    render(<PasswordPolicyDataView data={undefined} />);
    expect(screen.getByText("Loading...")).toBeDefined();
    render(<ApprovalPolicyDataView data={undefined} />);
    expect(screen.getByText("No policy loaded.")).toBeDefined();
    render(<CapabilitiesDataView data={undefined} />);
    expect(screen.getByText("No capabilities registered.")).toBeDefined();
    const { container } = render(<EntitlementsDataView data={undefined} />);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(0);
  });

  it("an audit row: the actor by address, the target by id when it names no account, no details as empty", () => {
    render(
      <AuditDataView
        data={{
          entries: [
            {
              id: "e1",
              createdAt: "2026-10-29T14:05:00.000Z",
              action: "admin_action",
              actor: { email: "admin@example.test", role: "admin" },
              actorId: "a-1",
              target: null,
              targetId: "jobs.config.x",
            },
          ],
        }}
      />
    );
    expect(screen.getByText(/admin@example\.test/)).toBeDefined();
    expect(
      screen.getByText(
        renderMessage("screens.admin_console.people.id", { id: "jobs.config.x" })
      )
    ).toBeDefined();
    expect(screen.queryByText(/\ba-1\b/)).toBeNull();
  });

  it("the password policy: numbers as numbers, each requirement as a mark", () => {
    render(
      <PasswordPolicyDataView
        data={{
          policy: {
            minLength: 12,
            rotationDays: 90,
            passwordHistoryCount: 5,
            requireUppercase: true,
            requireLowercase: false,
            requireNumber: true,
            requireSpecial: false,
          },
        }}
      />
    );
    expect(screen.getByText("12")).toBeDefined();
    expect(screen.getAllByText("✓")).toHaveLength(2);
    expect(screen.getAllByText("✕")).toHaveLength(2);
  });

  it("a role opened: its description; a role with no display name is named by its name", () => {
    render(
      <RolesDataView
        data={{
          roles: [
            {
              id: "r1",
              name: "reviewer",
              permissionCount: "3",
              description: "Reads the review queue",
              createdAt: null,
              updatedAt: null,
            },
          ],
        }}
      />
    );
    const toggle = screen.getByRole("button", {
      name: renderMessage("screens.admin_console.roles.permissions_toggle", {
        count: 3,
        role: "reviewer",
      }),
    });
    fireEvent.click(toggle);
    expect(screen.getByText("Reads the review queue")).toBeDefined();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});
