/**
 * @jest-environment jsdom
 */
/**
 * TASK-216 — the admin console's core, on its shared parts (app/admin/page.tsx,
 * components/admin/SectionConsole.tsx, the command bar): what a person sees for each finding
 * of SCREEN-FINDINGS' shell and command-bar tables and SECOND-WAVE-STATUS' E-1, E-2 and E-4.
 *
 * Every reply is a route's own (__tests__/fixtures/route-responses.json, made by the real
 * handlers): a plan is the planner route's answer to a model that made those tool calls.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import AdminPage from "@/app/admin/page";
import { renderMessage } from "@/platform/errors/messages";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";
import { describeWhat, acceptedResult } from "@/components/admin/HeldActionsPanel";
import type { PendingApproval } from "@/platform/admin/pending-approvals";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/platform/auth/context", () => ({
  ...jest.requireActual("@/platform/auth/context"),
  useAuth: () => ({ signOut: jest.fn(async () => undefined), session: null }),
}));

const m = (key: string, values?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.${key}`, values);
const json = (name: RouteFixtureName) => {
  const [status, body] = routeAnswer(name);
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};
/** The plan a planner fixture answers. */
const planOf = (name: RouteFixtureName) =>
  (routeAnswer(name)[1] as { plan: { actions: { tool: string; input: object }[] } }).plan;
// Each plan is its own name (a fixture's), not a body.
const PLAN_SEARCH: RouteFixtureName =
  "POST /api/admin/ai — a plan: search users for moderators";
const PLAN_THREE: RouteFixtureName =
  "POST /api/admin/ai — a plan: three searches on Roles";
const PLAN_ERASE_AND_ROLE: RouteFixtureName =
  "POST /api/admin/ai — a plan: erase Ann, change her role, and search";
const PLAN_MISSING: RouteFixtureName =
  "POST /api/admin/ai — a plan: a role change for an account that is not found";
const PLAN_PERMISSIONS: RouteFixtureName =
  "POST /api/admin/ai — a plan: change a role's permissions, then delete it";
const PLAN_APPROVE: RouteFixtureName =
  "POST /api/admin/ai — a plan: approve the held change";
const PLAN_REJECT: RouteFixtureName =
  "POST /api/admin/ai — a plan: reject the held change";
const PLAN_UNLISTED: RouteFixtureName =
  "POST /api/admin/ai — a plan: approve a held change that is not in the list";
const PLAN_AGENT: RouteFixtureName = "POST /api/admin/ai — a plan: register an agent";
const PLAN_NOTHING: RouteFixtureName =
  "POST /api/admin/ai — an answer with nothing to do";

const SESSION: RouteFixtureName =
  "GET /api/admin/session — a super admin with a name and an address";
const USERS: RouteFixtureName =
  "POST /api/admin/users/search — Ann and a super admin who never signed in";
const HELD: RouteFixtureName =
  "GET /api/admin/approvals — held changes, to a second admin who may decide them";
const held = (routeAnswer(HELD)[1] as { approvals: PendingApproval[] }).approvals;
const RUNTIME = held.find((a) => a.source === "runtime")!;

type Handler = (url: string, init?: RequestInit) => unknown;
const fetchMock = jest.fn();
let routes: Record<string, Handler>;
/** The requests made, as "METHOD path". */
const made = () =>
  fetchMock.mock.calls.map(
    ([url, init]) => `${init?.method ?? "GET"} ${String(url).split("?")[0]}`
  );

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  routes = {
    "/api/admin/session": () => json(SESSION),
    "/api/admin/users/search": () => json(USERS),
    "/api/admin/gdpr": () => json("GET /api/admin/gdpr — no erasure pending"),
    "/api/admin/roles": () => json("GET /api/admin/roles — the roles"),
    "/api/admin/approvals": () => json(HELD),
    "/api/admin/tenant": () => json("GET /api/admin/tenant — a single deployment"),
  };
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url).split("?")[0]!;
    const handler =
      routes[path] ??
      (path.startsWith("/api/admin/approvals/") ? routes["decide"] : undefined);
    if (!handler) throw new Error(`unexpected request: ${path}`);
    return handler(String(url), init);
  });
});

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => await Promise.resolve());
}
/**
 * The console, open on Users (the first section of an admin who may open every one). The whole
 * console mounts here — the session, then the list — so the wait is not Testing Library's default
 * second: on a loaded runner (two workers on two cores, with coverage) that second was too short
 * and the test failed for want of time, not of the list.
 */
