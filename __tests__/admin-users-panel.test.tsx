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
import { loadSession, resetSessionStateForTests } from "@/platform/auth/context";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";
import { USER_ROW_ACTION_PERMISSIONS } from "@/app/api/admin/ai/tool-permissions";
import { ROLE_PERMISSIONS } from "./helpers/test-identities";

const t = (key: string, values?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.users.${key}`, values);
/** The shared table's and confirm step's own words (components/admin/ui). */
const table = (key: string, values?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.ui.table.${key}`, values);
const confirmWords = (key: string) =>
  renderMessage(`screens.admin_console.confirm.${key}`);
const detailRegion = () => screen.queryByRole("region", { name: /^Account: / });
/** The outcome list's entry that says `text` (its standing is its data-outcome). */
const outcomeOf = async (text: string) =>
  (await screen.findByText(text)).closest("[data-outcome]") as HTMLElement;

// Every answer is the route's own (__tests__/fixtures/route-responses.json, made by the handlers).
type Listed = {
  users: { id: string; createdAt: string }[];
  roles: { id: string; name: string }[];
};
const LIST: RouteFixtureName =
  "POST /api/admin/users/search — Ann and a super admin who never signed in";
const listed = routeAnswer(LIST)[1] as Listed;
const ANN = listed.users[0]!;
const OLD_STAFF = listed.users[1]!;
const roleId = (name: string) => listed.roles.find((r) => r.name === name)!.id;
const user = () => ANN;

const respond = (name: RouteFixtureName) => {
  const [status, body] = routeAnswer(name);
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};
/** What a refusal's own message says (the screen shows it, by its code). */
const messageOf = (name: RouteFixtureName) =>
  (routeAnswer(name)[1] as { message: string }).message;

/** The refusals each route answers before it reads anything (requireAdmin). */
const GUARD_REFUSALS = [
  "signed out",
  "no permission",
  "a suspended staff account",
  "no second factor",
  "rate limited",
  "the permissions store down",
] as const;
const refusalsOf = (route: string, own: readonly string[] = []) =>
  [...GUARD_REFUSALS, ...own].map((r) => `${route} — refused (${r})` as RouteFixtureName);

const fetchMock = jest.fn();
type Handler = (url: string, init?: RequestInit) => unknown;
let onList: Handler;
let onPatch: Handler;
let onErase: Handler;

