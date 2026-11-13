/** @jest-environment jsdom */
/**
 * __tests__/session-idle-warning.test.tsx — a staff member is warned before an idle sign-out and
 * can carry on without losing the page (components/auth/SessionIdleWarning.tsx; ADR-057 D5)
 *
 * A staff session ends after 30 minutes without a request, and typing into a form makes none.
 * Covered: nothing shown to a user, a guest or a signed-out page; nothing shown to staff with
 * time in hand; the notice inside the warning window, with the time left; "Stay signed in" makes
 * one request that counts as use, the notice goes and what was typed in the page is still there;
 * "Sign out" signs out; the status poll is a GET (it does not keep the session alive); and when
 * the limit passes the server is asked, and its answer (signed out) is what the page shows.
 */

import "@testing-library/jest-dom";
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import SessionIdleWarning from "@/components/auth/SessionIdleWarning";
import {
  AuthContextProvider,
  resetSessionStateForTests,
  useAuth,
} from "@/platform/auth/context";

const T0 = 1_800_000_000_000;
interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}
const calls: Call[] = [];
let answer: (call: Call) => unknown;

const session = (audience: string, idleInSeconds: number | null) => ({
  authenticated: true,
  user: { userId: "u1", email: "staff@example.com", emailVerified: true, isGuest: false },
  csrfToken: "csrf-1",
  audience,
  idleExpiresAt: idleInSeconds === null ? null : Date.now() + idleInSeconds * 1000,
  absoluteExpiresAt: Date.now() + 12 * 3600_000,
  idleWarningSeconds: 120,
});

beforeEach(() => {
  jest.useFakeTimers({ now: T0 });
  calls.length = 0;
  resetSessionStateForTests();
  answer = () => ({ authenticated: false });
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    calls.push(call);
    return { ok: true, status: 200, json: async () => answer(call) } as Response;
  }) as unknown as typeof fetch;
});
afterEach(() => {
  jest.useRealTimers();
});

function Status() {
  const { isAuthenticated } = useAuth();
  return <p data-testid="status">{isAuthenticated ? "signed-in" : "signed-out"}</p>;
}

async function mount() {
  render(
    <AuthContextProvider>
      <Status />
      <label>
        Note
        <textarea defaultValue="" />
      </label>
      <SessionIdleWarning />
    </AuthContextProvider>
  );
  // The first read of the session, then the component's one-second clock.
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1100);
  });
}
const advance = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
const notice = () => screen.queryByTestId("session-idle-warning");

describe("who is warned", () => {
  it.each([
    ["a signed-out page", () => ({ authenticated: false })],
    ["a user, even inside the window (their limit is days)", () => session("user", 60)],
    ["a guest (no idle limit)", () => session("guest", null)],
    ["staff with time in hand", () => session("staff", 1500)],
  ])("%s: nothing is shown", async (_who, body) => {
    answer = body;
    await mount();
    expect(notice()).toBeNull();
  });

  it("staff inside the warning window: the notice, with the time left, and focus on staying", async () => {
    answer = () => session("staff", 90);
    await mount();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Still there?");
    expect(dialog).toHaveAccessibleDescription(/signed out in 8[89] seconds/);
    expect(dialog.textContent).toMatch(/8[89] seconds/);
    expect(screen.getByRole("button", { name: "Stay signed in" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  });

  it("the notice appears when the time left crosses into the window — not before", async () => {
    const idleAt = T0 + 300_000;
    answer = () => ({ ...session("staff", 0), idleExpiresAt: idleAt });
    await mount();
    expect(notice()).toBeNull();
    await advance(170_000); // 130 s left
    expect(notice()).toBeNull();
    await advance(12_000); // under 120 s left
    expect(notice()).not.toBeNull();
  });
});

describe("what the staff member can do", () => {
  it("Stay signed in: one POST that counts as use; the notice goes; what was typed stays", async () => {
    let used = false;
    answer = (call) => {
      if (call.method === "POST") used = true;
      return session("staff", used ? 1800 : 90);
    };
    await mount();
    const note = screen.getByLabelText("Note");
    fireEvent.change(note, { target: { value: "half a sentence" } });
    calls.length = 0;

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stay signed in" }));
      await jest.advanceTimersByTimeAsync(10);
    });
    await advance(1100);

    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("/api/auth/session");
    // A state-changing request: it carries the session's forgery token.
    expect(posts[0].headers["x-csrf-token"]).toBe("csrf-1");
    expect(notice()).toBeNull();
    expect(screen.getByTestId("status")).toHaveTextContent("signed-in");
    expect(screen.getByLabelText("Note")).toHaveValue("half a sentence");
  });

  it("Sign out: the server ends the session and the page says so", async () => {
    answer = () => session("staff", 90);
    await mount();
    calls.length = 0;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
      await jest.advanceTimersByTimeAsync(10);
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toContain("POST /api/auth/sign-out");
    expect(screen.getByTestId("status")).toHaveTextContent("signed-out");
    expect(notice()).toBeNull();
  });
});

describe("what the page asks the server", () => {
  it("the status poll is a GET every 30 seconds — reading the time left never extends it", async () => {
    answer = () => session("staff", 1500);
    await mount();
    calls.length = 0;
    await advance(61_000);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((c) => c.method === "GET" && c.url === "/api/auth/session")).toBe(
      true
    );
  });

  it("a user's page is never polled", async () => {
    answer = () => session("user", 7 * 86400);
    await mount();
    calls.length = 0;
    await advance(120_000);
    expect(calls).toEqual([]);
  });

  it("when the limit passes the server decides: it says signed out, and the page shows that", async () => {
    let over = false;
    answer = () => (over ? { authenticated: false } : session("staff", 30));
    await mount();
    expect(notice()).not.toBeNull();
    over = true;
    await advance(31_000);
    expect(screen.getByTestId("status")).toHaveTextContent("signed-out");
    expect(notice()).toBeNull();
  });
});