async function openConsole() {
  render(<AdminPage />);
  await screen.findByText("ann@example.com", undefined, { timeout: 5000 });
}
async function openSection(name: string) {
  fireEvent.click(within(screen.getByRole("navigation")).getByText(name));
  await settle();
}
/** Type a request and run it; the planner answers with the fixture `plan`. */
async function ask(plan: RouteFixtureName) {
  routes["/api/admin/ai"] = () => json(plan);
  fireEvent.change(screen.getByRole("textbox", { name: "Command" }), {
    target: { value: "do it" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  return screen.findByRole("region", { name: /Proposed actions|Answer/ });
}
const confirmButton = (count: number) =>
  screen.getByRole("button", { name: m("plan.confirm", { count }) });
const outcomes = () => [...document.querySelectorAll<HTMLElement>("[data-outcome]")];
const decision = (tool: "approve_hold" | "reject_hold"): RouteFixtureName =>
  tool === "approve_hold" ? PLAN_APPROVE : PLAN_REJECT;

describe("the shell: who is signed in, and where they are", () => {
  it("names who is signed in, then their role (SF-admin-005)", async () => {
    await openConsole();
    const who = document.querySelector("[data-signed-in-as]")!;
    expect(who).toHaveTextContent("Root Admin");
    expect(document.querySelector("[data-signed-in-role]")).toHaveTextContent(
      "Super admin"
    );
  });

  it("an account with no name or address: the role alone, never an id", async () => {
    routes["/api/admin/session"] = () => json("GET /api/admin/session — a super admin");
    await openConsole();
    expect(document.querySelector("[data-signed-in-as]")).toHaveTextContent(
      /^Super admin$/
    );
    expect(document.querySelector("[data-signed-in-role]")).toBeNull();
  });

  it("no command bar where it can do nothing; where it only searches, it says so (SF-admin-020)", async () => {
    await openConsole();
    expect(screen.getByRole("textbox", { name: "Command" })).toBeDefined();
    await openSection("Tenant");
    expect(screen.queryByRole("textbox", { name: "Command" })).toBeNull();
    routes["/api/admin/config"] = () =>
      json("GET /api/admin/config — every setting, with its metadata");
    await openSection("Platform config");
    expect(document.querySelector("[data-command-scope]")).toHaveTextContent(
      "Here the command bar only searches: settings."
    );
  });
});

describe("a section's read (E-4; SF-admin-002, 003, 004)", () => {
  it.each([
    [
      "Roles",
      "/api/admin/roles",
      "GET /api/admin/roles — refused (no permission)",
      /No roles found/,
    ],
    [
      "Approvals",
      "/api/admin/approvals",
      "GET /api/admin/approvals — refused (no permission)",
      /No pending approvals/,
    ],
  ] as [string, string, RouteFixtureName, RegExp][])(
    "%s refused: said as a failed read with a retry — never its 'nothing here'",
    async (name, path, refused, empty) => {
      routes[path] = () => json(refused);
      await openConsole();
      await openSection(name);
      const failed = await screen.findByRole("alert");
      expect(failed).toHaveTextContent(`Could not read ${name}`);
      expect(failed).toHaveTextContent(
        (routeAnswer(refused)[1] as { message: string }).message
      );
      expect(screen.queryByText(empty)).toBeNull();
      expect(screen.queryByText(/Loading/)).toBeNull();
      routes[path] = () =>
        json(path.endsWith("roles") ? "GET /api/admin/roles — the roles" : HELD);
      fireEvent.click(
        within(failed).getByRole("button", { name: `Try reading ${name} again` })
      );
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    }
  );

  it("[hostile] a read that gets no answer at all is said too — not 'Loading…' for ever", async () => {
    routes["/api/admin/roles"] = () => {
      throw new TypeError("Failed to fetch");
    };
    await openConsole();
    await openSection("Roles");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      renderMessage("screens.refusal.network")
    );
  });

  it("every section has Refresh and when it was read; a section reopened is read again, saying so", async () => {
    await openConsole();
    await openSection("Roles");
    expect(await screen.findByText(/^Read at \d\d:\d\d$/)).toBeDefined();
    const reads = () => made().filter((r) => r === "GET /api/admin/roles").length;
    expect(reads()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Read Roles again" }));
    await waitFor(() => expect(reads()).toBe(2));
    await openSection("Tenant");
    // Reopened: what it held before is not shown as if it were current while it is read.
    let release: (value: unknown) => void = () => undefined;
    routes["/api/admin/roles"] = () => new Promise((resolve) => (release = resolve));
    fireEvent.click(within(screen.getByRole("navigation")).getByText("Roles"));
    expect(await screen.findByText("Reading Roles…")).toHaveAttribute("role", "status");
    expect(screen.queryByText(/^Read at/)).toBeNull();
    await act(async () => release(json("GET /api/admin/roles — the roles")));
    expect(await screen.findByText(/^Read at/)).toBeDefined();
    expect(reads()).toBe(3);
  });
});

describe("a plan belongs to the section it was made on (SF-admin-001, 011, 016)", () => {
  const search = PLAN_SEARCH;

  it("a plan arriving takes focus, as a labelled region", async () => {
    await openConsole();
    const plan = await ask(search);
    await waitFor(() =>
      expect(
        within(plan).getByRole("heading", { name: "Proposed actions" })
      ).toHaveFocus()
    );
  });

  it("leaving the section leaves the plan and its outcomes behind", async () => {
    await openConsole();
    await ask(search);
    await openSection("Roles");
    expect(screen.queryByRole("region", { name: "Proposed actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Confirm/ })).toBeNull();
    expect(made()).not.toContain("POST /api/admin/ai/execute");
  });

  it("a second plan while the first is open starts with its own actions checked", async () => {
    await openConsole();
    await openSection("Roles");
    // A plan of one, unchecked: nothing to confirm …
    const first = await ask(PLAN_SEARCH);
    fireEvent.click(within(first).getByRole("checkbox"));
    expect(confirmButton(0)).toBeDisabled();
    // … then a plan of three arrives: its three actions, all checked — not the first plan's
    // (empty) selection, which showed them unchecked and counted indices of a plan long gone.
    await ask(PLAN_THREE);
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(3));
    for (const box of screen.getAllByRole("checkbox")) expect(box).toBeChecked();
    routes["/api/admin/ai/execute"] = (_url, init) => {
      expect(JSON.parse(String(init?.body)).actions).toEqual(planOf(PLAN_THREE).actions);
      return json("POST /api/admin/ai/execute — search users: the moderators");
    };
    fireEvent.click(confirmButton(3));
    await waitFor(() => expect(made()).toContain("POST /api/admin/ai/execute"));
  });
});

describe("what a plan says before it runs (SF-admin-010, 012, 013)", () => {
  it("every action that cannot be undone is marked so and says what is lost — not only 'delete role'", async () => {
    await openConsole();
    const plan = await ask(PLAN_ERASE_AND_ROLE);
    const [erase, role, find] = within(plan).getAllByRole("listitem");
    expect(erase).toHaveAttribute("data-risk", "irreversible");
    expect(erase).toHaveTextContent("Cannot be undone");
    expect(erase).toHaveTextContent(m("confirm.consequence.purge_user_data"));
    // The account by its address, the role by its display name — no id, no stored code.
    expect(plan).toHaveTextContent("ann@example.com");
    expect(plan).toHaveTextContent("Senior moderator");
    expect(plan.textContent).not.toMatch(/11111111|mod_l2/);
    expect(role).toHaveAttribute("data-risk", "consequential");
    expect(role).not.toHaveTextContent("Cannot be undone");
    expect(role).toHaveTextContent(m("confirm.consequence.change_user_role"));
    expect(find).toHaveAttribute("data-risk", "ordinary");
    // The button and the note speak for what is checked: danger while the erasure is.
    expect(confirmButton(3).className).toMatch(/bg-red-/);
    expect(screen.getByText(m("plan.destructive_note"))).toBeDefined();
    fireEvent.click(within(erase!).getByRole("checkbox"));
    expect(confirmButton(2).className).not.toMatch(/bg-red-/);
    expect(screen.queryByText(m("plan.destructive_note"))).toBeNull();
  });

  it("rejecting a held change cannot be undone; approving one is as grave as the change, named as the list names it", async () => {
    await openConsole();
    await openSection("Approvals");
    const plan = await ask(decision("reject_hold"));
    const item = within(plan).getByRole("listitem");
    expect(item).toHaveAttribute("data-risk", "irreversible");
    expect(item).toHaveTextContent(m("confirm.consequence.reject_hold"));
    // Named by what it is — never by the hold's id (SF-admin-013).
    expect(item).toHaveTextContent(describeWhat(RUNTIME));
    expect(item).not.toHaveTextContent(RUNTIME.id);
    await ask(decision("approve_hold"));
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Proposed actions" })).getByRole(
          "listitem"
        )
      ).toHaveAttribute("data-risk", "consequential")
    );
    // A hold that is not in the list: said as that, and still never an id.
    await ask(PLAN_UNLISTED);
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Proposed actions" })).toHaveTextContent(
        m("plan.describe.held_unlisted")
      )
    );
    expect(
      screen.getByRole("region", { name: "Proposed actions" })
    ).not.toHaveTextContent("99999999");
  });

  it("an account the planner did not find: said, unchecked, and it cannot be confirmed", async () => {
    await openConsole();
    const plan = await ask(PLAN_MISSING);
    expect(plan).toHaveTextContent(m("plan.account_missing"));
    const box = within(plan).getByRole("checkbox");
    expect(box).not.toBeChecked();
    expect(box).toBeDisabled();
    expect(confirmButton(0)).toBeDisabled();
  });

  it("roles and permissions by name, never by code", async () => {
    await openConsole();
    const plan = await ask(PLAN_PERMISSIONS);
    expect(plan).toHaveTextContent("Senior moderator");
    expect(plan).toHaveTextContent("View audit log");
    expect(plan.textContent).not.toMatch(/mod_l2|admin_view_audit|can_play/);
  });
});

