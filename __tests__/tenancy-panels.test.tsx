/**
 * @jest-environment jsdom
 */
/**
 * __tests__/tenancy-panels.test.tsx — the tenant's own settings and the operators' tenants
 * console on the console's shared parts (TASK-221; SCREEN-FINDINGS Tenancy, E-87 to E-89, E-91)
 *
 * Each case names the finding it holds; each is fed the routes' own answers
 * (__tests__/fixtures/route-responses.json), so a screen and its route cannot drift apart.
 */
import { renderMessage } from "@/platform/errors/messages";
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
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

/** A route's own answer, as fetch resolves it. */
function reply(name: string) {
  const [status, body] = routeAnswer(name as RouteFixtureName);
  return {
    ok: status < 400,
    status,
    json: async () => body,
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}
/** Answer each call in turn with these routes' answers; the last answer repeats. */
function answers(...list: string[]) {
  let i = 0;
  fetchMock.mockImplementation(async () => reply(list[Math.min(i++, list.length - 1)]!));
}
const bodyOf = <T,>(name: string) => routeAnswer(name as RouteFixtureName)[1] as T;
const sent = (n: number) => {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit | undefined];
  return {
    url,
    method: init?.method ?? "GET",
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
};
const t = (key: string, v?: Record<string, string | number>) =>
  renderMessage(`screens.tenancy.${key}`, v);
const ts = (key: string, v?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.tenant_settings.${key}`, v);
const allow =
  (...granted: string[]) =>
  (code: string) =>
    granted.includes(code);

const TENANT = bodyOf<Record<string, unknown>>(
  "GET /api/admin/tenant — a shared deployment's tenant, its spend under the cap"
);
const TENANTS = bodyOf<Record<string, unknown>>(
  "GET /api/operator/tenants — every state"
);

describe("TenantSettingsView (a tenant's administrators)", () => {
  it("shows the tenant: its name, kind, state by name, short name, addresses and spend (SF-admin-118)", () => {
    render(<TenantSettingsView data={TENANT} />);
    expect(screen.getByRole("heading", { name: "Acme" })).toBeDefined();
    expect(screen.getByText(t("kind_shared"))).toBeDefined();
    // The state by its name, in the console's case — never the stored "active".
    expect(screen.getByText("Active")).toBeDefined();
    expect(screen.queryByText("active")).toBeNull();
    expect(screen.getByText("acme.example.com")).toBeDefined();
    expect(screen.getByText(/12\.50 of .*100\.00 today/)).toBeDefined();
  });

  it("a body without its tenant is said as a failed read — never 'Loading…' for ever (E-4)", () => {
    render(<TenantSettingsView data={{}} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/Could not read/);
  });

  it("settings it may not see are said with the permission — never an empty list", () => {
    render(<TenantSettingsView data={{ ...TENANT, settings: null }} />);
    expect(screen.getByText(/settings are not shown to you/)).toBeDefined();
    expect(screen.queryByRole("table", { name: /Settings of/ })).toBeNull();
  });

  it("[E-91] a setting's change is offered only with its tier's permission, else disabled with why", () => {
    render(
      <TenantSettingsView data={TENANT} hasPermission={allow("config_manage_standard")} />
    );
    // The safety setting: this admin holds only the standard tier.
    fireEvent.click(screen.getByRole("button", { name: /^Open Signups enabled/ }));
    const panel = screen.getByRole("region", { name: "Signups enabled" });
    const edit = within(panel).getByRole("button", { name: ts("edit") });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAccessibleDescription(/Needs the permission/);
    expect(within(panel).getByRole("button", { name: ts("use_default") })).toBeDisabled();
  });

  it("[SF-admin-110] a number is edited by its type: out of range said at its field; the change confirmed now → after, with its comment", async () => {
    answers(
      "PUT /api/admin/config — saved",
      "GET /api/admin/tenant — a shared deployment's tenant, its spend under the cap"
    );
    const reload = jest.fn();
    render(
      <TenantSettingsView
        data={TENANT}
        hasPermission={allow("config_manage_standard")}
        onReload={reload}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Open Max devices per player/ }));
    fireEvent.click(screen.getByRole("button", { name: ts("edit") }));
    const field = screen.getByLabelText(/New value/);
    // The range is said before the mistake.
    expect(field).toHaveAccessibleDescription(/1.*20/);
    fireEvent.change(field, { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: ts("review") }));
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: ts("review") }));
    const confirm = screen.getByRole("alertdialog");
    expect(confirm).toHaveFocus();
    expect(confirm.querySelector("[data-diff]")).toHaveTextContent(/3.*7/);
    // The comment is required, and said at its field.
    fireEvent.click(within(confirm).getByRole("button", { name: ts("save") }));
    expect(within(confirm).getByRole("alert")).toHaveTextContent(/at least 3 characters/);
    fireEvent.change(within(confirm).getByLabelText(/Reason/), {
      target: { value: "more devices for the pilot" },
    });
    fireEvent.click(within(confirm).getByRole("button", { name: ts("save") }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0)).toEqual({
      url: "/api/admin/config",
      method: "PUT",
      body: {
        key: "max_devices_per_player",
        value: 7,
        changeComment: "more devices for the pilot",
      },
    });
    // The value is a number, never the text typed; the outcome names the change.
    expect(await screen.findByText(/Max devices per player set to 7/)).toBeDefined();
    expect(reload).toHaveBeenCalled();
  });

  it("an on/off setting is a checkbox; a held change says it waits — nothing changed yet", async () => {
    answers("PUT /api/admin/config — held for approval");
    const reload = jest.fn();
    render(
      <TenantSettingsView
        data={TENANT}
        hasPermission={allow("config_manage_safety")}
        onReload={reload}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Open Signups enabled/ }));
    fireEvent.click(screen.getByRole("button", { name: ts("edit") }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: ts("review") }));
    fireEvent.change(screen.getByLabelText(/Reason/), {
      target: { value: "open signups" },
    });
    fireEvent.click(screen.getByRole("button", { name: ts("save") }));
    const held = await screen.findByText(/Signups enabled set to/);
    expect(held.closest("[data-outcome]")).toHaveAttribute("data-outcome", "held");
    expect(sent(0).body.value).toBe(true);
    // Held: it is listed among the changes waiting for approval — read again.
    expect(reload).toHaveBeenCalled();
  });

  it("the settings: filtered by name, opened by a click on the row; each step can be cancelled; Close shuts the panel", () => {
    render(<TenantSettingsView data={TENANT} showIds />);
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "signups" } });
    expect(
      screen.queryByRole("button", { name: /^Open Max devices per player/ })
    ).toBeNull();
    fireEvent.change(search, { target: { value: "no such setting at all" } });
    expect(screen.getByText(/no such setting at all/)).toBeDefined();
    fireEvent.change(search, { target: { value: "" } });
    const table = screen.getByRole("table", { name: /Settings of/ });
    // With Show details the stored key is there to copy.
    expect(within(table).getAllByText("signups_enabled").length).toBeGreaterThan(0);
    const regions = screen.queryAllByRole("region").length;
    fireEvent.click(within(table).getAllByRole("row")[1]!);
    expect(screen.getAllByRole("region")).toHaveLength(regions + 1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryAllByRole("region")).toHaveLength(regions);
  });

  it("a change and a reset can each be cancelled at their confirm step — nothing sent", () => {
    render(
      <TenantSettingsView data={TENANT} hasPermission={allow("config_manage_standard")} />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Open Max devices per player/ }));
    fireEvent.click(screen.getByRole("button", { name: ts("edit") }));
    fireEvent.change(screen.getByLabelText(/New value/), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: ts("review") }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: /Cancel/ })
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const reset = screen.queryByRole("button", { name: ts("use_default") });
    if (reset && !(reset as HTMLButtonElement).disabled) {
      fireEvent.click(reset);
      fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", { name: /Cancel/ })
      );
      expect(screen.queryByRole("alertdialog")).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with no permission given, a setting's change is not offered", () => {
    render(<TenantSettingsView data={TENANT} />);
    fireEvent.click(screen.getByRole("button", { name: /^Open Signups enabled/ }));
    expect(screen.getByRole("button", { name: ts("edit") })).toBeDisabled();
  });

  it("Use the platform default is confirmed, then sent as a DELETE of the key", async () => {
    answers("DELETE /api/admin/config — the platform default again");
    render(
      <TenantSettingsView data={TENANT} hasPermission={allow("config_manage_safety")} />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Open Signups enabled/ }));
    fireEvent.click(screen.getByRole("button", { name: ts("use_default") }));
    const confirm = screen.getByRole("alertdialog");
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: ts("use_default") }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0)).toMatchObject({
      url: "/api/admin/config?key=signups_enabled",
      method: "DELETE",
    });
    expect(
      await screen.findByText(/Signups enabled follows the platform default/)
    ).toBeDefined();
  });
});

describe("OperatorTenantsView (operators)", () => {
  const open = (name: string) =>
    fireEvent.click(
      screen.getByRole("button", { name: t("open_tenant", { tenant: name }) })
    );

  it("lists tenants by name in a table that fits a phone: state by name, no actions column (SF-admin-112)", () => {
    render(<OperatorTenantsView data={TENANTS} />);
    const table = screen.getByRole("table", { name: t("tenants_caption") });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual([
      t("col_tenant"),
      t("col_state"),
      t("col_users"),
      t("col_addresses"),
    ]);
    expect(within(table).getAllByText("Suspended").length).toBeGreaterThan(0);
    expect(within(table).queryByText("suspended")).toBeNull();
  });

  it("a tenant opens in its own panel, heading focused; Close gives focus back to its row (SF-admin-112)", async () => {
    render(<OperatorTenantsView data={TENANTS} />);
    open("Acme");
    const heading = screen.getByRole("heading", { name: "Acme" });
    await waitFor(() => expect(heading).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: t("open_tenant", { tenant: "Acme" }) })
      ).toHaveFocus()
    );
  });

  it("[E-87 to E-89, SF-admin-117] suspending is confirmed, says who is locked out, and asks why", async () => {
    answers("POST /api/operator/tenants/[id]/state — suspended");
    const reload = jest.fn();
    render(<OperatorTenantsView data={TENANTS} onReload={reload} />);
    open("Acme");
    fireEvent.click(
      screen.getByRole("button", { name: t("suspend_label", { tenant: "Acme" }) })
    );
    const confirm = screen.getByRole("alertdialog", {
      name: t("confirm_suspend", { tenant: "Acme" }),
    });
    expect(confirm).toHaveTextContent(/Everyone in the tenant is locked out/);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(within(confirm).getByLabelText(/Reason/), {
      target: { value: "unpaid invoices" },
    });
    fireEvent.click(within(confirm).getByRole("button", { name: t("suspend") }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0)).toEqual({
      url: "/api/operator/tenants/aaaaaaaa-0000-4000-8000-0000000000a1/state",
      method: "POST",
      body: { action: "suspend", reason: "unpaid invoices" },
    });
    expect(await screen.findByText(t("suspend_label", { tenant: "Acme" }))).toBeDefined();
    expect(reload).toHaveBeenCalled();
  });

  it("[E-87 to E-89] removing an address is confirmed before the DELETE", async () => {
    answers("DELETE /api/operator/tenants/[id]/domains — removed");
    render(<OperatorTenantsView data={TENANTS} />);
    open("Acme");
    fireEvent.click(
      screen.getByRole("button", {
        name: t("remove_address", { host: "acme.example.com" }),
      })
    );
    expect(fetchMock).not.toHaveBeenCalled();
    const confirm = screen.getByRole("alertdialog");
    expect(confirm).toHaveTextContent(/no longer served/);
    fireEvent.click(within(confirm).getByRole("button", { name: t("remove") }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0)).toMatchObject({
      url: "/api/operator/tenants/aaaaaaaa-0000-4000-8000-0000000000a1/domains?host=acme.example.com",
      method: "DELETE",
    });
  });

  it("[SF-admin-114] one's own deletion request is said, and Approve is not offered on it", () => {
    render(<OperatorTenantsView data={TENANTS} />);
    open("Doomed");
    expect(screen.getByText(/\(you asked for it\)/)).toBeDefined();
    const approve = screen.getByRole("button", {
      name: t("approve_deletion_label", { tenant: "Doomed" }),
    });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription(t("approve_own"));
    expect(
      screen.getByRole("button", {
        name: t("reject_deletion_label", { tenant: "Doomed" }),
      })
    ).toBeEnabled();
  });

  it("[SF-admin-114] another operator's request is named by address, and Approve is offered", () => {
    const other = JSON.parse(JSON.stringify(TENANTS)) as {
      tenants: { pendingDeletion?: Record<string, unknown> }[];
    };
    for (const x of other.tenants)
      if (x.pendingDeletion)
        x.pendingDeletion = {
          ...x.pendingDeletion,
          byViewer: false,
          requester: { email: "op-b@example.com", role: "Operator", erased: false },
        };
    render(<OperatorTenantsView data={other} />);
    open("Doomed");
    expect(screen.getAllByText("op-b@example.com").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", {
        name: t("approve_deletion_label", { tenant: "Doomed" }),
      })
    ).toBeEnabled();
  });

  it("[E-87 to E-89] rejecting a deletion is confirmed, and its refusal is said with its reason", async () => {
    answers("POST /api/operator/deletions/[id] — refused (its own requester)");
    render(<OperatorTenantsView data={TENANTS} />);
    open("Doomed");
    fireEvent.click(
      screen.getByRole("button", {
        name: t("reject_deletion_label", { tenant: "Doomed" }),
      })
    );
    const confirm = screen.getByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: t("reject_deletion") }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0)).toMatchObject({
      url: "/api/operator/deletions/aaaaaaaa-0000-4000-8000-0000000000f1",
      method: "POST",
      body: { decision: "reject" },
    });
    await waitFor(() =>
      expect(document.querySelector("[data-outcome='refused']")).not.toBeNull()
    );
  });

  it("[SF-admin-113] making an administrator checks the address at its field, and says who, of which tenant", async () => {
    answers("POST /api/operator/tenants/[id]/admins — made administrator");
    render(<OperatorTenantsView data={TENANTS} />);
    open("Acme");
    fireEvent.click(
      screen.getByRole("button", { name: t("make_admin_label", { tenant: "Acme" }) })
    );
    const email = screen.getByLabelText(t("email"));
    fireEvent.change(email, { target: { value: "not an address" } });
    fireEvent.click(screen.getByRole("button", { name: t("review") }));
    expect(email).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(email, { target: { value: "ann@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: t("review") }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: t("make_admin"),
      })
    );
    expect(
      await screen.findByText(
        t("made_admin", { email: "ann@example.com", tenant: "Acme" })
      )
    ).toBeDefined();
  });

  it("[E-87 to E-89, SF-admin-113] purging due tenants cannot be undone, is confirmed, and says what was purged", async () => {
    answers("POST /api/operator/purge — none due");
    render(<OperatorTenantsView data={TENANTS} />);
    fireEvent.click(screen.getByRole("button", { name: t("purge_due") }));
    const confirm = screen.getByRole("alertdialog", { name: t("confirm_purge") });
    expect(confirm).toHaveAttribute("data-risk", "irreversible");
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: t("purge_due") }));
    expect(await screen.findByText(t("purge_none_done"))).toBeDefined();
    expect(sent(0)).toMatchObject({ url: "/api/operator/purge", method: "POST" });
  });

  it("[SF-admin-119] readiness: a checking state, each check by name, and the time of the check", async () => {
    answers("GET /api/operator/readiness — this deployment");
    render(<OperatorTenantsView data={TENANTS} />);
    fireEvent.click(screen.getByRole("button", { name: t("check") }));
    expect(screen.getByText(t("checking"))).toBeDefined();
    expect(await screen.findByText(/Checked at/)).toBeDefined();
    const checks = bodyOf<{ checks: { name: string }[] }>(
      "GET /api/operator/readiness — this deployment"
    ).checks;
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks)
      expect(
        document
          .querySelector(`[data-check="${c.name}"]`)
          ?.textContent?.startsWith(`${c.name}:`)
      ).toBe(false);
  });

  it("[SF-admin-111] the tenant's held changes are the Approvals card: what, before and after, who asked, when", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/approvals")
        ? reply("GET /api/operator/tenants/[id]/approvals — a setting's held change")
        : reply(
            "GET /api/operator/tenants/[id]/config — every setting, one only operators set"
          )
    );
    render(
      <OperatorTenantsView data={TENANTS} hasPermission={() => true} viewerId="someone" />
    );
    open("Acme");
    fireEvent.click(screen.getByRole("button", { name: t("tab_settings") }));
    const li = await waitFor(() => {
      const found = document.querySelector("li[data-approval]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(li.querySelector("[data-diff]")).not.toBeNull();
    expect(li.querySelector("time")).not.toBeNull();
    expect(li.querySelector("[data-requester]")).not.toBeNull();
    // A decision is the Approvals confirm step — never one click.
    fireEvent.click(
      within(li as HTMLElement).getAllByRole("button", { name: /^Approve/ })[0]!
    );
    expect(within(li as HTMLElement).getByRole("alertdialog")).toBeDefined();
  });

  it("[SF-admin-115] a refused read of the held changes is said as one — never 'none'", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/approvals")
        ? reply(
            "GET /api/operator/tenants/[id]/approvals — refused (a single deployment)"
          )
        : reply(
            "GET /api/operator/tenants/[id]/config — every setting, one only operators set"
          )
    );
    render(<OperatorTenantsView data={TENANTS} hasPermission={() => true} />);
    open("Acme");
    fireEvent.click(screen.getByRole("button", { name: t("tab_settings") }));
    await waitFor(() =>
      expect(document.querySelector("[data-read-failed='true']")).not.toBeNull()
    );
    expect(screen.queryByText(t("held_none"))).toBeNull();
  });

  it("[SF-admin-116] the export says it is working, and a refused one is said — nothing saved", async () => {
    answers("GET /api/operator/readiness — refused (no permission)");
    render(<OperatorTenantsView data={TENANTS} />);
    open("Acme");
    fireEvent.click(
      screen.getByRole("button", { name: t("export_label", { tenant: "Acme" }) })
    );
    expect(screen.getByText(t("exporting_status", { tenant: "Acme" }))).toBeDefined();
    await waitFor(() =>
      expect(document.querySelector("[data-outcome='refused']")).not.toBeNull()
    );
    expect(sent(0)).toMatchObject({
      url: "/api/operator/tenants/aaaaaaaa-0000-4000-8000-0000000000a1/export",
      method: "GET",
    });
  });

  it("[SF-admin-116] an export that stopped part-way is not saved as if it were whole", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-disposition": 'attachment; filename="tenant-x.ndjson"',
      }),
      blob: async () =>
        new Blob(['{"export":{}}\n{"table":"t","row":{}}\n{"error":"export_failed"}\n']),
    } as unknown as Response);
    render(<OperatorTenantsView data={TENANTS} />);
    open("Acme");
    fireEvent.click(
      screen.getByRole("button", { name: t("export_label", { tenant: "Acme" }) })
    );
    expect(await screen.findByText(t("export_incomplete"))).toBeDefined();
  });

  it("provisioning says what is missing at its field, then confirms the tenant read back", async () => {
    answers("POST /api/operator/tenants — provisioned");
    render(<OperatorTenantsView data={TENANTS} />);
    const form = screen.getByRole("form", { name: t("provision_heading") });
    fireEvent.click(within(form).getByRole("button", { name: t("review") }));
    expect(within(form).getByLabelText(t("slug"))).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    fireEvent.change(within(form).getByLabelText(t("slug")), {
      target: { value: "zeta" },
    });
    fireEvent.change(within(form).getByLabelText(t("name")), {
      target: { value: "Zeta" },
    });
    fireEvent.change(within(form).getByLabelText(t("domains")), {
      target: { value: "zeta.example.com, www.zeta.example.com" },
    });
    fireEvent.click(within(form).getByRole("button", { name: t("review") }));
    const confirm = screen.getByRole("alertdialog");
    expect(confirm).toHaveTextContent("zeta.example.com, www.zeta.example.com");
    fireEvent.click(within(confirm).getByRole("button", { name: t("provision") }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0).body).toEqual({
      slug: "zeta",
      name: "Zeta",
      domains: ["zeta.example.com", "www.zeta.example.com"],
    });
    expect(
      await screen.findByText(t("what_provision", { tenant: "Zeta" }))
    ).toBeDefined();
  });
});

describe("OperatorTenantsView: each step, each answer", () => {
  const open = (name: string) =>
    fireEvent.click(
      screen.getByRole("button", { name: t("open_tenant", { tenant: name }) })
    );

  it("asking to delete a tenant is confirmed with its reason, and said as held for a second operator", async () => {
    answers("POST /api/operator/tenants/[id]/deletion — requested");
    render(<OperatorTenantsView data={TENANTS} />);
    open("Acme");
    fireEvent.click(
      screen.getByRole("button", { name: t("delete_label", { tenant: "Acme" }) })
    );
    let confirm = screen.getByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: t("cancel") }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: t("delete_label", { tenant: "Acme" }) })
    );
    confirm = screen.getByRole("alertdialog");
    fireEvent.change(within(confirm).getByLabelText(/Reason/), {
      target: { value: "the contract ended" },
    });
    fireEvent.click(within(confirm).getByRole("button", { name: t("delete") }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0)).toEqual({
      url: "/api/operator/tenants/aaaaaaaa-0000-4000-8000-0000000000a1/deletion",
      method: "POST",
      body: { reason: "the contract ended" },
    });
    await waitFor(() =>
      expect(document.querySelector("[data-outcome='held']")).not.toBeNull()
    );
  });

  it("adding an address: needed at its field, then confirmed", async () => {
    answers("POST /api/operator/tenants/[id]/domains — added");
    render(<OperatorTenantsView data={TENANTS} />);
    open("Acme");
    fireEvent.click(
      screen.getByRole("button", { name: t("add_address_label", { tenant: "Acme" }) })
    );
    fireEvent.click(screen.getByRole("button", { name: t("review") }));
    expect(screen.getByLabelText(t("address"))).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(screen.getByLabelText(t("address")), {
      target: { value: "shop.acme.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: t("review") }));
    const confirm = screen.getByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: t("add_address") }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0)).toMatchObject({
      url: "/api/operator/tenants/aaaaaaaa-0000-4000-8000-0000000000a1/domains",
      method: "POST",
      body: { host: "shop.acme.example.com" },
    });
  });

  it("another operator's deletion request: Approve is the confirm step, sent as approve", async () => {
    const other = JSON.parse(JSON.stringify(TENANTS)) as {
      tenants: { pendingDeletion?: Record<string, unknown> }[];
    };
    for (const x of other.tenants)
      if (x.pendingDeletion)
        x.pendingDeletion = { ...x.pendingDeletion, byViewer: false };
    answers("POST /api/operator/deletions/[id] — refused (its own requester)");
    render(<OperatorTenantsView data={other} />);
    open("Doomed");
    fireEvent.click(
      screen.getByRole("button", {
        name: t("approve_deletion_label", { tenant: "Doomed" }),
      })
    );
    const confirm = screen.getByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: t("approve_deletion") }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0).body).toMatchObject({ decision: "approve" });
  });

  it("purging says each tenant purged by name and its rows; cancelling sends nothing", async () => {
    answers("POST /api/operator/purge — one purged");
    render(<OperatorTenantsView data={TENANTS} />);
    fireEvent.click(screen.getByRole("button", { name: t("purge_due") }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: t("cancel") })
    );
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("purge_due") }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: t("purge_due"),
      })
    );
    const done = await screen.findByText(/Gone/, { selector: "[data-outcome] *" });
    expect(done.closest("[data-outcome]")?.textContent).toContain(
      t("purge_one", { tenant: "Gone", rows: 12 })
    );
  });

  it("a readiness check that is refused is said, and can be tried again", async () => {
    answers("GET /api/operator/readiness — refused (no permission)");
    render(<OperatorTenantsView data={TENANTS} />);
    fireEvent.click(screen.getByRole("button", { name: t("check") }));
    await waitFor(() =>
      expect(document.querySelector("[data-read-failed='true']")).not.toBeNull()
    );
    fireEvent.click(screen.getByRole("button", { name: /again/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("provisioning can be cancelled at its confirm step; a row opens by a click anywhere on it", () => {
    render(<OperatorTenantsView data={TENANTS} />);
    const form = screen.getByRole("form", { name: t("provision_heading") });
    fireEvent.change(within(form).getByLabelText(t("slug")), {
      target: { value: "zeta" },
    });
    fireEvent.change(within(form).getByLabelText(t("name")), {
      target: { value: "Zeta" },
    });
    fireEvent.click(within(form).getByRole("button", { name: t("review") }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: t("cancel") })
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    const table = screen.getByRole("table", { name: t("tenants_caption") });
    fireEvent.click(within(table).getAllByRole("row")[1]!);
    expect(screen.getAllByRole("region").length).toBeGreaterThan(0);
  });

  it("a held change decided in the tenant's settings reads its settings and held changes again", async () => {
    let approvalsRead = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST")
        return reply(
          "POST /api/operator/tenants/[id]/approvals/[approvalId] — approved, its apply settling"
        );
      if (String(url).endsWith("/approvals")) {
        approvalsRead++;
        return reply(
          "GET /api/operator/tenants/[id]/approvals — a setting's held change"
        );
      }
      return reply(
        "GET /api/operator/tenants/[id]/config — every setting, one only operators set"
      );
    });
    render(
      <OperatorTenantsView data={TENANTS} hasPermission={() => true} viewerId="someone" />
    );
    open("Acme");
    fireEvent.click(screen.getByRole("button", { name: t("tab_settings") }));
    const li = (await waitFor(() => {
      const found = document.querySelector("li[data-approval]");
      expect(found).not.toBeNull();
      return found!;
    })) as HTMLElement;
    fireEvent.click(within(li).getAllByRole("button", { name: /^Approve/ })[0]!);
    const confirm = within(li).getByRole("alertdialog");
    const note = within(confirm).queryByLabelText(/Reason|Note/);
    if (note) fireEvent.change(note, { target: { value: "looks right to me" } });
    fireEvent.click(within(confirm).getAllByRole("button", { name: /^Approve/ })[0]!);
    await waitFor(() => expect(approvalsRead).toBeGreaterThan(1));
  });

  it("a body without its list is said as a failed read", () => {
    render(<OperatorTenantsView data={{}} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/Could not read/);
  });
});
