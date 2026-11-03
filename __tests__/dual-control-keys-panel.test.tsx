/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DualControlKeysPanel } from "@/components/admin/DualControlKeysPanel";

const fetchMock = jest.fn();
beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});
beforeEach(() => {
  fetchMock.mockReset();
});

/**
 * The route's status for a body, as the real route answers it (round 11, item 1: the round-10 mock
 * answered every body 200, so a held change the route answered 422 passed here) — a held change, or
 * one filed for two-person approval (round 12), 202; a tool failure 422; else 200.
 * __tests__/config-ai-held-reply.test.ts drives the real route and gives the panel's reader its
 * very reply.
 */
function statusOf(payload: unknown): number {
  const p = (payload ?? {}) as {
    held?: boolean;
    success?: boolean;
    data?: { requiresApproval?: boolean; approvalError?: string; applied?: boolean };
  };
  if (p.held === true) return 202;
  if (p.success && p.data?.requiresApproval && !p.data.approvalError) return 202;
  if (p.success === false || p.data?.applied === false) return 422;
  return 200;
}

function routeFetch(handlers: { get?: unknown; update?: unknown }) {
  fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { toolId: string };
    const payload = body.toolId === "get_config" ? handlers.get : handlers.update;
    const status = statusOf(payload);
    return {
      ok: status < 300,
      status,
      json: async () => payload,
    } as unknown as Response;
  });
}

const addInput = "Config key to add to dual-control";