describe("what became of a confirmed plan (E-1; SF-admin-021, 022)", () => {
  const plan = PLAN_AGENT;

  it("held for a second administrator: said as held — its own tone, with what happens next — and it takes focus", async () => {
    routes["/api/admin/agent-registry"] = () =>
      json("GET /api/admin/agent-registry — the registry");
    routes["/api/admin/ai/execute"] = () =>
      json("POST /api/admin/ai/execute — register_agent held for approval");
    await openConsole();
    await openSection("Trusted agents");
    await ask(plan);
    fireEvent.click(confirmButton(1));
    const [said] = await waitFor(() => {
      expect(outcomes()).toHaveLength(1);
      return outcomes();
    });
    expect(said).toHaveAttribute("data-outcome", "held");
    expect(said).toHaveTextContent("Held for approval");
    expect(said).toHaveTextContent("Register a trusted agent");
    expect(said).toHaveTextContent(`Next: ${m("results.next_held")}`);
    // Not the failure's colour, and no setting's key shown.
    expect(said!.className).not.toMatch(/red|amber/);
    expect(said).not.toHaveTextContent("agent.trusted_agents");
    await waitFor(() => expect(said).toHaveFocus());
    expect(said!.closest('[role="status"]')).toHaveAttribute("aria-live", "polite");
    // The plan is done with; the section was read again.
    expect(screen.queryByRole("region", { name: "Proposed actions" })).toBeNull();
    expect(made().filter((r) => r === "GET /api/admin/agent-registry")).toHaveLength(2);
  });

  it("[hostile] the confirm gets no answer at all: said as not done; the plan stays to be confirmed again", async () => {
    routes["/api/admin/ai/execute"] = () => {
      throw new TypeError("Failed to fetch");
    };
    await openConsole();
    await ask(PLAN_SEARCH);
    fireEvent.click(confirmButton(1));
    const [said] = await waitFor(() => {
      expect(outcomes()).toHaveLength(1);
      return outcomes();
    });
    expect(said).toHaveAttribute("data-outcome", "refused");
    expect(said).toHaveTextContent(renderMessage("screens.refusal.network"));
    // Not stuck "Running…": the plan can be confirmed again.
    expect(confirmButton(1)).not.toBeDisabled();
  });

  it("outcomes stay until each is dismissed; a later run adds to them", async () => {
    routes["/api/admin/ai/execute"] = () =>
      json("POST /api/admin/ai/execute — refused (rate limited)");
    await openConsole();
    await ask(PLAN_SEARCH);
    fireEvent.click(confirmButton(1));
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    fireEvent.click(confirmButton(1));
    await waitFor(() => expect(outcomes()).toHaveLength(2));
    // A new plan does not take them away.
    await ask(PLAN_NOTHING);
    expect(outcomes()).toHaveLength(2);
    fireEvent.click(within(outcomes()[0]!).getByRole("button", { name: "Dismiss" }));
    expect(outcomes()).toHaveLength(1);
  });
});

