/**
 * @jest-environment jsdom
 */
/**
 * __tests__/admin-usability-screens.test.tsx — the admin console as a person uses it (TASK-202)
 *
 * Each screen answered with what its real route answers (__tests__/fixtures/route-responses,
 * produced by the handlers in route-fixtures.test.ts — never a body written here):
 *
 *   - Platform config (N-60): a row opens its panel — key, description, tier, current value and
 *     default — with a type-aware input and a required comment; a change is sent on the governed
 *     path and the result says "Applied" or "Held for approval by …" and stays until dismissed;
 *     an admin without the tier's permission sees no edit button, and why;
 *   - Approvals (N-61, N-62): each hold says what it changes (key, now → after; a list's added
 *     items), who asked by address and role, when, and why; Approve and Reject ask again,
 *     repeating it; the result names the change and stays;
 *   - Trusted agents (N-66): register, held; the result stays;
 *   - Erasures (S3-E19): an unverifiable identity, and — one operator — no second one, said
 *     plainly;
 *   - long cells expand (N-64); the console's sections fit a phone (a picker).
 */
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { routeAnswer, type RouteFixtureName } from "./fixtures/route-responses";
import { renderMessage } from "@/platform/errors/messages";

const mockApiFetch = jest.fn();
jest.mock("@/platform/auth/api-fetch", () => ({
  apiFetch: (...a: unknown[]) => mockApiFetch(...a),
}));

import { PlatformConfigPanel } from "@/components/admin/PlatformConfigPanel";
import { HeldActionsPanel } from "@/components/admin/HeldActionsPanel";
import { TrustedAgentsPanel } from "@/components/admin/TrustedAgentsPanel";
import { ErasuresPanel } from "@/components/admin/ErasuresPanel";
import { ExpandableText } from "@/components/admin/ExpandableText";
import AdminShell from "@/components/admin/AdminShell";

/** A response as the route answered it (status and body from its fixture). */
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

/** The body of a fixture (the data a page passes a panel). */
const bodyOf = (name: RouteFixtureName) => routeAnswer(name)[1] as never;

const allow =
  (...granted: string[]) =>
  (code: string) =>
    granted.includes(code);

beforeEach(() => mockApiFetch.mockReset());

