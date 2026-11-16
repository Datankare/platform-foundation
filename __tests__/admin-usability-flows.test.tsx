/**
 * @jest-environment jsdom
 */
/**
 * __tests__/admin-usability-flows.test.tsx — the rest of each fixed screen's flows (TASK-202):
 * every state a person can meet on Approvals, Trusted agents, Erasures and Platform config — the
 * words for each kind of held change, each answer a decision gets, an edit, a suspension, an
 * attestation approved or refused, an unreadable list. Fetch is answered from the route fixtures
 * (__tests__/fixtures/route-responses), never a body written here; the panels' data are the
 * fixtures' bodies, varied where a state needs it.
 */
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { routeAnswer, type RouteFixtureName } from "./fixtures/route-responses";
import { renderMessage } from "@/platform/errors/messages";
import type { PendingApproval } from "@/platform/admin/pending-approvals";

const mockApiFetch = jest.fn();
jest.mock("@/platform/auth/api-fetch", () => ({
  apiFetch: (...a: unknown[]) => mockApiFetch(...a),
}));

import {
  acceptedResult,
  approverText,
  ChangeDiff,
  describeWhat,
  HeldActionsPanel,
  requesterText,
  summaryLines,
  whyHeld,
} from "@/components/admin/HeldActionsPanel";
import { ErasuresPanel } from "@/components/admin/ErasuresPanel";
import { PANEL_UNAVAILABLE } from "@/components/admin/PanelUnavailable";
import { shown } from "@/platform/errors/shown-text";
import { permissionLabel } from "@/components/admin/ui/labels";

function reply(name: RouteFixtureName) {
  const [status, body] = routeAnswer(name);
  const res = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone: () => res,
    headers: { get: () => "application/json" },
  };
  return res as unknown as Response;
}
const bodyOf = <T,>(name: RouteFixtureName) => routeAnswer(name)[1] as T;
const held = (key: string, v?: Record<string, string | number>) =>
  renderMessage(`screens.held.${key}`, v);

beforeEach(() => mockApiFetch.mockReset());

/** A hold as the listing gives it, varied per case. */
const base: PendingApproval = {
  source: "runtime",
  id: "h-1",
  label: "change_user_role",
  requester: "00000000-0000-4000-9000-000000000001",
  requiredPermission: "admin_manage_users",
  reason: shown("screens.held.reason_held", {
    risk: "restricted",
    effects: [],
    effected: "no",
  }),
  createdAt: "2026-01-01T00:00:00.000Z",
};
const target = { id: "u-1", email: "member@example.test" };