const listCalls = () =>
  fetchMock.mock.calls
    .map(([u, init]) => ({ url: String(u), init: init as RequestInit | undefined }))
    // TASK-215 (A-17): the list is read by POST /api/admin/users/search, its parameters in the
    // body — never the URL.
    .filter((c) => c.url === "/api/admin/users/search" && c.init?.method === "POST")
    .map(
      (c) =>
        new URLSearchParams(
          Object.entries(JSON.parse(String(c.init?.body)) as Record<string, unknown>).map(
            ([k, v]) => [k, String(v)]
          )
        )
    );

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  onList = () => respond(LIST);
  onPatch = () => respond("PATCH /api/admin/users — changed");
  onErase = (_u, init) =>
    !init?.method || init.method === "GET"
      ? respond("GET /api/admin/gdpr — no erasure pending")
      : respond("POST /api/admin/gdpr — held for a second admin");
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("/api/admin/users") && init?.method === "PATCH")
      return onPatch(u, init);
    if (u.startsWith("/api/admin/users")) return onList(u, init);
    if (u.startsWith("/api/admin/gdpr")) return onErase(u, init);
    throw new Error(`unexpected request: ${u}`);
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
  return screen.getByRole("region", { name: /^Account: / });
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

  it("the table: readable role (its stored name nowhere), standing, verification, dates", async () => {
    await shown();
    const rows = screen.getAllByRole("row");
    const staff = rows.find((r) =>
      within(r).queryByText(/Unknown \(never signed in since/)
    )!;
    expect(
      within(staff).getByText("Unknown (never signed in since 7 Jun 2026)")
    ).toBeDefined();
    // TASK-216 (SF-admin-042): the role by its name; the stored code is a detail, not a tooltip.
    expect(within(staff).getByText("Super admin")).not.toHaveAttribute("title");
    expect(screen.queryByText("super_admin")).toBeNull();
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
      respond("POST /api/admin/users/search — Ann suspended until 2 November");
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

  it("[hostile] the search is a POST carrying the session's forgery token, its text in the body only (ADR-057, A-17)", async () => {
    // The page's session, read as the page reads it (GET /api/auth/session).
    resetSessionStateForTests();
    const list = onList;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/auth/session") return respond("GET /api/auth/session — signed in");
      if (u.startsWith("/api/admin/users")) return list(u, init);
      throw new Error(`unexpected request: ${u}`);
    });
    await loadSession();
    await shown();
    const term = "ann@example.com";
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: term } });
    fireEvent.click(screen.getByRole("button", { name: t("search") }));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    const searches = fetchMock.mock.calls.filter(([u]) =>
      String(u).startsWith("/api/admin/users")
    );
    for (const [u, init] of searches) {
      const headers = new Headers((init as RequestInit).headers);
      expect([String(u), (init as RequestInit).method]).toEqual([
        "/api/admin/users/search",
        "POST",
      ]);
      expect(headers.get("x-csrf-token")).toBe("csrf-token-of-the-session");
      expect(headers.get("authorization")).toBeNull();
    }
    expect(JSON.parse(String((searches[1][1] as RequestInit).body)).q).toBe(term);
    expect(searches.map(([u]) => String(u)).join(" ")).not.toContain("ann%40");
    resetSessionStateForTests();
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
    onList = () => respond("POST /api/admin/users/search — a page of 25, more to read");
    await shown();
    expect(screen.getByRole("button", { name: table("previous") })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: table("next") }));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(listCalls()[1]!.get("offset")).toBe(String(USERS_PAGE_SIZE));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: table("previous") })).not.toBeDisabled()
    );
    fireEvent.click(screen.getByRole("button", { name: table("previous") }));
    await waitFor(() => expect(listCalls()).toHaveLength(3));
    expect(listCalls()[2]!.get("offset")).toBe("0");
  });

  it("no users matching a search says so, with the term", async () => {
    await shown();
    onList = () =>
      respond("POST /api/admin/users/search — no account matches the search");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zed" } });
    fireEvent.click(screen.getByRole("button", { name: t("search") }));
    expect(await screen.findByText(t("empty_search", { query: "zed" }))).toBeDefined();
  });
});

describe("the detail panel", () => {
  it("identity, readable and stored role, standing, created, last sign-in, entitlements", async () => {
    onList = () =>
      respond("POST /api/admin/users/search — Ann with Beta access until 1 December");
    await shown();
    const panel = openRow("Ann");
    // TASK-190: the account id is hidden by default, shown with "Show details" (UsersPanel showIds).
    expect(within(panel).queryByText(user().id)).toBeNull();
    expect(within(panel).getAllByText("Free").length).toBeGreaterThan(0);
    // The role's stored name is a detail too (TASK-216, SF-admin-042).
    expect(within(panel).queryByText("free")).toBeNull();
    expect(within(panel).getByText(/26 Oct 2026/)).toBeDefined();
    expect(within(panel).getByText(/27 Oct 2026/)).toBeDefined();
    expect(within(panel).getByText("Beta access (until 1 Dec 2026)")).toBeDefined();
  });

  it("an account never signed in: Never, and the missing address explained", async () => {
    await shown();
    const panel = openRow("Unknown (never signed in since 7 Jun 2026)");
    expect(within(panel).getByText("Super admin")).toBeDefined();
    expect(within(panel).queryByText("super_admin")).toBeNull();
    expect(within(panel).getByText(t("never"))).toBeDefined();
  });

  it("with Show details: the account id and the role's stored name", async () => {
    render(<UsersPanel hasPermission={everything} showIds />);
    await screen.findAllByText("ann@example.com");
    const panel = openRow("Ann");
    expect(within(panel).getByText(user().id)).toBeDefined();
    expect(within(panel).getByText("free")).toBeDefined();
  });

  it("values wrap at words, never mid-word (SF-admin-042)", async () => {
    await shown();
    const panel = openRow("Ann");
    expect(panel.querySelector(".break-all")).toBeNull();
    expect(panel.querySelector("dd")?.className).toMatch(/\bbreak-words\b/);
  });
});

