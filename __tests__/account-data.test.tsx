/** @jest-environment jsdom */
/**
 * __tests__/account-data.test.tsx — a copy of your data, and deleting your account, from the
 * account page (TASK-225, E-126)
 *
 * components/account/YourData.tsx and the account page around it, answered with each route's own
 * answers (__tests__/fixtures/route-responses.json): the copy is saved only when it arrived whole,
 * and a refusal saves nothing and says why; deleting asks first, in red, says what happens, and
 * acts only once the person has ticked that they understand — then through the platform's one
 * erasure route with its confirmation word, and the page says what was done (including a sign-in
 * whose removal is still being retried); a refusal leaves the account as it was. Nothing is put in
 * the browser's storage.
 *
 * hostile:role n/a: the routes check the account's own permission (their tests); the page shows
 * their refusal
 * hostile:self n/a: every call is the session's own account; the page sends no account id
 * hostile:store-down the export or the erasure refused (too large, the audit down): said, and
 * nothing saved or changed
 * hostile:id-spelling n/a: no id is read or sent
 */
import React from "react";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";
import { renderMessage } from "@/platform/errors/messages";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => "/account",
}));
jest.mock("@/platform/auth/context", () => ({
  ...jest.requireActual("@/platform/auth/context"),
  useAuth: () => ({
    user: { email: "me@example.test" },
    isLoading: false,
    isAuthenticated: true,
    isGuest: false,
    signOut: jest.fn(),
    signOutEverywhere: jest.fn(),
  }),
}));

import YourData, { wholeExport } from "@/components/account/YourData";
import AccountClient from "@/app/account/AccountClient";

const t = (key: string, values?: Record<string, string>) =>
  renderMessage(`screens.account.data.${key}`, values);

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];

const answers = new Map<string, RouteFixtureName>();
/** fetch answered by route with its own fixture; the export's body as the file the route sends. */
function routes(map: Record<string, RouteFixtureName>, exportCut = false) {
  answers.clear();
  for (const [k, v] of Object.entries(map)) answers.set(k, v);
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url: String(url),
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const name = answers.get(`${method} ${url}`);
    if (!name) throw new Error(`no answer for ${method} ${url}`);
    const [status, body] = routeAnswer(name);
    const text = JSON.stringify(body);
    const sent = exportCut ? text.slice(0, -5) : text;
    return {
      ok: status < 300,
      status,
      json: async () => body,
      headers: new Headers({
        "content-disposition": 'attachment; filename="my-data.json"',
      }),
      blob: async () => new Blob([sent], { type: "application/json" }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const saved: string[] = [];
beforeEach(() => {
  calls.length = 0;
  saved.length = 0;
  URL.createObjectURL = jest.fn(() => "blob:copy");
  URL.revokeObjectURL = jest.fn();
  jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    saved.push(this.download);
  });
});
afterEach(() => jest.restoreAllMocks());

describe("a copy of your data (E-126)", () => {
  it("downloaded whole: saved under the route's name, and said", async () => {
    routes({ "GET /api/account/export": "GET /api/account/export — the copy" });
    render(<YourData email="me@example.test" onDeleted={jest.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("export") }));
    });
    expect(
      await screen.findByText(t("export_done", { file: "my-data.json" }))
    ).toBeInTheDocument();
    expect(saved).toEqual(["my-data.json"]);
  });

  it("refused (too large): said in the route's words, nothing saved", async () => {
    routes({
      "GET /api/account/export": "GET /api/account/export — refused (too large)",
    });
    render(<YourData email="me@example.test" onDeleted={jest.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("export") }));
    });
    expect(
      await screen.findByText(/more than one download can carry/)
    ).toBeInTheDocument();
    expect(saved).toEqual([]);
  });

  it("a file that stopped part-way is never saved as if whole", async () => {
    routes({ "GET /api/account/export": "GET /api/account/export — the copy" }, true);
    render(<YourData email="me@example.test" onDeleted={jest.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("export") }));
    });
    // Said as not done (no answer that was whole), and nothing saved.
    expect(await screen.findByText("Not done")).toBeInTheDocument();
    expect(saved).toEqual([]);
    expect(screen.queryByText(t("export_done", { file: "my-data.json" }))).toBeNull();
    expect(wholeExport('{"a":1}\n')).toBe(true);
    expect(wholeExport('{"a":')).toBe(false);
  });

  it("nothing is kept in the browser's storage", async () => {
    const before = { local: localStorage.length, session: sessionStorage.length };
    routes({ "GET /api/account/export": "GET /api/account/export — the copy" });
    render(<YourData email="me@example.test" onDeleted={jest.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("export") }));
    });
    await screen.findByText(t("export_done", { file: "my-data.json" }));
    expect(localStorage.length).toBe(before.local);
    expect(sessionStorage.length).toBe(before.session);
  });
});

