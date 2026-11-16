/**
 * @jest-environment jsdom
 */
/**
 * __tests__/review-dashboard.test.tsx — the human review queue on the console's shared parts
 * (ADR-024, ADR-025; TASK-221, SF-admin-140 to 149)
 *
 * Fed the routes' own answers (__tests__/fixtures/route-responses.json).
 */
import { renderMessage } from "@/platform/errors/messages";
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import ReviewDashboard, {
  itemActionPath,
  PAGE_SIZE,
  queueUrl,
} from "@/components/ReviewDashboard/ReviewDashboard";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";

const fetchMock = jest.fn();
beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});
beforeEach(() => fetchMock.mockReset());

function reply(name: string, edit?: (body: Record<string, unknown>) => void) {
  const [status, body] = routeAnswer(name as RouteFixtureName);
  const copy = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  edit?.(copy);
  return {
    ok: status < 400,
    status,
    json: async () => copy,
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}
/** Answer by route: the queue's reads with `queue`, an item's PATCH with `patch`, … */
function serve(map: {
  queue: () => Response;
  patch?: () => Response;
  assist?: () => Response;
}) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/assist")) return map.assist!();
    if ((init?.method ?? "GET") === "PATCH") return map.patch!();
    return map.queue();
  });
}
const t = (key: string, v?: Record<string, string | number>) =>
  renderMessage(`screens.review_dashboard.${key}`, v);
const TWO = "GET /api/moderation/review — a pending and a claimed escalation";
const named = (body: Record<string, unknown>) => {
  for (const item of body.items as Record<string, unknown>[]) {
    item.target = { email: "tia@example.com", role: "Member", erased: false };
    if (item.claimedBy)
      item.claimer = { email: "mo@example.com", role: "Moderator", erased: false };
  }
};

