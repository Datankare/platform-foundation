/**
 * @jest-environment jsdom
 */
/**
 * The tenant settings and operator tenants screens (components/admin/TenancyPanels.tsx,
 * ADR-053 D5/D7): what each sends, and that each shows the server's answer.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  OperatorTenantsView,
  TenantSettingsView,
} from "@/components/admin/TenancyPanels";

const fetchMock = jest.fn();
beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});
beforeEach(() => fetchMock.mockReset());

function reply(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}
/** Answer each call in turn; the last answer repeats. */
function answers(...list: [number, unknown][]) {
  let i = 0;
  fetchMock.mockImplementation(async () => {
    const [s, b] = list[Math.min(i++, list.length - 1)];
    return reply(s, b);
  });
}
const sent = (n: number) => {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit | undefined];
  return {
    url,
    method: init?.method ?? "GET",
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
};

const TENANT = {
  tenant: {
    id: "11111111-1111-4111-8111-111111111111",
    mode: "shared",
    slug: "acme",
    name: "Acme",
    status: "active",
  },
  domains: [{ host: "acme.example.com", createdAt: "2026-01-01T00:00:00Z" }],
  budget: { usedUsd: 12.5, budgetUsd: 100, exhausted: false, period: "2026-10-23" },
  settings: [
    {
      key: "signups_enabled",
      description: "Whether new accounts may sign up",
      value: false,
      platformValue: true,
      overridden: true,
    },
    {
      key: "max_devices_per_player",
      description: null,
      value: 3,
      platformValue: 3,
      overridden: false,
    },
  ],
};