describe("deleting your account (E-126)", () => {
  it("asks first, in red, saying what happens; acts only once ticked; then the erasure route", async () => {
    routes({ "POST /api/account/delete": "POST /api/account/delete — deleted" });
    const onDeleted = jest.fn();
    render(<YourData email="me@example.test" onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: t("delete") }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveFocus();
    expect(dialog).toHaveAttribute("data-risk", "irreversible");
    expect(dialog).toHaveTextContent("This cannot be undone.");
    expect(dialog).toHaveTextContent(t("delete_consequence"));
    expect(dialog).toHaveTextContent(
      t("delete_confirm_title", { email: "me@example.test" })
    );
    // Not ticked: nothing is sent.
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: t("delete_confirm") }));
    });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(t("delete_tick_first"));
    expect(calls).toEqual([]);
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: t("delete_understand") })
    );
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: t("delete_confirm") }));
    });
    expect(calls).toEqual([
      { url: "/api/account/delete", method: "POST", body: { confirm: "DELETE" } },
    ]);
    expect(onDeleted).toHaveBeenCalledWith({ identityDeleted: true });
  });

  it("Cancel and Escape send nothing, and give focus back", () => {
    routes({ "POST /api/account/delete": "POST /api/account/delete — deleted" });
    render(<YourData email="me@example.test" onDeleted={jest.fn()} />);
    const open = screen.getByRole("button", { name: t("delete") });
    open.focus();
    fireEvent.click(open);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("button", { name: t("delete") })).toHaveFocus();
    expect(calls).toEqual([]);
  });

  it("refused: said in the route's words; the account is as it was", async () => {
    routes({
      "POST /api/account/delete":
        "POST /api/account/delete — refused (the audit could not be written)",
    });
    const onDeleted = jest.fn();
    render(<YourData email="me@example.test" onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: t("delete") }));
    fireEvent.click(screen.getByRole("checkbox", { name: t("delete_understand") }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("delete_confirm") }));
    });
    expect(onDeleted).not.toHaveBeenCalled();
    expect(
      await screen.findByText("This service is unavailable right now. Try again shortly.")
    ).toBeInTheDocument();
  });

  it("the account page then says what was done, its sign-in's removal still under way", async () => {
    routes({
      "GET /api/account/security":
        "GET /api/account/security — signed in, two-step verification on",
      "GET /api/moderation/appeals": "GET /api/moderation/appeals — none",
      "POST /api/account/delete":
        "POST /api/account/delete — deleted, its sign-in still being removed",
    });
    render(<AccountClient />);
    const data = screen.getByRole("region", { name: t("title") });
    fireEvent.click(within(data).getByRole("button", { name: t("delete") }));
    fireEvent.click(within(data).getByRole("checkbox", { name: t("delete_understand") }));
    await act(async () => {
      fireEvent.click(within(data).getByRole("button", { name: t("delete_confirm") }));
    });
    expect(screen.getByRole("heading", { name: t("deleted_title") })).toBeInTheDocument();
    expect(screen.getByText(t("deleted_identity_pending"))).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: t("title") })).toBeNull();
    expect(screen.getByRole("link", { name: t("deleted_leave") })).toHaveAttribute(
      "href",
      "/auth"
    );
  });
});
