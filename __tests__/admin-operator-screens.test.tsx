/**
 * @jest-environment jsdom
 */
/**
 * __tests__/admin-operator-screens.test.tsx — Erasures on the console's shared parts, and what the
 * operator screens share (TASK-221; SF-admin-090 to 093, 100, 107)
 *
 *   - Erasures: an erased account by a short reference and its date, its tenant by name, its id
 *     only with Show details; asking, approving and rejecting in the one confirm step; a store by
 *     name; a step done on no recorded date; the no-second-operator sentence says what to do;
 *   - (every recurring job's name and whether it removes records: job-names.test.ts, node);
 *   - each operator screen's states pass axe's WCAG 2.2 AA rules (jsdom: no contrast — the e2e
 *     journeys run axe on the rendered screens at 1280 and 390 px).
 */
import { renderMessage } from "@/platform/errors/messages";
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ErasuresPanel } from "@/components/admin/ErasuresPanel";
import { OperatorJobsView } from "@/components/admin/JobsPanels";
import {
  OperatorTenantsView,
  TenantSettingsView,
} from "@/components/admin/TenancyPanels";
import { AdminKillSwitchView } from "@/components/admin/AgentKillSwitchPanel";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";

// axe-core is installed with @axe-core/playwright (the e2e audits); here it runs in jsdom.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const axe = require("axe-core");
async function noViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(results.violations.map((v: { id: string }) => v.id)).toEqual([]);
}

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
const bodyOf = <T,>(name: string) =>
  JSON.parse(JSON.stringify(routeAnswer(name as RouteFixtureName)[1])) as T;