describe("actions: shown only with the permission their route requires", () => {
  it("the map is the routes': change role = admin_manage_users, erase = admin_purge_user_data", () => {
    expect(USER_ROW_ACTION_PERMISSIONS).toEqual({
      change_role: "admin_manage_users",
      erase_account: "admin_purge_user_data",
    });
  });

  // TASK-216: a control the route would refuse is shown disabled, with the reason — by the
  // permission's name, never its code (the shared gate).
  it("an admin (no admin_purge_user_data) is offered a role change; erasure is disabled, saying what it needs", async () => {
    const admin = ROLE_PERMISSIONS.admin!;
    expect(admin).not.toContain("admin_purge_user_data");
    await shown((c) => admin.includes(c));
    const panel = openRow("Ann");
    expect(
      within(panel).getByRole("button", { name: t("change_role_submit") })
    ).not.toBeDisabled();
    const erase = within(panel).getByRole("button", { name: t("erase") });
    expect(erase).toBeDisabled();
    expect(erase).toHaveAccessibleDescription("Needs the permission “Purge user data”.");
    fireEvent.click(erase);
    expect(within(panel).queryByRole("alertdialog")).toBeNull();
    expect(panel.textContent).not.toContain("admin_purge_user_data");
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

  it("without either permission: both disabled, each saying the permission it needs; no role to choose", async () => {
    await shown(only("can_access_admin"));
    const panel = openRow("Ann");
    const change = within(panel).getByRole("button", { name: t("change_role_submit") });
    expect(change).toBeDisabled();
    expect(change).toHaveAccessibleDescription("Needs the permission “Manage users”.");
    expect(within(panel).getByRole("button", { name: t("erase") })).toBeDisabled();
    expect(within(panel).queryByRole("combobox")).toBeNull();
    // And the read of a pending erasure is not made for someone who cannot erase.
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/admin/gdpr"))
    ).toBe(false);
  });

  it("role options are readable; the stored name is not their tooltip", async () => {
    await shown();
    const panel = openRow("Ann");
    const option = within(panel).getByRole("option", { name: "Super admin" });
    expect(option).not.toHaveAttribute("title");
  });
});

describe("change role", () => {
  /** Choose a role and ask; the confirm step is then open (unless the role is the same). */
  async function ask(to = roleId("moderator")) {
    await shown();
    const panel = openRow("Ann");
    fireEvent.change(
      within(panel).getByRole("combobox", { name: t("change_role_label") }),
      {
        target: { value: to },
      }
    );
    fireEvent.click(within(panel).getByRole("button", { name: t("change_role_submit") }));
    return panel;
  }
  async function change(to = roleId("moderator")) {
    const panel = await ask(to);
    await act(async () => {
      fireEvent.click(
        within(panel).getByRole("button", { name: t("confirm_role_submit") })
      );
    });
    return panel;
  }
  const sent = () => fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH");

  // TASK-216 (SF-admin-040): a role change went on one click, with no "from → to".
  it("asks first, naming the account and from → to; nothing is sent until confirmed", async () => {
    const panel = await ask();
    const dialog = within(panel).getByRole("alertdialog");
    expect(dialog).toHaveAccessibleName(t("confirm_role_title", { account: "Ann" }));
    expect(dialog).toHaveTextContent(
      t("confirm_role_change", { from: "Free", to: "Moderator" })
    );
    expect(dialog).toHaveTextContent(
      renderMessage("screens.admin_console.confirm.consequence.change_user_role")
    );
    // Consequential, not irreversible: not marked as something that cannot be undone.
    expect(dialog).toHaveAttribute("data-risk", "consequential");
    expect(dialog).not.toHaveTextContent(confirmWords("irreversible"));
    await waitFor(() => expect(dialog).toHaveFocus());
    expect(sent()).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: confirmWords("cancel") }));
    expect(within(panel).queryByRole("alertdialog")).toBeNull();
    expect(sent()).toBe(false);
    await waitFor(() =>
      expect(
        within(panel).getByRole("button", { name: t("change_role_submit") })
      ).toHaveFocus()
    );
  });

  it("sends the account and the role chosen", async () => {
    await change();
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(String(patch[1].body))).toEqual({
      userId: user().id,
      roleId: roleId("moderator"),
    });
  });

  it("held for a second admin (202 held): shown as held for approval — never as changed", async () => {
    onPatch = () => respond("PATCH /api/admin/users — held for a second admin");
    await change();
    const held = await outcomeOf(t("role_held", { from: "Free", to: "Moderator" }));
    expect(held).toHaveAttribute("data-outcome", "held");
    // What changed, for whom, and what happens next — and it took focus.
    expect(held).toHaveTextContent("Held for approval");
    expect(held).toHaveTextContent("For: Ann");
    expect(held).toHaveTextContent(t("next_role_held", { from: "Free" }));
    await waitFor(() => expect(held).toHaveFocus());
    expect(document.querySelector('[data-outcome="applied"]')).toBeNull();
    // Nothing changed yet: the list is not re-read as if it had.
    expect(listCalls()).toHaveLength(1);
  });

  it("done (200 success): says to what, and the list read again", async () => {
    await change();
    const done = await outcomeOf(t("role_changed", { from: "Free", to: "Moderator" }));
    expect(done).toHaveAttribute("data-outcome", "applied");
    expect(done).toHaveTextContent("For: Ann");
    expect(done).toHaveTextContent(t("next_role_changed"));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
  });

  it("the outcome stays until dismissed — closing the panel does not take it away", async () => {
    const panel = await change();
    const done = await outcomeOf(t("role_changed", { from: "Free", to: "Moderator" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(detailRegion()).toBeNull());
    expect(done).toBeInTheDocument();
    fireEvent.click(within(done).getByRole("button", { name: "Dismiss" }));
    expect(document.querySelector("[data-outcome]")).toBeNull();
  });

  it("the same role: nothing sent, and no confirmation asked", async () => {
    const panel = await ask(roleId("free"));
    expect(within(panel).queryByRole("alertdialog")).toBeNull();
    expect(sent()).toBe(false);
  });

  it.each(
    refusalsOf("PATCH /api/admin/users", [
      "no such account",
      "a protected role",
      "the roles store down",
    ])
  )("%s: the refusal is shown by its code, never success or held", async (name) => {
    onPatch = () => respond(name);
    await change();
    const refused = await outcomeOf(messageOf(name));
    expect(refused).toHaveAttribute("data-outcome", "refused");
    expect(refused).toHaveTextContent("Not done");
    expect(document.querySelector('[data-outcome="applied"]')).toBeNull();
    expect(document.querySelector('[data-outcome="held"]')).toBeNull();
  });

  it("the network fails: said so", async () => {
    onPatch = () => {
      throw new TypeError("Failed to fetch");
    };
    await change();
    expect(await outcomeOf(renderMessage("screens.refusal.network"))).toHaveAttribute(
      "data-outcome",
      "refused"
    );
  });

  it("[hostile] a 200 that says neither changed nor held is not a change", async () => {
    // A 200 whose body says neither (another route's own answer stands in for one).
    onPatch = () => respond("GET /api/admin/gdpr — no erasure pending");
    await change();
    expect(await outcomeOf(t("role_unconfirmed"))).toHaveAttribute(
      "data-outcome",
      "refused"
    );
    expect(listCalls()).toHaveLength(1);
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
    fireEvent.click(within(panel).getByRole("button", { name: confirmWords("cancel") }));
    // Only the read of a pending erasure (round 1, A6) — no erasure sent.
    expect(
      fetchMock.mock.calls.some(
        ([u, init]) => String(u).startsWith("/api/admin/gdpr") && init?.method === "POST"
      )
    ).toBe(false);
  });

  it("confirmed: held for a second admin — sent as an admin-action erasure of that account", async () => {
    const panel = await erase();
    const held = await outcomeOf(t("erase_held"));
    expect(held).toHaveAttribute("data-outcome", "held");
    expect(held).toHaveTextContent("For: Ann");
    expect(held).toHaveTextContent(t("next_erase_held"));
    // Nothing is erased yet: no second erasure is offered, the pending one is not repeated.
    expect(within(panel).queryByRole("button", { name: t("erase") })).toBeNull();
    const call = fetchMock.mock.calls.find(
      ([u, init]) => String(u).startsWith("/api/admin/gdpr") && init?.method === "POST"
    )!;
    expect(JSON.parse(String(call[1].body))).toEqual({
      userId: user().id,
      reason: "user-request",
    });
  });

  it("the held answer stays when the panel is closed; nothing was erased, so the list is not read again", async () => {
    const panel = await erase();
    const held = await outcomeOf(t("erase_held"));
    expect(listCalls()).toHaveLength(1);
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(detailRegion()).toBeNull());
    expect(held).toBeInTheDocument();
    expect(listCalls()).toHaveLength(1);
  });

  // TASK-216 (SF-admin-036, the requester's side): the reason was always the code "admin-action".
  it("the confirmation asks which kind of reason; the one chosen is sent", async () => {
    await shown();
    const panel = openRow("Ann");
    fireEvent.click(within(panel).getByRole("button", { name: t("erase") }));
    const dialog = within(panel).getByRole("alertdialog");
    const kinds = within(dialog).getByRole("combobox", { name: t("erase_reason_label") });
    expect(
      within(kinds)
        .getAllByRole("option")
        .map((o) => o.textContent)
    ).toEqual([
      t("erase_reason_user_request"),
      t("erase_reason_admin_action"),
      t("erase_reason_account_deletion"),
      t("erase_reason_legal_order"),
    ]);
    fireEvent.change(kinds, { target: { value: "legal-order" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: t("erase_confirm") }));
    });
    const call = fetchMock.mock.calls.find(
      ([u, init]) => String(u).startsWith("/api/admin/gdpr") && init?.method === "POST"
    )!;
    expect(JSON.parse(String(call[1].body))).toEqual({
      userId: user().id,
      reason: "legal-order",
    });
  });

  // TASK-194 round 1, A6: an erasure already waiting for approval is shown after a reload, and
  // no second one is offered.
  it("an erasure pending approval is shown when the panel opens, with no erase button", async () => {
    onErase = (u, init) =>
      !init?.method || init.method === "GET"
        ? respond("GET /api/admin/gdpr — an erasure pending")
        : respond("POST /api/admin/gdpr — refused (an erasure already pending)");
    await shown();
    const panel = openRow("Ann");
    expect(await within(panel).findByText(t("erase_pending"))).toBeDefined();
    expect(within(panel).queryByRole("button", { name: t("erase") })).toBeNull();
    const read = fetchMock.mock.calls.find(([u]) =>
      String(u).startsWith("/api/admin/gdpr?")
    )!;
    expect(String(read[0])).toBe(
      `/api/admin/gdpr?userId=${encodeURIComponent(user().id)}`
    );
  });

  it("no erasure pending: the erase button is offered", async () => {
    await shown();
    const panel = openRow("Ann");
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/admin/gdpr?"))
      ).toBe(true)
    );
    expect(within(panel).getByRole("button", { name: t("erase") })).toBeDefined();
    expect(within(panel).queryByText(t("erase_pending"))).toBeNull();
  });

  it.each(
    refusalsOf("POST /api/admin/gdpr", ["an erasure already pending", "no such account"])
  )("%s: shown by its code, never held", async (name) => {
    onErase = (_u, init) =>
      !init?.method || init.method === "GET"
        ? respond("GET /api/admin/gdpr — no erasure pending")
        : respond(name);
    await erase();
    expect(await outcomeOf(messageOf(name))).toHaveAttribute("data-outcome", "refused");
    expect(screen.queryByText(t("erase_held"))).toBeNull();
  });
});

