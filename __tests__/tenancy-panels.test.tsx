/**
 * @jest-environment jsdom
 */
/**
 * The tenant settings and operator tenants screens (components/admin/TenancyPanels.tsx,
 * ADR-053 D5/D7): what each sends, and that each shows the server's answer.
 */
import { renderMessage } from "@/platform/errors/messages";
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  OperatorTenantsView,
  TenantSettingsView,
} from "@/components/admin/TenancyPanels";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";

const fetchMock = jest.fn();
beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});
beforeEach(() => fetchMock.mockReset());

/** A route's own answer (__tests__/fixtures/route-responses.json), as fetch resolves it. */
function reply(name: string) {
  const [status, body] = routeAnswer(name as RouteFixtureName);
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}
/** Answer each call in turn with these routes' answers; the last answer repeats. */
function answers(...list: string[]) {
  let i = 0;
  fetchMock.mockImplementation(async () => reply(list[Math.min(i++, list.length - 1)]!));
}
const bodyOf = <T,>(name: string) => routeAnswer(name as RouteFixtureName)[1] as T;
const messageOf = (name: string) => bodyOf<{ message: string }>(name).message;
const sent = (n: number) => {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit | undefined];
  return {
    url,
    method: init?.method ?? "GET",
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
};

type TenantData = Parameters<typeof TenantSettingsView>[0]["data"];
const ACME_TENANT =
  "GET /api/admin/tenant — a shared deployment's tenant, its spend under the cap";