const er = (key: string, v?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.erasures.${key}`, v);

const ONE = "GET /api/operator/erasures — an unverifiable identity, one operator";
const ID = "0f0fc9b2-0000-4000-8000-000000000001";
const withTwo = (request?: { byViewer: boolean }) => {
  const o = bodyOf<{
    operators: number;
    erasures: {
      secondOperator: boolean;
      tenantName?: string;
      steps: Record<string, unknown>[];
    }[];
  }>(ONE);
  o.operators = 2;
  o.erasures[0]!.secondOperator = true;
  o.erasures[0]!.tenantName = "Acme";
  if (request)
    o.erasures[0]!.steps[0]!.attestationRequest = {
      by: { kind: "account", email: "op-a@example.test" },
      byViewer: request.byViewer,
      at: "2026-01-01T00:00:00.000Z",
      reason: "deleted_in_old_pool",
      expiresAt: "2099-01-08T00:00:00.000Z",
      expired: false,
    };
  return o;
};

describe("Erasures (SF-admin-090 to 093)", () => {
  it("[SF-admin-090] the account by a short reference and its date, the tenant by name; the whole id only with Show details", async () => {
    const { container, rerender } = render(<ErasuresPanel data={withTwo()} />);
    expect(screen.getByText(/^Erased account 0f0fc9b2…, erased/)).toBeDefined();
    expect(container.textContent).not.toContain(ID);
    expect(screen.getByText(er("tenant", { tenant: "Acme" }))).toBeDefined();
    expect(container.textContent).not.toContain("aaaaaaaa-0000-4000-8000-00000000000a");
    rerender(<ErasuresPanel data={withTwo()} showIds />);
    expect(screen.getByText(ID)).toBeDefined();
    await noViolations(container);
  });

  it("[SF-admin-092] a store by its name; a step done on no recorded date says only that it is done", () => {
    const o = withTwo();
    o.erasures[0]!.steps.push({
      store: "mail-list",
      done: true,
      attempts: 1,
      poolUnverified: false,
    });
    render(<ErasuresPanel data={o} />);
    expect(screen.getByText("The sign-in service")).toBeDefined();
    expect(screen.getByText("Mail list")).toBeDefined();
    // Its words alone — never "Erased " followed by nothing.
    expect(screen.getByText(er("step_done_undated")).textContent).toBe(
      er("step_done_undated")
    );
  });

  it("[SF-admin-093] no second operator: the sentence says what to do — no document to look up", () => {
    render(<ErasuresPanel data={bodyOf(ONE)} />);
    const said = screen.getByText(er("no_second_operator", { operators: 1 }));
    expect(said.textContent).not.toMatch(/see single-owner/i);
    expect(said.textContent).toMatch(/operator role/);
    expect(screen.queryByRole("button", { name: er("ask") })).toBeNull();
  });

  it("[SF-admin-091] asking is the one confirm step: the kind of reason by name, the note required at its field", async () => {
    fetchMock.mockResolvedValue(
      reply("POST /api/operator/tenants/[id]/erasures/[userId]/attestation — asked")
    );
    const reload = jest.fn();
    render(<ErasuresPanel data={withTwo()} onReload={reload} />);
    fireEvent.click(screen.getByRole("button", { name: er("ask") }));
    const confirm = screen.getByRole("alertdialog");
    expect(confirm).toHaveFocus();
    fireEvent.change(within(confirm).getByLabelText(er("field_reason")), {
      target: { value: "deleted_in_old_pool" },
    });
    fireEvent.click(within(confirm).getByRole("button", { name: er("submit_ask") }));
    expect(within(confirm).getByLabelText(/Reason/)).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(within(confirm).getByLabelText(/Reason/), {
      target: { value: "absent from both pools" },
    });
    fireEvent.click(within(confirm).getByRole("button", { name: er("submit_ask") }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/api/operator/tenants/aaaaaaaa-0000-4000-8000-00000000000a/erasures/${ID}/attestation`
    );
    expect(JSON.parse(String(init.body))).toEqual({
      reason: "deleted_in_old_pool",
      note: "absent from both pools",
      store: "identity-provider",
    });
    // Asked: held for a second operator — never "done".
    await waitFor(() =>
      expect(document.querySelector("[data-outcome='held']")).not.toBeNull()
    );
    // The request now shows on its step: the list is read again.
    expect(reload).toHaveBeenCalled();
  });

  it("[SF-admin-091] approving cannot be undone: the step says so, takes focus, and its button names the action", async () => {
    fetchMock.mockResolvedValue(
      reply("POST /api/operator/tenants/[id]/erasures/[userId]/attestation — approved")
    );
    render(<ErasuresPanel data={withTwo({ byViewer: false })} />);
    fireEvent.click(screen.getByRole("button", { name: er("approve") }));
    const confirm = screen.getByRole("alertdialog");
    expect(confirm).toHaveFocus();
    expect(confirm).toHaveAttribute("data-risk", "irreversible");
    expect(within(confirm).queryByRole("button", { name: "Confirm" })).toBeNull();
    fireEvent.click(within(confirm).getByRole("button", { name: er("approve") }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(
      JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))
    ).toEqual({ decision: "approve", store: "identity-provider" });
    await waitFor(() =>
      expect(document.querySelector("[data-outcome='applied']")).not.toBeNull()
    );
  });

  it("[hostile:self] one's own request: Approve disabled with why; a refusal is said", async () => {
    fetchMock.mockResolvedValue(
      reply(
        "POST /api/operator/tenants/[id]/erasures/[userId]/attestation — refused (own request)"
      )
    );
    render(<ErasuresPanel data={withTwo({ byViewer: true })} />);
    const approve = screen.getByRole("button", { name: er("approve") });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription(er("own_request"));
    fireEvent.click(screen.getByRole("button", { name: er("reject") }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: er("reject") })
    );
    await waitFor(() =>
      expect(document.querySelector("[data-outcome='refused']")).not.toBeNull()
    );
  });

  it("asking and approving can each be cancelled at the confirm step — nothing sent", () => {
    render(<ErasuresPanel data={withTwo({ byViewer: false })} />);
    fireEvent.click(screen.getByRole("button", { name: er("approve") }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: /Cancel/ })
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const ask = screen.queryByRole("button", { name: er("ask") });
    if (ask) {
      fireEvent.click(ask);
      fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", { name: /Cancel/ })
      );
      expect(screen.queryByRole("alertdialog")).toBeNull();
    }
    render(<ErasuresPanel data={withTwo()} />);
    fireEvent.click(screen.getAllByRole("button", { name: er("ask") }).at(-1)!);
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: /Cancel/ })
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a body without its list is said as a failed read; an empty list is said as empty", () => {
    const { rerender } = render(<ErasuresPanel data={{}} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/Could not read/);
    rerender(<ErasuresPanel data={{ ...bodyOf<object>(ONE), erasures: [] }} />);
    expect(screen.getByText(er("empty"))).toBeDefined();
  });
});

describe("the operator screens pass axe (WCAG 2.2 AA, jsdom)", () => {
  it.each([
    [
      "Jobs",
      () => (
        <OperatorJobsView
          data={bodyOf(
            "GET /api/operator/jobs — failures, dead letters and a record from before codes"
          )}
        />
      ),
    ],
    [
      "Tenants",
      () => (
        <OperatorTenantsView data={bodyOf("GET /api/operator/tenants — every state")} />
      ),
    ],
    [
      "Tenant",
      () => (
        <TenantSettingsView
          data={bodyOf(
            "GET /api/admin/tenant — a shared deployment's tenant, its spend under the cap"
          )}
        />
      ),
    ],
    ["Kill switch", () => <AdminKillSwitchView />],
  ])("%s", async (_name, view) => {
    const { container } = render(view());
    await noViolations(container);
  });
});
