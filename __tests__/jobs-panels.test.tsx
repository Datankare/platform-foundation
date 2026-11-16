/**
 * @jest-environment jsdom
 */
/**
 * __tests__/jobs-panels.test.tsx — the operators' Jobs console on the console's shared parts
 * (TASK-221; SCREEN-FINDINGS Jobs, SF-admin-100 to 108)
 *
 * Fed the routes' own answers (__tests__/fixtures/route-responses.json). Each case names the
 * finding it holds.
 */
import { renderMessage } from "@/platform/errors/messages";
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { OperatorJobsView, TenantJobsList } from "@/components/admin/JobsPanels";
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
function answers(...list: string[]) {
  let i = 0;
  fetchMock.mockImplementation(async () => reply(list[Math.min(i++, list.length - 1)]!));
}
const bodyOf = <T,>(name: string) =>
  JSON.parse(JSON.stringify(routeAnswer(name as RouteFixtureName)[1])) as T;
const sent = (n: number) => {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit | undefined];
  return {
    url,
    method: init?.method ?? "GET",
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
};
const t = (key: string, v?: Record<string, string | number>) =>
  renderMessage(`screens.jobs.${key}`, v);

type Jobs = {
  schedules: Record<string, unknown>[];
  deadLetters: Record<string, unknown>[];
  unresolvedEffects: Record<string, unknown>[];
};
const DATA = () => {
  const d = bodyOf<Jobs>(
    "GET /api/operator/jobs — failures, dead letters and a record from before codes"
  );
  // The tenant by name, as the route names one the directory lists (SF-admin-102).
  for (const j of d.deadLetters) j.tenantName = "Acme";
  return d;
};
const REAPER = "Overdue escalations";

