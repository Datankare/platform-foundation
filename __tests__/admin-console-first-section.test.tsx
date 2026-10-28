/**
 * @jest-environment jsdom
 */
/**
 * app/admin — the console reads no panel before the session says what this admin may open, and
 * opens on the first section it permits (TASK-184).
 *
 * The page opened "roles" at once and read `/api/admin/roles` before `GET /api/admin/session`
 * answered; the shell, mounted while the session was still loading, fell back to "users" and read
 * that too. A moderator (can_access_admin, can_moderate) was refused both (403) and saw a heading
 * over data it could not load; every admin got the same 403s before the second-factor check. Now
 * the initial panel is the first of AdminShell's `permittedSections` (the one mapping), nothing is
 * read while loading, for `auth.mfa_required` or for a refused session, and a role with no section
 * is told so — a safety net: the platform's session route requires can_access_admin, which always
 * opens Approvals and Tenant.
 */
import React from "react";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const push = jest.fn();
const replace = jest.fn();
const signOut = jest.fn(async () => undefined);
jest.mock("next/navigation", () => ({ useRouter: () => ({ push, replace }) }));
jest.mock("@/platform/auth/context", () => ({
  ...jest.requireActual("@/platform/auth/context"),
  useAuth: () => ({ signOut }),
}));

import AdminPage from "@/app/admin/page";
import AdminShell, { permittedSections } from "@/components/admin/AdminShell";
import { renderMessage } from "@/platform/errors/messages";

const NO_SECTIONS = renderMessage("screens.admin_console.no_sections");
const MFA_TITLE = renderMessage("screens.mfa.title");
const REFUSED = renderMessage("screens.admin_console.refused");
const MODERATOR = ["can_access_admin", "can_moderate"];

/** Each panel's data route and the permission its route checks (the server's, unchanged). */
const PANEL_ROUTES: Record<string, string> = {
  "/api/admin/users": "admin_manage_users",
  "/api/admin/roles": "admin_manage_roles",
  "/api/admin/entitlements": "admin_manage_entitlements",
  "/api/admin/audit": "admin_view_audit",
  "/api/admin/approvals": "can_access_admin",
  "/api/admin/password-policy": "admin_manage_config",
  "/api/admin/agent-registry": "admin_manage_agents",
  "/api/admin/per-account": "admin_manage_account_restrictions",
  "/api/admin/approval-policy": "admin_manage_approval_policy",
  "/api/admin/capabilities": "admin_view_audit",
  "/api/admin/capability-mapping": "admin_manage_config",
  "/api/admin/tenant": "can_access_admin",
  "/api/operator/tenants": "platform_operate",
  "/api/operator/jobs": "platform_operate",
};

const path = (url: unknown) => String(url).split("?")[0];

const fetchMock = jest.fn();
/** Every request the page made, by path. */
const requested = () => fetchMock.mock.calls.map(([u]) => path(u));
const panelReads = () => requested().filter((p) => p in PANEL_ROUTES);

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/**
 * A server that answers the session with `session` and each panel route as its permission
 * check would: 200 when held, 403 when not — so a forbidden read shows up as a 403 response.
 */
function serve(session: () => unknown, granted: readonly string[]) {
  const holds = (p: string) => granted.includes("*") || granted.includes(p);
  fetchMock.mockImplementation(async (url: unknown) => {
    const p = path(url);
    if (p === "/api/admin/session") return session();
    const permission = PANEL_ROUTES[p];
    if (permission === undefined) return json(404, {});
    if (!holds(permission)) return json(403, { code: "auth.permission_denied" });
    return json(200, p === "/api/admin/approvals" ? { approvals: [] } : {});
  });
}

const admin = (roleName: string, permissions: unknown[]) => () =>
  json(200, { roleName, permissions });

/** Lets every pending promise and effect run (the page reads in effects). */
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());
}

/** No request the page made was refused for permission. */
async function noRefusedRead() {
  for (const result of fetchMock.mock.results) {
    const res = (await result.value) as { status: number };
    expect(res.status).not.toBe(403);
  }
}

beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
  replace.mockReset();
  signOut.mockClear();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("the one mapping: permittedSections (AdminShell's order)", () => {
  it("a moderator may open Approvals, then Tenant — nothing else", () => {
    expect(permittedSections((c) => MODERATOR.includes(c))).toEqual([
      "approvals",
      "tenant",
    ]);
  });
  it("everything ('*') opens on Users, the shell's first section", () => {
    expect(permittedSections(() => true)[0]).toBe("users");
  });
  it("nothing held: no section", () => {
    expect(permittedSections(() => false)).toEqual([]);
  });
  it("the shell with no section renders and reports nothing — no fallback section", () => {
    const onSectionChange = jest.fn();
    const children = jest.fn(() => <div data-testid="content" />);
    render(
      <AdminShell
        adminName="x"
        hasPermission={() => false}
        onSignOut={jest.fn()}
        onSectionChange={onSectionChange}
      >
        {children}
      </AdminShell>
    );
    expect(onSectionChange).not.toHaveBeenCalled();
    expect(children).not.toHaveBeenCalled();
  });
});

