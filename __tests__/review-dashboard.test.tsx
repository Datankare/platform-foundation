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

import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";

/** A route's own answer (__tests__/fixtures/route-responses.json), as fetch resolves it. */
function answer(name: RouteFixtureName) {
  const [status, body] = routeAnswer(name);
  return { ok: status < 400, status, json: async () => body };
}
const NONE = "GET /api/moderation/review — none";
const ONE = "GET /api/moderation/review — one pending escalation";
const TWO = "GET /api/moderation/review — a pending and a claimed escalation";
const PENDING = "GET /api/moderation/review?status=pending — the pending escalation";
const CLAIMED = "GET /api/moderation/review — the escalation claimed";
const ACT = "PATCH /api/moderation/review/[id] —";

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
    fetchMock().mockResolvedValueOnce(answer(NONE));
    render(<ReviewDashboard />);
    await waitFor(() => expect(screen.getByTestId("rd-empty")).toBeDefined());
  });

  it("shows an error when the queue cannot be loaded", async () => {
    fetchMock().mockResolvedValueOnce(
      answer("GET /api/moderation/review — the store failing")
    );
    render(<ReviewDashboard />);
    await waitFor(() => expect(screen.getByTestId("rd-error")).toBeDefined());
  });

  it("renders the decision context (confidence, trajectory, timeline)", async () => {
    fetchMock().mockResolvedValueOnce(answer(ONE));
    render(<ReviewDashboard />);
    await waitFor(() => screen.getByTestId("rd-item-review-1"));
    expect(screen.getByTestId("rd-confidence-review-1")).toBeDefined();
    // SEC-017 (TASK-203): the bar's width is set on its style object, never as a style attribute
    // in the markup (the policy refuses those) — 52%, from the item's confidence.
    const fill = screen.getByTestId("rd-confidence-fill");
    await waitFor(() => expect(fill.style.width).toBe("52%"));
    expect(screen.getByTestId("rd-trajectory-review-1")).toBeDefined();
    expect(screen.getByTestId("rd-timeline-review-1")).toBeDefined();
    expect(screen.getByTestId("rd-step-review-1-0")).toBeDefined();
    // TASK-209: the Guardian's reasons and factors, recorded as catalog keys, in the words a
    // moderator always read; a chain step recorded before the keys, as such, its text disclosed.
    expect(screen.getByTestId("rd-reasoning-review-1").textContent).toBe(
      "Confidence 0.52 below threshold 0.6 for child (under 13) — escalating for human review."
    );
    expect(screen.getByText("translation-content: severity reduced by 1")).toBeDefined();
    const step = screen.getByTestId("rd-step-review-1-0");
    expect(step.textContent).toContain("A reason recorded before reasons were coded.");
    expect(step.textContent).toContain("ran the classifier");
  });
});

describe("ReviewDashboard — claim / release", () => {
  it("claims a pending item", async () => {
    fetchMock()
      .mockResolvedValueOnce(answer(ONE))
      .mockResolvedValueOnce(answer(`${ACT} claimed`))
      .mockResolvedValueOnce(answer(CLAIMED));

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
      .mockResolvedValueOnce(answer(CLAIMED))
      .mockResolvedValueOnce(answer(`${ACT} released`))
      .mockResolvedValueOnce(answer(ONE));

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
      .mockResolvedValueOnce(answer(ONE))
      .mockResolvedValueOnce(answer(`${ACT} refused (claimed by another reviewer)`));

    render(<ReviewDashboard />);
    await waitFor(() => screen.getByTestId("rd-claim-review-1"));
    fireEvent.click(screen.getByTestId("rd-claim-review-1"));

    await waitFor(() =>
      expect(screen.getByTestId("rd-error").textContent).toContain(
        (
          routeAnswer(`${ACT} refused (claimed by another reviewer)`)[1] as {
            message: string;
          }
        ).message
      )
    );
  });
});

