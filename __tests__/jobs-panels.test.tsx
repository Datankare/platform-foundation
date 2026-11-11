/**
 * @jest-environment jsdom
 */
/**
 * The Jobs console (components/admin/JobsPanels.tsx, ADR-056): what each action sends, that a
 * change asks for its reason inline (never window.prompt) and a discard for confirmation, that
 * every answer is shown — and that both views pass axe's WCAG 2.2 AA rules.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  OperatorJobsView,
  TenantJobsList,
  type JobsData,
} from "@/components/admin/JobsPanels";
import { routeAnswer } from "@/__tests__/fixtures/route-responses";
import { renderMessage } from "@/platform/errors/messages";

// axe-core is installed with @axe-core/playwright (the e2e audits); here it runs in jsdom.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const axe = require("axe-core");

const fetchMock = jest.fn();
beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});
beforeEach(() => fetchMock.mockReset());

function reply(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}
function answers(...list: [number, unknown][]) {
  let i = 0;
  fetchMock.mockImplementation(async () => {
    const [s, b] = list[Math.min(i++, list.length - 1)];
    return reply(s, b);
  });
}
const sent = (n: number) => {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit | undefined];
  return {
    url,
    method: init?.method ?? "GET",
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
};

// The Jobs console's data is the route's own answer (__tests__/route-fixtures.test.ts makes it from
// a store holding these jobs): the escalation reaper failing for one tenant of three, a module's
// schedule turned off with a tenant opt-out, a required schedule, and dead letters — one coded,
// one recorded before failures were coded (N-108).
const HISTORY =
  "GET /api/operator/jobs — failures, dead letters and a record from before codes";
const DATA = routeAnswer(HISTORY)[1] as JobsData;
const UNCODED = renderMessage("screens.jobs.errors.uncoded");
const messageOf = (name: Parameters<typeof routeAnswer>[0]) =>
  (routeAnswer(name)[1] as { message: string }).message;

async function noViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag22aa"] },
    // jsdom has no layout or canvas: contrast is the e2e audit's.
    rules: { "color-contrast": { enabled: false } },
  });
  expect(results.violations.map((v: { id: string }) => v.id)).toEqual([]);
}

describe("OperatorJobsView", () => {
  it("shows loading until there is data", () => {
    render(<OperatorJobsView data={undefined} />);
    expect(screen.getByText("Loading…")).toBeDefined();
  });

  it("shows each schedule, its state and the dead letters", () => {
    render(<OperatorJobsView data={DATA} />);
    // The schedule, and its two dead jobs.
    expect(screen.getAllByText("moderation.escalation-reaper")).toHaveLength(3);
    expect(screen.getByText("Every 15 minutes")).toBeDefined();
    expect(
      screen.getByText(
        /Last job was dead-lettered \(failing for 1 of 3 tenants\) — The database was unavailable\./
      )
    ).toBeDefined();
    expect(screen.getByText("1 queued · 0 running · 2 dead")).toBeDefined();
    expect(screen.getAllByText("No job has finished yet").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/a tenant may turn it off \(social.scheduled_agents_enabled\)/)
    ).toBeDefined();
    expect(
      screen.getByText("The job reported a failure (erasures_incomplete).")
    ).toBeDefined();
  });

  // N-108: a record written before failures were coded holds the runner's English. The screen
  // says, from the catalog, that it predates the codes; the stored text is behind a disclosure.
  it("a record from before the codes: the catalog's note, its stored text behind a disclosure", () => {
    const legacy = DATA.deadLetters!.find(
      (j) => j.lastError === "The database was unavailable."
    );
    expect(legacy).toBeDefined();
    const { container } = render(<OperatorJobsView data={DATA} />);
    const note = screen.getByText(UNCODED, { exact: false });
    const details = note.closest("td")!.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(within(details).getByText("Show the stored text")).toBeDefined();
    expect(within(details).getByText("The database was unavailable.")).toBeDefined();
    // Every other failure is in the catalog's words (none shown as stored).
    expect(container.querySelectorAll("details")).toHaveLength(1);
  });

  // TASK-194 round 18: a required schedule offers no "Turn off" — it is always on.
  // TASK-207's walk at 390 px: the tables made the page wider than the phone (676 px), on the base
  // too. Each scrolls within its card now; the page does not.
  it("each table scrolls within its card, so the page fits a phone", () => {
    const { container } = render(<OperatorJobsView data={DATA} />);
    const tables = container.querySelectorAll("table");
    expect(tables.length).toBeGreaterThan(1);
    for (const table of tables)
      expect(table.parentElement?.classList.contains("overflow-x-auto")).toBe(true);
  });

  it("a required schedule has no Turn off, and says it is always on", () => {
    expect(
      DATA.schedules!.find((x) => x.kind === "config.expire-approvals")?.required
    ).toBe(true);
    render(<OperatorJobsView data={DATA} />);
    expect(screen.getByText("config.expire-approvals")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /^Turn off config\.expire-approvals/ })
    ).toBeNull();
    expect(screen.getByText(/Required: always on/)).toBeDefined();
  });

  it("is accessible (axe, WCAG 2.2 AA)", async () => {
    const { container } = render(<OperatorJobsView data={DATA} />);
    await noViolations(container);
    fireEvent.click(
      screen.getByRole("button", { name: "Turn off moderation.escalation-reaper" })
    );
    await noViolations(container);
  });

  it("asks for a reason inline before turning a schedule off — never window.prompt", async () => {
    const prompt = jest.spyOn(window, "prompt");
    // The routes' own answers (TASK-200 rule 3: __tests__/route-fixtures.test.ts makes them).
    answers(
      routeAnswer("PATCH /api/operator/jobs/schedules/[kind] — turned off"),
      routeAnswer("GET /api/operator/jobs — an operator")
    );
    render(<OperatorJobsView data={DATA} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Turn off moderation.escalation-reaper" })
    );
    const form = screen.getByRole("form", {
      name: "Turn off moderation.escalation-reaper",
    });
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "maintenance" },
    });
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(sent(0)).toEqual({
      url: "/api/operator/jobs/schedules/moderation.escalation-reaper",
      method: "PATCH",
      body: { enabled: false, changeComment: "maintenance" },
    });
    expect(sent(1).url).toBe("/api/operator/jobs");
    expect(screen.getByRole("status").textContent).toBe(
      "Turn off moderation.escalation-reaper: done."
    );
    expect(prompt).not.toHaveBeenCalled();
    prompt.mockRestore();
  });

  it("says when a change is held for a second operator", async () => {
    // The route's own held answer is `success: false, pending: true` — not the hand-written
    // `success: true` this test used before TASK-200.
    answers(
      routeAnswer(
        "PATCH /api/operator/jobs/schedules/[kind] — held for a second operator"
      ),
      routeAnswer("GET /api/operator/jobs — an operator")
    );
    render(<OperatorJobsView data={DATA} />);
    fireEvent.click(screen.getByRole("button", { name: "Turn on test.optout" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "back on" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Turn on test.optout: held for a second operator's approval."
      )
    );
  });

  it("sets an interval only inside its bounds", async () => {
    answers(
      routeAnswer(
        "PATCH /api/operator/jobs/schedules/[kind] — held for a second operator"
      ),
      routeAnswer(HISTORY)
    );
    render(<OperatorJobsView data={DATA} />);
    const field = screen.getByLabelText(
      "New interval for moderation.escalation-reaper, in minutes"
    );
    const set = screen.getByRole("button", {
      name: "Set the interval of moderation.escalation-reaper",
    }) as HTMLButtonElement;
    for (const bad of ["4", "61", "7.5", "x", ""]) {
      fireEvent.change(field, { target: { value: bad } });
      expect(set.disabled).toBe(true);
    }
    fireEvent.change(field, { target: { value: "30" } });
    expect(set.disabled).toBe(false);
    fireEvent.click(set);
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "less often" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0).body).toEqual({ intervalMinutes: 30, changeComment: "less often" });
  });

  it("runs a job now, and shows a refusal's own message", async () => {
    const refused =
      "POST /api/operator/jobs/schedules/[kind]/run — refused (the audit log down)";
    answers(routeAnswer(refused));
    render(<OperatorJobsView data={DATA} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run test.optout now" }));
    });
    await waitFor(() => expect(screen.getByRole("status")).toBeDefined());
    expect(sent(0)).toMatchObject({
      url: "/api/operator/jobs/schedules/test.optout/run",
      method: "POST",
    });
    expect(screen.getByRole("status").textContent).toBe(
      `Run test.optout now: failed — ${messageOf(refused)}`
    );
  });

  it("replays a dead job", async () => {
    answers(
      routeAnswer("POST /api/operator/jobs/dead/[id] — replayed"),
      routeAnswer("GET /api/operator/jobs — the dead letters gone")
    );
    render(<OperatorJobsView data={DATA} />);
    await act(async () => {
      fireEvent.click(
        screen.getAllByRole("button", { name: "Replay gdpr.retention-purge" })[0]!
      );
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(sent(0)).toEqual({
      url: `/api/operator/jobs/dead/${DATA.deadLetters![0]!.id}`,
      method: "POST",
      body: { action: "replay" },
    });
    await waitFor(() => expect(screen.getByText("No dead-lettered jobs.")).toBeDefined());
  });

  it("asks to confirm a discard, and can be cancelled", async () => {
    answers(
      routeAnswer("POST /api/operator/jobs/dead/[id] — discarded"),
      routeAnswer(HISTORY)
    );
    render(<OperatorJobsView data={DATA} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Discard gdpr.retention-purge" })[0]!
    );
    expect(
      screen.getByText(/Discard this gdpr.retention-purge job for good/)
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Discard gdpr.retention-purge" })[0]!
    );
    const group = screen.getByRole("group", { name: "Discard gdpr.retention-purge" });
    await act(async () => {
      fireEvent.click(group.querySelector("button") as HTMLButtonElement);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(0).body).toEqual({ action: "discard" });
  });

  it("treats an unreachable server as a refusal, not a crash", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<OperatorJobsView data={DATA} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run test.optout now" }));
    });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Run test.optout now: failed — The request was refused."
      )
    );
  });
});

describe("TenantJobsList", () => {
  it("renders nothing without a history field, and says when it could not be read", () => {
    const { container, rerender } = render(<TenantJobsList jobs={undefined} />);
    expect(container.textContent).toBe("");
    rerender(<TenantJobsList jobs={null} />);
    expect(
      screen.getByText("The job history could not be read right now.")
    ).toBeDefined();
    rerender(<TenantJobsList jobs={[]} />);
    expect(screen.getByText("No background jobs yet.")).toBeDefined();
  });

  it("lists the tenant's jobs read-only, and is accessible", async () => {
    const { container } = render(<TenantJobsList jobs={DATA.deadLetters} />);
    expect(screen.getAllByText("gdpr.retention-purge")).toHaveLength(2);
    expect(screen.getAllByText("Dead-lettered")).toHaveLength(DATA.deadLetters!.length);
    expect(screen.getAllByText("1 of 1")).toHaveLength(2);
    // The record from before the codes: the catalog's note, its stored text disclosed on request.
    expect(screen.getByText(UNCODED, { exact: false })).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
    await noViolations(container);
  });
});
