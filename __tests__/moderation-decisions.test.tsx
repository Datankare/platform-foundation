/** @jest-environment jsdom */
/**
 * __tests__/moderation-decisions.test.tsx — the account page's decisions and their appeal
 * (TASK-210, N-117)
 *
 * components/account/ModerationDecisions.tsx answered by the appeals route's own answers
 * (__tests__/fixtures/route-responses.json): each decision where it stands, the appeal form under
 * an appealable one with the server's limits, a sent appeal confirmed and the list read again, a
 * refused read's own message with a retry. The clock is an hour after the fixtures' decisions
 * (FIXTURE_NOW): inside the 72-hour window.
 */
import React from "react";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ModerationDecisions, {
  decisionStanding,
} from "@/components/account/ModerationDecisions";
import {
  FIXTURE_NOW,
  routeAnswer,
  type RouteFixtureName,
} from "@/__tests__/fixtures/route-responses";
import { renderMessage } from "@/platform/errors/messages";
import { formatDateTime } from "@/components/admin/admin-format";
import type { OwnDecision } from "@/platform/moderation/review-service";

const fetchMock = jest.fn();
function answer(name: RouteFixtureName) {
  const [status, body] = routeAnswer(name);
  return { ok: status < 400, status, json: async () => body };
}
const list = (name: string) =>
  answer(`GET /api/moderation/appeals — ${name}` as RouteFixtureName);
const HOUR = 60 * 60 * 1000;
/** A time as the screen shows it (the viewer's own zone). */
const NOW_SHOWN = formatDateTime(FIXTURE_NOW);
const WINDOW_END = formatDateTime("2026-01-04T00:00:00.000Z");

beforeEach(() => {
  jest.useFakeTimers({ now: Date.parse(FIXTURE_NOW) + HOUR, doNotFake: ["setTimeout"] });
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => jest.useRealTimers());

const decision = (id: string) => screen.findByTestId(`decision-${id}`);

describe("the user's decisions (TASK-210)", () => {
  it("reads the caller's own decisions — no account id is sent", async () => {
    fetchMock.mockResolvedValueOnce(list("none"));
    render(<ModerationDecisions />);
    expect(screen.getByRole("status")).toHaveTextContent(/Loading your decisions/);
    expect(await screen.findByTestId("decisions-empty")).toHaveTextContent(
      renderMessage("screens.account.decisions.none")
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/moderation/appeals");
    expect(screen.getByText(/within 72 hours of it/)).toBeInTheDocument();
  });

  it("an appealable decision: what was blocked, when, until when, and Appeal", async () => {
    fetchMock.mockResolvedValueOnce(list("one appealable"));
    render(<ModerationDecisions />);
    const item = await decision("traj-1");
    expect(item).toHaveTextContent("Text you submitted");
    expect(item).toHaveTextContent(`Blocked ${NOW_SHOWN}`);
    expect(item).toHaveTextContent(`You can appeal until ${WINDOW_END}.`);
    expect(
      within(item).getByRole("button", { name: "Appeal this decision" })
    ).toBeEnabled();
  });

  it("Appeal opens the form with the server's limits; a sent appeal is confirmed and read again", async () => {
    fetchMock
      .mockResolvedValueOnce(list("one appealable"))
      .mockResolvedValueOnce(answer("POST /api/moderation/appeals — submitted"))
      .mockResolvedValueOnce(list("appealed, waiting"));
    render(<ModerationDecisions />);
    const item = await decision("traj-1");
    fireEvent.click(within(item).getByRole("button", { name: "Appeal this decision" }));
    const field = within(item).getByLabelText(/Why should this decision be reconsidered/);
    expect(field).toHaveAttribute("maxlength", "2000");
    fireEvent.change(field, { target: { value: "short" } });
    expect(within(item).getByTestId("af-counter")).toHaveTextContent(
      "15 more character(s)"
    );
    fireEvent.change(field, {
      target: { value: "This is a sufficiently long and detailed appeal reason." },
    });
    await act(async () => fireEvent.click(within(item).getByTestId("af-submit")));
    const post = fetchMock.mock.calls[1];
    expect(post[0]).toBe("/api/moderation/appeals");
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({
      originalDecisionId: "traj-1",
      appealReason: "This is a sufficiently long and detailed appeal reason.",
    });
    await waitFor(() =>
      expect(screen.getByTestId("decision-standing-traj-1")).toHaveTextContent(
        `Appeal sent ${NOW_SHOWN}. Waiting for a moderator.`
      )
    );
    expect(within(item).getByRole("status")).toHaveTextContent(/Your appeal was sent/);
    expect(
      within(item).queryByRole("button", { name: "Appeal this decision" })
    ).toBeNull();
  });

  it("Cancel closes the form without sending anything", async () => {
    fetchMock.mockResolvedValueOnce(list("one appealable"));
    render(<ModerationDecisions />);
    const item = await decision("traj-1");
    fireEvent.click(within(item).getByRole("button", { name: "Appeal this decision" }));
    fireEvent.click(within(item).getByRole("button", { name: "Cancel" }));
    expect(within(item).queryByTestId("appeal-form")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["appealed, in review", `Appeal sent ${NOW_SHOWN}. A moderator is reviewing it.`],
    ["appealed, upheld", `Appeal decided ${NOW_SHOWN}: the decision stands.`],
  ])("%s: where the appeal stands, and no second appeal", async (name, line) => {
    fetchMock.mockResolvedValueOnce(list(name));
    render(<ModerationDecisions />);
    const item = await decision("traj-1");
    expect(item).toHaveTextContent(line);
    expect(
      within(item).queryByRole("button", { name: "Appeal this decision" })
    ).toBeNull();
  });

  it("past its window: said so, and no Appeal", async () => {
    fetchMock.mockResolvedValueOnce(list("one past its window"));
    render(<ModerationDecisions />);
    const item = await decision("traj-old");
    expect(item).toHaveTextContent("The time to appeal this decision has passed.");
    expect(within(item).queryByRole("button")).toBeNull();
  });

  it("a refused read shows the refusal's own message, and Try again reads again", async () => {
    fetchMock
      .mockResolvedValueOnce(list("the store failing"))
      .mockResolvedValueOnce(list("one appealable"));
    render(<ModerationDecisions />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      (
        routeAnswer("GET /api/moderation/appeals — the store failing")[1] as {
          message: string;
        }
      ).message
    );
    await act(async () =>
      fireEvent.click(within(alert).getByRole("button", { name: "Try again" }))
    );
    expect(await decision("traj-1")).toBeInTheDocument();
  });

  it("an unreachable server is said so", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    render(<ModerationDecisions />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      renderMessage("screens.account.decisions.unreachable")
    );
  });
});

describe("decisionStanding", () => {
  const d = (over: Partial<OwnDecision>): OwnDecision => ({
    id: "t",
    decidedAt: "2026-01-01T00:00:00.000Z",
    contentType: "generation",
    appealableUntil: "2026-01-04T00:00:00.000Z",
    appeal: null,
    ...over,
  });
  const at = (iso: string) => Date.parse(iso);

  it("open until the window's last moment, closed after; an appeal's own status wins", () => {
    expect(decisionStanding(d({}), at("2026-01-03T23:59:59.999Z"))).toBe("appealable");
    expect(decisionStanding(d({}), at("2026-01-04T00:00:00.000Z"))).toBe("closed");
    expect(
      decisionStanding(
        d({ appeal: { status: "resolved", submittedAt: "x", decision: "overturn" } }),
        at("2027-01-01T00:00:00.000Z")
      )
    ).toBe("resolved");
  });
});