describe("ReviewDashboard — resolve", () => {
  it("resolves with uphold + notes", async () => {
    fetchMock()
      .mockResolvedValueOnce(answer(CLAIMED))
      .mockResolvedValueOnce(answer(`${ACT} resolved, upheld`))
      .mockResolvedValueOnce(answer(NONE));

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
    fetchMock().mockResolvedValueOnce(answer(CLAIMED));

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
      .mockResolvedValueOnce(answer(CLAIMED))
      .mockResolvedValueOnce(answer(`${ACT} resolved, modified to a block`))
      .mockResolvedValueOnce(answer(NONE));

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
    fetchMock().mockResolvedValueOnce(answer(ONE)).mockResolvedValueOnce(answer(PENDING));

    render(<ReviewDashboard />);
    await waitFor(() => screen.getByTestId("rd-list"));
    fireEvent.click(screen.getByTestId("rd-filter-pending"));

    await waitFor(() => expect(String(lastCall()[0])).toContain("?status=pending"));
  });

  it("never lets a slow earlier filter's response overwrite the newer one", async () => {
    let releaseAll!: (v: unknown) => void;
    fetchMock()
      .mockReturnValueOnce(new Promise((r) => (releaseAll = r)))
      .mockResolvedValueOnce(answer(PENDING));

    render(<ReviewDashboard />);
    fireEvent.click(screen.getByTestId("rd-filter-pending"));
    await waitFor(() => screen.getByTestId("rd-item-review-1"));

    // The slow "all" answer lists the claimed review-2 as well: it must not replace "pending".
    releaseAll(answer(TWO));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("rd-item-review-2")).toBeNull();
    expect(screen.getByTestId("rd-item-review-1")).toBeTruthy();
  });

  it("never lets a Refresh overtaken by a filter change overwrite the newer list", async () => {
    let releaseRefresh!: (v: unknown) => void;
    fetchMock()
      .mockResolvedValueOnce(answer(ONE))
      .mockReturnValueOnce(new Promise((r) => (releaseRefresh = r)))
      .mockResolvedValueOnce(answer(PENDING));

    render(<ReviewDashboard />);
    await waitFor(() => screen.getByTestId("rd-item-review-1"));
    fireEvent.click(screen.getByTestId("rd-refresh"));
    fireEvent.click(screen.getByTestId("rd-filter-pending"));
    await waitFor(() => expect(screen.queryByTestId("rd-loading")).toBeNull());
    await waitFor(() => screen.getByTestId("rd-item-review-1"));

    // The overtaken Refresh's answer lists the claimed review-2 as well: it must not land.
    releaseRefresh(answer(TWO));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("rd-item-review-2")).toBeNull();
    expect(screen.getByTestId("rd-item-review-1")).toBeTruthy();
  });

  it("shows loading from the click, and a click on the current filter does not refetch", async () => {
    let releasePending!: (v: unknown) => void;
    fetchMock()
      .mockResolvedValueOnce(answer(ONE))
      .mockReturnValueOnce(new Promise((r) => (releasePending = r)));

    render(<ReviewDashboard />);
    await waitFor(() => screen.getByTestId("rd-list"));
    fireEvent.click(screen.getByTestId("rd-filter-all"));
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("rd-loading")).toBeNull();

    fireEvent.click(screen.getByTestId("rd-filter-pending"));
    expect(screen.getByTestId("rd-loading")).toBeTruthy();
    releasePending(answer("GET /api/moderation/review?status=pending — none"));
    await waitFor(() => screen.getByTestId("rd-empty"));
  });
});

describe("ReviewDashboard — AI assist", () => {
  it("fetches and shows an advisory suggestion", async () => {
    fetchMock()
      .mockResolvedValueOnce(answer(CLAIMED))
      .mockResolvedValueOnce(
        answer("POST /api/moderation/review/[id]/assist — a suggestion")
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
      .mockResolvedValueOnce(answer(CLAIMED))
      .mockResolvedValueOnce(
        answer("POST /api/moderation/review/[id]/assist — a suggestion")
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
      .mockResolvedValueOnce(answer(CLAIMED))
      .mockResolvedValueOnce(
        answer(
          "POST /api/moderation/review/[id]/assist — no suggestion (the model unavailable)"
        )
      );

    render(<ReviewDashboard />);
    await waitFor(() => screen.getByTestId("rd-assist-btn-review-1"));
    fireEvent.click(screen.getByTestId("rd-assist-btn-review-1"));

    await waitFor(() =>
      expect(screen.getByTestId("rd-assist-none-review-1")).toBeDefined()
    );
  });
});