describe("DualControlKeysPanel — ADR-040 040c piece 2", () => {
  it("loads and lists the current dual-control keys", async () => {
    routeFetch({
      get: {
        success: true,
        data: { value: ["signups_enabled", "config.dual_control_keys"] },
      },
    });
    render(<DualControlKeysPanel />);
    await waitFor(() => expect(screen.getByText("signups_enabled")).toBeDefined());
    expect(screen.getByText("config.dual_control_keys")).toBeDefined();
  });

  it("holds the change when adding a key", async () => {
    routeFetch({
      get: { success: true, data: { value: ["signups_enabled"] } },
      update: {
        success: false,
        held: true,
        data: { pendingApproval: true, proposalId: "prop-1" },
      },
    });
    render(<DualControlKeysPanel />);
    await waitFor(() => expect(screen.getByText("signups_enabled")).toBeDefined());
    fireEvent.change(screen.getByLabelText(addInput), {
      target: { value: "moderation.escalation_sla_hours" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByRole("status")).toBeDefined());
    expect(screen.getByText(/Change held for approval/)).toBeDefined();
    expect(screen.getByText(/prop-1/)).toBeDefined();
    const updateCall = fetchMock.mock.calls.find(
      (c) => JSON.parse((c[1] as { body: string }).body).toolId === "update_config"
    );
    expect(updateCall).toBeDefined();
  });

  it("rejects adding a duplicate key without calling the server", async () => {
    routeFetch({ get: { success: true, data: { value: ["signups_enabled"] } } });
    render(<DualControlKeysPanel />);
    await waitFor(() => expect(screen.getByText("signups_enabled")).toBeDefined());
    fireEvent.change(screen.getByLabelText(addInput), {
      target: { value: "signups_enabled" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText(/already dual-controlled/)).toBeDefined();
  });

  it("holds the change when removing a key", async () => {
    routeFetch({
      get: {
        success: true,
        data: { value: ["signups_enabled", "config.dual_control_keys"] },
      },
      update: {
        success: false,
        held: true,
        data: { pendingApproval: true, proposalId: "prop-2" },
      },
    });
    render(<DualControlKeysPanel />);
    await waitFor(() => expect(screen.getByText("signups_enabled")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Remove signups_enabled" }));
    await waitFor(() =>
      expect(screen.getByText(/Change held for approval/)).toBeDefined()
    );
  });

  it("applies the change when it is not held", async () => {
    routeFetch({
      get: { success: true, data: { value: ["signups_enabled"] } },
      update: { success: true, data: { applied: true } },
    });
    render(<DualControlKeysPanel />);
    await waitFor(() => expect(screen.getByText("signups_enabled")).toBeDefined());
    fireEvent.change(screen.getByLabelText(addInput), { target: { value: "new.key" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByText("Change applied.")).toBeDefined());
    expect(screen.getByText("new.key")).toBeDefined();
  });

  it("surfaces an error when the change is refused", async () => {
    routeFetch({
      get: { success: true, data: { value: ["signups_enabled"] } },
      update: { success: false, error: "Config key not found." },
    });
    render(<DualControlKeysPanel />);
    await waitFor(() => expect(screen.getByText("signups_enabled")).toBeDefined());
    fireEvent.change(screen.getByLabelText(addInput), { target: { value: "bogus.key" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByText(/Config key not found/)).toBeDefined();
  });

  // Round 10 (I-A self-check): every refusal reads through the shared handler. A refused reply
  // that is not JSON (a proxy's page) used to read as an empty body — and so as "Change applied.",
  // with the new key listed though nothing changed.
  it("never reads a refused, non-JSON reply as applied", async () => {
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { toolId: string };
      if (body.toolId === "get_config") {
        const payload = { success: true, data: { value: ["signups_enabled"] } };
        return {
          ok: true,
          status: 200,
          json: async () => payload,
        } as unknown as Response;
      }
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
    expect(screen.queryByText("Change applied.")).toBeNull();
    expect(screen.queryByText("new.key")).toBeNull();
  });

  // A held change is held at the status the route answers it (202 — round 11, item 1, when it
  // read the body first because the route answered it 422). Round 15, I-2: a refusal is never
  // read as pending, whatever its body says — a refused filing kept `requiresApproval`.
  it.each([
    [202, true],
    [422, false],
    [409, false],
  ])("a held body at %i is held: %s", async (status, held) => {
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { toolId: string };
      const get = body.toolId === "get_config";
      const payload = get
        ? { success: true, data: { value: ["signups_enabled"] } }
        : {
            success: false,
            held: true,
            data: { pendingApproval: true, proposalId: "p-9", requiresApproval: true },
            ...(status >= 400
              ? {
                  code: "approvals.already_pending",
                  params: { key: "config.dual_control_keys" },
                }
              : {}),
          };
      const code = get ? 200 : status;
      return {
        ok: code < 300,
        status: code,
        json: async () => payload,
      } as unknown as Response;
    });
    render(<DualControlKeysPanel />);
    await waitFor(() => expect(screen.getByText("signups_enabled")).toBeDefined());
    fireEvent.change(screen.getByLabelText(addInput), { target: { value: "new.key" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    if (held) {
      await waitFor(() =>
        expect(screen.getByText(/Change held for approval/)).toBeDefined()
      );
      expect(screen.queryByRole("alert")).toBeNull();
    } else {
      await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
      expect(screen.queryByText(/Change held for approval/)).toBeNull();
    }
  });

  // Round 15, nit 4: a lost commit may have applied — the list is read again, so it shows what
  // the setting is, and the outcome is said to be unknown.
  it("after a lost commit reads the list again and says so", async () => {
    let reads = 0;
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { toolId: string };
      if (body.toolId === "get_config") {
        reads += 1;
        const value = reads === 1 ? ["signups_enabled"] : ["signups_enabled", "new.key"];
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { value } }),
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 503,
        json: async () => ({
          code: "admin.write_indeterminate",
          params: {},
          message: "Whether it took effect is unknown.",
        }),
      } as unknown as Response;
    });
    render(<DualControlKeysPanel />);
    await waitFor(() => expect(screen.getByText("signups_enabled")).toBeDefined());
    fireEvent.change(screen.getByLabelText(addInput), { target: { value: "new.key" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByText("new.key")).toBeDefined());
    expect(reads).toBe(2);
    expect(screen.getByRole("alert").textContent).toContain(
      "Whether it took effect is unknown."
    );
  });

  // Round 12, I-1: two-person approval — it read as "Change applied.", the key listed.
  it("shows a change filed for two-person approval as pending, never applied", async () => {
    routeFetch({
      get: { success: true, data: { value: ["signups_enabled"] } },
      update: {
        success: true,
        data: { applied: false, requiresApproval: true, approval: { id: "apr-7" } },
      },
    });
    render(<DualControlKeysPanel />);
    await waitFor(() => expect(screen.getByText("signups_enabled")).toBeDefined());
    fireEvent.change(screen.getByLabelText(addInput), { target: { value: "new.key" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(screen.getByText(/Change held for approval/)).toBeDefined()
    );
    expect(screen.getByText(/approval apr-7/)).toBeDefined();
    expect(screen.queryByText("Change applied.")).toBeNull();
    expect(screen.queryByText("new.key")).toBeNull();
  });

  // Round 13, I-C: a value the entry refuses answers 422 with its code and the entry's reasons
  // (as __tests__/config-ai-held-reply.test.ts shows the real route answering); the panel says
  // them.
  it("says why a value is refused, from the coded reply", async () => {
    // As the route answers it (round 14, item 2): admin.config_invalid_value, its reason worded.
    const reason = "config.dual_control_keys takes a list.";
    routeFetch({
      get: { success: true, data: { value: ["signups_enabled"] } },
      update: {
        success: false,
        data: { applied: false },
        code: "admin.config_invalid_value",
        params: {
          key: "config.dual_control_keys",
          reason: "type",
          expected: "json_array",
        },
        message: reason,
        error: reason,
      },
    });
    render(<DualControlKeysPanel />);
    await waitFor(() => expect(screen.getByText("signups_enabled")).toBeDefined());
    fireEvent.change(screen.getByLabelText(addInput), { target: { value: "x.y" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByRole("alert").textContent).toContain(reason);
  });

  it("shows the empty state when no keys are set", async () => {
    routeFetch({ get: { success: true, data: { value: [] } } });
    render(<DualControlKeysPanel />);
    await waitFor(() =>
      expect(screen.getByText("No keys are dual-controlled.")).toBeDefined()
    );
  });
});