describe("TenantSettingsView", () => {
  it("shows loading until there is a tenant", () => {
    render(<TenantSettingsView data={undefined} />);
    expect(screen.getByText("Loading…")).toBeDefined();
  });

  it("shows the tenant, its addresses, spend and settings", () => {
    render(<TenantSettingsView data={TENANT} />);
    expect(screen.getByRole("heading", { name: "Acme" })).toBeDefined();
    expect(screen.getByText(/A tenant of a shared deployment/)).toBeDefined();
    expect(screen.getByText("acme.example.com")).toBeDefined();
    expect(screen.getByText("$12.50 of $100.00")).toBeDefined();
    expect(screen.getByText("tenant's own")).toBeDefined();
    // Only an overridden setting can go back to the default.
    expect(
      screen.getByRole("button", { name: "Use the platform default for signups_enabled" })
    ).toBeDefined();
    expect(
      screen.queryByRole("button", {
        name: "Use the platform default for max_devices_per_player",
      })
    ).toBeNull();
  });

  it("says when the tenant's agents have reached the cap", () => {
    render(
      <TenantSettingsView
        data={{ ...TENANT, budget: { ...TENANT.budget, usedUsd: 100, exhausted: true } }}
      />
    );
    expect(screen.getByText(/The cap is reached/)).toBeDefined();
  });

  it("a single deployment: no addresses needed, no reset", () => {
    render(
      <TenantSettingsView
        data={{
          ...TENANT,
          tenant: { ...TENANT.tenant, mode: "single", name: null, slug: null },
          domains: [],
        }}
      />
    );
    expect(screen.getByRole("heading", { name: "This deployment" })).toBeDefined();
    expect(screen.getByText("Not needed in a single-tenant deployment.")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Use the platform default/ })).toBeNull();
  });

  it("saves a value as JSON when it parses, then reloads", async () => {
    answers([200, { success: true }], [200, TENANT]);
    render(<TenantSettingsView data={TENANT} />);
    const save = screen.getByRole("button", { name: "Save max_devices_per_player" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("New value for max_devices_per_player"), {
      target: { value: "5" },
    });
    fireEvent.click(save);
    await screen.findByText("max_devices_per_player saved.");
    expect(sent(0)).toEqual({
      url: "/api/admin/config",
      method: "PUT",
      body: { key: "max_devices_per_player", value: 5, changeComment: "Tenant settings" },
    });
    expect(sent(1).url).toBe("/api/admin/tenant");
  });

  it("says when a change is held for approval", async () => {
    answers([202, { pending: true }], [200, TENANT]);
    render(<TenantSettingsView data={TENANT} />);
    fireEvent.change(screen.getByLabelText("New value for signups_enabled"), {
      target: { value: "true" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save signups_enabled" }));
    await screen.findByText("signups_enabled is held for approval.");
  });

  it("shows the server's refusal and does not reload", async () => {
    answers([403, { code: "admin.config_scope_refused", message: "Only operators." }]);
    render(<TenantSettingsView data={TENANT} />);
    fireEvent.change(screen.getByLabelText("New value for signups_enabled"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save signups_enabled" }));
    await screen.findByText("signups_enabled: Only operators.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("goes back to the default through DELETE", async () => {
    answers([200, { success: true }], [200, TENANT]);
    render(<TenantSettingsView data={TENANT} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Use the platform default for signups_enabled" })
    );
    await screen.findByText("signups_enabled uses the platform default again.");
    expect(sent(0)).toMatchObject({
      url: "/api/admin/config?key=signups_enabled",
      method: "DELETE",
    });
  });

  it("an unreachable server is a refusal, not a crash", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<TenantSettingsView data={TENANT} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Use the platform default for signups_enabled" })
    );
    await screen.findByText("signups_enabled: The request was refused.");
  });
});

const ROWS = [
  {
    id: "t-active",
    slug: "acme",
    name: "Acme",
    status: "active",
    domains: ["acme.example.com"],
    userCount: 4,
  },
  {
    id: "t-suspended",
    slug: "beta",
    name: "Beta",
    status: "suspended",
    domains: [],
    userCount: 1,
  },
  {
    id: "t-deleted",
    slug: "gone",
    name: "Gone",
    status: "deleted",
    domains: [],
    userCount: 0,
    purgeAfter: "2026-11-20T00:00:00Z",
  },
  {
    id: "t-pending",
    slug: "doomed",
    name: "Doomed",
    status: "active",
    domains: [],
    userCount: 2,
    pendingDeletion: { requestId: "req-1", requestedBy: "op-1" },
  },
  {
    id: "t-purged",
    slug: "purged",
    name: "Purged",
    status: "deleted",
    domains: [],
    userCount: 0,
    purgeAfter: "2026-01-01T00:00:00Z",
    purgedAt: "2026-01-02T00:00:00Z",
  },
];

describe("OperatorTenantsView", () => {
  const view = () => render(<OperatorTenantsView data={{ tenants: ROWS }} />);
  const button = (name: string) => screen.getByRole("button", { name });
  const none = (name: string) =>
    expect(screen.queryByRole("button", { name })).toBeNull();

  it("shows loading until there is a list", () => {
    render(<OperatorTenantsView data={undefined} />);
    expect(screen.getByText("Loading…")).toBeDefined();
  });

  it("offers only the actions each state allows", () => {
    view();
    button("Suspend Acme");
    none("Resume Acme");
    none("Restore Acme");
    button("Resume Beta");
    none("Suspend Beta");
    button("Restore Gone");
    none("Request deletion of Gone (another operator approves)");
    none("Make one of Gone's users its administrator");
    button("Approve the deletion of Doomed");
    button("Reject the deletion of Doomed");
    none("Request deletion of Doomed (another operator approves)");
    // A purged tenant has nothing left to restore, address or export.
    none("Restore Purged");
    none("Add an address for Purged");
    expect(
      screen.queryByRole("link", { name: "Export all of Purged's data" })
    ).toBeNull();
    expect(screen.getByRole("link", { name: "Export all of Acme's data" })).toBeDefined();
    expect(screen.getByText("purged after 2026-11-20")).toBeDefined();
  });

  it("asks for a reason inline, then suspends with it", async () => {
    answers([200, { success: true }], [200, { tenants: ROWS }]);
    view();
    fireEvent.click(button("Suspend Acme"));
    const form = screen.getByRole("form", { name: "Suspend Acme" });
    expect(form).toBeDefined();
    const confirm = button("Confirm");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "  unpaid  " },
    });
    fireEvent.click(confirm);
    await screen.findByText("Suspend Acme: done.");
    expect(sent(0)).toEqual({
      url: "/api/operator/tenants/t-active/state",
      method: "POST",
      body: { action: "suspend", reason: "unpaid" },
    });
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("cancel and Escape send nothing", () => {
    view();
    fireEvent.click(button("Resume Beta"));
    fireEvent.click(button("Cancel"));
    expect(screen.queryByRole("form")).toBeNull();
    fireEvent.click(button("Restore Gone"));
    fireEvent.keyDown(screen.getByLabelText("Reason"), { key: "Escape" });
    expect(screen.queryByRole("form")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests a deletion with its reason", async () => {
    answers([202, { success: true }], [200, { tenants: ROWS }]);
    view();
    fireEvent.click(button("Request deletion of Acme (another operator approves)"));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "closed" } });
    fireEvent.submit(screen.getByRole("form"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0)).toEqual({
      url: "/api/operator/tenants/t-active/deletion",
      method: "POST",
      body: { reason: "closed" },
    });
  });

  it("decides a pending deletion, and shows a refusal (own request)", async () => {
    answers([403, { code: "tenant.self_approval", message: "Another operator must." }]);
    view();
    fireEvent.click(button("Approve the deletion of Doomed"));
    await screen.findByText("Approve the deletion of Doomed: Another operator must.");
    expect(sent(0)).toEqual({
      url: "/api/operator/deletions/req-1",
      method: "POST",
      body: { decision: "approve" },
    });
  });

  it("adds and removes addresses", async () => {
    answers([200, { success: true }], [200, { tenants: ROWS }]);
    view();
    fireEvent.click(button("Add an address for Beta"));
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: "beta.example.com" },
    });
    fireEvent.click(button("Confirm"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(sent(0)).toEqual({
      url: "/api/operator/tenants/t-suspended/domains",
      method: "POST",
      body: { host: "beta.example.com" },
    });
    fireEvent.click(button("Remove acme.example.com"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(sent(2)).toMatchObject({
      url: "/api/operator/tenants/t-active/domains?host=acme.example.com",
      method: "DELETE",
    });
  });

  it("makes a user administrator by email", async () => {
    answers([200, { success: true }], [200, { tenants: ROWS }]);
    view();
    fireEvent.click(button("Make one of Acme's users its administrator"));
    const field = screen.getByLabelText("Email") as HTMLInputElement;
    expect(field.type).toBe("email");
    fireEvent.change(field, { target: { value: "a@acme.example.com" } });
    fireEvent.click(button("Confirm"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0)).toEqual({
      url: "/api/operator/tenants/t-active/admins",
      method: "POST",
      body: { email: "a@acme.example.com" },
    });
  });

  it("provisions a tenant, splitting the addresses, and clears the form", async () => {
    answers([201, { tenant: { id: "new" } }], [200, { tenants: ROWS }]);
    view();
    const provision = button("Provision");
    expect((provision as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Slug"), { target: { value: " new " } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Co" } });
    fireEvent.change(screen.getByLabelText("Addresses (comma-separated)"), {
      target: { value: "a.example.com, b.example.com  c.example.com" },
    });
    fireEvent.click(provision);
    await screen.findByText("Provision: done.");
    expect(sent(0)).toEqual({
      url: "/api/operator/tenants",
      method: "POST",
      body: {
        slug: "new",
        name: "New Co",
        domains: ["a.example.com", "b.example.com", "c.example.com"],
      },
    });
    expect((screen.getByLabelText("Slug") as HTMLInputElement).value).toBe("");
  });

  it("keeps the form when provisioning is refused", async () => {
    answers([409, { code: "tenant.conflict", message: "That slug is taken." }]);
    view();
    fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Acme 2" } });
    fireEvent.click(button("Provision"));
    await screen.findByText("Provision: That slug is taken.");
    expect((screen.getByLabelText("Slug") as HTMLInputElement).value).toBe("acme");
  });

  it("purges due tenants", async () => {
    answers([200, { purged: [] }], [200, { tenants: ROWS }]);
    view();
    fireEvent.click(button("Purge due"));
    await screen.findByText("Purge due tenants: done.");
    expect(sent(0)).toMatchObject({ url: "/api/operator/purge", method: "POST" });
  });

  it("shows each readiness check, its state named for screen readers", async () => {
    answers([
      200,
      {
        mode: "shared",
        ready: false,
        checks: [
          { name: "request role", state: "ready", detail: "app_tenant" },
          { name: "identity attribute", state: "not_ready", detail: "writable" },
          { name: "owner connection", state: "unknown", detail: "timeout" },
        ],
      },
    ]);
    view();
    fireEvent.click(button("Check"));
    await screen.findByText("writable");
    expect(screen.getByText("(ready)")).toBeDefined();
    expect(screen.getByText("(not ready)")).toBeDefined();
    expect(screen.getByText("(unknown)")).toBeDefined();
  });

  it("reports a failed readiness check", async () => {
    answers([403, { code: "admin.operator_only", message: "Operators only." }]);
    view();
    await act(async () => {
      fireEvent.click(button("Check"));
    });
    await screen.findByText("Readiness: Operators only.");
  });
});

