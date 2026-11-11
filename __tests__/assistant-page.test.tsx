/** @jest-environment jsdom */
/**
 * __tests__/assistant-page.test.tsx — the assistant page, its answer streamed from /api/stream, and
 * the home bar's way to it (TASK-211, N-118)
 *
 * Until TASK-211 no screen used /api/stream or its hook (hooks/useRealtimeStream.ts). Here the
 * screen is answered with the route's own answers (__tests__/fixtures/route-responses.json, made by
 * the handler: the event stream's text exactly as sent, and its refusals): signed out → sign-in; a
 * guest is told the assistant is for accounts and nothing is sent; a signed-in user's question is
 * sent as the user, and the answer shown as it streams; an answer cut off at its length limit says
 * so; a refusal is shown by its kind — rejected content links to its decision, a refusal mid-answer
 * links to none, a rate limit says when to retry, a lost connection offers "Try again"; Stop marks
 * the answer incomplete and nothing from a stopped answer reaches the next.
 *
 * Hostile cases (REVIEW.md 3):
 * hostile:role a guest is never shown the form and sends nothing (the route refuses guests too —
 *   its fixture is the route's own refusal; the role checks are stream-api.test.ts's)
 * hostile:self n/a: a question names no account; the account is the verified token's
 * hostile:store-down the connection lost: a network refusal, with "Try again"
 * hostile:id-spelling n/a: the screen sends no id, only the question
 */
import React from "react";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ReadableStream } from "node:stream/web";
import { TextDecoder, TextEncoder } from "node:util";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";
import { renderMessage } from "@/platform/errors/messages";

// The event stream is read with the web's stream and decoder, which this environment lacks.
Object.assign(globalThis, { ReadableStream, TextDecoder, TextEncoder });

const replace = jest.fn();
const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace, push }) }));

const mockAuth = {
  user: null as { email: string } | null,
  isLoading: false,
  isAuthenticated: false,
  isGuest: false,
  signOut: jest.fn(async () => undefined),
};
jest.mock("@/platform/auth/context", () => ({
  ...jest.requireActual("@/platform/auth/context"),
  useAuth: () => mockAuth,
}));
jest.mock("@/platform/modules/app-home", () => ({
  __esModule: true,
  default: () => null,
}));

import AssistantClient from "@/app/assistant/AssistantClient";
import AssistantPage, { metadata } from "@/app/assistant/page";
import HomeClient from "@/app/HomeClient";

const t = (key: string, values?: Record<string, string | number>) =>
  renderMessage(`screens.assistant.${key}`, values);

const encoder = new TextEncoder();

/** The route's answer `name`, as fetch returns it: an event stream, or a refusal's JSON. */
function reply(name: RouteFixtureName) {
  const [status, body] = routeAnswer(name);
  const ok = status >= 200 && status < 300;
  if (typeof body === "string") {
    return {
      ok,
      status,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(body));
          controller.close();
        },
      }),
    };
  }
  const json = async () => body;
  return { ok, status, body: null, json, clone: () => ({ json }) };
}

/**
 * The route's answer `name`, held open after its first event (as a model still writing): the
 * events after it arrive when `release` is called; the request's abort ends it, as fetch's does.
 */
function held(name: RouteFixtureName, signal?: AbortSignal | null) {
  const body = routeAnswer(name)[1] as string;
  const [first, ...rest] = body.split(/(?<=\n\n)/);
  let release = () => undefined as void;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(first!));
      release = () => {
        try {
          controller.enqueue(encoder.encode(rest.join("")));
          controller.close();
        } catch {
          // Already ended by the abort.
        }
      };
      signal?.addEventListener("abort", () =>
        controller.error(new DOMException("The operation was aborted.", "AbortError"))
      );
    },
  });
  return { response: { ok: true, status: 200, body: stream }, release: () => release() };
}

const fetchMock = jest.fn();
beforeEach(() => {
  Object.assign(mockAuth, {
    user: null,
    isLoading: false,
    isAuthenticated: false,
    isGuest: false,
  });
  replace.mockReset();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  localStorage.clear();
});

const signedIn = () => {
  Object.assign(mockAuth, { user: { email: "me@example.test" }, isAuthenticated: true });
  // The session apiFetch reads (platform/auth/context.tsx), as a signed-in browser holds it.
  localStorage.setItem("pf_access_token", "mock-access-token");
  localStorage.setItem(
    "pf_user",
    JSON.stringify({
      userId: "u-1",
      email: "me@example.test",
      emailVerified: true,
      isGuest: false,
    })
  );
};

const QUESTION = "What is a rainbow?";
const box = () => screen.getByLabelText("Your question");
const askButton = () => screen.getByRole("button", { name: "Ask" });

