/**
 * @jest-environment jsdom
 */
/**
 * The agent kill switch in the consoles (components/admin/AgentKillSwitchPanel.tsx, TASK-172):
 * the admin console's section for config_manage_safety holders (POST /api/admin/agents/suspend)
 * and the operators' per-tenant one (POST /api/operator/tenants/[id]/agents/suspend). A reason is
 * required, an explicit confirmation comes before anything is sent (inline — never
 * window.prompt or window.confirm), the request goes through apiFetch, and the answer is shown:
 * the agents suspended, the holds withdrawn, whether the invalidation was published again. Every
 * view passes axe's WCAG 2.2 AA rules.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  AdminKillSwitchView,
  AgentKillSwitch,
} from "@/components/admin/AgentKillSwitchPanel";
import AdminShell from "@/components/admin/AdminShell";
import { OperatorTenantsView } from "@/components/admin/TenancyPanels";

// axe-core is installed with @axe-core/playwright (the e2e audits); here it runs in jsdom.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const axe = require("axe-core");

const fetchMock = jest.fn();
beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});
beforeEach(() => {
  fetchMock.mockReset();
  jest.spyOn(window, "prompt").mockImplementation(() => {
    throw new Error("window.prompt must not be used");
  });
  jest.spyOn(window, "confirm").mockImplementation(() => {
    throw new Error("window.confirm must not be used");
  });
});
afterEach(() => jest.restoreAllMocks());

function reply(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}
function answer(status: number, body: unknown) {
  fetchMock.mockImplementation(async () => reply(status, body));
}
const sent = (n: number) => {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit | undefined];
  return {
    url,
    method: init?.method ?? "GET",
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
    headers: (init?.headers ?? {}) as Record<string, string>,
  };
};

async function noViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag22aa"] },
    // jsdom has no layout or canvas: contrast is the e2e audit's.
    rules: { "color-contrast": { enabled: false } },
  });
  expect(results.violations.map((v: { id: string }) => v.id)).toEqual([]);
}

const reasonBox = () => screen.getByLabelText("Reason (recorded with the suspension)");
const suspendButton = () => screen.getByRole("button", { name: "Suspend every agent" });
const confirmButton = () =>
  screen.getByRole("button", { name: "Yes, suspend every agent" });

async function suspendWith(reason: string) {
  fireEvent.change(reasonBox(), { target: { value: reason } });
  fireEvent.click(suspendButton());
  await act(async () => {
    fireEvent.click(confirmButton());
  });
}

describe("the admin console's kill switch (config_manage_safety)", () => {
  it("needs a reason before it can be asked for", () => {
    render(<AdminKillSwitchView />);
    expect(suspendButton()).toHaveProperty("disabled", true);
    fireEvent.change(reasonBox(), { target: { value: "   " } });
    expect(suspendButton()).toHaveProperty("disabled", true);
    fireEvent.change(reasonBox(), { target: { value: "agent:x looping" } });
    expect(suspendButton()).toHaveProperty("disabled", false);
    // Submitting a blank form does nothing.
    fireEvent.change(reasonBox(), { target: { value: "" } });
    fireEvent.submit(reasonBox().closest("form")!);
    expect(screen.queryByRole("button", { name: "Yes, suspend every agent" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for confirmation first; nothing is sent until it is given, and cancel sends nothing", () => {
    render(<AdminKillSwitchView />);
    fireEvent.change(reasonBox(), { target: { value: "incident 42" } });
    fireEvent.click(suspendButton());
    expect(screen.getByText("Suspend every agent now?")).toBeDefined();
    expect(screen.getByText("Reason: incident 42")).toBeDefined();
    expect(document.activeElement).toBe(confirmButton());
    expect(reasonBox()).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Suspend every agent now?")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.prompt).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("sends the trimmed reason to the admin route, and shows the agents suspended and the holds withdrawn", async () => {
    answer(200, { suspended: ["agent:x", "agent:y"], withdrawn: ["hold-1"] });
    render(<AdminKillSwitchView />);
    await suspendWith("  incident 42  ");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(0)).toMatchObject({
      url: "/api/admin/agents/suspend",
      method: "POST",
      body: { reason: "incident 42" },
      headers: { "Content-Type": "application/json" },
    });
    const status = await screen.findByRole("status");
    expect(
      within(status).getByText("2 agents suspended: agent:x and agent:y.")
    ).toBeDefined();
    expect(within(status).getByText("1 pending hold withdrawn:")).toBeDefined();
    expect(within(status).getByText("hold-1")).toBeDefined();
    // Back to the form: a second suspension needs its own confirmation.
    expect(screen.queryByText("Suspend every agent now?")).toBeNull();
  });

  it("nothing active: says so, and whether the invalidation was published again", async () => {
    answer(200, { suspended: [], withdrawn: [], republished: true });
    render(<AdminKillSwitchView />);
    await suspendWith("again");
    expect(
      await screen.findByText("No agent was active, so none was suspended.")
    ).toBeDefined();
    expect(
      screen.getByText("Every instance was told again to drop its cached agent registry.")
    ).toBeDefined();
    expect(screen.getByText("No pending hold was withdrawn.")).toBeDefined();
  });

  it("nothing active and the invalidation not published: a warning", async () => {
    answer(200, { suspended: [], republished: false });
    render(<AdminKillSwitchView />);
    await suspendWith("again");
    expect(await screen.findByText(/did not go through/)).toBeDefined();
  });

  it("nothing active, no republish reported: only that none was active", async () => {
    answer(200, { suspended: [], withdrawn: [] });
    render(<AdminKillSwitchView />);
    await suspendWith("again");
    await screen.findByText("No agent was active, so none was suspended.");
    expect(screen.queryByText(/told again/)).toBeNull();
    expect(screen.queryByText(/did not go through/)).toBeNull();
  });

  it("a refusal shows the server's reason; a 503 is unavailable, never a refusal", async () => {
    answer(409, {
      code: "admin.kill_switch_failed",
      message: "The agents could not all be suspended. Nothing was changed; try again.",
    });
    const { unmount } = render(<AdminKillSwitchView />);
    await suspendWith("x");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Not suspended: The agents could not all be suspended. Nothing was changed; try again."
    );
    unmount();

    answer(503, { code: "service.unavailable" });
    render(<AdminKillSwitchView />);
    await suspendWith("x");
    expect((await screen.findByRole("alert")).textContent).toMatch(/unavailable/);
  });

  it("a refusal with no message says it was refused; a network failure is unavailable", async () => {
    answer(403, {});
    const { unmount } = render(<AdminKillSwitchView />);
    await suspendWith("x");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Not suspended: The request was refused."
    );
    unmount();

    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<AdminKillSwitchView />);
    await suspendWith("x");
    expect((await screen.findByRole("alert")).textContent).toMatch(/unavailable/);
  });

  it("a body that is not JSON is a refusal, not a crash", async () => {
    fetchMock.mockImplementation(
      async () =>
        ({
          ok: false,
          status: 500,
          json: async () => {
            throw new SyntaxError("not json");
          },
        }) as unknown as Response
    );
    render(<AdminKillSwitchView />);
    await suspendWith("x");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Not suspended: The request was refused."
    );
  });

  it("shows the busy state while the request runs, and editing the reason clears the answer", async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => (release = resolve))
    );
    render(<AdminKillSwitchView />);
    fireEvent.change(reasonBox(), { target: { value: "x" } });
    fireEvent.click(suspendButton());
    fireEvent.click(confirmButton());
    expect(screen.getByRole("button", { name: "Suspending…" })).toHaveProperty(
      "disabled",
      true
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty(
      "disabled",
      true
    );
    await act(async () => {
      release(reply(200, { suspended: ["agent:x"], withdrawn: [] }));
    });
    await screen.findByText("1 agent suspended: agent:x.");
    fireEvent.change(reasonBox(), { target: { value: "y" } });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("is accessible (axe, WCAG 2.2 AA): the form, the confirmation and the answer", async () => {
    answer(200, { suspended: ["agent:x"], withdrawn: ["hold-1"] });
    const { container } = render(<AdminKillSwitchView />);
    await noViolations(container);
    fireEvent.change(reasonBox(), { target: { value: "x" } });
    fireEvent.click(suspendButton());
    await noViolations(container);
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    await screen.findByRole("status");
    await noViolations(container);
  });

  it("is a section of the admin console only for a holder of config_manage_safety", () => {
    const shell = (granted: string[]) =>
      render(
        <AdminShell
          adminName="A"
          hasPermission={(p) => granted.includes(p)}
          onSignOut={() => undefined}
        >
          {(section) => <p>{section}</p>}
        </AdminShell>
      );
    const { unmount } = shell(["can_access_admin", "admin_manage_agents"]);
    expect(screen.queryByRole("button", { name: /Agent kill switch/ })).toBeNull();
    unmount();
    shell(["config_manage_safety"]);
    fireEvent.click(screen.getByRole("button", { name: /Agent kill switch/ }));
    expect(screen.getByText("kill-switch")).toBeDefined();
  });
});

describe("the operators' per-tenant kill switch (platform_operate)", () => {
  const ROWS = [
    {
      id: "t-active",
      slug: "acme",
      name: "Acme",
      status: "active",
      domains: [],
      userCount: 4,
    },
    {
      id: "t/odd id",
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
  ];
  const view = () => render(<OperatorTenantsView data={{ tenants: ROWS }} />);

  it("is offered for every tenant not deleted", () => {
    view();
    screen.getByRole("button", { name: "Agent kill switch for Acme" });
    screen.getByRole("button", { name: "Agent kill switch for Beta" });
    expect(
      screen.queryByRole("button", { name: "Agent kill switch for Gone" })
    ).toBeNull();
  });

  it("opens for that tenant, confirms, and sends the reason to its route", async () => {
    answer(200, { suspended: ["agent:x"], withdrawn: [] });
    view();
    fireEvent.click(screen.getByRole("button", { name: "Agent kill switch for Beta" }));
    expect(
      screen.getByRole("form", { name: "Suspend every agent of Beta" })
    ).toBeDefined();
    fireEvent.change(reasonBox(), { target: { value: "beta incident" } });
    fireEvent.click(suspendButton());
    expect(screen.getByText("Suspend every agent of Beta now?")).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(sent(0)).toMatchObject({
      url: "/api/operator/tenants/t%2Fodd%20id/agents/suspend",
      method: "POST",
      body: { reason: "beta incident" },
    });
    await screen.findByText("1 agent suspended: agent:x.");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(
      screen.queryByRole("form", { name: "Suspend every agent of Beta" })
    ).toBeNull();
  });

  it("is accessible (axe, WCAG 2.2 AA) inside the tenants console", async () => {
    const { container } = view();
    fireEvent.click(screen.getByRole("button", { name: "Agent kill switch for Acme" }));
    await noViolations(container);
  });
});

describe("AgentKillSwitch without a close", () => {
  it("renders for a named tenant without a close button", async () => {
    render(<AgentKillSwitch endpoint="/x" tenant="Zed" />);
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Suspend every agent of Zed" })
      ).toBeDefined()
    );
  });
});
