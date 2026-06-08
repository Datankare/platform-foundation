/**
 * @jest-environment jsdom
 */
/**
 * __tests__/appeal-form.test.tsx
 *
 * RTL tests for the user-facing AppealForm. global.fetch is mocked. Covers
 * validation gating, the character counter, successful submission (+ onSubmitted
 * callback and request shape), server-error display, and network failure.
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AppealForm from "@/components/AppealForm/AppealForm";

const LONG_REASON = "This is a sufficiently long and detailed appeal reason.";

function okJson(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as unknown as Response;
}
function errJson(status: number, data: unknown = {}): Response {
  return { ok: false, status, json: async () => data } as unknown as Response;
}

beforeEach(() => {
  global.fetch = jest.fn();
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("AppealForm", () => {
  it("keeps submit disabled until the reason meets the minimum length", () => {
    render(<AppealForm originalDecisionId="traj-1" />);

    const btn = screen.getByTestId("af-submit") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("af-reason"), { target: { value: "short" } });
    expect(btn.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("af-reason"), { target: { value: LONG_REASON } });
    expect(btn.disabled).toBe(false);
  });

  it("shows characters-needed then character count in the counter", () => {
    render(<AppealForm originalDecisionId="traj-1" minReasonLength={20} />);

    expect(screen.getByTestId("af-counter").textContent).toContain("more character");

    fireEvent.change(screen.getByTestId("af-reason"), {
      target: { value: "x".repeat(25) },
    });
    expect(screen.getByTestId("af-counter").textContent).toContain("characters");
  });

  it("submits the appeal and shows the success state", async () => {
    const onSubmitted = jest.fn();
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      okJson({ item: { id: "appeal-1" } })
    );

    render(<AppealForm originalDecisionId="traj-1" onSubmitted={onSubmitted} />);
    fireEvent.change(screen.getByTestId("af-reason"), { target: { value: LONG_REASON } });
    fireEvent.click(screen.getByTestId("af-submit"));

    await waitFor(() => expect(screen.getByTestId("af-success")).toBeDefined());
    expect(onSubmitted).toHaveBeenCalledWith({ id: "appeal-1" });

    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(call[0]).toBe("/api/moderation/appeals");
    expect(JSON.parse(call[1].body).originalDecisionId).toBe("traj-1");
    expect(JSON.parse(call[1].body).appealReason).toBe(LONG_REASON);
  });

  it("shows a failure box on a server error and no success", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      errJson(409, { error: "An appeal is already pending for this decision" })
    );

    render(<AppealForm originalDecisionId="traj-1" />);
    fireEvent.change(screen.getByTestId("af-reason"), { target: { value: LONG_REASON } });
    fireEvent.click(screen.getByTestId("af-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("af-error").textContent).toContain("already pending")
    );
    expect(screen.queryByTestId("af-success")).toBeNull();
  });

  it("shows a failure box on a network error", async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("network"));

    render(<AppealForm originalDecisionId="traj-1" />);
    fireEvent.change(screen.getByTestId("af-reason"), { target: { value: LONG_REASON } });
    fireEvent.click(screen.getByTestId("af-submit"));

    await waitFor(() => expect(screen.getByTestId("af-error")).toBeDefined());
  });
});
