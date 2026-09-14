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

function routeFetch(handlers: { get?: unknown; update?: unknown }) {
  fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { toolId: string };
    const payload = body.toolId === "get_config" ? handlers.get : handlers.update;
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
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

  it("shows the empty state when no keys are set", async () => {
    routeFetch({ get: { success: true, data: { value: [] } } });
    render(<DualControlKeysPanel />);
    await waitFor(() =>
      expect(screen.getByText("No keys are dual-controlled.")).toBeDefined()
    );
  });
});