describe("a decision from the command bar says what the route answered (E-2)", () => {
  async function decide(tool: "approve_hold" | "reject_hold", answered: () => unknown) {
    routes["decide"] = answered;
    await openConsole();
    await openSection("Approvals");
    await ask(decision(tool));
    fireEvent.click(confirmButton(1));
    return (
      await waitFor(() => {
        expect(outcomes()).toHaveLength(1);
        return outcomes();
      })
    )[0]!;
  }
  const answerOf = (name: RouteFixtureName) =>
    routeAnswer(name)[1] as Record<string, unknown>;

  it("sent to the decision route, with the hold's source; the list is read again", async () => {
    await decide("approve_hold", () =>
      json("POST /api/admin/approvals/[id] — approved, it took effect")
    );
    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/approvals/")
    )!;
    const sent = JSON.parse(String(call[1].body));
    expect(String(call[0])).toBe(`/api/admin/approvals/${RUNTIME.id}`);
    expect(sent).toEqual({ decision: "approve", source: "runtime" });
    expect(made()).not.toContain("POST /api/admin/ai/execute");
    expect(made().filter((r) => r === "GET /api/admin/approvals")).toHaveLength(2);
  });

  it("approved and applied: says so, naming the change", async () => {
    const name = "POST /api/admin/approvals/[id] — approved, it took effect";
    const said = await decide("approve_hold", () => json(name));
    expect(said).toHaveAttribute("data-outcome", "applied");
    expect(said).toHaveTextContent(
      acceptedResult("approve", RUNTIME, answerOf(name)).text
    );
    expect(said).not.toHaveTextContent("Decision recorded");
  });

  it("approved, but another approver is still needed: held — never 'done'", async () => {
    const name =
      "POST /api/admin/approvals/[id] — approved, now waiting for a second approval";
    const said = await decide("approve_hold", () => json(name));
    expect(said).toHaveAttribute("data-outcome", "held");
    expect(said).toHaveTextContent(
      acceptedResult("approve", RUNTIME, answerOf(name)).text
    );
    expect(said).toHaveTextContent(`Next: ${m("results.next_waits")}`);
  });

  it("applied, and its record could not be stored: said as that", async () => {
    const name =
      "POST /api/admin/approvals/[id] — approved and applied, its record not stored";
    const body = answerOf(name);
    expect(body.recorded).toBe(false);
    const said = await decide("approve_hold", () => json(name));
    expect(said).toHaveAttribute("data-outcome", "unrecorded");
    expect(said).toHaveTextContent("Done, but not recorded");
    expect(said).toHaveTextContent(acceptedResult("approve", RUNTIME, body).text);
    expect(said).toHaveTextContent(`Next: ${m("results.next_unrecorded")}`);
  });

  it("rejected: says the change was not made", async () => {
    const name = "POST /api/admin/approvals/[id] — rejected";
    const said = await decide("reject_hold", () => json(name));
    expect(said).toHaveAttribute("data-outcome", "applied");
    expect(said).toHaveTextContent(
      acceptedResult("reject", RUNTIME, answerOf(name)).text
    );
  });

  it("refused (the requester's own change): the refusal's sentence, naming the change", async () => {
    const name = "POST /api/admin/approvals/[id] — refused (its own requester)";
    const said = await decide("approve_hold", () => json(name));
    expect(said).toHaveAttribute("data-outcome", "refused");
    expect(said).toHaveTextContent(String(answerOf(name).message));
    expect(said).toHaveTextContent(describeWhat(RUNTIME));
  });

  it("approved but the run failed, the approval kept: what became of it and what to do", async () => {
    const name = "POST /api/admin/approvals/[id] — approved, the run failed";
    const said = await decide("approve_hold", () => json(name));
    expect(said).toHaveAttribute("data-outcome", "refused");
    expect(said).toHaveTextContent(
      renderMessage("screens.held.result_approved_failed", {
        label: describeWhat(RUNTIME),
        reason: String(answerOf(name).message),
      })
    );
  });

  it("[hostile] the decision gets no answer at all: said, not dropped", async () => {
    const said = await decide("approve_hold", () => {
      throw new TypeError("Failed to fetch");
    });
    expect(said).toHaveAttribute("data-outcome", "refused");
    expect(said).toHaveTextContent(renderMessage("screens.refusal.network"));
  });
});