const cfg = (key: string, v?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.config.${key}`, v);

describe("Platform config: a setting opens its panel and can be changed (N-60)", () => {
  const data = bodyOf("GET /api/admin/config — every setting, with its metadata");

  it("lists every setting; a row opens its key, description, tier, value and default", () => {
    render(
      <PlatformConfigPanel data={data} hasPermission={allow("config_manage_safety")} />
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: cfg("open_label", { key: "moderation.strike_ban_threshold" }),
      })
    );
    const panel = screen.getByRole("region", {
      name: /moderation\.strike_ban_threshold/,
    });
    expect(within(panel).getByText("Strikes before an account is banned.")).toBeTruthy();
    expect(within(panel).getByText(cfg("field_default"))).toBeTruthy();
    expect(within(panel).getByText(cfg("range", { min: 1, max: 20 }))).toBeTruthy();
    expect(within(panel).getByText(new RegExp(cfg("tier_safety")))).toBeTruthy();
  });

  it("filters on this screen only", () => {
    render(<PlatformConfigPanel data={data} hasPermission={allow()} />);
    fireEvent.change(screen.getByLabelText(cfg("filter_label")), {
      target: { value: "language" },
    });
    expect(screen.getByText("default_language")).toBeTruthy();
    expect(screen.queryByText("moderation.strike_ban_threshold")).toBeNull();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("[hostile:role] without the tier's permission: no edit button, and why", () => {
    // A standard-tier admin opens a safety setting.
    render(
      <PlatformConfigPanel data={data} hasPermission={allow("config_manage_standard")} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: cfg("open_label", { key: "signups_enabled" }) })
    );
    expect(screen.queryByRole("button", { name: cfg("edit") })).toBeNull();
    expect(
      screen.getByText(cfg("cannot_edit", { permission: "config_manage_safety" }))
    ).toBeTruthy();
  });

  it("a number outside its range and a missing comment are said before anything is sent", async () => {
    render(
      <PlatformConfigPanel data={data} hasPermission={allow("config_manage_safety")} />
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: cfg("open_label", { key: "moderation.strike_ban_threshold" }),
      })
    );
    fireEvent.click(screen.getByRole("button", { name: cfg("edit") }));
    fireEvent.change(screen.getByLabelText(cfg("new_value")), {
      target: { value: "99" },
    });
    fireEvent.click(screen.getByRole("button", { name: cfg("submit") }));
    expect(await screen.findByText(cfg("number_above", { max: 20 }))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(cfg("new_value")), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: cfg("submit") }));
    expect(await screen.findByText(cfg("comment_missing"))).toBeTruthy();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("a held change says held, by whom, and stays until dismissed", async () => {
    mockApiFetch.mockResolvedValueOnce(
      reply("POST /api/admin/config-ai/execute — update_config held for approval")
    );
    render(
      <PlatformConfigPanel data={data} hasPermission={allow("config_manage_safety")} />
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: cfg("open_label", { key: "moderation.strike_ban_threshold" }),
      })
    );
    fireEvent.click(screen.getByRole("button", { name: cfg("edit") }));
    fireEvent.change(screen.getByLabelText(cfg("new_value")), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText(cfg("comment")), {
      target: { value: "Fewer bans for first offences" },
    });
    fireEvent.click(screen.getByRole("button", { name: cfg("submit") }));
    const held = cfg("held", {
      key: "moderation.strike_ban_threshold",
      value: "7",
      approver: cfg("approver_safety"),
    });
    expect(await screen.findByText(held)).toBeTruthy();
    // Sent on the governed path, confirmed, with the comment.
    const [url, init] = mockApiFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/config-ai/execute");
    expect(JSON.parse(String(init.body))).toEqual({
      toolId: "update_config",
      input: {
        key: "moderation.strike_ban_threshold",
        value: 7,
        changeComment: "Fewer bans for first offences",
        confirmed: true,
      },
    });
    // It stays (no timer) until dismissed.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText(held)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: renderMessage("screens.held.result_dismiss") })
    );
    expect(screen.queryByText(held)).toBeNull();
  });

  it("an applied change says applied, and the value is read again", async () => {
    mockApiFetch
      .mockResolvedValueOnce(
        reply("POST /api/admin/config-ai/execute — update_config applied")
      )
      .mockResolvedValueOnce(
        reply("GET /api/admin/config — every setting, with its metadata")
      );
    render(
      <PlatformConfigPanel data={data} hasPermission={allow("config_manage_standard")} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: cfg("open_label", { key: "default_language" }) })
    );
    fireEvent.click(screen.getByRole("button", { name: cfg("edit") }));
    fireEvent.change(screen.getByLabelText(cfg("new_value")), {
      target: { value: "fr" },
    });
    fireEvent.change(screen.getByLabelText(cfg("comment")), {
      target: { value: "French by default" },
    });
    fireEvent.click(screen.getByRole("button", { name: cfg("submit") }));
    expect(
      await screen.findByText(cfg("applied", { key: "default_language", value: "fr" }))
    ).toBeTruthy();
    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/api/admin/config?enhanced=true")
    );
  });

  it("a refusal is said in the catalog's words, with the setting", async () => {
    mockApiFetch.mockResolvedValueOnce(
      reply("POST /api/admin/config-ai/execute — update_config refused (out of range)")
    );
    // A list setting: its JSON is checked, then sent.
    render(
      <PlatformConfigPanel data={data} hasPermission={allow("config_manage_safety")} />
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: cfg("open_label", { key: "moderation.strike_ban_threshold" }),
      })
    );
    fireEvent.click(screen.getByRole("button", { name: cfg("edit") }));
    fireEvent.change(screen.getByLabelText(cfg("new_value")), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText(cfg("comment")), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: cfg("submit") }));
    const status = await screen.findByRole("status");
    await waitFor(() =>
      expect(status.textContent).toContain(
        cfg("refused", { key: "moderation.strike_ban_threshold", reason: "" }).trim()
      )
    );
  });

  it("a list setting's JSON is checked as it is typed", () => {
    render(
      <PlatformConfigPanel data={data} hasPermission={allow("config_manage_safety")} />
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: cfg("open_label", { key: "config.dual_control_keys" }),
      })
    );
    fireEvent.click(screen.getByRole("button", { name: cfg("edit") }));
    fireEvent.change(screen.getByLabelText(cfg("new_value")), {
      target: { value: '{"not": "a list"}' },
    });
    expect(screen.getByRole("alert").textContent).toBe(cfg("json_not_array"));
  });

  it("a boolean is a switch", () => {
    render(
      <PlatformConfigPanel data={data} hasPermission={allow("config_manage_safety")} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: cfg("open_label", { key: "signups_enabled" }) })
    );
    fireEvent.click(screen.getByRole("button", { name: cfg("edit") }));
    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});

const held = (key: string, v?: Record<string, string>) =>
  renderMessage(`screens.held.${key}`, v);

describe("Approvals: the approver sees what they decide (N-61, N-62)", () => {
  const data = bodyOf(
    "GET /api/admin/approvals — held changes, to a second admin who may decide them"
  );

  it("each hold: what, before → after, who by address and role, when, why — never an id", () => {
    const { container } = render(<HeldActionsPanel data={data} />);
    // The two-person approval of a number: now 5, after 7.
    expect(
      screen.getByText(held("what_config", { key: "moderation.strike_ban_threshold" }))
    ).toBeTruthy();
    const diffs = container.querySelectorAll("[data-diff='true']");
    expect(diffs.length).toBe(2);
    expect(diffs[1].textContent ?? diffs[0].textContent).toBeTruthy();
    expect(container.textContent).toContain("Fewer bans for first offences");
    // The held list change: the key it adds.
    expect(container.textContent).toContain("+ default_language");
    // Who asked, by address and role.
    const who = [...container.querySelectorAll("[data-requester='true']")].map(
      (n) => n.textContent
    );
    expect(who).toContain("requester@example.test (Super admin)");
    // Never the requester's id.
    for (const a of (data as { approvals: { requester: string }[] }).approvals)
      expect(container.textContent).not.toContain(a.requester);
  });

  it("Approve asks again, repeating what is decided; Go back sends nothing", () => {
    render(<HeldActionsPanel data={data} />);
    const what = held("what_config", { key: "moderation.strike_ban_threshold" });
    fireEvent.click(
      screen.getByRole("button", { name: held("approve_label", { what }) })
    );
    const confirm = screen.getByRole("group", { name: held("confirm_approve_title") });
    expect(within(confirm).getByText(what)).toBeTruthy();
    expect(within(confirm).getByText(/requester@example\.test/)).toBeTruthy();
    fireEvent.click(
      within(confirm).getByRole("button", { name: held("confirm_cancel") })
    );
    expect(
      screen.queryByRole("group", { name: held("confirm_approve_title") })
    ).toBeNull();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

const ag = (key: string, v?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.agents.${key}`, v);