function askQuestion(question = QUESTION) {
  fireEvent.change(box(), { target: { value: question } });
  fireEvent.click(askButton());
}

const answerRegion = () => screen.getByRole("region", { name: "Answer" });
const messageOf = (name: RouteFixtureName) =>
  (routeAnswer(name)[1] as { message: string }).message;
/** The coded end's message inside a streamed answer (the route's own event). */
const routeMessage = (name: RouteFixtureName) =>
  (
    JSON.parse(
      (routeAnswer(name)[1] as string)
        .split("\n")
        .find((l) => l.includes('"error"'))!
        .slice(6)
    ) as { error: string }
  ).error;

describe("the assistant page (TASK-211)", () => {
  it("is titled from the catalog and renders the client page", () => {
    expect(metadata.title).toBe("Assistant");
    expect(AssistantPage().type).toBe(AssistantClient);
  });

  it("signed out: sent to sign-in, nothing shown or sent", () => {
    const { container } = render(<AssistantClient />);
    expect(replace).toHaveBeenCalledWith("/auth");
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loading: says so, and decides nothing yet", () => {
    mockAuth.isLoading = true;
    render(<AssistantClient />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(replace).not.toHaveBeenCalled();
  });

  it("a guest: told the assistant is for accounts, with sign-in; no form, nothing sent", () => {
    Object.assign(mockAuth, { isAuthenticated: true, isGuest: true });
    render(<AssistantClient />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Assistant");
    expect(screen.getByText(t("guest"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/auth"
    );
    expect(screen.queryByLabelText("Your question")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signed in: the question is sent to /api/stream as the user, and the answer shown", async () => {
    signedIn();
    fetchMock.mockImplementation(async () => reply("POST /api/stream — an answer"));
    render(<AssistantClient />);
    expect(screen.getByRole("link", { name: "← Back to home" })).toHaveAttribute(
      "href",
      "/"
    );
    expect(askButton()).toBeDisabled();
    fireEvent.change(box(), { target: { value: QUESTION } });
    expect(askButton()).toBeEnabled();
    expect(
      screen.getByText(t("question_hint", { count: 18, max: 4000 }))
    ).toBeInTheDocument();
    fireEvent.click(askButton());

    const region = answerRegion();
    await waitFor(() =>
      expect(within(region).getByTestId("assistant-answer")).toHaveTextContent(
        "A rainbow is sunlight split by raindrops."
      )
    );
    expect(within(region).getByText(`You asked: ${QUESTION}`)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(askButton()).toBeInTheDocument());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/stream");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ prompt: QUESTION });
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer mock-access-token"
    );
  });

  it("Ctrl+Enter asks, as the hint says", async () => {
    signedIn();
    fetchMock.mockImplementation(async () => reply("POST /api/stream — an answer"));
    render(<AssistantClient />);
    fireEvent.change(box(), { target: { value: QUESTION } });
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(screen.getByTestId("assistant-answer")).toHaveTextContent("A rainbow is")
    );
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an answer cut off at its length limit says it is not complete (N-45)", async () => {
    signedIn();
    fetchMock.mockImplementation(async () =>
      reply("POST /api/stream — an answer cut off at its length limit")
    );
    render(<AssistantClient />);
    askQuestion();
    expect(
      await within(answerRegion()).findByText(renderMessage("screens.stream.truncated"))
    ).toHaveAttribute("role", "status");
    expect(screen.getByTestId("assistant-answer")).toHaveTextContent(
      "A rainbow is sunlight split"
    );
  });

  it("rejected content: the refusal's own message, and the link to its decision", async () => {
    signedIn();
    fetchMock.mockImplementation(async () =>
      reply("POST /api/stream — refused (content rejected)")
    );
    render(<AssistantClient />);
    askQuestion("something the screening blocks");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      messageOf("POST /api/stream — refused (content rejected)")
    );
    expect(
      within(alert).getByRole("link", { name: "See this decision and appeal it" })
    ).toHaveAttribute("href", "/account");
  });

  it("an answer withheld mid-stream: its message, and no decision to appeal (the question was not blocked)", async () => {
    signedIn();
    fetchMock.mockImplementation(async () =>
      reply("POST /api/stream — the answer withheld by screening")
    );
    render(<AssistantClient />);
    askQuestion();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      routeMessage("POST /api/stream — the answer withheld by screening")
    );
    expect(within(alert).queryByRole("link")).toBeNull();
  });

  // TASK-211 (N-119): only a block links to a decision; a hold and an outage do not.
  it("a question held for a moderator: says so, as a wait, with no appeal link", async () => {
    signedIn();
    fetchMock.mockImplementation(async () =>
      reply("POST /api/stream — held for a moderator")
    );
    render(<AssistantClient />);
    askQuestion("something the screening holds for review");
    const region = answerRegion();
    const held = await within(region).findByText(
      messageOf("POST /api/stream — held for a moderator")
    );
    expect(held).toHaveAttribute("role", "status");
    expect(within(region).queryByRole("alert")).toBeNull();
    expect(within(region).queryByRole("link")).toBeNull();
  });

  it("the screening unavailable: the outage, with Try again and no appeal link", async () => {
    signedIn();
    fetchMock.mockImplementation(async () =>
      reply("POST /api/stream — refused (the screening unavailable)")
    );
    render(<AssistantClient />);
    askQuestion();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      messageOf("POST /api/stream — refused (the screening unavailable)")
    );
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(within(alert).queryByRole("link")).toBeNull();
  });

  it("rate limited: says when to try again", async () => {
    signedIn();
    fetchMock.mockImplementation(async () =>
      reply("POST /api/stream — refused (rate limited)")
    );
    render(<AssistantClient />);
    askQuestion();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      messageOf("POST /api/stream — refused (rate limited)")
    );
    expect(alert).toHaveTextContent(
      renderMessage("screens.refusal.retry_after", { seconds: 30 })
    );
  });

  it("a guest's token refused by the route: shown as the route says, with sign-in", async () => {
    signedIn();
    fetchMock.mockImplementation(async () =>
      reply("POST /api/stream — refused (a guest)")
    );
    render(<AssistantClient />);
    askQuestion();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(messageOf("POST /api/stream — refused (a guest)"));
    expect(within(alert).getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/auth"
    );
  });

  it("the connection lost: a network refusal, and Try again asks again", async () => {
    signedIn();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<AssistantClient />);
    askQuestion();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(renderMessage("screens.refusal.network"));
    fetchMock.mockImplementation(async () => reply("POST /api/stream — an answer"));
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.getByTestId("assistant-answer")).toHaveTextContent("A rainbow is")
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))
    ).toEqual({
      prompt: QUESTION,
    });
  });

  it("Stop ends the answer, marks it incomplete, and nothing from it reaches the next question", async () => {
    signedIn();
    let first: ReturnType<typeof held> | undefined;
    fetchMock.mockImplementationOnce(async (_u: string, init?: RequestInit) => {
      first = held(
        "POST /api/stream — an answer cut off at its length limit",
        init?.signal
      );
      return first.response;
    });
    render(<AssistantClient />);
    askQuestion();
    await waitFor(() =>
      expect(screen.getByTestId("assistant-answer")).toHaveTextContent(
        "A rainbow is sunlight split"
      )
    );
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText(t("stopped"))).toBeInTheDocument();
    expect(askButton()).toBeEnabled();

    fetchMock.mockImplementationOnce(async () => reply("POST /api/stream — an answer"));
    askQuestion("And a second question?");
    await waitFor(() =>
      expect(screen.getByTestId("assistant-answer")).toHaveTextContent(
        "A rainbow is sunlight split by raindrops."
      )
    );
    // The stopped answer's last events, arriving late, change nothing.
    await act(async () => first!.release());
    expect(screen.queryByText(renderMessage("screens.stream.truncated"))).toBeNull();
    expect(screen.queryByText(t("stopped"))).toBeNull();
    expect(screen.getByText("You asked: And a second question?")).toBeInTheDocument();
  });

  it("Clear empties the question and the answer", async () => {
    signedIn();
    fetchMock.mockImplementation(async () => reply("POST /api/stream — an answer"));
    render(<AssistantClient />);
    askQuestion();
    await waitFor(() =>
      expect(screen.getByTestId("assistant-answer")).toHaveTextContent("A rainbow is")
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(box()).toHaveValue("");
    expect(screen.queryByRole("region", { name: "Answer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("the question is bounded as the route bounds it", () => {
    signedIn();
    render(<AssistantClient />);
    expect(box()).toHaveAttribute("maxLength", "4000");
  });
});

describe("the home bar's way to the assistant (TASK-211)", () => {
  it("a signed-in user: Assistant, beside Your account", () => {
    signedIn();
    render(<HomeClient />);
    expect(screen.getByRole("link", { name: "Assistant" })).toHaveAttribute(
      "href",
      "/assistant"
    );
    expect(screen.getByRole("link", { name: "Your account" })).toBeInTheDocument();
  });

  it("a guest: the assistant is for accounts, so no link", () => {
    Object.assign(mockAuth, { isAuthenticated: true, isGuest: true });
    render(<HomeClient />);
    expect(screen.queryByRole("link", { name: "Assistant" })).toBeNull();
  });
});