describe("Approvals: each kind of held change in words (N-61)", () => {
  it.each([
    [
      { label: "change_user_role", summary: { target } },
      held("what_role_change", { account: "member@example.test" }),
    ],
    [
      { label: "purge_user_data", summary: { target } },
      held("what_erasure", { account: "member@example.test", known: "true" }),
    ],
    [
      { label: "block_user_feature", summary: { target, feature: "translate" } },
      held("what_block", { account: "member@example.test", feature: "Translate" }),
    ],
    [
      {
        label: "unblock_user_feature",
        summary: { target: { notFound: true as const }, feature: "translate" },
      },
      held("what_unblock", { account: held("account_missing"), feature: "Translate" }),
    ],
    [
      { label: "create_role", summary: { role: "qa" } },
      held("what_create_role", { role: "Qa" }),
    ],
    [
      { label: "delete_role", summary: { role: "qa" } },
      held("what_delete_role", { role: "Qa" }),
    ],
    [
      { label: "duplicate_role", summary: { role: "qa2", fromRole: "qa" } },
      held("what_duplicate_role", { role: "Qa2", from: "Qa" }),
    ],
    [
      { label: "assign_permissions", summary: { role: "qa" } },
      held("what_assign_permissions", { role: "Qa" }),
    ],
    [
      { label: "create_entitlement_group", summary: { group: "pro" } },
      held("what_create_group", { group: "pro" }),
    ],
    [
      { label: "set_entitlement_group_active", summary: { group: "pro", active: false } },
      held("what_group_active", { group: "pro", active: "false" }),
    ],
    [{ label: "set_approval_policy" }, held("what_policy")],
    // A setting by its name (TASK-220, SF-admin-031): "moderation.strike_ban_threshold" →
    // "Moderation: strike ban threshold".
    [
      { label: "update_config", configKey: "moderation.strike_ban_threshold" },
      held("what_config", { key: "Moderation: strike ban threshold" }),
    ],
    [
      {
        label: "reset_config",
        change: { key: "k", action: "reset" as const, before: 1, after: 2 },
      },
      held("what_config_reset", { key: "K" }),
    ],
    // Without the details (a viewer who may not decide): the kind of change, in words.
    [
      { label: "change_user_role" },
      renderMessage("screens.admin_console.tools.change_user_role"),
    ],
    [
      { label: "purge_user_data" },
      renderMessage("screens.admin_console.tools.purge_user_data"),
    ],
    [
      { label: "block_user_feature" },
      renderMessage("screens.admin_console.tools.block_user_feature"),
    ],
    [
      { label: "unblock_user_feature" },
      renderMessage("screens.admin_console.tools.unblock_user_feature"),
    ],
    [{ label: "create_role" }, renderMessage("screens.admin_console.tools.create_role")],
    [{ label: "delete_role" }, renderMessage("screens.admin_console.tools.delete_role")],
    [
      { label: "duplicate_role" },
      renderMessage("screens.admin_console.tools.duplicate_role"),
    ],
    [
      { label: "assign_permissions" },
      renderMessage("screens.admin_console.tools.assign_permissions"),
    ],
    [
      { label: "create_entitlement_group" },
      renderMessage("screens.admin_console.tools.create_entitlement_group"),
    ],
    [
      { label: "set_entitlement_group_active" },
      renderMessage("screens.admin_console.tools.set_entitlement_group_active"),
    ],
    // A tool the catalogue does not name: said to be one, by its name made readable.
    [
      { label: "an_app_tool" },
      renderMessage("screens.admin_console.tools.unknown", { tool: "An app tool" }),
    ],
  ])("%j", (over, said) => {
    expect(describeWhat({ ...base, ...over } as PendingApproval)).toBe(said);
  });

  it("a role change's permissions, granted and taken away, and the account's role changed since", () => {
    expect(
      summaryLines({
        target,
        fromRole: "free",
        toRole: "moderator",
        roleChangedSince: { now: null },
        permissionsGranted: ["can_moderate"],
        permissionsRemoved: ["can_play"],
        reason: "r",
        dryRun: true,
      })
    ).toEqual([
      held("summary_role", { from: "Free", to: "Moderator" }),
      held("summary_role_changed", { role: held("summary_role_unknown") }),
      held("summary_granted", { permissions: permissionLabel("can_moderate") }),
      held("summary_removed", { permissions: permissionLabel("can_play") }),
      held("summary_reason", { reason: "r" }),
      held("summary_dry_run"),
    ]);
    expect(summaryLines(undefined)).toEqual([]);
    expect(summaryLines({ toRole: "admin" })[0]).toBe(
      held("summary_role", { from: held("summary_role_unknown"), to: "Admin" })
    );
  });

  it("who asked: address and role, erased, not found, no address — never an id", () => {
    expect(
      requesterText({
        requestedBy: { kind: "account", email: "a@x.test", role: "super_admin" },
      })
    ).toBe("a@x.test (Super admin)");
    expect(
      requesterText({ requestedBy: { kind: "account", email: "a@x.test", role: null } })
    ).toBe("a@x.test");
    expect(
      requesterText({ requestedBy: { kind: "account", email: null, role: "x" } })
    ).toBe(held("requester_no_email"));
    expect(requesterText({ requestedBy: { kind: "erased" } })).toBe(
      held("requester_erased")
    );
    expect(requesterText({})).toBe(held("requester_unknown"));
  });

  it("who may approve, and why it waits", () => {
    expect(approverText("config_manage_safety")).toBe(held("approver_safety"));
    expect(approverText("config_manage_standard")).toBe(held("approver_standard"));
    expect(approverText("admin_manage_users")).toBe(
      held("approver_other", { permission: permissionLabel("admin_manage_users") })
    );
    expect(whyHeld({ ...base, state: "undecided" })).toBe(held("why_undecided"));
    expect(whyHeld({ ...base, state: "retry" })).toBe(held("why_retry"));
    expect(whyHeld({ ...base, source: "config-approval", state: "held" })).toBe(
      held("why_two_person")
    );
    expect(whyHeld({ ...base, state: "held" })).toBe(held("why_dual_control"));
  });

  it("each answer a decision gets, naming the change (N-62)", () => {
    const what = describeWhat({ ...base, summary: { target } });
    const a = { ...base, summary: { target } };
    expect(acceptedResult("reject", a, {}).text).toBe(
      held("result_rejected_what", { what })
    );
    expect(acceptedResult("mark_executed", a, {}).text).toBe(
      held("result_done", { what })
    );
    expect(acceptedResult("withdraw", a, {}).text).toBe(
      held("result_withdrawn_now", { what })
    );
    expect(acceptedResult("approve", a, { pendingApproval: { id: "x" } })).toMatchObject({
      kind: "held",
      text: held("result_waits", { what }),
    });
    expect(acceptedResult("approve", a, { recorded: false }).text).toBe(
      held("result_unrecorded", { what })
    );
    expect(acceptedResult("reapprove", a, { applied: true }).text).toBe(
      held("result_applied", { what })
    );
    const config = {
      ...base,
      source: "config-approval" as const,
      change: { key: "k", action: "set" as const, before: 1, after: 2 },
    };
    expect(acceptedResult("approve", config, {}).text).toBe(
      held("result_applied_config", {
        what: held("what_config", { key: "K" }),
        value: "2",
      })
    );
  });

  it("a change's diff: the same value, a list's items, a scalar now and after, where it goes", () => {
    const { rerender, container } = render(
      <ChangeDiff
        change={{ key: "k", action: "set", before: 1, after: 1, scope: "platform" }}
      />
    );
    expect(container.textContent).toContain(held("diff_unchanged"));
    expect(container.textContent).toContain(held("diff_scope_platform"));
    rerender(
      <ChangeDiff
        change={{
          key: "k",
          action: "set",
          before: ["a", "b"],
          after: ["b"],
          scope: "tenant",
        }}
      />
    );
    expect(container.textContent).toContain("− a");
    expect(container.textContent).toContain(held("diff_scope_tenant"));
    rerender(
      <ChangeDiff change={{ key: "k", action: "set", before: "low", after: "high" }} />
    );
    expect(container.textContent).toContain(held("diff_before"));
    expect(container.textContent).toContain("high");
  });

  it("Reject confirms, repeating what; an undecided run shows its detail behind Details", async () => {
    const rows: PendingApproval[] = [
      { ...base, id: "r-1", summary: { target }, state: "held" },
      {
        ...base,
        id: "r-2",
        label: "purge_user_data",
        undecided: true,
        state: "undecided",
        reason: shown("screens.held.reason_undecided", {
          noted: "yes",
          detail: "run stopped",
        }),
      },
    ];
    mockApiFetch.mockRejectedValueOnce(new Error("offline"));
    render(<HeldActionsPanel data={{ approvals: rows }} hasPermission={() => true} />);
    const what = held("what_role_change", { account: "member@example.test" });
    fireEvent.click(screen.getByRole("button", { name: held("reject_label", { what }) }));
    const confirm = screen.getByRole("alertdialog", {
      name: held("confirm_reject_title"),
    });
    expect(within(confirm).getByText(held("confirm_note_reject"))).toBeTruthy();
    fireEvent.click(
      within(confirm).getByRole("button", { name: held("confirm_reject") })
    );
    // Unreachable: said once, in the outcome list; nothing decided (TASK-220, SF-admin-033).
    expect(
      await screen.findByText(renderMessage("screens.refusal.network"))
    ).toBeTruthy();
    expect(screen.getByText(/\(run stopped\)/)).toBeTruthy();
    expect(screen.getByText(held("details"))).toBeTruthy();
  });
});