describe("ReviewDashboard", () => {
  it("[SF-admin-149] reads a page of the queue, with Refresh and its read time", async () => {
    serve({ queue: () => reply(TWO) });
    render(<ReviewDashboard />);
    expect(screen.getByText(/^Reading Review queue/)).toBeDefined();
    expect(await screen.findByTestId("rd-item-review-1")).toBeDefined();
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(queueUrl("all", 0));
    expect(queueUrl("all", 0)).toContain(`limit=${PAGE_SIZE}`);
    expect(screen.getByText(/Read at/)).toBeDefined();
  });

  it("a queue that cannot be read is said — never 'No items in the review queue'", async () => {
    serve({ queue: () => reply("GET /api/moderation/review — the store failing") });
    render(<ReviewDashboard />);
    await waitFor(() =>
      expect(document.querySelector("[data-read-failed='true']")).not.toBeNull()
    );
    expect(screen.queryByText(t("no_items_in_the_review"))).toBeNull();
  });

  it("[SF-admin-149] pages: Next asks for the next page; the range is said", async () => {
    serve({ queue: () => reply(TWO, (b) => (b.hasMore = true)) });
    render(<ReviewDashboard />);
    await screen.findByTestId("rd-item-review-1");
    expect(document.querySelector("[data-page-range]")).toHaveTextContent("1–2");
    fireEvent.click(screen.getByRole("button", { name: t("next_page") }));
    await waitFor(() =>
      expect((fetchMock.mock.calls.at(-1) as [string])[0]).toBe(
        queueUrl("all", PAGE_SIZE)
      )
    );
  });

  it("[SF-admin-140] an item names its account by address and its decision by kind — no hex id without Show details", async () => {
    serve({ queue: () => reply(TWO, named) });
    const { container } = render(<ReviewDashboard />);
    const card = await screen.findByTestId("rd-item-review-1");
    expect(card).toHaveTextContent("tia@example.com");
    expect(card).toHaveTextContent(t("decision_of", { action: t("action_escalate") }));
    expect(container.textContent).not.toContain("11111111-1111-4111-8111-111111111111");
  });

  it("[SF-admin-146] an item says how long it has waited and when an open escalation is acted on", async () => {
    serve({ queue: () => reply(TWO) });
    render(<ReviewDashboard />);
    const card = await screen.findByTestId("rd-item-review-1");
    expect(card).toHaveTextContent(t("waiting_since"));
    // The fixture's escalation is long past its due time: overdue.
    expect(card.querySelector("[data-due='overdue']")).not.toBeNull();
  });

  it("[SF-admin-141] a claim is shown; only its holder may resolve or release it", async () => {
    serve({
      queue: () =>
        reply(TWO, (b) => {
          named(b);
          (b.items as Record<string, unknown>[])[1]!.claimedByViewer = false;
        }),
    });
    render(<ReviewDashboard />);
    const theirs = await screen.findByTestId("rd-item-review-2");
    expect(theirs).toHaveTextContent(/Claimed by mo@example\.com/);
    expect(within(theirs).queryByRole("button", { name: t("resolve") })).toBeNull();
    expect(within(theirs).queryByRole("button", { name: t("release") })).toBeNull();
  });

  it("[SF-admin-142, 143, 148] resolving: each decision explained, confirmed with notes said at their field, and what happened is kept", async () => {
    serve({
      queue: () => reply(TWO),
      patch: () => reply("PATCH /api/moderation/review/[id] — resolved, upheld"),
    });
    render(<ReviewDashboard />);
    const mine = await screen.findByTestId("rd-item-review-2");
    fireEvent.click(within(mine).getByRole("button", { name: t("resolve") }));
    const decision = within(mine).getByLabelText(t("decision"));
    expect(decision).toHaveAccessibleDescription(t("decision_help_uphold"));
    fireEvent.change(decision, { target: { value: "overturn" } });
    expect(decision).toHaveAccessibleDescription(t("decision_help_overturn"));
    fireEvent.click(within(mine).getByRole("button", { name: t("review_decision") }));
    const confirm = within(mine).getByRole("alertdialog");
    expect(confirm).toHaveFocus();
    fireEvent.click(within(confirm).getByRole("button", { name: t("submit_decision") }));
    // Too short: said at the notes, not in a banner at the top.
    expect(within(confirm).getByLabelText(t("reviewer_notes"))).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(
      fetchMock.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === "PATCH"
      )
    ).toHaveLength(0);
    fireEvent.change(within(confirm).getByLabelText(t("reviewer_notes")), {
      target: { value: "A quoted headline." },
    });
    fireEvent.click(within(confirm).getByRole("button", { name: t("submit_decision") }));
    const done = await screen.findByText(/Overturned the decision/);
    expect(done.closest("[data-outcome]")).toHaveAttribute("data-outcome", "applied");
    const patch = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "PATCH"
    ) as [string, RequestInit];
    expect(patch[0]).toBe(itemActionPath({ id: "review-2", source: "escalation" }));
    expect(JSON.parse(String(patch[1].body))).toEqual({
      action: "resolve",
      decision: "overturn",
      reviewerNotes: "A quoted headline.",
    });
  });

  it("[SF-admin-142] a claim says what happened; [SF-admin-143] a refusal is said on its item", async () => {
    serve({
      queue: () => reply(TWO),
      patch: () =>
        reply(
          "PATCH /api/moderation/review/[id] — refused (claimed by another reviewer)"
        ),
    });
    render(<ReviewDashboard />);
    const card = await screen.findByTestId("rd-item-review-1");
    fireEvent.click(within(card).getByRole("button", { name: t("claim") }));
    await waitFor(() =>
      expect(card.querySelector("[data-outcome='refused']")).not.toBeNull()
    );
  });

  it("[SF-admin-145] a refused suggestion says why; [SF-admin-144] categories by name", async () => {
    serve({
      queue: () =>
        reply(TWO, (b) => {
          const m = (
            b.items as {
              moderationResult: { classifierOutput?: Record<string, unknown> };
            }[]
          )[0]!.moderationResult;
          m.classifierOutput = {
            ...(m.classifierOutput ?? {}),
            categories: ["self_harm"],
            severity: "high",
          };
        }),
      assist: () => reply("POST /api/admin/agents/suspend — refused (rate limited)"),
    });
    render(<ReviewDashboard />);
    const card = await screen.findByTestId("rd-item-review-1");
    expect(card).toHaveTextContent("Self-harm");
    expect(card).not.toHaveTextContent("self_harm");
    expect(card).toHaveTextContent(/Severity: High/);
    fireEvent.click(within(card).getByRole("button", { name: t("get_ai_suggestion") }));
    expect(await within(card).findByText(/^No suggestion: /)).toBeDefined();
  });

  it("a status filter reads from the first page; Previous goes back a page", async () => {
    serve({ queue: () => reply(TWO, (b) => (b.hasMore = true)) });
    render(<ReviewDashboard />);
    await screen.findByTestId("rd-item-review-1");
    fireEvent.click(screen.getByRole("button", { name: t("next_page") }));
    await waitFor(() =>
      expect((fetchMock.mock.calls.at(-1) as [string])[0]).toBe(
        queueUrl("all", PAGE_SIZE)
      )
    );
    await screen.findByTestId("rd-item-review-1");
    fireEvent.click(screen.getByRole("button", { name: t("previous_page") }));
    await waitFor(() =>
      expect((fetchMock.mock.calls.at(-1) as [string])[0]).toBe(queueUrl("all", 0))
    );
    fireEvent.click(screen.getByRole("button", { name: t("filter_claimed") }));
    await waitFor(() =>
      expect((fetchMock.mock.calls.at(-1) as [string])[0]).toBe(queueUrl("claimed", 0))
    );
    expect(screen.getByRole("button", { name: t("filter_claimed") })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("releasing one's claim says so, kept until dismissed; a refusal on an item is dismissed too", async () => {
    serve({
      queue: () => reply(TWO),
      patch: () => reply("PATCH /api/moderation/review/[id] — released"),
    });
    render(<ReviewDashboard />);
    const mine = await screen.findByTestId("rd-item-review-2");
    fireEvent.click(within(mine).getByRole("button", { name: t("release") }));
    const done = await screen.findByText(/^Released /);
    const kept = done.closest("[data-outcome]") as HTMLElement;
    fireEvent.click(within(kept).getByRole("button", { name: /Dismiss/ }));
    await waitFor(() => expect(screen.queryByText(/^Released /)).toBeNull());
    const patch = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "PATCH"
    ) as [string, RequestInit];
    expect(JSON.parse(String(patch[1].body))).toEqual({ action: "unclaim" });

    serve({
      queue: () => reply(TWO),
      patch: () =>
        reply(
          "PATCH /api/moderation/review/[id] — refused (claimed by another reviewer)"
        ),
    });
    const card = screen.getByTestId("rd-item-review-1");
    fireEvent.click(within(card).getByRole("button", { name: t("claim") }));
    await waitFor(() =>
      expect(card.querySelector("[data-outcome='refused']")).not.toBeNull()
    );
    const refused = card.querySelector("[data-outcome='refused']") as HTMLElement;
    fireEvent.click(within(refused).getByRole("button", { name: /Dismiss/ }));
    await waitFor(() =>
      expect(card.querySelector("[data-outcome='refused']")).toBeNull()
    );
  });

  it("Modify asks the action it becomes; the form and its confirm step can each be cancelled", async () => {
    serve({
      queue: () => reply(TWO),
      patch: () =>
        reply("PATCH /api/moderation/review/[id] — resolved, modified to a block"),
    });
    render(<ReviewDashboard />);
    const mine = await screen.findByTestId("rd-item-review-2");
    fireEvent.click(within(mine).getByRole("button", { name: t("resolve") }));
    fireEvent.click(within(mine).getByRole("button", { name: t("cancel") }));
    expect(within(mine).queryByLabelText(t("decision"))).toBeNull();
    fireEvent.click(within(mine).getByRole("button", { name: t("resolve") }));
    fireEvent.change(within(mine).getByLabelText(t("decision")), {
      target: { value: "modify" },
    });
    fireEvent.change(within(mine).getByLabelText(t("modified_action")), {
      target: { value: "block" },
    });
    fireEvent.click(within(mine).getByRole("button", { name: t("review_decision") }));
    fireEvent.click(
      within(within(mine).getByRole("alertdialog")).getByRole("button", {
        name: t("cancel"),
      })
    );
    expect(within(mine).queryByRole("alertdialog")).toBeNull();
    fireEvent.click(within(mine).getByRole("button", { name: t("review_decision") }));
    const confirm = within(mine).getByRole("alertdialog");
    fireEvent.change(within(confirm).getByLabelText(t("reviewer_notes")), {
      target: { value: "A block fits better." },
    });
    fireEvent.click(within(confirm).getByRole("button", { name: t("submit_decision") }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (c) => (c[1] as RequestInit | undefined)?.method === "PATCH"
        )
      ).toBe(true)
    );
    const patch = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "PATCH"
    ) as [string, RequestInit];
    expect(JSON.parse(String(patch[1].body))).toMatchObject({
      action: "resolve",
      decision: "modify",
      modifiedAction: "block",
    });
  });

  it("a resolved item says its decision, what it became, who decided and when, and the notes", async () => {
    serve({
      queue: () =>
        reply(TWO, (b) => {
          const items = b.items as Record<string, unknown>[];
          Object.assign(items[1]!, {
            status: "resolved",
            decision: "modify",
            modifiedAction: "block",
            resolvedBy: "00000000-0000-4000-9000-887b6c240009",
            resolver: { email: "mo@example.com", role: "Moderator", erased: false },
            resolvedAt: "2026-01-02T00:00:00.000Z",
            reviewerNotes: "A block fits better.",
          });
          Object.assign(items[0]!, { status: "resolved", decision: null });
        }),
    });
    render(<ReviewDashboard />);
    const done = await screen.findByTestId("rd-item-review-2");
    expect(within(done).getByTestId("rd-decision-review-2")).toHaveTextContent(
      t("decision_line", { decision: t("decision_modify") })
    );
    expect(done).toHaveTextContent(/Changed to:/);
    expect(done).toHaveTextContent("mo@example.com");
    expect(done).toHaveTextContent("A block fits better.");
    const other = screen.getByTestId("rd-item-review-1");
    expect(within(other).getByTestId("rd-decision-review-1")).toHaveTextContent(
      t("decision_line", { decision: t("decision_unknown") })
    );
    expect(other).toHaveTextContent(t("decided_by_platform"));
  });

  it("[SF-admin-147] no light-theme boxes on the dark console", async () => {
    serve({ queue: () => reply(TWO) });
    const { container } = render(<ReviewDashboard />);
    await screen.findByTestId("rd-item-review-1");
    expect(container.innerHTML).not.toMatch(
      /bg-(?:red|blue|amber|gray|green)-(?:50|100)\b/
    );
  });
});