describe("the console's first panel (TASK-184)", () => {
  it("a moderator opens on Approvals, reads only it, and is refused nothing", async () => {
    serve(admin("moderator", MODERATOR), MODERATOR);
    render(<AdminPage />);
    await waitFor(() => expect(panelReads()).toEqual(["/api/admin/approvals"]));
    await settle();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("approvals");
    expect(requested()).not.toContain("/api/admin/roles");
    expect(requested()).not.toContain("/api/admin/users");
    expect(panelReads()).toEqual(["/api/admin/approvals"]);
    await noRefusedRead();
    // Only the sections it may open are offered; the second one reads its own route.
    expect(screen.queryByText("Roles")).toBeNull();
    fireEvent.click(screen.getByText("Tenant"));
    await waitFor(() =>
      expect(panelReads()).toEqual(["/api/admin/approvals", "/api/admin/tenant"])
    );
    await noRefusedRead();
  });

  it("the session is read first; no panel read starts before it answers", async () => {
    let answer: (v: unknown) => void = () => undefined;
    fetchMock.mockImplementation(async (url: unknown) => {
      const p = path(url);
      if (p === "/api/admin/session") return new Promise((resolve) => (answer = resolve));
      return json(200, { approvals: [] });
    });
    render(<AdminPage />);
    await settle();
    expect(requested()).toEqual(["/api/admin/session"]);
    await act(async () =>
      answer(json(200, { roleName: "moderator", permissions: MODERATOR }))
    );
    await waitFor(() => expect(panelReads()).toEqual(["/api/admin/approvals"]));
  });

  it("the dev-bypass admin ('*') opens on the shell's first section, Users — read once, no 403", async () => {
    serve(admin("dev-bypass", ["*"]), ["*"]);
    render(<AdminPage />);
    await waitFor(() => expect(panelReads()).toEqual(["/api/admin/users"]));
    await settle();
    expect(panelReads()).toEqual(["/api/admin/users"]);
    expect(requested()).not.toContain("/api/admin/roles");
    await noRefusedRead();
  });

  it("an admin whose first permitted section is Roles opens on Roles and reads only it", async () => {
    const granted = ["can_access_admin", "admin_manage_roles"];
    serve(admin("roles_admin", granted), granted);
    render(<AdminPage />);
    await waitFor(() => expect(panelReads()).toEqual(["/api/admin/roles"]));
    await settle();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Roles");
    expect(panelReads()).toEqual(["/api/admin/roles"]);
    await noRefusedRead();
  });

  it("non-string permissions are dropped, not trusted: the moderator's sections only", async () => {
    serve(admin("moderator", [null, 42, { code: "*" }, ["*"], ...MODERATOR]), MODERATOR);
    render(<AdminPage />);
    await waitFor(() => expect(panelReads()).toEqual(["/api/admin/approvals"]));
    await settle();
    await noRefusedRead();
  });

  it("while the session is loading: a loading state, no shell, no panel read", async () => {
    fetchMock.mockImplementation((url: unknown) =>
      path(url) === "/api/admin/session"
        ? new Promise(() => undefined)
        : Promise.resolve(json(200, {}))
    );
    render(<AdminPage />);
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(screen.queryByText("Admin Panel")).toBeNull();
    expect(screen.queryByText("Administrator")).toBeNull();
    expect(requested()).toEqual(["/api/admin/session"]);
  });

  // Each waits for the screen the refusal leads to, so a session that never answered fails here.
  it("mfa_required: the enrolment, and no panel read", async () => {
    serve(() => json(403, { code: "auth.mfa_required" }), ["*"]);
    render(<AdminPage />);
    expect(await screen.findByText(MFA_TITLE)).toBeInTheDocument();
    await settle();
    expect(screen.queryByText("Admin Panel")).toBeNull();
    expect(requested()).toEqual(["/api/admin/session"]);
    expect(panelReads()).toEqual([]);
  });

  it("a refused session (no administrative access): the access page, and no panel read", async () => {
    serve(() => json(403, { code: "auth.permission_denied" }), ["*"]);
    render(<AdminPage />);
    expect(await screen.findByText(REFUSED)).toBeInTheDocument();
    await settle();
    expect(screen.queryByText("Admin Panel")).toBeNull();
    expect(requested()).toEqual(["/api/admin/session"]);
    expect(panelReads()).toEqual([]);
  });

  it.each([
    ["no permissions at all", []],
    ["only permissions no section uses", ["can_play", "can_moderate", "admin_unknown"]],
  ])(
    "administrative access with %s: says no section is available, reads nothing",
    async (_label, granted) => {
      serve(admin("odd_role", granted), granted);
      render(<AdminPage />);
      expect(await screen.findByRole("alert")).toHaveTextContent(NO_SECTIONS);
      await settle();
      expect(screen.queryByText("Admin Panel")).toBeNull();
      expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
      expect(panelReads()).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
      await waitFor(() => expect(push).toHaveBeenCalledWith("/auth"));
      expect(signOut).toHaveBeenCalled();
    }
  );

  it("the no-section message is the catalog's, and says what to do", () => {
    expect(NO_SECTIONS).toMatch(/available for your role/);
    expect(NO_SECTIONS).toMatch(/sign out/);
  });
});
