/**
 * @jest-environment jsdom
 */
/**
 * The Dual control screen (ADR-040 040c; TASK-220: SF-admin-080 to 084, E-66). Every answer is
 * the routes' own (__tests__/fixtures/route-responses.json, made by __tests__/route-fixtures.test.ts):
 * the settings as GET /api/admin/config?enhanced=true lists them (the console's read, handed to
 * the view), the Approvals list, and the config route's answers to a change.
 */
import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { DualControlKeysPanel } from "@/components/admin/DualControlKeysPanel";
import { ALWAYS_DUAL_CONTROLLED } from "@/platform/admin/config-handlers";
import { renderMessage } from "@/platform/errors/messages";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";

const fetchMock = jest.fn();
beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});
beforeEach(() => {
  fetchMock.mockReset();
});

const UPDATE = "POST /api/admin/config-ai/execute — update_config:";
const SETTINGS = routeAnswer(
  "GET /api/admin/config — every setting, with its metadata"
)[1] as {
  entries: { key: string; value: unknown }[];
};

/** A route's own answer (__tests__/fixtures/route-responses.json), as fetch resolves it. */
function answer(name: RouteFixtureName): Response {
  const [status, body] = routeAnswer(name);
  return { ok: status < 300, status, json: async () => body } as unknown as Response;
}
const messageOf = (name: RouteFixtureName) =>
  (routeAnswer(name)[1] as { message: string }).message;

/** The settings with the list holding `keys` (null: the list is not among them). */
const settings = (keys: string[] | null) => ({
  entries: SETTINGS.entries
    .filter((e) => keys !== null || e.key !== "config.dual_control_keys")
    .map((e) => (e.key === "config.dual_control_keys" ? { ...e, value: keys } : e)),
});

const NONE = "GET /api/admin/approvals — none held" as RouteFixtureName;

/** The routes: the Approvals list answers the fixture `approvals`, a change answers `update`. */
function routes(approvals: RouteFixtureName = NONE, update?: RouteFixtureName) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === "/api/admin/approvals") return answer(approvals);
    if (url === "/api/admin/config-ai/execute") {
      if (!update) throw new Error("no change expected");
      return answer(update);
    }
    throw new Error(`unexpected ${url}`);
  });
}

const may = () => true;
const panel = (keys: string[] | null, more: Record<string, unknown> = {}) => (
  <DualControlKeysPanel data={settings(keys)} hasPermission={may} {...more} />
);
const outcomes = () =>
  screen.getByRole("status", { name: /Results of your changes to dual control/ });

