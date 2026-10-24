/**
 * @jest-environment jsdom
 */
/**
 * The Jobs console (components/admin/JobsPanels.tsx, ADR-056): what each action sends, that a
 * change asks for its reason inline (never window.prompt) and a discard for confirmation, that
 * every answer is shown — and that both views pass axe's WCAG 2.2 AA rules.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  OperatorJobsView,
  TenantJobsList,
  type JobsData,
} from "@/components/admin/JobsPanels";

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

const DATA: JobsData = {
  schedules: [
    {
      kind: "moderation.escalation-reaper",
      description: "Applies the remedy to escalations over their SLA.",
      owner: "core",
      scope: "each-tenant",
      enabled: true,
      intervalMinutes: 15,
      minIntervalMinutes: 5,
      maxIntervalMinutes: 60,
      tenantOptOutKey: null,
      state: {
        nextRunAt: "2026-10-24T10:15:00.000Z",
        lastRunAt: "2026-10-24T10:00:00.000Z",
        lastEnqueued: 3,
        lastStatus: "dead",
        lastError: "The database was unavailable.",
        lastFinishedAt: "2026-10-24T10:01:00.000Z",
        reported: 3,
        failing: 1,
        queued: 1,
        running: 0,
        dead: 2,
      },
    },
    {
      kind: "social.curator",
      description: "Runs the curator agent.",
      owner: "social",
      scope: "each-tenant",
      enabled: false,
      intervalMinutes: 1440,
      minIntervalMinutes: 60,
      maxIntervalMinutes: 10080,
      tenantOptOutKey: "social.scheduled_agents_enabled",
      state: null,
    },
  ],
  deadLetters: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      tenantId: "aaaaaaaa-0000-4000-8000-00000000000a",
      kind: "gdpr.retention-purge",
      status: "dead",
      attempts: 5,
      maxAttempts: 5,
      lastError:
        "2 of 3 due erasures did not complete; they stay due and are tried again.",
      updatedAt: "2026-10-24T09:00:00.000Z",
    },
  ],
};

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
    expect(screen.getByText("moderation.escalation-reaper")).toBeDefined();
    expect(screen.getByText("Every 15 minutes")).toBeDefined();
    expect(
      screen.getByText(
        /Last job was dead-lettered \(failing for 1 of 3 tenants\) — The database was unavailable\./
      )
    ).toBeDefined();
    expect(screen.getByText("1 queued · 0 running · 2 dead")).toBeDefined();
    expect(screen.getByText("No job has finished yet")).toBeDefined();
    expect(
      screen.getByText(/a tenant may turn it off \(social.scheduled_agents_enabled\)/)
    ).toBeDefined();
    expect(screen.getByText(/2 of 3 due erasures did not complete/)).toBeDefined();
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
    answers([200, { success: true }], [200, DATA]);
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
    answers([202, { success: true, pending: true }], [200, DATA]);
    render(<OperatorJobsView data={DATA} />);
    fireEvent.click(screen.getByRole("button", { name: "Turn on social.curator" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "back on" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Turn on social.curator: held for a second operator's approval."
      )
    );
  });

  it("sets an interval only inside its bounds", async () => {
    answers([200, { success: true }], [200, DATA]);
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
    answers([
      503,
      { code: "service.unavailable", message: "The audit log is unavailable." },
    ]);
    render(<OperatorJobsView data={DATA} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run social.curator now" }));
    });
    await waitFor(() => expect(screen.getByRole("status")).toBeDefined());
    expect(sent(0)).toMatchObject({
      url: "/api/operator/jobs/schedules/social.curator/run",
      method: "POST",
    });
    expect(screen.getByRole("status").textContent).toBe(
      "Run social.curator now failed: The audit log is unavailable."
    );
  });

  it("replays a dead job", async () => {
    answers([200, { result: {} }], [200, { ...DATA, deadLetters: [] }]);
    render(<OperatorJobsView data={DATA} />);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Replay gdpr.retention-purge" })
      );
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(sent(0)).toEqual({
      url: "/api/operator/jobs/dead/11111111-1111-4111-8111-111111111111",
      method: "POST",
      body: { action: "replay" },
    });
    await waitFor(() => expect(screen.getByText("No dead-lettered jobs.")).toBeDefined());
  });

  it("asks to confirm a discard, and can be cancelled", async () => {
    answers([200, { result: {} }], [200, DATA]);
    render(<OperatorJobsView data={DATA} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard gdpr.retention-purge" }));
    expect(
      screen.getByText(/Discard this gdpr.retention-purge job for good/)
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard gdpr.retention-purge" }));
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
      fireEvent.click(screen.getByRole("button", { name: "Run social.curator now" }));
    });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Run social.curator now failed: The request was refused."
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
    expect(screen.getByText("gdpr.retention-purge")).toBeDefined();
    expect(screen.getByText("Dead-lettered")).toBeDefined();
    expect(screen.getByText("5 of 5")).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
    await noViolations(container);
  });
});
