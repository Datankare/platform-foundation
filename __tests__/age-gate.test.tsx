/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import AgeGate, { dateBounds, dateProblem } from "@/components/auth/AgeGate";
import { say } from "@/__tests__/helpers/auth-screen";

const mockProps = {
  onVerified: jest.fn(),
  onCancel: jest.fn(),
};

// A fixed date, mid-year at noon UTC, so "25 years old" holds whatever day the suite runs and
// in any time zone (TASK-159). Only Date is faked: React's scheduling keeps the real timers.
const NOW = new Date("2026-06-15T12:00:00Z");
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [
      "hrtime",
      "nextTick",
      "performance",
      "queueMicrotask",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "requestIdleCallback",
      "cancelIdleCallback",
      "setImmediate",
      "clearImmediate",
      "setInterval",
      "clearInterval",
      "setTimeout",
      "clearTimeout",
    ],
  });
});

afterEach(() => {
  jest.useRealTimers();
});

const field = () =>
  screen.getByLabelText(say("age_gate.date_of_birth")) as HTMLInputElement;
const enter = (iso: string) => {
  fireEvent.change(field(), { target: { value: iso } });
  fireEvent.click(screen.getByRole("button", { name: say("age_gate.continue") }));
};

describe("AgeGate", () => {
  it("SF-app-046: one date field, which the browser draws in the reader's own order", () => {
    render(<AgeGate {...mockProps} />);
    expect(field().type).toBe("date");
    expect(field().getAttribute("autocomplete")).toBe("bday");
    expect(field().min).toBe("1906-06-15");
    expect(field().max).toBe("2026-06-15");
  });

  it("SF-app-046: it is a form — Enter in the field continues", () => {
    render(<AgeGate {...mockProps} />);
    fireEvent.change(field(), { target: { value: "2000-03-15" } });
    fireEvent.submit(field().closest("form")!);
    expect(mockProps.onVerified).toHaveBeenCalledWith(
      expect.objectContaining({ isMinor: false }),
      "2000-03-15"
    );
  });

  it("renders title and description", () => {
    render(<AgeGate {...mockProps} />);
    expect(
      screen.getByRole("heading", { name: say("age_gate.verify_your_age") })
    ).toBeDefined();
    expect(screen.getByText(say("age_gate.please_enter_your_date_of"))).toBeDefined();
  });

  it("an empty date is the field's error: announced, the field marked", () => {
    render(<AgeGate {...mockProps} />);
    fireEvent.click(screen.getByRole("button", { name: say("age_gate.continue") }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(say("age_gate.enter_your_date_of_birth"));
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(field().getAttribute("aria-describedby")).toBe(alert.id);
    expect(mockProps.onVerified).not.toHaveBeenCalled();
  });

  it("the error clears as the date is changed", () => {
    render(<AgeGate {...mockProps} />);
    fireEvent.click(screen.getByRole("button", { name: say("age_gate.continue") }));
    fireEvent.change(field(), { target: { value: "2000-03-15" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refuses what is not a real date, a date in the future, and one more than 120 years ago", () => {
    expect(dateProblem("2000-02-30", NOW)).toBe(
      say("age_gate.please_enter_a_valid_date")
    );
    expect(dateProblem("15/03/2000", NOW)).toBe(
      say("age_gate.please_enter_a_valid_date")
    );
    expect(dateProblem("2027-01-01", NOW)).toBe(say("age_gate.date_of_birth_cannot_be"));
    expect(dateProblem("1900-01-01", NOW)).toBe(
      say("age_gate.please_enter_a_valid_date")
    );
    expect(dateProblem("  ", NOW)).toBe(say("age_gate.enter_your_date_of_birth"));
    expect(dateProblem("2000-03-15", NOW)).toBeNull();
    expect(dateBounds(NOW)).toEqual({ min: "1906-06-15", max: "2026-06-15" });
  });

  it("calls onVerified with adult result for 25-year-old", () => {
    render(<AgeGate {...mockProps} />);
    enter("2001-01-15");
    expect(mockProps.onVerified).toHaveBeenCalledWith(
      expect.objectContaining({
        isMinor: false,
        age: 25,
        requiresParentalConsent: false,
        contentRatingLevel: 3,
      }),
      "2001-01-15"
    );
  });

  // TASK-181: until parental consent ships (Batch 4) an under-13 date is refused here.
  it("refuses a 10-year-old's date with the not-available-yet message", () => {
    render(<AgeGate {...mockProps} />);
    enter("2016-01-15");
    expect(mockProps.onVerified).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(
      /children under 13 are not available yet/
    );
  });

  it("calls onVerified with teen result for 15-year-old", () => {
    render(<AgeGate {...mockProps} />);
    enter("2011-01-15");
    expect(mockProps.onVerified).toHaveBeenCalledWith(
      expect.objectContaining({
        isMinor: true,
        requiresParentalConsent: false,
        contentRatingLevel: 2,
      }),
      "2011-01-15"
    );
  });

  it("calls onCancel when back link clicked", () => {
    render(<AgeGate {...mockProps} />);
    fireEvent.click(screen.getByText(say("age_gate.back_to_sign_in")));
    expect(mockProps.onCancel).toHaveBeenCalled();
  });
});