describe("the list's own read", () => {
  it("a 503 is 'could not be read' with a retry — never an empty list", async () => {
    onList = () =>
      respond("POST /api/admin/users/search — refused (the permissions store down)");
    render(<UsersPanel hasPermission={everything} />);
    expect(
      await screen.findByText(renderMessage("screens.admin_console.unavailable_title"))
    ).toBeDefined();
    expect(screen.queryByText(t("empty"))).toBeNull();
    onList = () => respond("POST /api/admin/users/search — Ann alone");
    fireEvent.click(screen.getByRole("button", { name: /^Try reading .* again$/ }));
    expect(await screen.findByText("ann@example.com")).toBeDefined();
  });

  it.each([
    ...refusalsOf("POST /api/admin/users/search").filter(
      (n) => !n.endsWith("store down)")
    ),
    "POST /api/admin/users/search — the store failing" as RouteFixtureName,
  ])("%s: the refusal is shown, not an empty list", async (name) => {
    onList = () => respond(name);
    render(<UsersPanel hasPermission={everything} />);
    expect(await screen.findByText(messageOf(name))).toBeDefined();
    expect(screen.queryByText(t("empty"))).toBeNull();
  });

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
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(opener).toHaveFocus());
    expect(opener.closest("tr")).not.toHaveAttribute("aria-current");
  });

  it("the erase confirmation is an alertdialog that takes focus; cancel and Escape return it to Erase", async () => {
    await shown();
    const panel = openRow("Ann");
    fireEvent.click(within(panel).getByRole("button", { name: t("erase") }));
    const dialog = within(panel).getByRole("alertdialog");
    expect(dialog).toHaveAccessibleName(t("confirm_erase_title", { account: "Ann" }));
    // Irreversible: marked so in words, and it says what will be lost (TASK-216).
    expect(dialog).toHaveAttribute("data-risk", "irreversible");
    const description = dialog.getAttribute("aria-describedby")!;
    const said = document.getElementById(description)!.textContent;
    expect(said).toContain(confirmWords("irreversible"));
    expect(said).toContain(t("erase_warning"));
    expect(said).toContain(
      renderMessage("screens.admin_console.confirm.consequence.purge_user_data")
    );
    await waitFor(() => expect(dialog).toHaveFocus());
    fireEvent.click(within(dialog).getByRole("button", { name: confirmWords("cancel") }));
    await waitFor(() =>
      expect(within(panel).getByRole("button", { name: t("erase") })).toHaveFocus()
    );
    fireEvent.click(within(panel).getByRole("button", { name: t("erase") }));
    fireEvent.keyDown(within(panel).getByRole("alertdialog"), { key: "Escape" });
    await waitFor(() =>
      expect(within(panel).getByRole("button", { name: t("erase") })).toHaveFocus()
    );
    expect(
      fetchMock.mock.calls.some(
        ([u, init]) => String(u).startsWith("/api/admin/gdpr") && init?.method === "POST"
      )
    ).toBe(false);
  });

  // TASK-207: held, the Erase button is gone (the erasure is pending) — focus went nowhere.
  it("once the erasure is held, focus moves to what says so", async () => {
    await shown();
    const panel = openRow("Ann");
    fireEvent.click(within(panel).getByRole("button", { name: t("erase") }));
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: t("erase_confirm") }));
    });
    const held = await outcomeOf(t("erase_held"));
    await waitFor(() => expect(held).toHaveFocus());
  });

  it("refused, focus moves to the outcome that says why", async () => {
    onErase = (_u, init) =>
      !init?.method || init.method === "GET"
        ? respond("GET /api/admin/gdpr — no erasure pending")
        : respond("POST /api/admin/gdpr — refused (no such account)");
    await shown();
    const panel = openRow("Ann");
    fireEvent.click(within(panel).getByRole("button", { name: t("erase") }));
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: t("erase_confirm") }));
    });
    const refused = await outcomeOf(
      messageOf("POST /api/admin/gdpr — refused (no such account)")
    );
    await waitFor(() => expect(refused).toHaveFocus());
    // And the erasure can be asked for again.
    expect(within(panel).getByRole("button", { name: t("erase") })).not.toBeDisabled();
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
    let list: RouteFixtureName = "POST /api/admin/users/search — Ann alone";
    onList = () => respond(list);
    const { rerender } = render(<UsersPanel hasPermission={everything} refreshKey={0} />);
    await screen.findByText("ann@example.com");
    const panel = openRow("Ann");
    const select = within(panel).getByRole("combobox", { name: t("change_role_label") });
    expect(select).toHaveValue(roleId("free"));
    list = "POST /api/admin/users/search — Ann, now a moderator";
    rerender(<UsersPanel hasPermission={everything} refreshKey={1} />);
    await waitFor(() =>
      expect(
        within(detailRegion()!).getByRole("combobox", {
          name: t("change_role_label"),
        })
      ).toHaveValue(roleId("moderator"))
    );
  });

  it("choosing the same role says so neutrally — not as a success", async () => {
    await shown();
    const panel = openRow("Ann");
    fireEvent.click(within(panel).getByRole("button", { name: t("change_role_submit") }));
    // Said at the field, tied to it (TASK-216: the shared Field) — not as an outcome.
    const said = await within(panel).findByText(t("change_role_same"));
    const select = within(panel).getByRole("combobox", { name: t("change_role_label") });
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(select.getAttribute("aria-describedby")).toContain(said.id);
    expect(document.querySelector("[data-outcome]")).toBeNull();
  });

  it("paging is off while a page is being read", async () => {
    onList = () => respond("POST /api/admin/users/search — a page of 25, more to read");
    await shown();
    let release: (v: unknown) => void = () => undefined;
    onList = () => new Promise((r) => (release = r));
    fireEvent.click(screen.getByRole("button", { name: table("next") }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: table("next") })).toBeDisabled()
    );
    expect(screen.getByRole("button", { name: table("previous") })).toBeDisabled();
    expect(
      screen.getByText(
        renderMessage("screens.admin_console.ui.reading_again", { panel: "Users" })
      )
    ).toHaveAttribute("role", "status");
    await act(async () =>
      release(respond("POST /api/admin/users/search — a page of 25, more to read"))
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: table("next") })).not.toBeDisabled()
    );
  });

  it("a refused re-read hides the rows read before: never stale data under a refusal", async () => {
    const { rerender } = render(<UsersPanel hasPermission={everything} refreshKey={0} />);
    await screen.findByText("ann@example.com");
    openRow("Ann");
    onList = () => respond("POST /api/admin/users/search — refused (no permission)");
    rerender(<UsersPanel hasPermission={everything} refreshKey={1} />);
    expect(
      await screen.findByText(
        messageOf("POST /api/admin/users/search — refused (no permission)")
      )
    ).toBeDefined();
    expect(screen.queryByText("ann@example.com")).toBeNull();
    expect(detailRegion()).toBeNull();
  });
});

