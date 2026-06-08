/** @jest-environment jsdom */
/**
 * __tests__/review-dashboard.test.tsx
 *
 * RTL tests for the reasoning-forward ReviewDashboard (Sprint 6 Full C).
 * Covers: load/empty/error states, claim, release, resolve (happy/validation/
 * modify), filter refetch, PATCH failure, the on-demand AI-assist flow
 * (banner / decision prefill / no-suggestion), and reasoning-context render.
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ReviewDashboard from "@/components/ReviewDashboard/ReviewDashboard";

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function errJson(status: number, body: unknown = {}) {
  return { ok: false, status, json: async () => body };
}

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "review-1",
    source: "escalation",
    priority: "high",
    status: "pending",
    moderationResult: {
      action: "escalate",
      triggeredBy: "classifier",
      direction: "input",
      contentType: "generation",
      contentRatingLevel: 1,
      blocklistMatches: [],
      classifierOutput: {
        safe: false,
        categories: ["violence"],
        confidence: 0.52,
        severity: "medium",
      },
      reasoning: "Low confidence — escalating.",
      severityAdjustment: 0,
      contextFactors: ["translation context"],
      attributeToUser: true,
      pipelineLatencyMs: 100,
      classifierCostUsd: 0.001,
      trajectoryId: "traj-1",
      agentId: "guardian-1",
    },
    explanationChain: {
      id: "exp-1",
      requestId: "req-1",
      steps: [
        {
          phase: "classify",
          description: "ran the classifier",
          data: {},
          durationMs: 10,
        },
      ],
      conclusion: "Escalated for human review.",
      createdAt: "2026-05-01T00:00:00Z",
    },
    targetUserId: "user-1",
    requestId: "req-1",
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

function fetchMock() {
  return global.fetch as unknown as jest.Mock;
}
function patchCall() {
  return fetchMock().mock.calls.find(
    (c) => c[1] && (c[1] as RequestInit).method === "PATCH"
  );
}
function lastCall() {
  const calls = fetchMock().mock.calls;
  return calls[calls.length - 1];
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
});
afterEach(() => {
  jest.clearAllMocks();
});

describe("ReviewDashboard — states", () => {
  it("shows the loading state", () => {
    fetchMock().mockReturnValueOnce(new Promise(() => {}));
    render(<ReviewDashboard />);
    expect(screen.getByTestId("rd-loading")).toBeDefined();
  });

  it("shows the empty state when there are no items", async () => {
    fetchMock().mockResolvedValueOnce(okJson({ items: [] }));
    render(<ReviewDashboard />);
    await waitFor(() => expect(screen.getByTestId("rd-empty")).toBeDefined());
  });

  it("shows an error when the queue cannot be loaded", async () => {
    fetchMock().mockResolvedValueOnce(errJson(500));
    render(<ReviewDashboard />);
    await waitFor(() => expect(screen.getByTestId("rd-error")).toBeDefined());
  });

  it("renders the decision context (confidence, trajectory, timeline)", async () => {
    fetchMock().mockResolvedValueOnce(okJson({ items: [makeItem()] }));
    render(<ReviewDashboard />);
    await waitFor(() => screen.getByTestId("rd-item-review-1"));
    expect(screen.getByTestId("rd-confidence-review-1")).toBeDefined();
    expect(screen.getByTestId("rd-trajectory-review-1")).toBeDefined();
    expect(screen.getByTestId("rd-timeline-review-1")).toBeDefined();
    expect(screen.getByTestId("rd-step-review-1-0")).toBeDefined();
  });
});

describe("ReviewDashboard — claim / release", () => {
  it("claims a pending item", async () => {
    fetchMock()
      .mockResolvedValueOnce(okJson({ items: [makeItem()] }))
      .mockResolvedValueOnce(okJson({}))
      .mockResolvedValueOnce(okJson({ items: [makeItem({ status: "claimed" })] }));

    render(<ReviewDashboard />);
    await waitFor(() => screen.getByTestId("rd-claim-review-1"));
    fireEvent.click(screen.getByTestId("rd-claim-review-1"));

    await waitFor(() => {
      const call = patchCall();
      expect(call).toBeDefined();
      expect(JSON.parse((call![1] as RequestInit).body as string).action).toBe("claim");
    });
  });

  it("releases a claimed item", async () => {
    fetchMock()
      .mockResolvedValueOnce(okJson({ items: [makeItem({ status: "claimed" })] }))
      .mockResolvedValueOnce(okJson({}))
      .mockResolvedValueOnce(okJson({ items: [makeItem()] }));

    render(<ReviewDashboard />);
    await waitFor(() => screen.getByTestId("rd-release-review-1"));
    fireEvent.click(screen.getByTestId("rd-release-review-1"));

    await waitFor(() => {
      const call = patchCall();
      expect(JSON.parse((call![1] as RequestInit).body as string).action).toBe("unclaim");
    });
  });

  it("surfaces a PATCH failure as an error", async () => {
    fetchMock()
      .mockResolvedValueOnce(okJson({ items: [makeItem()] }))
      .mockResolvedValueOnce(errJson(409, { error: "Already claimed" }));

    render(<ReviewDashboard />);
    await waitFor(() => screen.getByTestId("rd-claim-review-1"));
    fireEvent.click(screen.getByTestId("rd-claim-review-1"));

    await waitFor(() =>
      expect(screen.getByTestId("rd-error").textContent).toContain("Already claimed")
    );
  });
});

describe("ReviewDashboard — resolve", () => {
  it("resolves with uphold + notes", async () => {
    fetchMock()
      .mockResolvedValueOnce(okJson({ items: [makeItem({ status: "claimed" })] }))
      .mockResolvedValueOnce(okJson({}))
      .mockResolvedValueOnce(okJson({ items: [] }));

    render(<ReviewDashboard />);
    await waitFor(() => screen.getByTestId("rd-resolve-open-review-1"));
    fireEvent.click(screen.getByTestId("rd-resolve-open-review-1"));
    fireEvent.change(screen.getByTestId("rd-notes"), {
      target: { value: "Looks correct." },
    });
    fireEvent.click(screen.getByTestId("rd-resolve-submit"));

    await waitFor(() => {
      const body = JSON.parse((patchCall()![1] as RequestInit).body as string);
      expect(body.action).toBe("resolve");
      expect(body.decision).toBe("uphold");
      expect(body.reviewerNotes).toBe("Looks correct.");
    });
  });

  it("requires reviewer notes", async () => {
    fetchMock().mockResolvedValueOnce(
      okJson({ items: [makeItem({ status: "claimed" })] })
    );

    render(<ReviewDashboard />);
    await waitFor(() => screen.getByTestId("rd-resolve-open-review-1"));
    fireEvent.click(screen.getByTestId("rd-resolve-open-review-1"));
    fireEvent.click(screen.getByTestId("rd-resolve-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("rd-error").textContent).toContain("notes are required")
    );
    expect(patchCall()).toBeUndefined();
  });

  it("sends modifiedAction when decision is modify", async () => {
    fetchMock()
      .mockResolvedValueOnce(okJson({ items: [makeItem({ status: "claimed" })] }))
      .mockResolvedValueOnce(okJson({}))
      .mockResolvedValueOnce(okJson({ items: [] }));

    render(<ReviewDashboard />);
    await waitFor(() => screen.getByTestId("rd-resolve-open-review-1"));
    fireEvent.click(screen.getByTestId("rd-resolve-open-review-1"));
    fireEvent.change(screen.getByTestId("rd-decision-select"), {
      target: { value: "modify" },
    });
    expect(screen.getByTestId("rd-modify-block")).toBeDefined();
    fireEvent.change(screen.getByTestId("rd-modified-action"), {
      target: { value: "block" },
    });
    fireEvent.change(screen.getByTestId("rd-notes"), {
      target: { value: "Downgrade to block." },
    });
    fireEvent.click(screen.getByTestId("rd-resolve-submit"));

    await waitFor(() => {
      const body = JSON.parse((patchCall()![1] as RequestInit).body as string);
      expect(body.decision).toBe("modify");
      expect(body.modifiedAction).toBe("block");
    });
  });
});

describe("ReviewDashboard — filter", () => {
  it("refetches with a status query when the filter changes", async () => {
    fetchMock()
      .mockResolvedValueOnce(okJson({ items: [makeItem()] }))
      .mockResolvedValueOnce(okJson({ items: [makeItem()] }));

    render(<ReviewDashboard />);
    await waitFor(() => screen.getByTestId("rd-list"));
    fireEvent.click(screen.getByTestId("rd-filter-pending"));

    await waitFor(() => expect(String(lastCall()[0])).toContain("?status=pending"));
  });
});

describe("ReviewDashboard — AI assist", () => {
  it("fetches and shows an advisory suggestion", async () => {
    fetchMock()
      .mockResolvedValueOnce(okJson({ items: [makeItem({ status: "claimed" })] }))
      .mockResolvedValueOnce(
        okJson({
          recommendation: {
            recommendation: "overturn",
            rationale: "Historical context likely benign.",
          },
        })
      );

    render(<ReviewDashboard />);
    await waitFor(() => screen.getByTestId("rd-assist-btn-review-1"));
    fireEvent.click(screen.getByTestId("rd-assist-btn-review-1"));

    await waitFor(() =>
      expect(screen.getByTestId("rd-assist-banner-review-1").textContent).toContain(
        "Historical context"
      )
    );
    expect(String(lastCall()[0])).toBe("/api/moderation/review/review-1/assist");
    expect((lastCall()[1] as RequestInit).method).toBe("POST");
  });

  it("prefills the resolve decision from the suggestion", async () => {
    fetchMock()
      .mockResolvedValueOnce(okJson({ items: [makeItem({ status: "claimed" })] }))
      .mockResolvedValueOnce(
        okJson({
          recommendation: { recommendation: "overturn", rationale: "Context." },
        })
      );

    render(<ReviewDashboard />);
    await waitFor(() => screen.getByTestId("rd-assist-btn-review-1"));
    fireEvent.click(screen.getByTestId("rd-assist-btn-review-1"));
    await waitFor(() => screen.getByTestId("rd-assist-banner-review-1"));

    fireEvent.click(screen.getByTestId("rd-resolve-open-review-1"));
    const select = screen.getByTestId("rd-decision-select") as HTMLSelectElement;
    expect(select.value).toBe("overturn");
  });

  it("shows the no-suggestion state when assist returns null (fail-open)", async () => {
    fetchMock()
      .mockResolvedValueOnce(okJson({ items: [makeItem({ status: "claimed" })] }))
      .mockResolvedValueOnce(okJson({ recommendation: null }));

    render(<ReviewDashboard />);
    await waitFor(() => screen.getByTestId("rd-assist-btn-review-1"));
    fireEvent.click(screen.getByTestId("rd-assist-btn-review-1"));

    await waitFor(() =>
      expect(screen.getByTestId("rd-assist-none-review-1")).toBeDefined()
    );
  });
});