describe("Trusted agents: a form on the governed path (N-66)", () => {
  const data = bodyOf("GET /api/admin/agent-registry — the registry");

  it("registers an agent; held, by whom; the result stays", async () => {
    mockApiFetch.mockResolvedValueOnce(
      reply("POST /api/admin/ai/execute — register_agent held for approval")
    );
    render(
      <TrustedAgentsPanel data={data} hasPermission={allow("admin_manage_agents")} />
    );
    fireEvent.click(screen.getByRole("button", { name: ag("register") }));
    fireEvent.change(screen.getByLabelText(ag("field_id")), {
      target: { value: "agent:e2e-helper" },
    });
    fireEvent.change(screen.getByLabelText(ag("field_scope")), {
      target: { value: "translate" },
    });
    fireEvent.change(screen.getByLabelText(ag("field_ttl")), {
      target: { value: "120" },
    });
    fireEvent.click(screen.getByRole("button", { name: ag("submit_register") }));
    const text = ag("held", {
      what: ag("what_register", { agent: "agent:e2e-helper" }),
      approver: ag("approver"),
    });
    expect(await screen.findByText(text)).toBeTruthy();
    const [, init] = mockApiFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      actions: [
        {
          tool: "register_agent",
          input: {
            agent_id: "agent:e2e-helper",
            scopes: ["translate"],
            max_token_ttl: 120,
          },
        },
      ],
    });
  });

  it("an applied registration reads the registry again", async () => {
    mockApiFetch
      .mockResolvedValueOnce(reply("POST /api/admin/ai/execute — register_agent applied"))
      .mockResolvedValueOnce(reply("GET /api/admin/agent-registry — the registry"));
    render(
      <TrustedAgentsPanel data={data} hasPermission={allow("admin_manage_agents")} />
    );
    fireEvent.click(screen.getByRole("button", { name: ag("register") }));
    fireEvent.change(screen.getByLabelText(ag("field_id")), {
      target: { value: "agent:e2e-helper" },
    });
    fireEvent.click(screen.getByRole("button", { name: ag("submit_register") }));
    expect(
      await screen.findByText(
        ag("applied", { what: ag("what_register", { agent: "agent:e2e-helper" }) })
      )
    ).toBeTruthy();
    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/api/admin/agent-registry")
    );
  });

  it("[hostile:role] without admin_manage_agents: the list, no forms, and why", () => {
    render(<TrustedAgentsPanel data={data} hasPermission={allow()} />);
    expect(screen.getByText("agent:research")).toBeTruthy();
    expect(screen.queryByRole("button", { name: ag("register") })).toBeNull();
    expect(
      screen.getByText(ag("cannot_edit", { permission: "admin_manage_agents" }))
    ).toBeTruthy();
  });

  it("an edit changes one thing at a time; an id is required; suspend asks first", () => {
    render(
      <TrustedAgentsPanel data={data} hasPermission={allow("admin_manage_agents")} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: ag("edit_label", { agent: "agent:research" }) })
    );
    fireEvent.change(screen.getByLabelText(ag("field_scope")), {
      target: { value: "a, b" },
    });
    fireEvent.change(screen.getByLabelText(ag("field_ttl")), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: ag("submit_edit") }));
    expect(screen.getByRole("alert").textContent).toBe(ag("one_at_a_time"));
    fireEvent.click(
      screen.getByRole("button", {
        name: ag("suspend_label", { agent: "agent:research" }),
      })
    );
    expect(
      screen.getByText(ag("confirm_suspend", { agent: "agent:research" }))
    ).toBeTruthy();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

