/**
 * @jest-environment jsdom
 */
/**
 * TASK-185 — the admin console's Users screen (components/admin/UsersPanel.tsx), against a mock
 * server: what each row shows (a missing address, a readable role with its stored name, dates
 * that cannot be misread, the standing), search, sort and paging sent to the server, the detail
 * panel, the actions shown only with their permission, a role change held for approval shown as
 * held — never as done — and every refusal the routes can return shown by its code.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  UsersPanel,
  USERS_PAGE_SIZE,
  formatDate,
  readableRole,
  shownEmail,
  shownName,
} from "@/components/admin/UsersPanel";
import { renderMessage } from "@/platform/errors/messages";
import { REFUSAL_HANDLERS } from "@/platform/errors/refusal";
import { USER_ROW_ACTION_PERMISSIONS } from "@/app/api/admin/ai/tool-permissions";
import { ROLE_PERMISSIONS } from "./helpers/test-identities";

const t = (key: string, values?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.users.${key}`, values);

const ROLES = [
  { id: "r-free", name: "free", displayName: "Free" },
  { id: "r-mod", name: "moderator", displayName: "Moderator" },
  { id: "r-super", name: "super_admin", displayName: "Super Admin" },
];

const user = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  email: "ann@example.com",
  displayName: "Ann",
  roleId: "r-free",
  roleName: "free",
  roleDisplayName: "Free",
  status: "active",
  statusUntil: null,
  emailVerified: true,
  createdAt: "2026-10-26T12:00:00.000Z",
  lastSignInAt: "2026-10-27T12:00:00.000Z",
  isDeleted: false,
  entitlements: [],
  ...over,
});

const OLD_STAFF = user({
  id: "22222222-2222-4222-8222-222222222222",
  email: null,
  displayName: "",
  roleId: "r-super",
  roleName: "super_admin",
  roleDisplayName: "Super Admin",
  emailVerified: false,
  createdAt: "2026-06-07T12:00:00.000Z",
  lastSignInAt: null,
});

const respond = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const fetchMock = jest.fn();
type Handler = (url: string, init?: RequestInit) => unknown;
let onList: Handler;
let onPatch: Handler;
let onErase: Handler;

const listCalls = () =>
  fetchMock.mock.calls
    .map(([u, init]) => ({ url: String(u), init: init as RequestInit | undefined }))
    .filter(
      (c) => c.url.startsWith("/api/admin/users?") && (c.init?.method ?? "GET") === "GET"
    )
    .map((c) => new URL(c.url, "http://x").searchParams);

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  onList = () =>
    respond(200, {
      users: [user(), OLD_STAFF],
      roles: ROLES,
      page: { hasMore: false },
    });
  onPatch = () => respond(200, { success: true });
  onErase = () => respond(200, { status: "completed" });
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("/api/admin/users") && init?.method === "PATCH")
      return onPatch(u, init);
    if (u.startsWith("/api/admin/users")) return onList(u, init);
    if (u.startsWith("/api/admin/gdpr")) return onErase(u, init);
    return respond(404, {});
  });
});

const everything = () => true;
const only =
  (...codes: string[]) =>
  (c: string) =>
    codes.includes(c);

async function shown(hasPermission: (c: string) => boolean = everything) {
  render(<UsersPanel hasPermission={hasPermission} />);
  await screen.findByText("ann@example.com");
}

function openRow(label: string) {
  fireEvent.click(screen.getByRole("button", { name: t("open_row", { name: label }) }));
  return screen.getByRole("region", { name: new RegExp(t("detail_title")) });
}

describe("what a row shows", () => {
  it("dates as day, month name, year", () => {
    expect(formatDate("2026-10-26T12:00:00.000Z")).toBe("26 Oct 2026");
    expect(formatDate(null)).toBe("—");
    expect(formatDate("not a date")).toBe("—");
  });

  it.each([
    ["super_admin", "Super Admin", "Super admin"],
    ["safety_approver", "Safety Approver", "Safety approver"],
    ["qa_lead", "QA Lead", "QA lead"],
    ["custom_role", null, "Custom role"],
    ["free", "", "Free"],
  ])("role %p (%p) reads %p", (name, display, expected) => {
    expect(readableRole(name, display)).toBe(expected);
  });

  it("a missing display name falls back to the address, then —", () => {
    expect(shownName({ displayName: "  ", email: "a@x.io" })).toBe("a@x.io");
    expect(shownName({ displayName: null, email: null })).toBe("—");
  });

  it("a missing address, never signed in: never signed in since it was created", () => {
    expect(
      shownEmail({ email: null, lastSignInAt: null, createdAt: OLD_STAFF.createdAt })
    ).toBe("Unknown (never signed in since 7 Jun 2026)");
  });

  it("a missing address on an account that DOES sign in is never 'never signed in': the provider did not give one", () => {
    const text = shownEmail({
      email: "",
      lastSignInAt: "2026-07-01T12:00:00Z",
      createdAt: OLD_STAFF.createdAt,
    });
    expect(text).toBe(
      "Unknown: address not received from the sign-in provider (last sign-in 1 Jul 2026)"
    );
    expect(text).not.toMatch(/never signed in/);
  });

  it("the table: readable role with the stored name as its tooltip, standing, verification, dates", async () => {
    await shown();
    const rows = screen.getAllByRole("row");
    const staff = rows.find((r) =>
      within(r).queryByText(/Unknown \(never signed in since/)
    )!;
    expect(
      within(staff).getByText("Unknown (never signed in since 7 Jun 2026)")
    ).toBeDefined();
    expect(within(staff).getByText("Super admin")).toHaveAttribute(
      "title",
      "super_admin"
    );
    expect(within(staff).getByText(t("never"))).toBeDefined();
    expect(within(staff).getByText(t("no"))).toBeDefined();
    const ann = rows.find((r) => within(r).queryByText("ann@example.com"))!;
    expect(within(ann).getByText("26 Oct 2026")).toBeDefined();
    expect(within(ann).getByText("27 Oct 2026")).toBeDefined();
    expect(within(ann).getByText(t("status_active"))).toBeDefined();
    // No display name and no address: the name column is "—" (and the row is named by its
    // address cell instead).
    expect(within(staff).getByText("—")).toBeDefined();
  });

  it("a restriction with an end date says until when", async () => {
    onList = () =>
      respond(200, {
        users: [user({ status: "suspended", statusUntil: "2026-11-02T12:00:00.000Z" })],
        roles: ROLES,
        page: { hasMore: false },
      });
    await shown();
    expect(screen.getByText("Suspended until 2 Nov 2026")).toBeDefined();
  });
});

describe("search, sort and paging go to the server", () => {
  it("the first read: newest first, a page of 25, no search", async () => {
    await shown();
    const [first] = listCalls();
    expect(Object.fromEntries(first!)).toEqual({
      sort: "created",
      dir: "desc",
      limit: String(USERS_PAGE_SIZE),
      offset: "0",
    });
  });

  it("a hostile search term is sent as one encoded parameter, never spliced", async () => {
    await shown();
    const term = "%' or 1=1 -- &sort=email";
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: term } });
    fireEvent.click(screen.getByRole("button", { name: t("search") }));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    const params = listCalls()[1]!;
    expect(params.get("q")).toBe(term.trim());
    expect(params.getAll("sort")).toEqual(["created"]);
    expect(params.get("offset")).toBe("0");
  });

  it("the search box takes at most 100 characters (the server's bound)", async () => {
    await shown();
    expect(screen.getByRole("searchbox")).toHaveAttribute("maxLength", "100");
  });

  it("sort by last sign-in, least recent first", async () => {
    await shown();
    fireEvent.change(screen.getByRole("combobox", { name: t("sort_label") }), {
      target: { value: "3" },
    });
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(listCalls()[1]!.get("sort")).toBe("last_sign_in");
    expect(listCalls()[1]!.get("dir")).toBe("asc");
  });

  it("next and previous pages move the offset; previous is off on the first page", async () => {
    onList = () =>
      respond(200, { users: [user(), OLD_STAFF], roles: ROLES, page: { hasMore: true } });
    await shown();
    expect(screen.getByRole("button", { name: t("previous") })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: t("next") }));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(listCalls()[1]!.get("offset")).toBe(String(USERS_PAGE_SIZE));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: t("previous") })).not.toBeDisabled()
    );
    fireEvent.click(screen.getByRole("button", { name: t("previous") }));
    await waitFor(() => expect(listCalls()).toHaveLength(3));
    expect(listCalls()[2]!.get("offset")).toBe("0");
  });

  it("no users matching a search says so, with the term", async () => {
    await shown();
    onList = () => respond(200, { users: [], roles: ROLES, page: { hasMore: false } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zed" } });
    fireEvent.click(screen.getByRole("button", { name: t("search") }));
    expect(await screen.findByText(t("empty_search", { query: "zed" }))).toBeDefined();
  });
});

describe("the detail panel", () => {
  it("identity, readable and stored role, standing, created, last sign-in, entitlements", async () => {
    onList = () =>
      respond(200, {
        users: [
          user({
            entitlements: [
              { code: "beta", name: "Beta access", expiresAt: "2026-12-01T12:00:00Z" },
            ],
          }),
          OLD_STAFF,
        ],
        roles: ROLES,
        page: { hasMore: false },
      });
    await shown();
    const panel = openRow("Ann");
    expect(within(panel).getByText(user().id)).toBeDefined();
    expect(within(panel).getAllByText("Free").length).toBeGreaterThan(0);
    expect(within(panel).getByText("free")).toBeDefined();
    expect(within(panel).getByText(/26 Oct 2026/)).toBeDefined();
    expect(within(panel).getByText(/27 Oct 2026/)).toBeDefined();
    expect(within(panel).getByText("Beta access (until 1 Dec 2026)")).toBeDefined();
  });

  it("an account never signed in: Never, and the missing address explained", async () => {
    await shown();
    const panel = openRow("Unknown (never signed in since 7 Jun 2026)");
    expect(within(panel).getByText("super_admin")).toBeDefined();
    expect(within(panel).getByText(t("never"))).toBeDefined();
  });
});

describe("actions: shown only with the permission their route requires", () => {
  it("the map is the routes': change role = admin_manage_users, erase = admin_purge_user_data", () => {
    expect(USER_ROW_ACTION_PERMISSIONS).toEqual({
      change_role: "admin_manage_users",
      erase_account: "admin_purge_user_data",
    });
  });

  it("an admin (no admin_purge_user_data) is offered a role change, not an erasure", async () => {
    const admin = ROLE_PERMISSIONS.admin!;
    expect(admin).not.toContain("admin_purge_user_data");
    await shown((c) => admin.includes(c));
    const panel = openRow("Ann");
    expect(
      within(panel).getByRole("button", { name: t("change_role_submit") })
    ).toBeDefined();
    expect(within(panel).queryByRole("button", { name: t("erase") })).toBeNull();
  });

  it("a super_admin is offered both", async () => {
    const sa = ROLE_PERMISSIONS.super_admin!;
    await shown((c) => sa.includes(c));
    const panel = openRow("Ann");
    expect(
      within(panel).getByRole("button", { name: t("change_role_submit") })
    ).toBeDefined();
    expect(within(panel).getByRole("button", { name: t("erase") })).toBeDefined();
  });

  it("without either permission: no action, and it says so", async () => {
    await shown(only("can_access_admin"));
    const panel = openRow("Ann");
    expect(
      within(panel).queryByRole("button", { name: t("change_role_submit") })
    ).toBeNull();
    expect(within(panel).queryByRole("button", { name: t("erase") })).toBeNull();
    expect(within(panel).getByText(t("no_actions"))).toBeDefined();
  });

  it("role options are readable, with the stored name as their tooltip", async () => {
    await shown();
    const panel = openRow("Ann");
    const option = within(panel).getByRole("option", { name: "Super admin" });
    expect(option).toHaveAttribute("title", "super_admin");
  });
});

describe("change role", () => {
  async function change(to = "r-mod") {
    await shown();
    const panel = openRow("Ann");
    fireEvent.change(
      within(panel).getByRole("combobox", { name: t("change_role_label") }),
      {
        target: { value: to },
      }
    );
    await act(async () => {
      fireEvent.click(
        within(panel).getByRole("button", { name: t("change_role_submit") })
      );
    });
    return panel;
  }

  it("sends the account and the role chosen", async () => {
    await change();
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(String(patch[1].body))).toEqual({
      userId: user().id,
      roleId: "r-mod",
    });
  });

  it("held for a second admin (202 held): shown as held for approval — never as changed", async () => {
    onPatch = () => respond(202, { success: false, held: true, proposalId: "p-1" });
    const panel = await change();
    const held = await within(panel).findByText(t("held"));
    expect(held).toHaveAttribute("data-held", "true");
    expect(within(panel).queryByText(t("changed"))).toBeNull();
    // Nothing changed yet: the list is not re-read as if it had.
    expect(listCalls()).toHaveLength(1);
  });

  it("a 202 that does not say held is not taken as done either", async () => {
    onPatch = () => respond(202, {});
    const panel = await change();
    await waitFor(() => expect(within(panel).getByRole("alert")).toBeDefined());
    expect(within(panel).queryByText(t("changed"))).toBeNull();
    expect(within(panel).queryByText(t("held"))).toBeNull();
  });

  it("done (200 success): changed, and the list read again", async () => {
    const panel = await change();
    expect(await within(panel).findByText(t("changed"))).toBeDefined();
    await waitFor(() => expect(listCalls()).toHaveLength(2));
  });

  it("the same role: nothing sent", async () => {
    await change("r-free");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it.each(Object.keys(REFUSAL_HANDLERS))(
    "refused with %s: the refusal is shown by its code, never success or held",
    async (code) => {
      onPatch = () =>
        respond(code.startsWith("service.") ? 503 : 403, {
          code,
          message: `the server says ${code}`,
        });
      const panel = await change();
      expect(await within(panel).findByText(`the server says ${code}`)).toBeDefined();
      expect(within(panel).queryByText(t("changed"))).toBeNull();
      expect(within(panel).queryByText(t("held"))).toBeNull();
    }
  );

  it("the network fails: said so", async () => {
    onPatch = () => {
      throw new TypeError("Failed to fetch");
    };
    const panel = await change();
    expect(
      await within(panel).findByText(renderMessage("screens.refusal.network"))
    ).toBeDefined();
  });
});

describe("erase account data", () => {
  async function erase() {
    await shown();
    const panel = openRow("Ann");
    fireEvent.click(within(panel).getByRole("button", { name: t("erase") }));
    expect(within(panel).getByText(t("erase_warning"))).toBeDefined();
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: t("erase_confirm") }));
    });
    return panel;
  }

  it("asks first; cancel sends nothing", async () => {
    await shown();
    const panel = openRow("Ann");
    fireEvent.click(within(panel).getByRole("button", { name: t("erase") }));
    fireEvent.click(within(panel).getByRole("button", { name: t("erase_cancel") }));
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/admin/gdpr"))
    ).toBe(false);
  });

  it("confirmed: erased — sent as an admin-action erasure of that account", async () => {
    const panel = await erase();
    expect(await within(panel).findByText(t("erased"))).toBeDefined();
    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).startsWith("/api/admin/gdpr")
    )!;
    expect(JSON.parse(String(call[1].body))).toEqual({
      userId: user().id,
      reason: "admin-action",
    });
  });

  it("the answer stays until the panel is closed; closing reads the list again", async () => {
    const panel = await erase();
    expect(await within(panel).findByText(t("erased"))).toBeDefined();
    expect(listCalls()).toHaveLength(1);
    fireEvent.click(within(panel).getByRole("button", { name: t("close") }));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
  });

  it("an incomplete purge is never shown as erased", async () => {
    onErase = () => respond(200, { status: "partial" });
    const panel = await erase();
    expect(
      await within(panel).findByText(t("erase_incomplete", { status: "partial" }))
    ).toBeDefined();
    expect(within(panel).queryByText(t("erased"))).toBeNull();
  });

  it.each(Object.keys(REFUSAL_HANDLERS))(
    "refused with %s: shown by its code, never erased",
    async (code) => {
      onErase = () => respond(403, { code, message: `the server says ${code}` });
      const panel = await erase();
      expect(await within(panel).findByText(`the server says ${code}`)).toBeDefined();
      expect(within(panel).queryByText(t("erased"))).toBeNull();
    }
  );
});

describe("the list's own read", () => {
  it("a 503 is 'could not be read' with a retry — never an empty list", async () => {
    onList = () => respond(503, { code: "service.unavailable" });
    render(<UsersPanel hasPermission={everything} />);
    expect(
      await screen.findByText(renderMessage("screens.admin_console.unavailable_title"))
    ).toBeDefined();
    expect(screen.queryByText(t("empty"))).toBeNull();
    onList = () =>
      respond(200, { users: [user()], roles: ROLES, page: { hasMore: false } });
    fireEvent.click(screen.getByRole("button", { name: /^Try reading .* again$/ }));
    expect(await screen.findByText("ann@example.com")).toBeDefined();
  });

  it.each(Object.keys(REFUSAL_HANDLERS).filter((c) => c !== "service.unavailable"))(
    "refused with %s: the refusal is shown, not an empty list",
    async (code) => {
      onList = () => respond(403, { code, message: `the server says ${code}` });
      render(<UsersPanel hasPermission={everything} />);
      expect(await screen.findByText(`the server says ${code}`)).toBeDefined();
      expect(screen.queryByText(t("empty"))).toBeNull();
    }
  );

  it("a bumped refresh key reads the page again", async () => {
    const { rerender } = render(<UsersPanel hasPermission={everything} refreshKey={0} />);
    await screen.findByText("ann@example.com");
    rerender(<UsersPanel hasPermission={everything} refreshKey={1} />);
    await waitFor(() => expect(listCalls()).toHaveLength(2));
  });
});

describe("focus and the selected row (TASK-185 review)", () => {
  it("opening a row focuses the panel's heading and marks the row current; closing returns focus to its button", async () => {
    await shown();
    const opener = screen.getByRole("button", { name: t("open_row", { name: "Ann" }) });
    const panel = openRow("Ann");
    const heading = within(panel).getByRole("heading", { level: 3 });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(opener.closest("tr")).toHaveAttribute("aria-current", "true");
    const other = screen.getByRole("button", {
      name: t("open_row", { name: "Unknown (never signed in since 7 Jun 2026)" }),
    });
    expect(other.closest("tr")).not.toHaveAttribute("aria-current");
    fireEvent.click(within(panel).getByRole("button", { name: t("close") }));
    await waitFor(() => expect(opener).toHaveFocus());
    expect(opener.closest("tr")).not.toHaveAttribute("aria-current");
  });

  it("the erase confirmation is an alertdialog that takes focus; cancel and Escape return it to Erase", async () => {
    await shown();
    const panel = openRow("Ann");
    fireEvent.click(within(panel).getByRole("button", { name: t("erase") }));
    const dialog = within(panel).getByRole("alertdialog");
    expect(dialog).toHaveAccessibleName(t("erase"));
    expect(dialog).toHaveAccessibleDescription(t("erase_warning"));
    await waitFor(() => expect(dialog).toHaveFocus());
    fireEvent.click(within(dialog).getByRole("button", { name: t("erase_cancel") }));
    await waitFor(() =>
      expect(within(panel).getByRole("button", { name: t("erase") })).toHaveFocus()
    );
    fireEvent.click(within(panel).getByRole("button", { name: t("erase") }));
    fireEvent.keyDown(within(panel).getByRole("alertdialog"), { key: "Escape" });
    await waitFor(() =>
      expect(within(panel).getByRole("button", { name: t("erase") })).toHaveFocus()
    );
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/admin/gdpr"))
    ).toBe(false);
  });

  it("once the erasure has answered, focus returns to Erase", async () => {
    await shown();
    const panel = openRow("Ann");
    fireEvent.click(within(panel).getByRole("button", { name: t("erase") }));
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: t("erase_confirm") }));
    });
    await within(panel).findByText(t("erased"));
    await waitFor(() =>
      expect(within(panel).getByRole("button", { name: t("erase") })).toHaveFocus()
    );
  });
});

describe("rows the routes refuse to change offer no change (TASK-185 review)", () => {
  it("the admin's own row: neither action, and why", async () => {
    render(<UsersPanel hasPermission={everything} selfId={user().id} />);
    await screen.findByText("ann@example.com");
    const panel = openRow("Ann");
    expect(
      within(panel).queryByRole("button", { name: t("change_role_submit") })
    ).toBeNull();
    expect(within(panel).queryByRole("button", { name: t("erase") })).toBeNull();
    expect(within(panel).getByText(t("self_row"))).toBeDefined();
  });

  it("a super_admin's row: neither action, and why", async () => {
    await shown();
    const panel = openRow("Unknown (never signed in since 7 Jun 2026)");
    expect(
      within(panel).queryByRole("button", { name: t("change_role_submit") })
    ).toBeNull();
    expect(within(panel).queryByRole("button", { name: t("erase") })).toBeNull();
    expect(within(panel).getByText(t("protected_row"))).toBeDefined();
  });
});

describe("the role shown, the same-role answer, loading (TASK-185 review)", () => {
  it("the role chosen follows the account's role when the list is read again", async () => {
    let role = { roleId: "r-free", roleName: "free", roleDisplayName: "Free" };
    onList = () =>
      respond(200, { users: [user(role)], roles: ROLES, page: { hasMore: false } });
    const { rerender } = render(<UsersPanel hasPermission={everything} refreshKey={0} />);
    await screen.findByText("ann@example.com");
    const panel = openRow("Ann");
    const select = within(panel).getByRole("combobox", { name: t("change_role_label") });
    expect(select).toHaveValue("r-free");
    role = { roleId: "r-mod", roleName: "moderator", roleDisplayName: "Moderator" };
    rerender(<UsersPanel hasPermission={everything} refreshKey={1} />);
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("region", { name: new RegExp(t("detail_title")) })
        ).getByRole("combobox", { name: t("change_role_label") })
      ).toHaveValue("r-mod")
    );
  });

  it("choosing the same role says so neutrally — not as a success", async () => {
    await shown();
    const panel = openRow("Ann");
    fireEvent.click(within(panel).getByRole("button", { name: t("change_role_submit") }));
    const said = await within(panel).findByText(t("change_role_same"));
    expect(said.className).not.toMatch(/green/);
    expect(within(panel).queryByText(t("changed"))).toBeNull();
  });

  it("paging is off while a page is being read", async () => {
    onList = () =>
      respond(200, { users: [user(), OLD_STAFF], roles: ROLES, page: { hasMore: true } });
    await shown();
    let release: (v: unknown) => void = () => undefined;
    onList = () => new Promise((r) => (release = r));
    fireEvent.click(screen.getByRole("button", { name: t("next") }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: t("next") })).toBeDisabled()
    );
    expect(screen.getByRole("button", { name: t("previous") })).toBeDisabled();
    expect(screen.getByText(t("loading"))).toBeDefined();
    await act(async () =>
      release(respond(200, { users: [user()], roles: ROLES, page: { hasMore: true } }))
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: t("next") })).not.toBeDisabled()
    );
  });

  it("a refused re-read hides the rows read before: never stale data under a refusal", async () => {
    const { rerender } = render(<UsersPanel hasPermission={everything} refreshKey={0} />);
    await screen.findByText("ann@example.com");
    openRow("Ann");
    onList = () =>
      respond(403, { code: "auth.permission_denied", message: "no longer yours" });
    rerender(<UsersPanel hasPermission={everything} refreshKey={1} />);
    expect(await screen.findByText("no longer yours")).toBeDefined();
    expect(screen.queryByText("ann@example.com")).toBeNull();
    expect(
      screen.queryByRole("region", { name: new RegExp(t("detail_title")) })
    ).toBeNull();
  });
});