const er = (key: string, v?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.erasures.${key}`, v);

type Overview = {
  operators: number;
  erasures: {
    secondOperator: boolean;
    purgedAt: string | null;
    purgeFailing: boolean;
    purgeAttempts: number;
    purgeRetryAt: string | null;
    requestedBy: unknown;
    steps: Record<string, unknown>[];
  }[];
};

describe("Erasures: each step's state and the attestation's decisions (S3-E19)", () => {
  const fixture = bodyOf<Overview>(
    "GET /api/operator/erasures — an unverifiable identity, one operator"
  );
  const withRequest = (byViewer: boolean): Overview => {
    const o = JSON.parse(JSON.stringify(fixture)) as Overview;
    o.operators = 2;
    o.erasures[0].secondOperator = true;
    o.erasures[0].steps[0].attestationRequest = {
      by: { kind: "account", email: "op-a@example.test" },
      byViewer,
      at: "2026-01-01T00:00:00.000Z",
      reason: "deleted_in_old_pool",
      expiresAt: "2026-01-08T00:00:00.000Z",
      expired: false,
    };
    return o;
  };

  it("a second operator approves after the confirm; the result stays", async () => {
    mockApiFetch
      .mockResolvedValueOnce(
        reply("POST /api/operator/tenants/[id]/erasures/[userId]/attestation — approved")
      )
      .mockResolvedValueOnce(
        reply("GET /api/operator/erasures — an unverifiable identity, one operator")
      );
    render(<ErasuresPanel data={withRequest(false)} />);
    expect(screen.getByText(/Attestation asked by op-a@example\.test/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: er("approve") }));
    const id = "0f0fc9b2-0000-4000-8000-000000000001";
    expect(
      screen.getByText(
        er("confirm_approve", { id, reason: er("reason_deleted_in_old_pool") })
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: er("confirm") }));
    expect(await screen.findByText(er("approved", { id }))).toBeTruthy();
    expect(
      JSON.parse(String((mockApiFetch.mock.calls[0] as [string, RequestInit])[1].body))
    ).toEqual({
      decision: "approve",
      store: "identity-provider",
    });
  });

  it("[hostile:self] the requester sees it is theirs, may only reject, and a refusal is said", async () => {
    mockApiFetch
      .mockResolvedValueOnce(
        reply(
          "POST /api/operator/tenants/[id]/erasures/[userId]/attestation — refused (own request)"
        )
      )
      .mockResolvedValueOnce(
        reply("GET /api/operator/erasures — an unverifiable identity, one operator")
      );
    render(<ErasuresPanel data={withRequest(true)} />);
    expect(screen.getByText(er("own_request"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: er("approve") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: er("reject") }));
    fireEvent.click(screen.getByRole("button", { name: er("confirm") }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/Not done for account/)
    );
  });

  it("done, attested, expired, purged and failing purges are each said; an unreachable server too", async () => {
    const o = JSON.parse(JSON.stringify(fixture)) as Overview;
    o.erasures[0].purgedAt = "2026-01-02T00:00:00.000Z";
    o.erasures[0].purgeFailing = true;
    o.erasures[0].purgeAttempts = 2;
    o.erasures[0].requestedBy = { kind: "erased" };
    o.erasures[0].steps = [
      {
        store: "identity-provider",
        done: true,
        doneAt: "2026-01-02T00:00:00.000Z",
        attempts: 3,
        poolUnverified: false,
        attested: {
          by: { kind: "unknown" },
          requestedBy: { kind: "account", email: null },
          at: "2026-01-02T00:00:00.000Z",
          reason: "pool_decommissioned",
        },
      },
      {
        store: "mail-list",
        done: false,
        attempts: 1,
        poolUnverified: true,
        attestationRequest: {
          by: { kind: "account", email: "op-a@example.test" },
          byViewer: false,
          at: "2026-01-01T00:00:00.000Z",
          reason: "a-new-reason",
          expiresAt: "2026-01-01T00:00:00.000Z",
          expired: true,
        },
      },
    ];
    o.operators = 2;
    o.erasures[0].secondOperator = true;
    mockApiFetch
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"));
    const { container } = render(<ErasuresPanel data={o} />);
    expect(container.textContent).toContain(er("step_other", { store: "mail-list" }));
    expect(container.textContent).toContain(
      renderMessage("screens.admin_console.people.erased")
    );
    expect(container.textContent).toMatch(/Closed by attestation/);
    expect(container.textContent).toMatch(/expired on/);
    expect(container.textContent).toMatch(/Data purged/);
    expect(container.textContent).toMatch(/The last data purge failed \(2 attempts\)/);
    // Expired: ask again.
    fireEvent.click(screen.getByRole("button", { name: er("ask") }));
    fireEvent.change(screen.getByLabelText(er("field_note")), {
      target: { value: "checked again" },
    });
    fireEvent.click(screen.getByRole("button", { name: er("submit_ask") }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/Not done for account/)
    );
  });

  it("not read yet, or unreadable: said", () => {
    const { rerender } = render(<ErasuresPanel data={undefined} />);
    expect(screen.getByText(er("loading"))).toBeTruthy();
    rerender(<ErasuresPanel data={PANEL_UNAVAILABLE} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    rerender(<ErasuresPanel data={{ ...fixture, erasures: [] }} />);
    expect(screen.getByText(er("empty"))).toBeTruthy();
  });
});