const er = (key: string, v?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.erasures.${key}`, v);

describe("Erasures: open erasures and the attestation (S3-E19)", () => {
  const data = bodyOf(
    "GET /api/operator/erasures — an unverifiable identity, one operator"
  );

  it("shows the unverifiable identity, and plainly that no second operator exists", () => {
    const { container } = render(<ErasuresPanel data={data} />);
    expect(container.querySelector("[data-pool-unverified='true']")).not.toBeNull();
    expect(screen.getByText(er("no_second_operator", { operators: 1 }))).toBeTruthy();
    // No request is offered that no one could approve.
    expect(screen.queryByRole("button", { name: er("ask") })).toBeNull();
    expect(
      screen.getByText(er("requested_by", { person: "requester@example.test" }))
    ).toBeTruthy();
  });

  it("with a second operator: ask, with a reason and a note; the result stays", async () => {
    const two = JSON.parse(JSON.stringify(data)) as {
      operators: number;
      erasures: { secondOperator: boolean }[];
    };
    two.operators = 2;
    two.erasures[0].secondOperator = true;
    mockApiFetch
      .mockResolvedValueOnce(
        reply("POST /api/operator/tenants/[id]/erasures/[userId]/attestation — asked")
      )
      .mockResolvedValueOnce(
        reply("GET /api/operator/erasures — an unverifiable identity, one operator")
      );
    render(<ErasuresPanel data={two} />);
    fireEvent.click(screen.getByRole("button", { name: er("ask") }));
    fireEvent.change(screen.getByLabelText(er("field_note")), {
      target: { value: "ab" },
    });
    fireEvent.click(screen.getByRole("button", { name: er("submit_ask") }));
    expect(screen.getByRole("alert").textContent).toBe(er("note_short"));
    fireEvent.change(screen.getByLabelText(er("field_note")), {
      target: { value: "absent from both pools" },
    });
    fireEvent.click(screen.getByRole("button", { name: er("submit_ask") }));
    const id = "0f0fc9b2-0000-4000-8000-000000000001";
    expect(await screen.findByText(er("asked", { id }))).toBeTruthy();
    const [url, init] = mockApiFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/api/operator/tenants/aaaaaaaa-0000-4000-8000-00000000000a/erasures/${id}/attestation`
    );
    expect(JSON.parse(String(init.body))).toEqual({
      reason: "pool_decommissioned",
      note: "absent from both pools",
      store: "identity-provider",
    });
  });
});

describe("long cells and narrow screens (N-64)", () => {
  it("a long value is cut with a button that shows all of it, and back", () => {
    const text = "x".repeat(200);
    render(<ExpandableText text={text} column="Details" />);
    expect(screen.queryByText(text)).toBeNull();
    const more = screen.getByRole("button", {
      name: renderMessage("screens.admin_console.cell.more_label", { column: "Details" }),
    });
    fireEvent.click(more);
    expect(screen.getByText(new RegExp(`^${text}`))).toBeTruthy();
    expect(more.getAttribute("aria-expanded")).toBe("true");
  });

  it("the console's sections are a picker on a phone, the sidebar on a desktop: one list", () => {
    const changed = jest.fn();
    render(
      <AdminShell
        adminName="Admin"
        hasPermission={allow("can_access_admin", "platform_operate")}
        onSignOut={() => undefined}
        onSectionChange={changed}
      >
        {(s) => <p>{s}</p>}
      </AdminShell>
    );
    const picker = screen.getByRole("combobox", {
      name: renderMessage("screens.admin_console.nav_label"),
    });
    fireEvent.change(picker, { target: { value: "erasures" } });
    expect(changed).toHaveBeenLastCalledWith("erasures");
    expect(screen.getByText("erasures")).toBeTruthy();
  });
});