const TENANT = bodyOf<NonNullable<TenantData>>(ACME_TENANT);

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
        data={bodyOf(
          "GET /api/admin/tenant — a shared deployment's tenant, its cap reached"
        )}
      />
    );
    expect(screen.getByText(/The cap is reached/)).toBeDefined();
  });

  it("a single deployment: no addresses needed, no reset", () => {
    render(
      <TenantSettingsView data={bodyOf("GET /api/admin/tenant — a single deployment")} />
    );
    expect(screen.getByRole("heading", { name: "This deployment" })).toBeDefined();
    expect(screen.getByText("Not needed in a single-tenant deployment.")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Use the platform default/ })).toBeNull();
  });

  it("saves a value as JSON when it parses, then reloads", async () => {
    answers("PUT /api/admin/config — saved", ACME_TENANT);
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
    answers("PUT /api/admin/config — held for approval", ACME_TENANT);
    render(<TenantSettingsView data={TENANT} />);
    fireEvent.change(screen.getByLabelText("New value for signups_enabled"), {
      target: { value: "true" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save signups_enabled" }));
    await screen.findByText("signups_enabled is held for approval.");
  });

  it("shows the server's refusal and does not reload", async () => {
    const refused = "PUT /api/admin/config — refused (not this tenant's to set)";
    answers(refused);
    render(<TenantSettingsView data={TENANT} />);
    fireEvent.change(screen.getByLabelText("New value for signups_enabled"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save signups_enabled" }));
    await screen.findByText(`signups_enabled: ${messageOf(refused)}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Round 15, nit 4: a write whose commit was lost may have applied — the page reads the setting
  // again, so the admin sees its actual value, and says the outcome is unknown.
  const LOST = messageOf("PUT /api/admin/config — the commit lost");

  it("after a lost commit (save) reloads the setting and says so", async () => {
    answers(
      "PUT /api/admin/config — the commit lost",
      "GET /api/admin/tenant — after a lost commit, max_devices_per_player 7"
    );
    render(<TenantSettingsView data={TENANT} />);
    fireEvent.change(screen.getByLabelText("New value for max_devices_per_player"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save max_devices_per_player" }));
    await screen.findByText(`max_devices_per_player: ${LOST}`);
    expect(sent(1).url).toBe("/api/admin/tenant");
    await screen.findByText("7");
  });

  it("after a lost commit (reset) reloads the setting and says so", async () => {
    answers(
      "DELETE /api/admin/config — the commit lost",
      "GET /api/admin/tenant — after a lost commit, signups_enabled the platform's"
    );
    render(<TenantSettingsView data={TENANT} />);
    const reset = "Use the platform default for signups_enabled";
    fireEvent.click(screen.getByRole("button", { name: reset }));
    await screen.findByText(`signups_enabled: ${LOST}`);
    expect(sent(1).url).toBe("/api/admin/tenant");
    // Reloaded: it uses the platform default now, so there is nothing to reset.
    await waitFor(() => expect(screen.queryByRole("button", { name: reset })).toBeNull());
  });

  it("goes back to the default through DELETE", async () => {
    answers("DELETE /api/admin/config — the platform default again", ACME_TENANT);
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

const TENANTS = "GET /api/operator/tenants — every state";
type TenantRows = Parameters<typeof OperatorTenantsView>[0]["data"];
const ROWS = bodyOf<NonNullable<TenantRows>>(TENANTS).tenants ?? [];
const idOf = (slug: string) => ROWS.find((t) => t.slug === slug)!.id;

describe("OperatorTenantsView", () => {
  const view = () => render(<OperatorTenantsView data={{ tenants: ROWS }} />);
  const button = (name: string) => screen.getByRole("button", { name });
  const none = (name: string) =>
    expect(screen.queryByRole("button", { name })).toBeNull();

  it("shows loading until there is a list", () => {
    render(<OperatorTenantsView data={undefined} />);
    expect(screen.getByText("Loading…")).toBeDefined();
  });

  it("the tenants table scrolls inside its own box, never the page (390 px, TASK-203)", () => {
    const { container } = view();
    const tables = container.querySelectorAll("table");
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      const box = table.parentElement!;
      expect(box.hasAttribute("data-scroll-box")).toBe(true);
      expect(box.className).toContain("overflow-x-auto");
    }
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
    answers("POST /api/operator/tenants/[id]/state — suspended", TENANTS);
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
      url: `/api/operator/tenants/${idOf("acme")}/state`,
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
    answers("POST /api/operator/tenants/[id]/deletion — requested", TENANTS);
    view();
    fireEvent.click(button("Request deletion of Acme (another operator approves)"));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "closed" } });
    fireEvent.submit(screen.getByRole("form"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0)).toEqual({
      url: `/api/operator/tenants/${idOf("acme")}/deletion`,
      method: "POST",
      body: { reason: "closed" },
    });
  });

  it("decides a pending deletion, and shows a refusal (own request)", async () => {
    const refused = "POST /api/operator/deletions/[id] — refused (its own requester)";
    answers(refused);
    view();
    fireEvent.click(button("Approve the deletion of Doomed"));
    await screen.findByText(`Approve the deletion of Doomed: ${messageOf(refused)}`);
    const pending = ROWS.find((t) => t.slug === "doomed")!.pendingDeletion!;
    expect(sent(0)).toEqual({
      url: `/api/operator/deletions/${pending.requestId}`,
      method: "POST",
      body: { decision: "approve" },
    });
  });

  it("adds and removes addresses", async () => {
    let call = 0;
    fetchMock.mockImplementation(async () =>
      reply(
        [
          "POST /api/operator/tenants/[id]/domains — added",
          TENANTS,
          "DELETE /api/operator/tenants/[id]/domains — removed",
          TENANTS,
        ][Math.min(call++, 3)]!
      )
    );
    view();
    fireEvent.click(button("Add an address for Beta"));
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: "beta.example.com" },
    });
    fireEvent.click(button("Confirm"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(sent(0)).toEqual({
      url: `/api/operator/tenants/${idOf("beta")}/domains`,
      method: "POST",
      body: { host: "beta.example.com" },
    });
    fireEvent.click(button("Remove acme.example.com"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(sent(2)).toMatchObject({
      url: `/api/operator/tenants/${idOf("acme")}/domains?host=acme.example.com`,
      method: "DELETE",
    });
  });

  it("makes a user administrator by email", async () => {
    answers("POST /api/operator/tenants/[id]/admins — made administrator", TENANTS);
    view();
    fireEvent.click(button("Make one of Acme's users its administrator"));
    const field = screen.getByLabelText("Email") as HTMLInputElement;
    expect(field.type).toBe("email");
    fireEvent.change(field, { target: { value: "a@acme.example.com" } });
    fireEvent.click(button("Confirm"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0)).toEqual({
      url: `/api/operator/tenants/${idOf("acme")}/admins`,
      method: "POST",
      body: { email: "a@acme.example.com" },
    });
  });

  it("provisions a tenant, splitting the addresses, and clears the form", async () => {
    answers("POST /api/operator/tenants — provisioned", TENANTS);
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
    const refused = "POST /api/operator/tenants — refused (the slug taken)";
    answers(refused);
    view();
    fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Acme 2" } });
    fireEvent.click(button("Provision"));
    await screen.findByText(`Provision: ${messageOf(refused)}`);
    expect((screen.getByLabelText("Slug") as HTMLInputElement).value).toBe("acme");
  });

  it("purges due tenants", async () => {
    answers("POST /api/operator/purge — none due", TENANTS);
    view();
    fireEvent.click(button("Purge due"));
    await screen.findByText("Purge due tenants: done.");
    expect(sent(0)).toMatchObject({ url: "/api/operator/purge", method: "POST" });
  });

  it("shows each readiness check, its state named for screen readers", async () => {
    answers("GET /api/operator/readiness — this deployment");
    view();
    fireEvent.click(button("Check"));
    // Each check by the catalog's name, and its detail worded by the catalog (TASK-206).
    await screen.findByText(
      new RegExp(renderMessage("screens.readiness.owner_unset").slice(0, 30))
    );
    expect(
      screen.getByText(
        new RegExp(renderMessage("screens.readiness.database_role_missing"))
      )
    ).toBeDefined();
    expect(screen.getAllByText("(ready)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("(not ready)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("(unknown)").length).toBeGreaterThan(0);
  });

  it("reports a failed readiness check", async () => {
    const refused = "GET /api/operator/readiness — refused (no permission)";
    answers(refused);
    view();
    await act(async () => {
      fireEvent.click(button("Check"));
    });
    await screen.findByText(`Readiness: ${messageOf(refused)}`);
  });
});

describe("OperatorTenantsView — one tenant's settings, as an operator", () => {
  const CONFIG =
    "GET /api/operator/tenants/[id]/config — every setting, one only operators set";
  const HELD =
    "GET /api/operator/tenants/[id]/approvals — a two-person approval, its requester not here";
  const NONE = "GET /api/operator/tenants/[id]/approvals — none";
  const DECIDE = "POST /api/operator/tenants/[id]/approvals/[approvalId] —";
  const heldId = (name: string) =>
    bodyOf<{ approvals: { id: string }[] }>(name).approvals.at(-1)!.id;
  /** Route each call by URL and method. */
  /** Route each "METHOD url" to the fixture that answers it (a table of names, not bodies). */
  function routes(table: ReadonlyMap<string, string>) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const k = `${init?.method ?? "GET"} ${url}`;
      const name = table.get(k);
      if (!name) throw new Error(`unexpected request: ${k}`);
      return reply(name);
    });
  }
  const base = `/api/operator/tenants/${idOf("acme")}`;
  // The erasure's account is not in this tenant's users: the label says so.
  const ERASE = "Erase the account an account that is no longer found";
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
    routes(
      new Map([
        [`GET ${base}/config`, CONFIG],
        [`GET ${base}/approvals`, HELD],
      ])
    );
    await open();
    expect(screen.getByText("agent.budget.tenant_max_cost_per_day")).toBeDefined();
    expect(screen.getByText("operators only · safety")).toBeDefined();
    expect(screen.getByText("its administrators may set this")).toBeDefined();
    expect(screen.getByText("Waiting for approval")).toBeDefined();
    // The requester is never named by id (TASK-202, N-63): a listing that names none says so.
    const requester = bodyOf<{ approvals: { requester: string }[] }>(HELD).approvals[0]!
      .requester;
    expect(document.body.textContent).not.toContain(requester);
    expect(
      screen.getByText(/requested by an account not found in this tenant/)
    ).toBeDefined();
    // Filter narrows the list.
    fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "budget" } });
    expect(screen.queryByText("max_devices_per_player")).toBeNull();
  });

  it("sets a platform-governed key for the tenant through the operator route", async () => {
    routes(
      new Map([
        [`GET ${base}/config`, CONFIG],
        [`GET ${base}/approvals`, NONE],
        [`PUT ${base}/config`, "PUT /api/operator/tenants/[id]/config — saved"],
      ])
    );
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
    routes(
      new Map([
        [`GET ${base}/config`, CONFIG],
        [`GET ${base}/approvals`, NONE],
        [
          `PUT ${base}/config`,
          "PUT /api/operator/tenants/[id]/config — held for approval",
        ],
        [
          `DELETE ${base}/config?key=max_devices_per_player`,
          "DELETE /api/operator/tenants/[id]/config — the platform default again",
        ],
      ])
    );
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
    const refused = `${DECIDE} refused (its own requester)`;
    const id = heldId(HELD);
    routes(
      new Map([
        [`GET ${base}/config`, CONFIG],
        [`GET ${base}/approvals`, HELD],
        [`POST ${base}/approvals/${id}`, refused],
      ])
    );
    await open();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Approve the held change Setting moderation.strike_ban_threshold",
      })
    );
    await screen.findByText(
      `Setting moderation.strike_ban_threshold: ${messageOf(refused)}`
    );
    const post = fetchMock.mock.calls.find(([u]) => u === `${base}/approvals/${id}`) as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(post[1].body))).toEqual({
      decision: "approve",
      source: "config-approval",
    });
  });

  // TASK-194 round 17: an operator's decision is read as the Approvals panel reads it — the shared
  // reader (decision-outcome.ts): what became of the approval, and when; the list read again.
  it.each([
    [
      `${DECIDE} approved, its apply settling`,
      "Its outcome is being checked: if it did not apply, it is listed again within 75 minutes.",
    ],
    [
      `${DECIDE} approved, stale and withdrawn`,
      "It was withdrawn; the requester must ask again.",
    ],
  ])(
    "a decision's outcome (%s) is said as the Approvals panel says it, and the list read again",
    async (answer, then) => {
      const said = `Setting moderation.strike_ban_threshold: ${messageOf(answer)} ${then}`;
      routes(
        new Map([
          [`GET ${base}/config`, CONFIG],
          [`GET ${base}/approvals`, HELD],
          [`POST ${base}/approvals/${heldId(HELD)}`, answer],
        ])
      );
      await open();
      const reads = () =>
        fetchMock.mock.calls.filter(([u]) => u === `${base}/approvals`).length;
      const before = reads();
      fireEvent.click(
        screen.getByRole("button", {
          name: "Approve the held change Setting moderation.strike_ban_threshold",
        })
      );
      await screen.findByText(said);
      await waitFor(() => expect(reads()).toBe(before + 1));
    }
  );

  it("an undecided held change offers its three decisions, and withdraws it through the operator route (round 7, I-3)", async () => {
    const UNDECIDED =
      "GET /api/operator/tenants/[id]/approvals — an undecided erasure no one in it may decide";
    const undecided = bodyOf<{ approvals: { id: string; undecided?: boolean }[] }>(
      UNDECIDED
    ).approvals.find((a) => a.undecided)!;
    routes(
      new Map([
        [`GET ${base}/config`, CONFIG],
        [`GET ${base}/approvals`, UNDECIDED],
        [
          `POST ${base}/approvals/${undecided.id}`,
          `${DECIDE} an undecided erasure withdrawn`,
        ],
      ])
    );
    await open();
    // No one in the tenant may decide it: said, for the operator.
    expect(
      screen.getByText(
        "No one in this tenant but its requester and the account it acts on may approve it again or mark it executed (another holder who fails its rules may only withdraw it): decide it here."
      )
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: `Approve the held change ${ERASE} again` })
    ).toBeNull();
    expect(
      screen.getByRole("button", {
        // Named in words (TASK-202, N-62): the tool's id was the label.
        name: `Mark ${ERASE} executed: verified that it took effect`,
      })
    ).toBeDefined();
    expect(
      screen.getByRole("button", {
        name: `Approve ${ERASE} again: verified that it did not take effect`,
      })
    ).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", {
        name: `Withdraw ${ERASE}: verified that it did not take effect; it will not run`,
      })
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => u === `${base}/approvals/${undecided.id}`)
      ).toBe(true)
    );
    const post = fetchMock.mock.calls.find(
      ([u]) => u === `${base}/approvals/${undecided.id}`
    ) as [string, RequestInit];
    expect(JSON.parse(String(post[1].body))).toEqual({
      decision: "withdraw",
      source: "runtime",
    });
  });

  it("an undecided duplicate refused approval again says what to do with it (round 8, item 1)", async () => {
    const UNDECIDED =
      "GET /api/operator/tenants/[id]/approvals — an undecided erasure no one in it may decide";
    const undecided = bodyOf<{ approvals: { id: string; undecided?: boolean }[] }>(
      UNDECIDED
    ).approvals.find((a) => a.undecided)!;
    routes(
      new Map([
        [`GET ${base}/config`, CONFIG],
        [`GET ${base}/approvals`, UNDECIDED],
        [
          `POST ${base}/approvals/${undecided.id}`,
          `${DECIDE} an undecided erasure approved again, another open`,
        ],
      ])
    );
    await open();
    fireEvent.click(
      screen.getByRole("button", {
        name: `Approve ${ERASE} again: verified that it did not take effect`,
      })
    );
    // As the Approvals panel says it (round 17: one reader): an erasure's duplicate is named.
    await screen.findByText(
      renderMessage("screens.held.result_duplicate_undecided", {
        label: ERASE,
      })
    );
    expect(
      renderMessage("screens.held.result_duplicate_undecided", {
        label: "purge_user_data",
      })
    ).toMatch(/withdraw it/);
  });

  it("an unreadable tenant's settings say why; Close removes the panel", async () => {
    const refused =
      "GET /api/operator/tenants/[id]/config — refused (a single deployment)";
    routes(
      new Map([
        [`GET ${base}/config`, refused],
        [
          `GET ${base}/approvals`,
          "GET /api/operator/tenants/[id]/approvals — refused (a single deployment)",
        ],
      ])
    );
    await open();
    expect(screen.getByText(`Settings of Acme: ${messageOf(refused)}`)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("heading", { name: "Settings of Acme" })).toBeNull();
  });
});
