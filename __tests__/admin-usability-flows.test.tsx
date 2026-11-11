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
import {
  parseList,
  parseTtl,
  TrustedAgentsPanel,
} from "@/components/admin/TrustedAgentsPanel";
import { ErasuresPanel } from "@/components/admin/ErasuresPanel";
import {
  editPermission,
  PlatformConfigPanel,
  type SettingEntry,
} from "@/components/admin/PlatformConfigPanel";
import { PANEL_UNAVAILABLE } from "@/components/admin/PanelUnavailable";
import { shown } from "@/platform/errors/shown-text";

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
const allow =
  (...granted: string[]) =>
  (code: string) =>
    granted.includes(code);
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
      held("what_block", { account: "member@example.test", feature: "translate" }),
    ],
    [
      {
        label: "unblock_user_feature",
        summary: { target: { notFound: true as const }, feature: "translate" },
      },
      held("what_unblock", { account: held("account_missing"), feature: "translate" }),
    ],
    [
      { label: "create_role", summary: { role: "qa" } },
      held("what_create_role", { role: "qa" }),
    ],
    [
      { label: "delete_role", summary: { role: "qa" } },
      held("what_delete_role", { role: "qa" }),
    ],
    [
      { label: "duplicate_role", summary: { role: "qa2", fromRole: "qa" } },
      held("what_duplicate_role", { role: "qa2", from: "qa" }),
    ],
    [
      { label: "assign_permissions", summary: { role: "qa" } },
      held("what_assign_permissions", { role: "qa" }),
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
    [{ label: "update_config", configKey: "k" }, held("what_config", { key: "k" })],
    [
      {
        label: "reset_config",
        change: { key: "k", action: "reset" as const, before: 1, after: 2 },
      },
      held("what_config_reset", { key: "k" }),
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
    [{ label: "an_app_tool" }, held("what_tool", { tool: "an_app_tool" })],
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
      held("summary_role", { from: "free", to: "moderator" }),
      held("summary_role_changed", { role: held("summary_role_unknown") }),
      held("summary_granted", { permissions: "can_moderate" }),
      held("summary_removed", { permissions: "can_play" }),
      held("summary_reason", { reason: "r" }),
      held("summary_dry_run"),
    ]);
    expect(summaryLines(undefined)).toEqual([]);
    expect(summaryLines({ toRole: "admin" })[0]).toBe(
      held("summary_role", { from: held("summary_role_unknown"), to: "admin" })
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
      held("approver_other", { permission: "admin_manage_users" })
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
        what: held("what_config", { key: "k" }),
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
    render(<HeldActionsPanel data={{ approvals: rows }} />);
    const what = held("what_role_change", { account: "member@example.test" });
    fireEvent.click(screen.getByRole("button", { name: held("reject_label", { what }) }));
    const confirm = screen.getByRole("group", { name: held("confirm_reject_title") });
    expect(within(confirm).getByText(held("confirm_note_reject"))).toBeTruthy();
    fireEvent.click(
      within(confirm).getByRole("button", { name: held("confirm_reject") })
    );
    // Unreachable: said at the row, nothing decided.
    expect(await screen.findByText(held("network_error"))).toBeTruthy();
    expect(screen.getByText(/\(run stopped\)/)).toBeTruthy();
    expect(screen.getByText(held("details"))).toBeTruthy();
  });
});

