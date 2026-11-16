/**
 * @jest-environment jsdom
 */
/**
 * __tests__/agent-kill-switch-panel.test.tsx — the agent kill switch on the console's shared
 * parts (TASK-172; TASK-221, SF-admin-125 to 127)
 *
 * Fed the route's own answers (__tests__/fixtures/route-responses.json).
 */
import { renderMessage } from "@/platform/errors/messages";
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  AdminKillSwitchView,
  AgentKillSwitch,
} from "@/components/admin/AgentKillSwitchPanel";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";

const fetchMock = jest.fn();
beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});
beforeEach(() => fetchMock.mockReset());

function reply(name: string) {
  const [status, body] = routeAnswer(name as RouteFixtureName);
  return {
    ok: status < 400,
    status,
    json: async () => body,
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}
const bodyOf = <T,>(name: string) => routeAnswer(name as RouteFixtureName)[1] as T;
const t = (key: string, v?: Record<string, string | number | string[]>) =>
  renderMessage(`screens.kill_switch.${key}`, v as never);

async function suspend(reason = "an agent misbehaved") {
  fireEvent.click(screen.getByRole("button", { name: t("suspend") }));
  const confirm = screen.getByRole("alertdialog");
  fireEvent.change(within(confirm).getByLabelText(/Reason/), {
    target: { value: reason },
  });
  fireEvent.click(within(confirm).getByRole("button", { name: t("confirm_yes") }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
}

describe("AgentKillSwitch", () => {
  it("is confirmed in the one confirm step: what happens, focus in, a reason required, nothing sent before", async () => {
    render(<AdminKillSwitchView />);
    fireEvent.click(screen.getByRole("button", { name: t("suspend") }));
    const confirm = screen.getByRole("alertdialog", { name: t("confirm_heading") });
    expect(confirm).toHaveFocus();
    expect(confirm).toHaveTextContent(t("confirm_body"));
    fireEvent.click(within(confirm).getByRole("button", { name: t("confirm_yes") }));
    expect(within(confirm).getByRole("alert")).toHaveTextContent(/at least 3 characters/);
    expect(fetchMock).not.toHaveBeenCalled();
    // Escape is Cancel: nothing sent, focus back on the button that opened it.
    fireEvent.keyDown(confirm, { key: "Escape" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: t("suspend") })).toHaveFocus()
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the reason to its route and says what was suspended — kept until dismissed (SF-admin-127)", async () => {
    fetchMock.mockResolvedValue(
      reply("POST /api/admin/agents/suspend — two suspended, a held change withdrawn")
    );
    render(<AdminKillSwitchView />);
    await suspend();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/agents/suspend");
    expect(JSON.parse(String(init.body))).toEqual({ reason: "an agent misbehaved" });
    const body = bodyOf<{ suspended: string[]; withdrawn: string[] }>(
      "POST /api/admin/agents/suspend — two suspended, a held change withdrawn"
    );
    const done = await screen.findByText(
      t("suspended", { count: body.suspended.length, agents: body.suspended })
    );
    const entry = done.closest("[data-outcome]")!;
    expect(entry).toHaveAttribute("data-outcome", "applied");
    // The withdrawn holds are named as what they are — no id unless details are shown.
    expect(entry).toHaveTextContent(t("withdrawn", { count: body.withdrawn.length }));
    for (const id of body.withdrawn) expect(entry.textContent).not.toContain(id);
    // A second suspension adds to the list; the first stays until it is dismissed.
    fetchMock.mockClear();
    await suspend("again");
    await waitFor(() =>
      expect(document.querySelectorAll("[data-outcome]")).toHaveLength(2)
    );
    fireEvent.click(
      within(entry as HTMLElement).getByRole("button", { name: "Dismiss" })
    );
    expect(document.querySelectorAll("[data-outcome]")).toHaveLength(1);
  });

  it("[SF-admin-125] with Show details, each withdrawn hold's reference is shown", async () => {
    fetchMock.mockResolvedValue(
      reply("POST /api/admin/agents/suspend — two suspended, a held change withdrawn")
    );
    render(<AdminKillSwitchView showIds />);
    await suspend();
    const { withdrawn } = bodyOf<{ withdrawn: string[] }>(
      "POST /api/admin/agents/suspend — two suspended, a held change withdrawn"
    );
    for (const id of withdrawn) expect(await screen.findByText(id)).toBeDefined();
  });

  it("nothing active, and the instances not told again: done, with what to check", async () => {
    fetchMock.mockResolvedValue(
      reply(
        "POST /api/admin/agents/suspend — none active, the invalidation not published"
      )
    );
    render(<AdminKillSwitchView />);
    await suspend();
    const said = await screen.findByText(t("none_active"));
    const entry = said.closest("[data-outcome]")!;
    expect(entry).toHaveAttribute("data-outcome", "unrecorded");
    expect(entry).toHaveTextContent(/Check the platform's alerts/);
  });

  it.each([
    "POST /api/admin/agents/suspend — refused (no permission)",
    "POST /api/admin/agents/suspend — refused (rate limited)",
    "POST /api/admin/agents/suspend — refused (the audit log down)",
  ])("[SF-admin-126] %s: the catalogue's sentence — never a raw code", async (name) => {
    fetchMock.mockResolvedValue(reply(name));
    render(<AdminKillSwitchView />);
    await suspend();
    await waitFor(() =>
      expect(document.querySelector("[data-outcome='refused']")).not.toBeNull()
    );
    const text = document.querySelector("[data-outcome='refused']")!.textContent ?? "";
    const { code } = bodyOf<{ code: string }>(name);
    expect(text).not.toContain(code);
  });

  it("no answer at all is said — nothing was suspended", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<AdminKillSwitchView />);
    await suspend();
    await waitFor(() =>
      expect(document.querySelector("[data-outcome='refused']")).not.toBeNull()
    );
  });

  it("a tenant's switch, for operators: its route, and the tenant named", async () => {
    fetchMock.mockResolvedValue(
      reply("POST /api/operator/tenants/[id]/agents/suspend — one suspended")
    );
    render(
      <AgentKillSwitch endpoint="/api/operator/tenants/t1/agents/suspend" tenant="Acme" />
    );
    expect(screen.getByText(t("intro_tenant", { tenant: "Acme" }))).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: t("suspend") }));
    expect(
      screen.getByRole("alertdialog", {
        name: t("confirm_heading_tenant", { tenant: "Acme" }),
      })
    ).toBeDefined();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "abuse" } });
    fireEvent.click(screen.getByRole("button", { name: t("confirm_yes") }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "/api/operator/tenants/t1/agents/suspend"
    );
    await waitFor(() =>
      expect(document.querySelector("[data-outcome-who]")).toHaveTextContent("Acme")
    );
  });
});
