/**
 * @jest-environment jsdom
 */
/**
 * __tests__/admin-governance-panels.test.tsx — Platform config and Trusted agents on the
 * console's shared parts (TASK-220; SF-admin-070 to 075, 130 to 134)
 *
 * Each screen is given what its route answers (__tests__/fixtures/route-responses.json, made by
 * __tests__/route-fixtures.test.ts), and each change is answered by the route's own answer.
 */
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { routeAnswer, type RouteFixtureName } from "./fixtures/route-responses";
import { renderMessage } from "@/platform/errors/messages";
import {
  PlatformConfigPanel,
  byCategory,
  editPermission,
  valueText,
  type SettingEntry,
} from "@/components/admin/PlatformConfigPanel";
import { TrustedAgentsPanel, parseTtl } from "@/components/admin/TrustedAgentsPanel";
import { permissionLabel } from "@/components/admin/ui/labels";

const fetchMock = jest.fn();
beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});
beforeEach(() => fetchMock.mockReset());

function reply(name: string): Response {
  const [status, b] = routeAnswer(name as RouteFixtureName);
  return { ok: status < 400, status, json: async () => b } as unknown as Response;
}
const body = (name: string) =>
  routeAnswer(name as RouteFixtureName)[1] as Record<string, unknown>;
function sent(url: string): Record<string, unknown> {
  const call = fetchMock.mock.calls.find((c) => c[0] === url);
  if (!call) throw new Error(`no request to ${url}`);
  return JSON.parse(String((call[1] as RequestInit).body));
}
const may = () => true;
const outcomes = () =>
  screen.getAllByRole("status").find((n) => n.hasAttribute("data-outcomes"))!;
