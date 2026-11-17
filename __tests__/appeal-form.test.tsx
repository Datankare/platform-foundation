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
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AppealForm from "@/components/AppealForm/AppealForm";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";
import { renderMessage } from "@/platform/errors/messages";

const LONG_REASON = "This is a sufficiently long and detailed appeal reason.";

/** The appeals route's own answer (__tests__/fixtures/route-responses.json). */
function answer(name: RouteFixtureName): Response {
  const [status, body] = routeAnswer(name);
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}
const SUBMITTED = "POST /api/moderation/appeals — submitted";

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
    (global.fetch as jest.Mock).mockResolvedValueOnce(answer(SUBMITTED));

    render(<AppealForm originalDecisionId="traj-1" onSubmitted={onSubmitted} />);
    fireEvent.change(screen.getByTestId("af-reason"), { target: { value: LONG_REASON } });
    fireEvent.click(screen.getByTestId("af-submit"));

    await waitFor(() => expect(screen.getByTestId("af-success")).toBeDefined());
    expect(onSubmitted).toHaveBeenCalledWith(
      (routeAnswer(SUBMITTED)[1] as { item: unknown }).item
    );

    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(call[0]).toBe("/api/moderation/appeals");
    expect(JSON.parse(call[1].body).originalDecisionId).toBe("traj-1");
    expect(JSON.parse(call[1].body).appealReason).toBe(LONG_REASON);
  });

  it("shows a failure box on a server error and no success", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      answer("POST /api/moderation/appeals — refused (an appeal already pending)")
    );

    render(<AppealForm originalDecisionId="traj-1" />);
    fireEvent.change(screen.getByTestId("af-reason"), { target: { value: LONG_REASON } });
    fireEvent.click(screen.getByTestId("af-submit"));

    // The error is the field's, tied to it and announced (SF-app-061).
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("already pending")
    );
    expect(screen.getByTestId("af-reason")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByTestId("af-success")).toBeNull();
  });

  it("shows a failure box on a network error", async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("network"));

    render(<AppealForm originalDecisionId="traj-1" />);
    fireEvent.change(screen.getByTestId("af-reason"), { target: { value: LONG_REASON } });
    fireEvent.click(screen.getByTestId("af-submit"));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        renderMessage("screens.refusal.network")
      )
    );
  });
});

describe("AppealForm on a page with several decisions (TASK-210)", () => {
  it("each form's label names its own field, and the field takes the server's longest reason", () => {
    render(
      <>
        <AppealForm originalDecisionId="traj-1" maxReasonLength={2000} />
        <AppealForm originalDecisionId="traj-2" maxReasonLength={500} />
      </>
    );
    const fields = screen.getAllByLabelText(/Why should this decision be reconsidered/);
    expect(fields).toHaveLength(2);
    expect(fields[0].id).not.toBe(fields[1].id);
    expect(fields[0].getAttribute("maxlength")).toBe("2000");
    expect(fields[1].getAttribute("maxlength")).toBe("500");
  });

  it("the confirmation promises no notification the platform does not send", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(answer(SUBMITTED));
    render(<AppealForm originalDecisionId="traj-1" />);
    fireEvent.change(screen.getByTestId("af-reason"), { target: { value: LONG_REASON } });
    fireEvent.click(screen.getByTestId("af-submit"));
    const done = await screen.findByTestId("af-success");
    expect(done.textContent).toBe(
      "Your appeal has been submitted. A moderator will review it."
    );
    expect(done.textContent).not.toMatch(/notified/);
  });
});

describe("AppealForm in the app's dark look (TASK-224, SF-app-061)", () => {
  it("no light box: the success and error boxes are the app's tones", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      answer("POST /api/moderation/appeals — submitted")
    );
    const { container } = render(<AppealForm originalDecisionId="traj-1" />);
    fireEvent.change(screen.getByTestId("af-reason"), { target: { value: LONG_REASON } });
    fireEvent.click(screen.getByTestId("af-submit"));
    await waitFor(() => expect(screen.getByTestId("af-success")).toBeDefined());
    expect(container.innerHTML).not.toMatch(/bg-(?:green|red)-50\b|bg-white\b/);
  });

  it("the count is the field's help, read with it", () => {
    render(<AppealForm originalDecisionId="traj-1" minReasonLength={20} />);
    const field = screen.getByTestId("af-reason");
    const counter = screen.getByTestId("af-counter");
    expect(field.getAttribute("aria-describedby") ?? "").toContain(
      counter.parentElement?.id ?? "missing"
    );
  });
});