const ag = (key: string, v?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.agents.${key}`, v);

describe("Trusted agents: every state and change (N-66)", () => {
  const data = bodyOf<{ agents: unknown[] }>(
    "GET /api/admin/agent-registry — the registry"
  );

  it("reads a list as typed, and a ceiling as whole seconds", () => {
    expect(parseList("a, b\nb,, c ")).toEqual(["a", "b", "c"]);
    expect(parseTtl("120")).toBe(120);
    expect(parseTtl("0")).toBeNull();
    expect(parseTtl("1.5")).toBeNull();
    expect(parseTtl(" ")).toBeNull();
  });

  it("not read yet, unreadable, empty: said, never 'none' for unreadable", () => {
    const { rerender } = render(<TrustedAgentsPanel data={undefined} />);
    expect(screen.getByText(renderMessage("screens.admin_console.loading"))).toBeTruthy();
    rerender(<TrustedAgentsPanel data={PANEL_UNAVAILABLE} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    rerender(<TrustedAgentsPanel data={{ agents: [] }} />);
    expect(
      screen.getByText(renderMessage("screens.admin_console.no_agents"))
    ).toBeTruthy();
  });

  it("changes an agent's scope; the refusal is said in the catalog's words, and stays", async () => {
    mockApiFetch.mockResolvedValueOnce(
      reply(
        "POST /api/admin/ai/execute — set_agent_scope refused (no admin_manage_agents)"
      )
    );
    render(
      <TrustedAgentsPanel data={data} hasPermission={allow("admin_manage_agents")} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: ag("edit_label", { agent: "agent:research" }) })
    );
    fireEvent.change(screen.getByLabelText(ag("field_scope")), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: ag("submit_edit") }));
    const reason = renderMessage("errors.auth.permission_denied", {
      permission: "admin_manage_agents",
    });
    expect(
      await screen.findByText(
        ag("refused", {
          what: ag("what_scope", { agent: "agent:research", scopes: ag("no_scope") }),
          reason,
        })
      )
    ).toBeTruthy();
    const [, init] = mockApiFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).actions[0]).toEqual({
      tool: "set_agent_scope",
      input: { agent_id: "agent:research", scopes: [] },
    });
  });

  it("changes the ceiling alone; nothing changed is said; a bad ceiling is refused before sending", async () => {
    mockApiFetch.mockResolvedValueOnce(
      reply("POST /api/admin/ai/execute — register_agent held for approval")
    );
    render(
      <TrustedAgentsPanel data={data} hasPermission={allow("admin_manage_agents")} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: ag("edit_label", { agent: "agent:research" }) })
    );
    fireEvent.click(screen.getByRole("button", { name: ag("submit_edit") }));
    expect(screen.getByRole("alert").textContent).toBe(ag("nothing_changed"));
    fireEvent.change(screen.getByLabelText(ag("field_ttl")), { target: { value: "-1" } });
    fireEvent.click(screen.getByRole("button", { name: ag("submit_edit") }));
    expect(screen.getByRole("alert").textContent).toBe(ag("ttl_invalid"));
    fireEvent.change(screen.getByLabelText(ag("field_ttl")), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: ag("submit_edit") }));
    expect(
      await screen.findByText(
        ag("held", {
          what: ag("what_ttl", { agent: "agent:research", seconds: 60 }),
          approver: ag("approver"),
        })
      )
    ).toBeTruthy();
    expect(
      JSON.parse(String((mockApiFetch.mock.calls[0] as [string, RequestInit])[1].body))
        .actions[0]
    ).toEqual({
      tool: "set_agent_ttl",
      input: { agent_id: "agent:research", max_token_ttl: 60 },
    });
  });

  it("suspends after the confirm; reactivates a suspended agent; an unreachable server is said", async () => {
    const suspended = JSON.parse(JSON.stringify(data)) as {
      agents: [string, { status: string }][];
    };
    suspended.agents[0][1].status = "suspended";
    mockApiFetch.mockRejectedValueOnce(new Error("offline"));
    render(
      <TrustedAgentsPanel data={suspended} hasPermission={allow("admin_manage_agents")} />
    );
    expect(screen.getByText(ag("status_suspended"))).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: ag("reactivate_label", { agent: "agent:research" }),
      })
    );
    expect(
      screen.getByText(ag("confirm_reactivate", { agent: "agent:research" }))
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: ag("confirm") }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(
        /Not applied: reactivate agent:research/
      )
    );
    expect(
      JSON.parse(String((mockApiFetch.mock.calls[0] as [string, RequestInit])[1].body))
        .actions[0]
    ).toEqual({
      tool: "suspend_agent",
      input: { agent_id: "agent:research", reactivate: true },
    });
  });

  it("a register form without an id says so; Cancel closes it", () => {
    render(
      <TrustedAgentsPanel data={data} hasPermission={allow("admin_manage_agents")} />
    );
    fireEvent.click(screen.getByRole("button", { name: ag("register") }));
    fireEvent.click(screen.getByRole("button", { name: ag("submit_register") }));
    expect(screen.getByRole("alert").textContent).toBe(ag("id_missing"));
    fireEvent.change(screen.getByLabelText(ag("field_id")), {
      target: { value: "agent:x" },
    });
    fireEvent.change(screen.getByLabelText(ag("field_ttl")), {
      target: { value: "-5" },
    });
    fireEvent.click(screen.getByRole("button", { name: ag("submit_register") }));
    expect(screen.getByRole("alert").textContent).toBe(ag("ttl_invalid"));
    fireEvent.click(screen.getByRole("button", { name: ag("cancel") }));
    expect(screen.getByRole("button", { name: ag("register") })).toBeTruthy();
    expect(mockApiFetch).not.toHaveBeenCalled();
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

const cfg = (key: string, v?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.config.${key}`, v);