describe("OperatorJobsView", () => {
  it("lists each section in the one table: jobs by name, tenants by name — never an id or a code (SF-admin-102, 107)", () => {
    const data = DATA();
    const { container } = render(<OperatorJobsView data={data} />);
    expect(screen.getByRole("table", { name: t("schedules_caption") })).toBeDefined();
    const dead = screen.getByRole("table", { name: t("dead_caption") });
    expect(within(dead).getAllByText("Acme").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("aaaaaaaa-0000-4000-8000-00000000000a");
    expect(container.textContent).not.toContain("moderation.escalation-reaper");
    // Every date in the console's format: no ISO text.
    expect(container.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("a job opens its panel at the row; its owner and its tenant opt-out by name (SF-admin-105, 107)", async () => {
    render(<OperatorJobsView data={DATA()} />);
    fireEvent.click(
      screen.getByRole("button", { name: t("open_job", { job: "Test optout" }) })
    );
    const panel = screen.getByRole("region", { name: "Test optout" });
    await waitFor(() =>
      expect(within(panel).getByRole("heading", { name: "Test optout" })).toHaveFocus()
    );
    expect(panel).toHaveTextContent(/Social: scheduled agents enabled/);
    expect(panel).not.toHaveTextContent("social.scheduled_agents_enabled");
  });

  it("[SF-admin-100] Run now is confirmed — never one click — and a job that removes records cannot be undone and asks why", async () => {
    const data = DATA();
    data.schedules[0]!.deletesData = true;
    answers(
      "POST /api/operator/jobs/schedules/[kind]/run — refused (the audit log down)"
    );
    render(<OperatorJobsView data={data} />);
    fireEvent.click(screen.getByRole("button", { name: t("open_job", { job: REAPER }) }));
    fireEvent.click(screen.getByRole("button", { name: t("run_now") }));
    expect(fetchMock).not.toHaveBeenCalled();
    const confirm = screen.getByRole("alertdialog", {
      name: t("confirm_run_now", { job: REAPER }),
    });
    expect(confirm).toHaveAttribute("data-risk", "irreversible");
    fireEvent.click(within(confirm).getByRole("button", { name: t("run_now") }));
    expect(within(confirm).getByRole("alert")).toHaveTextContent(/at least 3 characters/);
    fireEvent.change(within(confirm).getByLabelText(/Reason/), {
      target: { value: "catch up after the outage" },
    });
    fireEvent.click(within(confirm).getByRole("button", { name: t("run_now") }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0)).toEqual({
      url: "/api/operator/jobs/schedules/moderation.escalation-reaper/run",
      method: "POST",
      body: { reason: "catch up after the outage" },
    });
    // The refusal is said in the schedules' own outcome list.
    await waitFor(() =>
      expect(document.querySelector("[data-outcome='refused']")).not.toBeNull()
    );
  });

  it("a job that removes nothing is still confirmed, its reason optional", async () => {
    answers(
      "POST /api/operator/jobs/schedules/[kind]/run — refused (the audit log down)"
    );
    render(<OperatorJobsView data={DATA()} />);
    fireEvent.click(screen.getByRole("button", { name: t("open_job", { job: REAPER }) }));
    fireEvent.click(screen.getByRole("button", { name: t("run_now") }));
    const confirm = screen.getByRole("alertdialog");
    expect(confirm).toHaveAttribute("data-risk", "consequential");
    fireEvent.click(within(confirm).getByRole("button", { name: t("run_now") }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0).body).toEqual({});
  });

  it("[SF-admin-106] an interval out of its bounds is said at its field, with the bounds — the button is never just grey", async () => {
    answers("PATCH /api/operator/jobs/schedules/[kind] — held for a second operator");
    render(<OperatorJobsView data={DATA()} />);
    fireEvent.click(screen.getByRole("button", { name: t("open_job", { job: REAPER }) }));
    fireEvent.click(screen.getByRole("button", { name: t("change_interval") }));
    const field = screen.getByLabelText(t("interval_field"));
    expect(field).toHaveAccessibleDescription(t("interval_bounds", { min: 5, max: 60 }));
    fireEvent.change(field, { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: t("review") }));
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(
      t("interval_out_of_bounds", { min: 5, max: 60 })
    );
    fireEvent.change(field, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: t("review") }));
    const confirm = screen.getByRole("alertdialog");
    expect(confirm).toHaveTextContent(t("interval_change", { from: 15, to: 30 }));
    fireEvent.change(within(confirm).getByLabelText(/Reason/), {
      target: { value: "less load at night" },
    });
    fireEvent.click(within(confirm).getByRole("button", { name: t("set_interval") }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0)).toEqual({
      url: "/api/operator/jobs/schedules/moderation.escalation-reaper",
      method: "PATCH",
      body: { intervalMinutes: 30, changeComment: "less load at night" },
    });
    const held = await screen.findByText(
      t("what_interval", { job: REAPER, minutes: 30 })
    );
    expect(held.closest("[data-outcome]")).toHaveAttribute("data-outcome", "held");
  });

  it("a required job offers no Turn off, and says why", () => {
    render(<OperatorJobsView data={DATA()} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: t("open_job", { job: "Expire configuration approvals" }),
      })
    );
    expect(screen.queryByRole("button", { name: t("turn_off") })).toBeNull();
    expect(screen.getByText(t("required_help"))).toBeDefined();
  });

  it("[SF-admin-103, 108, 101] a replay is confirmed with its reason, and its outcome stays beside the dead jobs", async () => {
    answers("POST /api/operator/jobs/dead/[id] — replayed");
    const reload = jest.fn();
    render(<OperatorJobsView data={DATA()} onReload={reload} />);
    fireEvent.click(
      screen.getAllByRole("button", {
        name: /^Open the failed job Erasure purge/,
      })[0]!
    );
    fireEvent.click(screen.getByRole("button", { name: t("replay") }));
    expect(fetchMock).not.toHaveBeenCalled();
    const confirm = screen.getByRole("alertdialog");
    expect(confirm).toHaveFocus();
    fireEvent.change(within(confirm).getByLabelText(/Reason/), {
      target: { value: "the database is back" },
    });
    fireEvent.click(within(confirm).getByRole("button", { name: t("replay") }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0)).toEqual({
      url: "/api/operator/jobs/dead/00000000-0000-4000-8000-000000000001",
      method: "POST",
      body: { action: "replay", reason: "the database is back" },
    });
    const done = await screen.findByText(/Run Erasure purge again/);
    // In the dead jobs' section, not under the schedules.
    const section = done.closest("section")!;
    expect(
      within(section).getByRole("heading", { name: t("dead_heading") })
    ).toBeDefined();
    expect(reload).toHaveBeenCalled();
  });

  it("[SF-admin-108] a discard cannot be undone, is confirmed and needs its reason", async () => {
    answers("POST /api/operator/jobs/dead/[id] — discarded");
    render(<OperatorJobsView data={DATA()} />);
    fireEvent.click(
      screen.getAllByRole("button", {
        name: /^Open the failed job Erasure purge/,
      })[0]!
    );
    fireEvent.click(screen.getByRole("button", { name: t("discard") }));
    const confirm = screen.getByRole("alertdialog");
    expect(confirm).toHaveAttribute("data-risk", "irreversible");
    fireEvent.click(within(confirm).getByRole("button", { name: t("discard") }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(within(confirm).getByLabelText(/Reason/), {
      target: { value: "a test tenant, removed" },
    });
    fireEvent.click(within(confirm).getByRole("button", { name: t("discard") }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0).body).toEqual({ action: "discard", reason: "a test tenant, removed" });
  });
});

describe("OperatorJobsView: each step, each answer", () => {
  it("a run now that ran says what ran, in words, and reads the list again", async () => {
    answers("POST /api/operator/jobs/schedules/[kind]/run — ran");
    const reload = jest.fn();
    render(<OperatorJobsView data={DATA()} onReload={reload} />);
    fireEvent.click(screen.getByRole("button", { name: t("open_job", { job: REAPER }) }));
    fireEvent.click(screen.getByRole("button", { name: t("run_now") }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: t("run_now") })
    );
    const done = await screen.findByText(
      t("run_now_done", { job: REAPER, enqueued: 1, succeeded: 0, retried: 0, dead: 0 })
    );
    expect(done.closest("[data-outcome]")).toHaveAttribute("data-outcome", "applied");
    expect(reload).toHaveBeenCalled();
  });

  it("turning a job off is confirmed with its reason; cancelling sends nothing", async () => {
    answers("PATCH /api/operator/jobs/schedules/[kind] — turned off");
    render(<OperatorJobsView data={DATA()} showIds />);
    fireEvent.click(screen.getByRole("button", { name: t("open_job", { job: REAPER }) }));
    // With Show details the job's stored kind is there to copy.
    expect(screen.getAllByText("moderation.escalation-reaper").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: t("turn_off") }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: t("cancel") })
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("turn_off") }));
    const confirm = screen.getByRole("alertdialog");
    fireEvent.change(within(confirm).getByLabelText(/Reason/), {
      target: { value: "paused for the migration" },
    });
    fireEvent.click(within(confirm).getByRole("button", { name: t("turn_off") }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0)).toEqual({
      url: "/api/operator/jobs/schedules/moderation.escalation-reaper",
      method: "PATCH",
      body: { enabled: false, changeComment: "paused for the migration" },
    });
  });

  it("a job turned off offers Turn on; an interval not whole, or unchanged, is said at its field", () => {
    const data = DATA();
    const optout = data.schedules.find((s) => s.kind === "test.optout")!;
    const bounds = {
      min: optout.minIntervalMinutes as number,
      max: optout.maxIntervalMinutes as number,
    };
    const now = String(optout.intervalMinutes);
    render(<OperatorJobsView data={data} />);
    fireEvent.click(
      screen.getByRole("button", { name: t("open_job", { job: "Test optout" }) })
    );
    fireEvent.click(screen.getByRole("button", { name: t("turn_on") }));
    expect(screen.getByRole("alertdialog")).toBeDefined();
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: t("cancel") })
    );
    fireEvent.click(screen.getByRole("button", { name: t("change_interval") }));
    const field = screen.getByLabelText(t("interval_field"));
    fireEvent.change(field, { target: { value: "7.5" } });
    fireEvent.click(screen.getByRole("button", { name: t("review") }));
    expect(screen.getByRole("alert")).toHaveTextContent(t("interval_not_whole", bounds));
    fireEvent.change(field, { target: { value: now } });
    fireEvent.click(screen.getByRole("button", { name: t("review") }));
    expect(screen.getByRole("alert")).toHaveTextContent(t("interval_unchanged"));
    fireEvent.change(field, { target: { value: String(bounds.min + 1) } });
    fireEvent.click(screen.getByRole("button", { name: t("review") }));
    // Back from the confirm step to the field, then out.
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: t("cancel") })
    );
    expect(screen.getByLabelText(t("interval_field"))).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: t("cancel") }));
    expect(screen.queryByLabelText(t("interval_field"))).toBeNull();
  });

  it("a row opens its panel by a click anywhere on it; a dead job's step can be cancelled", () => {
    render(<OperatorJobsView data={DATA()} showIds />);
    const schedules = screen.getByRole("table", { name: t("schedules_caption") });
    fireEvent.click(within(schedules).getAllByRole("row")[1]!);
    expect(screen.getAllByRole("region").length).toBeGreaterThan(0);
    const dead = screen.getByRole("table", { name: t("dead_caption") });
    fireEvent.click(within(dead).getAllByRole("row")[1]!);
    fireEvent.click(screen.getByRole("button", { name: t("discard") }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: t("cancel") })
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unresolved call: by its tenant's name, settled as took effect or no effect, confirmed", async () => {
    const data = DATA();
    data.unresolvedEffects = [
      {
        id: "effect-1",
        tenantId: "aaaaaaaa-0000-4000-8000-00000000000a",
        tenantName: "Acme",
        operationId: "op-1",
        effectKey: "send-mail:1",
        effectType: "mail.send",
        attempts: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    answers("POST /api/operator/jobs/effects/[id] — took effect");
    const { container } = render(<OperatorJobsView data={data} showIds />);
    const effects = screen.getByRole("table", { name: t("effects_caption") });
    expect(within(effects).getByText("Acme")).toBeDefined();
    fireEvent.click(within(effects).getAllByRole("row")[1]!);
    expect(container.textContent).toContain("send-mail:1");
    fireEvent.click(screen.getByRole("button", { name: t("no_effect") }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: t("cancel") })
    );
    fireEvent.click(screen.getByRole("button", { name: t("took_effect") }));
    const confirm = screen.getByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: t("took_effect") }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0)).toEqual({
      url: "/api/operator/jobs/effects/effect-1",
      method: "POST",
      body: { outcome: "took_effect" },
    });
    await waitFor(() =>
      expect(document.querySelector("[data-outcome='applied']")).not.toBeNull()
    );
  });

  it("a body without its lists is said as a failed read — never 'Loading…' for ever", () => {
    render(<OperatorJobsView data={{ schedules: [] }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/Could not read/);
  });

  it("a stored failure from before the codes is behind a disclosure — never the screen's words", () => {
    const { container } = render(<OperatorJobsView data={DATA()} />);
    expect(container.querySelector("[data-stored-text='true']")).not.toBeNull();
  });
});

describe("TenantJobsList", () => {
  it("not part of the read: nothing; unreadable: said; none: said; a job by name and state", () => {
    const { container, rerender } = render(<TenantJobsList jobs={undefined} />);
    expect(container.textContent).toBe("");
    rerender(<TenantJobsList jobs={null} />);
    expect(screen.getByText(t("tenant_unavailable"))).toBeDefined();
    rerender(<TenantJobsList jobs={[]} />);
    expect(screen.getByText(t("tenant_none"))).toBeDefined();
    rerender(
      <TenantJobsList
        jobs={[
          {
            id: "j1",
            kind: "gdpr.retention-purge",
            status: "dead",
            attempts: 1,
            maxAttempts: 1,
            lastError: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "j2",
            kind: "jobs.prune",
            status: "weird" as never,
            attempts: 1,
            maxAttempts: 1,
            lastError: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ]}
      />
    );
    expect(screen.getByText(t("status_dead"))).toBeDefined();
    // A state the catalogue does not know is said to be unknown — never as stored.
    expect(screen.getByText(t("status_unknown"))).toBeDefined();
    expect(screen.queryByText("weird")).toBeNull();
  });
});