const cfg = (key: string, v?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.config.${key}`, v);

const SETTINGS = body("GET /api/admin/config — every setting, with its metadata");
const UPDATE = "POST /api/admin/config-ai/execute — update_config";

describe("Platform config (SF-admin-070 to 075)", () => {
  it("the settings by category, each category sorted, each setting by name — its key only with Show details (SF-admin-072)", () => {
    const { rerender } = render(
      <PlatformConfigPanel data={SETTINGS} hasPermission={may} />
    );
    const sections = screen
      .getAllByRole("table")
      .map((t) => t.querySelector("caption")!.textContent);
    expect(sections).toEqual([...sections].sort());
    expect(
      screen.getByRole("button", {
        name: /Open the setting Moderation: strike ban threshold/,
      })
    ).toBeDefined();
    expect(screen.queryByText("moderation.strike_ban_threshold")).toBeNull();
    rerender(<PlatformConfigPanel data={SETTINGS} hasPermission={may} showIds />);
    expect(screen.getByText("moderation.strike_ban_threshold")).toBeDefined();
    // The grouping on its own: categories by their names, settings by theirs.
    const groups = byCategory(SETTINGS.entries as SettingEntry[]);
    expect(groups.map((g) => g.label)).toEqual([...groups.map((g) => g.label)].sort());
  });

  it("a setting opens beside the list, its heading takes focus, and Close gives focus back to its row (SF-admin-070)", async () => {
    render(<PlatformConfigPanel data={SETTINGS} hasPermission={may} />);
    const open = screen.getByRole("button", { name: /Open the setting Signups enabled/ });
    open.focus();
    fireEvent.click(open);
    const panel = screen.getByRole("region", { name: "Signups enabled" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(panel).getByRole("heading", { level: 3 })
      )
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /Open the setting Signups enabled/ })
      )
    );
  });

  it("a change: now → after and why in a confirm step; the reason is the record's comment (SF-admin-071)", async () => {
    fetchMock.mockResolvedValue(reply(`${UPDATE} held for approval`));
    render(<PlatformConfigPanel data={SETTINGS} hasPermission={may} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Open the setting Moderation: strike ban threshold/,
      })
    );
    fireEvent.click(screen.getByRole("button", { name: cfg("edit") }));
    fireEvent.change(screen.getByRole("textbox", { name: cfg("new_value") }), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: cfg("review") }));
    const step = screen.getByRole("alertdialog");
    const diff = step.querySelector("[data-diff='true']")!;
    expect(diff.textContent).toContain("5");
    expect(diff.textContent).toContain("7");
    // Too short a reason: said at its field, nothing sent.
    fireEvent.change(within(step).getByRole("textbox", { name: "Reason" }), {
      target: { value: "no" },
    });
    fireEvent.click(within(step).getByRole("button", { name: cfg("submit") }));
    expect(
      within(step).getByRole("textbox", { name: "Reason" }).getAttribute("aria-invalid")
    ).toBe("true");
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(within(step).getByRole("textbox", { name: "Reason" }), {
      target: { value: "Fewer bans for first offences" },
    });
    fireEvent.click(within(step).getByRole("button", { name: cfg("submit") }));
    await waitFor(() => expect(outcomes().textContent).toContain("Held for approval"));
    expect(sent("/api/admin/config-ai/execute")).toEqual({
      toolId: "update_config",
      input: {
        key: "moderation.strike_ban_threshold",
        value: 7,
        changeComment: "Fewer bans for first offences",
        confirmed: true,
      },
    });
  });

  it("without the tier's permission: the change disabled, saying which permission by name (SF-admin-073)", () => {
    render(<PlatformConfigPanel data={SETTINGS} hasPermission={() => false} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Open the setting Signups enabled/ })
    );
    const edit = screen.getByRole("button", { name: cfg("edit") }) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(
      screen.getByText(
        `Needs the permission “${permissionLabel(editPermission("safety"))}”.`
      )
    ).toBeDefined();
    expect(document.body.textContent).not.toContain("config_manage_safety");
  });

  it("a value that cannot be sent is said at its field, in the catalogue's words (SF-admin-074)", () => {
    render(<PlatformConfigPanel data={SETTINGS} hasPermission={may} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Open the setting Moderation: strike ban threshold/,
      })
    );
    fireEvent.click(screen.getByRole("button", { name: cfg("edit") }));
    const box = screen.getByRole("textbox", { name: cfg("new_value") });
    fireEvent.change(box, { target: { value: "999" } });
    fireEvent.click(screen.getByRole("button", { name: cfg("review") }));
    expect(box.getAttribute("aria-invalid")).toBe("true");
    const described = box.getAttribute("aria-describedby")!.split(" ");
    expect(described.map((id) => document.getElementById(id)!.textContent)).toContain(
      cfg("number_above", { max: 20 })
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a list that is not one: the catalogue's words, never the parser's English (SF-admin-074)", () => {
    render(<PlatformConfigPanel data={SETTINGS} hasPermission={may} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Open the setting Config: dual control keys/ })
    );
    fireEvent.click(screen.getByRole("button", { name: cfg("edit") }));
    const box = screen.getByRole("textbox", { name: cfg("new_value") });
    fireEvent.change(box, { target: { value: '["a",' } });
    fireEvent.click(screen.getByRole("button", { name: cfg("review") }));
    expect(screen.getByRole("alert").textContent).toBe(cfg("json_invalid"));
    expect(document.body.textContent).not.toMatch(/Unexpected|JSON\.parse/);
  });

  it("allowed values by name (SF-admin-075)", () => {
    render(<PlatformConfigPanel data={SETTINGS} hasPermission={may} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Open the setting Default language/ })
    );
    expect(screen.getByText("English, French, Spanish")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: cfg("edit") }));
    expect(
      within(screen.getByRole("combobox", { name: cfg("new_value") }))
        .getAllByRole("option")
        .map((o) => o.textContent)
    ).toEqual(["English", "French", "Spanish"]);
  });

  it("a list of words as a list — no brackets or quotation marks; an empty one is None", () => {
    const entries = SETTINGS.entries as SettingEntry[];
    const list = entries.find((e) => e.valueType === "json_array")!;
    expect(valueText(list, ["signups_enabled", "config.dual_control_keys"])).toBe(
      "signups_enabled, config.dual_control_keys"
    );
    expect(valueText(list, [])).toBe(cfg("list_empty"));
    // A list of lists stays as written (its own screen says it in words).
    expect(valueText(list, [["a", ["b"]]])).toBe('[["a",["b"]]]');
    render(<PlatformConfigPanel data={SETTINGS} hasPermission={may} />);
    expect(screen.getAllByText("signups_enabled, config.dual_control_keys").length).toBe(
      1
    );
  });

  it("applied: said, and the settings read again; refused: why, in the catalogue's words", async () => {
    const onReload = jest.fn();
    fetchMock.mockResolvedValueOnce(reply(`${UPDATE} applied`));
    render(
      <PlatformConfigPanel data={SETTINGS} hasPermission={may} onReload={onReload} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Open the setting Default language/ })
    );
    fireEvent.click(screen.getByRole("button", { name: cfg("edit") }));
    fireEvent.change(screen.getByRole("combobox", { name: cfg("new_value") }), {
      target: { value: "fr" },
    });
    fireEvent.click(screen.getByRole("button", { name: cfg("review") }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), {
      target: { value: "Most members read French" },
    });
    fireEvent.click(screen.getByRole("button", { name: cfg("submit") }));
    await waitFor(() => expect(outcomes().textContent).toContain("Done"));
    expect(outcomes().textContent).toContain("Set Default language to French");
    expect(onReload).toHaveBeenCalled();

    const refused = `${UPDATE} refused (out of range)`;
    fetchMock.mockResolvedValueOnce(reply(refused));
    fireEvent.click(
      screen.getByRole("button", {
        name: /Open the setting Moderation: strike ban threshold/,
      })
    );
    fireEvent.click(screen.getByRole("button", { name: cfg("edit") }));
    fireEvent.change(screen.getByRole("textbox", { name: cfg("new_value") }), {
      target: { value: "6" },
    });
    fireEvent.click(screen.getByRole("button", { name: cfg("review") }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), {
      target: { value: "A little more lenient" },
    });
    fireEvent.click(screen.getByRole("button", { name: cfg("submit") }));
    await waitFor(() =>
      expect(outcomes().textContent).toContain(
        (body(refused) as { message: string }).message
      )
    );
  });

  it("filters by name or what a setting does; nothing matching is said", () => {
    render(<PlatformConfigPanel data={SETTINGS} hasPermission={may} />);
    const filter = screen.getByRole("searchbox", { name: cfg("filter_label") });
    fireEvent.change(filter, { target: { value: "strike ban" } });
    expect(screen.getAllByRole("table")).toHaveLength(1);
    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(screen.getByText(cfg("none_match", { filter: "zzz" }))).toBeDefined();
  });

  it("a body without its list is a failed read — never 'no settings'", () => {
    render(<PlatformConfigPanel data={{}} hasPermission={may} />);
    expect(screen.getByRole("alert").textContent).toContain("Could not read");
  });
});

const ag = (key: string, v?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.agents.${key}`, v);
const AGENTS = body(
  "GET /api/admin/agent-registry — the registry and the capabilities the map knows"
);
const EXEC = "POST /api/admin/ai/execute —";