// TASK-216: the screen is the console's shared parts — the one table, its pager's count, the
// panel state for every failed read, the detail beside the list.
describe("the shared parts (TASK-216)", () => {
  it("the list is the one table: a caption, header scope, inside a region that scrolls itself", async () => {
    await shown();
    const list = screen.getByRole("table", { name: "Users" });
    for (const th of within(list).getAllByRole("columnheader"))
      expect(th).toHaveAttribute("scope", "col");
    const card = list.closest('[role="region"]')!;
    expect(card).toHaveAccessibleName("Users");
    expect(card.className).toMatch(/\boverflow-x-auto\b/);
    expect(card.className).toMatch(/\bmax-w-full\b/);
    // Reachable and scrollable from the keyboard (2.1.1).
    expect(card).toHaveAttribute("tabindex", "0");
  });

  it("the pager says how many there are in all, from the route's count (SF-admin-041)", async () => {
    onList = () => respond("POST /api/admin/users/search — a page of 25, more to read");
    await shown();
    const total = (
      routeAnswer("POST /api/admin/users/search — a page of 25, more to read")[1] as {
        page: { total: number };
      }
    ).page.total;
    expect(total).toBeGreaterThan(USERS_PAGE_SIZE);
    expect(screen.getByText(table("range_of", { from: 1, to: 25, total }))).toBeDefined();
  });

  it("[hostile] no count in the answer: the range alone, never 'of undefined'", async () => {
    // The route's own answer, as a server before the count sent it: without the two fields.
    const body = JSON.parse(
      JSON.stringify(
        routeAnswer("POST /api/admin/users/search — a page of 25, more to read")[1]
      )
    ) as { page: Record<string, unknown> };
    delete body.page.total;
    delete body.page.totalCapped;
    onList = () => ({ ok: true, status: 200, json: async () => body });
    await shown();
    expect(screen.getByText(table("range", { from: 1, to: 25 }))).toBeDefined();
  });

  it("the detail opens beside the list, which leaves out its secondary columns; closed, they are back (SF-admin-043)", async () => {
    await shown();
    expect(screen.getByRole("columnheader", { name: t("col_created") })).toBeDefined();
    const panel = openRow("Ann");
    const layout = panel.closest("[data-detail-open]")!;
    expect(layout).toHaveAttribute("data-detail-open", "true");
    // Wide: side by side. Narrow: the list gives way to the detail.
    expect(layout.className).toMatch(/xl:grid-cols-/);
    expect(layout.querySelector("[data-detail-list]")?.className).toMatch(
      /\bhidden xl:block\b/
    );
    expect(screen.queryByRole("columnheader", { name: t("col_created") })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: t("col_verified") })).toBeNull();
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(detailRegion()).toBeNull());
    expect(screen.getByRole("columnheader", { name: t("col_created") })).toBeDefined();
  });

  it("a read that gets no answer at all is said, with a retry — never 'no users'", async () => {
    onList = () => {
      throw new TypeError("Failed to fetch");
    };
    render(<UsersPanel hasPermission={everything} />);
    const failed = await screen.findByRole("alert");
    expect(failed).toHaveTextContent(renderMessage("screens.refusal.network"));
    expect(failed).toHaveTextContent("Could not read Users");
    expect(screen.queryByText(t("empty"))).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    onList = () => respond(LIST);
    fireEvent.click(within(failed).getByRole("button", { name: /^Try reading/ }));
    expect(await screen.findByText("ann@example.com")).toBeDefined();
  });

  it("Refresh reads the list again and says when it was read", async () => {
    await shown();
    expect(screen.getByText(/^Read at \d\d:\d\d$/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Read Users again" }));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
  });
});