describe("OperatorTenantsView — one tenant's settings, as an operator", () => {
  const ENTRIES = [
    {
      key: "max_devices_per_player",
      description: "Devices",
      value: 5,
      platformValue: 3,
      overridden: true,
      tenantOverridable: true,
      permissionTier: "standard",
    },
    {
      key: "agent.budget.tenant_max_cost_per_day",
      description: "Tenant cap",
      value: 100,
      platformValue: 100,
      overridden: false,
      tenantOverridable: false,
      permissionTier: "safety",
    },
  ];
  const HELD = [
    {
      source: "config-approval",
      id: "apr-1",
      label: "moderation.strike_ban_threshold",
      requester: "op-1",
      requiredPermission: "config_manage_safety",
    },
  ];
  /** Route each call by URL and method. */
  function routes(table: Record<string, [number, unknown]>) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const k = `${init?.method ?? "GET"} ${url}`;
      const hit = table[k] ?? [404, { code: "x", message: `no route ${k}` }];
      return reply(hit[0], hit[1]);
    });
  }
  const base = "/api/operator/tenants/t-active";
  const open = async () => {
    render(<OperatorTenantsView data={{ tenants: ROWS }} />);
    fireEvent.click(screen.getByRole("button", { name: "Settings of Acme" }));
    await screen.findByRole("heading", { name: "Settings of Acme" });
  };

  it("is not offered for a deleted tenant", () => {
    render(<OperatorTenantsView data={{ tenants: ROWS }} />);
    expect(screen.queryByRole("button", { name: "Settings of Gone" })).toBeNull();
  });

  it("lists every setting — including those only operators set — and the held changes", async () => {
    routes({
      [`GET ${base}/config`]: [200, { entries: ENTRIES }],
      [`GET ${base}/approvals`]: [200, { approvals: HELD }],
    });
    await open();
    expect(screen.getByText("agent.budget.tenant_max_cost_per_day")).toBeDefined();
    expect(screen.getByText("operators only · safety")).toBeDefined();
    expect(screen.getByText("its administrators may set this")).toBeDefined();
    expect(screen.getByText("Waiting for approval")).toBeDefined();
    // Filter narrows the list.
    fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "budget" } });
    expect(screen.queryByText("max_devices_per_player")).toBeNull();
  });

  it("sets a platform-governed key for the tenant through the operator route", async () => {
    routes({
      [`GET ${base}/config`]: [200, { entries: ENTRIES }],
      [`GET ${base}/approvals`]: [200, { approvals: [] }],
      [`PUT ${base}/config`]: [200, { success: true }],
    });
    await open();
    fireEvent.change(
      screen.getByLabelText("New value for agent.budget.tenant_max_cost_per_day"),
      { target: { value: "25" } }
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save agent.budget.tenant_max_cost_per_day" })
    );
    await screen.findByText("agent.budget.tenant_max_cost_per_day saved.");
    const put = fetchMock.mock.calls.find(
      ([u, i]) => u === `${base}/config` && (i as RequestInit)?.method === "PUT"
    ) as [string, RequestInit];
    expect(JSON.parse(String(put[1].body))).toEqual({
      key: "agent.budget.tenant_max_cost_per_day",
      value: 25,
      changeComment: "Set by an operator for this tenant",
    });
  });

  it("says when a change waits for a second approver, and resets through DELETE", async () => {
    routes({
      [`GET ${base}/config`]: [200, { entries: ENTRIES }],
      [`GET ${base}/approvals`]: [200, { approvals: [] }],
      [`PUT ${base}/config`]: [202, { success: true, pending: true }],
      [`DELETE ${base}/config?key=max_devices_per_player`]: [200, { success: true }],
    });
    await open();
    fireEvent.change(screen.getByLabelText("New value for max_devices_per_player"), {
      target: { value: "9" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save max_devices_per_player" }));
    await screen.findByText("max_devices_per_player is held for approval.");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Use the platform default for max_devices_per_player",
      })
    );
    await screen.findByText("max_devices_per_player uses the platform default again.");
  });

  it("decides a held change in that tenant, and shows a refusal", async () => {
    routes({
      [`GET ${base}/config`]: [200, { entries: ENTRIES }],
      [`GET ${base}/approvals`]: [200, { approvals: HELD }],
      [`POST ${base}/approvals/apr-1`]: [
        403,
        { code: "approvals.self_approval", message: "You requested this change." },
      ],
    });
    await open();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Approve the held change moderation.strike_ban_threshold",
      })
    );
    await screen.findByText(
      "moderation.strike_ban_threshold: You requested this change."
    );
    const post = fetchMock.mock.calls.find(([u]) => u === `${base}/approvals/apr-1`) as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(post[1].body))).toEqual({
      decision: "approve",
      source: "config-approval",
    });
  });

  it("an unreadable tenant's settings say why; Close removes the panel", async () => {
    routes({
      [`GET ${base}/config`]: [
        409,
        { code: "tenant.not_shared", message: "One tenant." },
      ],
      [`GET ${base}/approvals`]: [
        409,
        { code: "tenant.not_shared", message: "One tenant." },
      ],
    });
    await open();
    expect(screen.getByText("Settings of Acme: One tenant.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("heading", { name: "Settings of Acme" })).toBeNull();
  });
});