describe("Trusted agents (SF-admin-130 to 134)", () => {
  const registry = (agents: unknown[]) => ({ ...AGENTS, agents });

  it("the agents by name; a status by name — an unknown one said to be unknown, never Active (SF-admin-132)", () => {
    render(
      <TrustedAgentsPanel
        data={registry([
          ["agent:zed", { owner: "first-party", scopes: [], status: "suspended" }],
          [
            "agent:amy",
            { owner: "first-party", scopes: ["translate"], status: "retired" },
          ],
        ])}
      />
    );
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.querySelector("button")!.textContent)).toEqual([
      "agent:amy",
      "agent:zed",
    ]);
    expect(rows[0]!.textContent).toContain(
      renderMessage("screens.admin_console.labels.agent_status.unknown")
    );
    expect(rows[0]!.textContent).not.toContain("Active");
    expect(rows[1]!.textContent).toContain("Suspended");
  });

  it("scope by capability name; a ceiling not set says the platform's default — no literal dash (SF-admin-134)", () => {
    render(
      <TrustedAgentsPanel
        data={registry([
          [
            "agent:amy",
            { owner: "first-party", scopes: ["identify-song"], status: "active" },
          ],
        ])}
      />
    );
    expect(screen.getByText("Identify song")).toBeDefined();
    expect(screen.getByText(ag("ttl_default"))).toBeDefined();
    expect(screen.queryByText("—")).toBeNull();
  });

  it("the scope chosen from the capability map by name; one the map lost still shown (SF-admin-130)", async () => {
    fetchMock.mockResolvedValue(reply(`${EXEC} register_agent held for approval`));
    render(
      <TrustedAgentsPanel
        data={registry([
          ["agent:amy", { owner: "first-party", scopes: ["gone"], status: "active" }],
        ])}
        hasPermission={may}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "agent:amy" }));
    fireEvent.click(screen.getByRole("button", { name: ag("change_scope") }));
    expect(
      screen.getByRole("checkbox", { name: ag("scope_unmapped", { capability: "Gone" }) })
    ).toBeDefined();
    fireEvent.click(screen.getByRole("checkbox", { name: "Identify song" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: ag("scope_unmapped", { capability: "Gone" }) })
    );
    fireEvent.click(screen.getByRole("button", { name: ag("submit_edit") }));
    // Read back before it is sent: from → to, by name (a consequential change).
    const step = screen.getByRole("alertdialog", {
      name: ag("confirm_scope", { agent: "agent:amy" }),
    });
    expect(step.textContent).toContain(
      ag("from", { value: ag("scope_unmapped", { capability: "Gone" }) }).split(" (")[0]!
    );
    expect(step.textContent).toContain(ag("to", { value: "Identify song" }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(within(step).getByRole("button", { name: ag("submit_edit") }));
    await waitFor(() => expect(outcomes().textContent).toContain("Held for approval"));
    expect(sent("/api/admin/ai/execute")).toEqual({
      actions: [
        {
          tool: "set_agent_scope",
          input: { agent_id: "agent:amy", scopes: ["identify-song"] },
        },
      ],
    });
  });

  it("one change open at a time; suspending confirms, takes focus, and gives it back (SF-admin-131)", async () => {
    render(<TrustedAgentsPanel data={AGENTS} hasPermission={may} />);
    fireEvent.click(screen.getByRole("button", { name: "agent:research" }));
    const suspend = screen.getByRole("button", {
      name: ag("suspend_label", { agent: "agent:research" }),
    });
    suspend.focus();
    fireEvent.click(suspend);
    const step = screen.getByRole("alertdialog");
    await waitFor(() => expect(document.activeElement).toBe(step));
    // The other changes are not open beside it.
    expect(screen.queryByRole("button", { name: ag("change_scope") })).toBeNull();
    fireEvent.keyDown(step, { key: "Escape" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", {
          name: ag("suspend_label", { agent: "agent:research" }),
        })
      )
    );
  });

  it("every field's help is tied to it; a missing name is said at its field (SF-admin-133)", () => {
    render(<TrustedAgentsPanel data={AGENTS} hasPermission={may} />);
    fireEvent.click(screen.getByRole("button", { name: ag("register") }));
    for (const name of [ag("field_id"), ag("field_owner"), ag("field_ttl")]) {
      const box = screen.getByRole("textbox", { name });
      const help = box.getAttribute("aria-describedby")!;
      expect(document.getElementById(help.split(" ")[0]!)!.textContent).not.toBe("");
    }
    expect(
      screen
        .getByRole("group", { name: ag("field_scope") })
        .getAttribute("aria-describedby")
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: ag("submit_register") }));
    expect(
      screen.getByRole("textbox", { name: ag("field_id") }).getAttribute("aria-invalid")
    ).toBe("true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("registering reads the agent back — who answers, capabilities, longest token — before it is sent", async () => {
    fetchMock.mockResolvedValue(reply(`${EXEC} register_agent held for approval`));
    render(<TrustedAgentsPanel data={AGENTS} hasPermission={may} />);
    fireEvent.click(screen.getByRole("button", { name: ag("register") }));
    fireEvent.change(screen.getByRole("textbox", { name: ag("field_id") }), {
      target: { value: "agent:new" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Identify song" }));
    fireEvent.click(screen.getByRole("button", { name: ag("submit_register") }));
    const step = screen.getByRole("alertdialog", {
      name: ag("confirm_register", { agent: "agent:new" }),
    });
    expect(step.textContent).toContain(ag("line_owner", { owner: ag("owner_default") }));
    expect(step.textContent).toContain(ag("line_scope", { value: "Identify song" }));
    expect(step.textContent).toContain(ag("line_ttl", { value: ag("ttl_default") }));
    expect(fetchMock).not.toHaveBeenCalled();
    // Cancelled: nothing is sent, and the form is back as it was.
    fireEvent.click(within(step).getByRole("button", { name: /Cancel/ }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("textbox", { name: ag("field_id") }) as HTMLInputElement).value
    ).toBe("agent:new");
    fireEvent.click(screen.getByRole("button", { name: ag("submit_register") }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: ag("submit_register"),
      })
    );
    await waitFor(() => expect(outcomes().textContent).toContain("Held for approval"));
    expect(sent("/api/admin/ai/execute")).toEqual({
      actions: [
        {
          tool: "register_agent",
          input: { agent_id: "agent:new", scopes: ["identify-song"] },
        },
      ],
    });
  });

  it("a refusal always says why, by the catalogue's sentence for its code (SF-admin-134)", async () => {
    fetchMock.mockResolvedValueOnce(
      reply(`${EXEC} set_agent_scope refused (no admin_manage_agents)`)
    );
    render(<TrustedAgentsPanel data={AGENTS} hasPermission={may} />);
    fireEvent.click(screen.getByRole("button", { name: "agent:research" }));
    fireEvent.click(screen.getByRole("button", { name: ag("change_ttl") }));
    fireEvent.change(screen.getByRole("textbox", { name: ag("field_ttl") }), {
      target: { value: "120" },
    });
    fireEvent.click(screen.getByRole("button", { name: ag("submit_edit") }));
    const step = screen.getByRole("alertdialog");
    expect(step.textContent).toContain(ag("to", { value: ag("ttl", { seconds: 120 }) }));
    fireEvent.click(within(step).getByRole("button", { name: ag("submit_edit") }));
    await waitFor(() =>
      expect(outcomes().textContent).toContain(
        renderMessage("errors.auth.permission_denied", {
          permission: "admin_manage_agents",
        })
      )
    );
    // Said in full: never a reason that is empty (it read "…: ").
    expect(outcomes().textContent).not.toMatch(/: $/m);
  });

  it("without admin_manage_agents: the list, and the changes disabled, saying why by name", () => {
    render(<TrustedAgentsPanel data={AGENTS} hasPermission={() => false} />);
    expect(
      (screen.getByRole("button", { name: ag("register") }) as HTMLButtonElement).disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "agent:research" }));
    expect(
      screen.getAllByText(
        `Needs the permission “${permissionLabel("admin_manage_agents")}”.`
      ).length
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: ag("change_scope") })).toBeNull();
  });

  it("a ceiling is whole seconds above zero", () => {
    expect(parseTtl("300")).toBe(300);
    for (const bad of ["", "0", "-5", "1.5", "ten"]) expect(parseTtl(bad)).toBeNull();
  });
});