/** Add `name` through the picker: open it, find it, choose it, review, confirm. */
function addSetting(name: string, find: string) {
  fireEvent.click(screen.getByRole("button", { name: "Add a setting to dual control" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Find a setting" }), {
    target: { value: find },
  });
  const select = screen.getByRole("combobox", { name: "Setting" });
  const option = within(select).getByRole("option", { name });
  fireEvent.change(select, { target: { value: (option as HTMLOptionElement).value } });
  fireEvent.click(screen.getByRole("button", { name: "Review the change" }));
  fireEvent.click(screen.getByRole("button", { name: "Add it" }));
}

describe("DualControlKeysPanel — ADR-040 040c; TASK-220", () => {
  it("lists the settings under dual control by name — their keys only with Show details (SF-admin-084)", async () => {
    routes();
    const { rerender } = render(panel(["signups_enabled", "config.dual_control_keys"]));
    expect(screen.getByText("Signups enabled")).toBeDefined();
    expect(screen.getByText("Config: dual control keys")).toBeDefined();
    expect(screen.queryByText("signups_enabled")).toBeNull();
    rerender(panel(["signups_enabled", "config.dual_control_keys"], { showIds: true }));
    expect(screen.getByText("signups_enabled")).toBeDefined();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/approvals", expect.anything())
    );
  });

  it("the list is always dual-controlled: a change made here is held, never applied", () => {
    expect(ALWAYS_DUAL_CONTROLLED).toContain("config.dual_control_keys");
  });

  it("a list not among the settings read is said as a failed read — never as an empty, unprotected list (SF-admin-080)", () => {
    routes();
    render(panel(null));
    expect(screen.getByRole("alert").textContent).toContain(
      renderMessage("screens.dual_control.missing")
    );
    expect(screen.queryByText(renderMessage("screens.dual_control.empty"))).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("an empty list says so, after a read that succeeded", () => {
    routes();
    render(panel([]));
    expect(screen.getByText(renderMessage("screens.dual_control.empty"))).toBeDefined();
  });

  it("adding: confirmed, then held — named, with a link to Approvals, never an id (SF-admin-082)", async () => {
    const held = `${UPDATE} a dual-control key added, held` as RouteFixtureName;
    routes(NONE, held);
    render(panel(["signups_enabled"]));
    addSetting("Default language", "language");
    await waitFor(() => expect(outcomes().textContent).toContain("Held for approval"));
    expect(outcomes().textContent).toContain("Add Default language to dual control");
    expect(
      within(outcomes())
        .getByRole("link", { name: "Open Approvals" })
        .getAttribute("href")
    ).toBe("?section=approvals");
    const { proposalId } = (routeAnswer(held)[1] as { data: { proposalId: string } })
      .data;
    expect(document.body.textContent).not.toContain(proposalId);
    const call = fetchMock.mock.calls.find(
      (c) => c[0] === "/api/admin/config-ai/execute"
    )!;
    expect(JSON.parse((call[1] as { body: string }).body)).toEqual({
      toolId: "update_config",
      input: {
        key: "config.dual_control_keys",
        value: ["signups_enabled", "default_language"],
        changeComment: "",
        confirmed: true,
      },
    });
    // Held, not applied: the list is what it was; Approvals is read again to show the change.
    expect(screen.getAllByRole("row")).toHaveLength(2);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter((c) => c[0] === "/api/admin/approvals").length
      ).toBe(2)
    );
  });

  it("a setting already listed, or already waiting to be added, is not offered again (SF-admin-083)", async () => {
    routes(
      "GET /api/admin/approvals — held changes, to a second admin who may decide them"
    );
    render(panel(["signups_enabled", "config.dual_control_keys"]));
    // The first held change adds default_language: said on the list, and not offered.
    await waitFor(() =>
      expect(
        screen.getByText(/Waiting in Approvals to be added: Default language/)
      ).toBeDefined()
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add a setting to dual control" })
    );
    const options = within(screen.getByRole("combobox", { name: "Setting" }))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).not.toContain("Default language");
    expect(options).not.toContain("Signups enabled");
  });

  it("a setting whose removal waits is marked, and cannot be removed again (SF-admin-083)", async () => {
    routes("GET /api/admin/approvals — a held removal from the dual-control list");
    render(panel(["signups_enabled", "config.dual_control_keys"]));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Remove Signups enabled from dual control",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(true)
    );
    expect(
      screen.getAllByText(renderMessage("screens.dual_control.pending_remove")).length
    ).toBeGreaterThan(0);
  });

  it("a waiting change this viewer may not see in full is said as one", async () => {
    routes(
      "GET /api/admin/approvals — a held change to the dual-control list, to an admin who may not decide it"
    );
    render(panel(["signups_enabled"]));
    await waitFor(() =>
      expect(
        screen.getByText(renderMessage("screens.dual_control.pending_unseen"))
      ).toBeDefined()
    );
  });

  it.each([
    ["neither store readable", "Approvals could not be read just now"],
    [
      "the held changes under dual control unreadable",
      renderMessage("screens.dual_control.pending_unreadable"),
    ],
  ])(
    "the changes waiting unreadable (%s): said, so none reads as none",
    async (which, said) => {
      routes(`GET /api/admin/approvals — ${which}` as RouteFixtureName);
      render(panel(["signups_enabled"]));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(said));
    }
  );

  it("removing: confirmed, then held; still listed until approved", async () => {
    routes(NONE, `${UPDATE} a dual-control key removed, held` as RouteFixtureName);
    render(panel(["signups_enabled", "config.dual_control_keys"]));
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Signups enabled from dual control" })
    );
    expect(screen.getByRole("alertdialog").textContent).toContain(
      renderMessage("screens.admin_console.confirm.consequence.dual_control_remove")
    );
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Remove from dual control",
      })
    );
    await waitFor(() =>
      expect(outcomes().textContent).toContain("Remove Signups enabled from dual control")
    );
    expect(screen.getByText("Signups enabled")).toBeDefined();
  });

  it("a refused change says why, never as held", async () => {
    const refused =
      `${UPDATE} the dual-control list, refused (no safety tier)` as RouteFixtureName;
    routes(NONE, refused);
    render(panel(["signups_enabled"]));
    addSetting("Default language", "language");
    await waitFor(() => expect(outcomes().textContent).toContain(messageOf(refused)));
    expect(outcomes().textContent).not.toContain("Held for approval");
  });

  it("no answer at all: not done, said, and the buttons come back (SF-admin-081)", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/admin/approvals") return answer(NONE);
      throw new TypeError("Failed to fetch");
    });
    render(panel(["signups_enabled"]));
    addSetting("Default language", "language");
    await waitFor(() =>
      expect(outcomes().textContent).toContain(renderMessage("screens.refusal.network"))
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Remove Signups enabled from dual control",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
  });

  // Round 10 (I-A self-check): a refused reply that is not JSON (a proxy's page) is a refusal.
  it("never reads a refused, non-JSON reply as held or applied", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/admin/approvals") return answer(NONE);
      return {
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      } as unknown as Response;
    });
    render(panel(["signups_enabled"]));
    addSetting("Default language", "language");
    await waitFor(() =>
      expect(outcomes().textContent).toContain("Something went wrong. Please try again.")
    );
    expect(outcomes().textContent).not.toContain("Held for approval");
  });

  it("the Approvals read failing is said, and the list is still shown", async () => {
    routes("GET /api/admin/approvals — refused (no permission)");
    render(panel(["signups_enabled"]));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Could not read Approvals")
    );
    expect(screen.getByText("Signups enabled")).toBeDefined();
  });

  it("without the list's own tier permission, adding and removing are not offered blind (E-66)", () => {
    routes();
    render(
      panel(["signups_enabled"], {
        hasPermission: (c: string) => c !== "config_manage_safety",
      })
    );
    const add = screen.getByRole("button", {
      name: "Add a setting to dual control",
    }) as HTMLButtonElement;
    const remove = screen.getByRole("button", {
      name: "Remove Signups enabled from dual control",
    }) as HTMLButtonElement;
    expect([add.disabled, remove.disabled]).toEqual([true, true]);
    expect(
      screen.getAllByText("Needs the permission “Manage safety config”.").length
    ).toBe(2);
  });
});
