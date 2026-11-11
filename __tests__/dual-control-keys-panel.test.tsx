/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DualControlKeysPanel } from "@/components/admin/DualControlKeysPanel";
import { ALWAYS_DUAL_CONTROLLED } from "@/platform/admin/config-handlers";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";

const fetchMock = jest.fn();
beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});
beforeEach(() => {
  fetchMock.mockReset();
});

const KEYS = "POST /api/admin/config-ai/execute — get_config: the dual-control keys,";
const UPDATE = "POST /api/admin/config-ai/execute — update_config:";

/** A route's own answer (__tests__/fixtures/route-responses.json), as fetch resolves it. */
function answer(name: RouteFixtureName): Response {
  const [status, body] = routeAnswer(name);
  return { ok: status < 300, status, json: async () => body } as unknown as Response;
}
const messageOf = (name: RouteFixtureName) =>
  (routeAnswer(name)[1] as { message: string }).message;

/** The config route answering the panel's read with `get` and its change with `update`. */
function routeFetch(get: string, update?: string) {
  fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { toolId: string };
    const name = body.toolId === "get_config" ? get : update;
    if (!name) throw new Error(`unexpected ${body.toolId}`);
    return answer(name as RouteFixtureName);
  });
}

const addInput = "Config key to add to dual-control";

describe("DualControlKeysPanel — ADR-040 040c piece 2", () => {
  // TASK-207: the panel read `data.value`; the route answers the setting as `data.entry` — so
  // against the real route it listed nothing, whatever the setting held.
  it("loads and lists the current dual-control keys, from the setting's entry", async () => {
    routeFetch(`${KEYS} two keys`);
    render(<DualControlKeysPanel />);
    await waitFor(() => expect(screen.getByText("signups_enabled")).toBeDefined());
    expect(screen.getByText("config.dual_control_keys")).toBeDefined();
  });

  // TASK-207's walk at 390 px: a long key pushed its Remove button past the phone's edge.
  it("a long key wraps, and its Remove button keeps its size", async () => {
    routeFetch(`${KEYS} two keys`);
    render(<DualControlKeysPanel />);
    const key = await screen.findByText("config.dual_control_keys");
    expect(key.className).toMatch(/\bmin-w-0\b/);
    expect(key.className).toMatch(/\bbreak-all\b/);
    const remove = key.parentElement!.querySelector("button")!;
    expect(remove.className).toMatch(/\bshrink-0\b/);
  });

  it("the list is always dual-controlled: a change made here is held, never applied", () => {
    expect(ALWAYS_DUAL_CONTROLLED).toContain("config.dual_control_keys");
  });

  it("holds the change when adding a key", async () => {
    const held = `${UPDATE} a dual-control key added, held`;
    routeFetch(`${KEYS} one key`, held);
    render(<DualControlKeysPanel />);
    await waitFor(() => expect(screen.getByText("signups_enabled")).toBeDefined());
    fireEvent.change(screen.getByLabelText(addInput), {
      target: { value: "new.key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByRole("status")).toBeDefined());
    expect(screen.getByText(/Change held for approval/)).toBeDefined();
    const { proposalId } = (
      routeAnswer(held as RouteFixtureName)[1] as {
        data: { proposalId: string };
      }
    ).data;
    expect(screen.getByText(new RegExp(proposalId))).toBeDefined();
    // Held, not applied: the list is what it was.
    expect(screen.queryByText("new.key")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    const updateCall = fetchMock.mock.calls.find(
      (c) => JSON.parse((c[1] as { body: string }).body).toolId === "update_config"
    );
    expect(JSON.parse((updateCall![1] as { body: string }).body).input).toMatchObject({
      key: "config.dual_control_keys",
      value: ["signups_enabled", "new.key"],
    });
  });

  it("rejects adding a duplicate key without calling the server", async () => {
    routeFetch(`${KEYS} one key`);
    render(<DualControlKeysPanel />);
    await waitFor(() => expect(screen.getByText("signups_enabled")).toBeDefined());
    fireEvent.change(screen.getByLabelText(addInput), {
      target: { value: "signups_enabled" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText(/already dual-controlled/)).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("holds the change when removing a key", async () => {
    routeFetch(`${KEYS} two keys`, `${UPDATE} a dual-control key removed, held`);
    render(<DualControlKeysPanel />);
    await waitFor(() => expect(screen.getByText("signups_enabled")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Remove signups_enabled" }));
    await waitFor(() =>
      expect(screen.getByText(/Change held for approval/)).toBeDefined()
    );
    // Still listed until an approver clears it.
    expect(screen.getByText("signups_enabled")).toBeDefined();
  });

  it("surfaces the refusal when the change is refused, never as held", async () => {
    const refused =
      `${UPDATE} the dual-control list, refused (no safety tier)` as RouteFixtureName;
    routeFetch(`${KEYS} one key`, refused);
    render(<DualControlKeysPanel />);
    await waitFor(() => expect(screen.getByText("signups_enabled")).toBeDefined());
    fireEvent.change(screen.getByLabelText(addInput), { target: { value: "new.key" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByRole("alert").textContent).toContain(messageOf(refused));
    expect(screen.queryByText(/Change held for approval/)).toBeNull();
    expect(screen.queryByText("new.key")).toBeNull();
  });

  it("a read the route refuses says why, and lists nothing", async () => {
    const refused = `${KEYS} refused (no permission)` as RouteFixtureName;
    routeFetch(refused);
    render(<DualControlKeysPanel />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByRole("alert").textContent).toContain(messageOf(refused));
  });

  // Round 10 (I-A self-check): every refusal reads through the shared handler. A refused reply
  // that is not JSON (a proxy's page) used to read as an empty body — and so as "Change applied.",
  // with the new key listed though nothing changed.
  it("never reads a refused, non-JSON reply as held or applied", async () => {
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { toolId: string };
      if (body.toolId === "get_config")
        return answer(`${KEYS} one key` as RouteFixtureName);
      return {
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      } as unknown as Response;
    });
    render(<DualControlKeysPanel />);
    await waitFor(() => expect(screen.getByText("signups_enabled")).toBeDefined());
    fireEvent.change(screen.getByLabelText(addInput), { target: { value: "new.key" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByText("Something went wrong. Please try again.")).toBeDefined();
    expect(screen.queryByText(/Change held for approval/)).toBeNull();
    expect(screen.queryByText("new.key")).toBeNull();
  });

  it("shows the empty state when no keys are set", async () => {
    routeFetch(`${KEYS} none`);
    render(<DualControlKeysPanel />);
    await waitFor(() =>
      expect(screen.getByText("No keys are dual-controlled.")).toBeDefined()
    );
  });
});