describe("Platform config: the rest of the edit panel (N-60)", () => {
  const data = bodyOf<{ entries: SettingEntry[] }>(
    "GET /api/admin/config — every setting, with its metadata"
  );

  it("a setting's tier decides the permission its change needs", () => {
    expect(editPermission("standard")).toBe("config_manage_standard");
    expect(editPermission("safety")).toBe("config_manage_safety");
  });

  it("a choice of allowed values; the re-read after an applied change refused: said", async () => {
    mockApiFetch
      .mockResolvedValueOnce(
        reply("POST /api/admin/config-ai/execute — update_config applied")
      )
      .mockResolvedValueOnce(
        reply("GET /api/admin/config — refused (no administrative access)")
      );
    render(
      <PlatformConfigPanel data={data} hasPermission={allow("config_manage_standard")} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: cfg("open_label", { key: "default_language" }) })
    );
    expect(screen.getByText(cfg("field_allowed"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: cfg("edit") }));
    fireEvent.change(screen.getByLabelText(cfg("new_value")), {
      target: { value: "es" },
    });
    fireEvent.change(screen.getByLabelText(cfg("comment")), {
      target: { value: "Spanish" },
    });
    fireEvent.click(screen.getByRole("button", { name: cfg("submit") }));
    expect(
      await screen.findByText(/default_language could not be read again/)
    ).toBeTruthy();
  });

  it("the same value is said, not sent; Cancel and Close; a network failure is said", async () => {
    mockApiFetch.mockRejectedValueOnce(new Error("offline"));
    render(
      <PlatformConfigPanel data={data} hasPermission={allow("config_manage_safety")} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: cfg("open_label", { key: "signups_enabled" }) })
    );
    fireEvent.click(screen.getByRole("button", { name: cfg("edit") }));
    fireEvent.change(screen.getByLabelText(cfg("comment")), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: cfg("submit") }));
    expect(screen.getByText(cfg("unchanged"))).toBeTruthy();
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: cfg("submit") }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(
        /Not applied: signups_enabled/
      )
    );
    fireEvent.click(screen.getByRole("button", { name: cfg("cancel") }));
    fireEvent.click(screen.getByRole("button", { name: cfg("close") }));
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("not read yet; nothing read; nothing matching", () => {
    const { rerender } = render(
      <PlatformConfigPanel data={undefined} hasPermission={allow()} />
    );
    expect(screen.getByText(cfg("loading"))).toBeTruthy();
    rerender(<PlatformConfigPanel data={{ entries: [] }} hasPermission={allow()} />);
    expect(screen.getByText(cfg("empty"))).toBeTruthy();
    rerender(<PlatformConfigPanel data={data} hasPermission={allow()} />);
    fireEvent.change(screen.getByLabelText(cfg("filter_label")), {
      target: { value: "zzz" },
    });
    expect(screen.getByText(cfg("none_match", { filter: "zzz" }))).toBeTruthy();
  });
});
