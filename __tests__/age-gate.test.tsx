/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import AgeGate from "@/components/auth/AgeGate";

const mockProps = {
  onVerified: jest.fn(),
  onCancel: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("AgeGate", () => {
  it("renders month, day, year inputs", () => {
    render(<AgeGate {...mockProps} />);
    expect(screen.getByLabelText("Month")).toBeDefined();
    expect(screen.getByLabelText("Day")).toBeDefined();
    expect(screen.getByLabelText("Year")).toBeDefined();
  });

  it("renders title and description", () => {
    render(<AgeGate {...mockProps} />);
    expect(screen.getByText("Verify Your Age")).toBeDefined();
    expect(
      screen.getByText("Please enter your date of birth to continue.")
    ).toBeDefined();
  });

  it("continue button disabled until all fields filled", () => {
    render(<AgeGate {...mockProps} />);
    const button = screen.getByText("Continue");
    expect(button.getAttribute("disabled")).not.toBeNull();

    fireEvent.change(screen.getByLabelText("Month"), {
      target: { value: "03" },
    });
    fireEvent.change(screen.getByLabelText("Day"), {
      target: { value: "15" },
    });
    expect(button.getAttribute("disabled")).not.toBeNull();

    fireEvent.change(screen.getByLabelText("Year"), {
      target: { value: "2000" },
    });
    expect(button.getAttribute("disabled")).toBeNull();
  });

  it("only accepts numeric input", () => {
    render(<AgeGate {...mockProps} />);
    const monthInput = screen.getByLabelText("Month") as HTMLInputElement;
    fireEvent.change(monthInput, { target: { value: "ab" } });
    expect(monthInput.value).toBe("");

    fireEvent.change(monthInput, { target: { value: "12" } });
    expect(monthInput.value).toBe("12");
  });

  it("limits month to 2 digits, day to 2 digits, year to 4 digits", () => {
    render(<AgeGate {...mockProps} />);
    const monthInput = screen.getByLabelText("Month") as HTMLInputElement;
    fireEvent.change(monthInput, { target: { value: "123" } });
    expect(monthInput.value).toBe("12");

    const yearInput = screen.getByLabelText("Year") as HTMLInputElement;
    fireEvent.change(yearInput, { target: { value: "20001" } });
    expect(yearInput.value).toBe("2000");
  });

  it("shows error for invalid month", () => {
    render(<AgeGate {...mockProps} />);
    fireEvent.change(screen.getByLabelText("Month"), {
      target: { value: "13" },
    });
    fireEvent.change(screen.getByLabelText("Day"), {
      target: { value: "15" },
    });
    fireEvent.change(screen.getByLabelText("Year"), {
      target: { value: "2000" },
    });
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByRole("alert").textContent).toBe("Month must be between 1 and 12");
  });

  it("shows error for invalid day", () => {
    render(<AgeGate {...mockProps} />);
    fireEvent.change(screen.getByLabelText("Month"), {
      target: { value: "02" },
    });
    fireEvent.change(screen.getByLabelText("Day"), {
      target: { value: "32" },
    });
    fireEvent.change(screen.getByLabelText("Year"), {
      target: { value: "2000" },
    });
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByRole("alert").textContent).toBe("Day must be between 1 and 31");
  });

  it("shows error for future date", () => {
    render(<AgeGate {...mockProps} />);
    const futureYear = new Date().getFullYear() + 1;
    fireEvent.change(screen.getByLabelText("Month"), {
      target: { value: "01" },
    });
    fireEvent.change(screen.getByLabelText("Day"), {
      target: { value: "01" },
    });
    fireEvent.change(screen.getByLabelText("Year"), {
      target: { value: String(futureYear) },
    });
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByRole("alert").textContent).toBe("Please enter a valid year");
  });

  it("calls onVerified with adult result for 25-year-old", () => {
    const year = new Date().getFullYear() - 25;
    render(<AgeGate {...mockProps} />);
    fireEvent.change(screen.getByLabelText("Month"), {
      target: { value: "01" },
    });
    fireEvent.change(screen.getByLabelText("Day"), {
      target: { value: "15" },
    });
    fireEvent.change(screen.getByLabelText("Year"), {
      target: { value: String(year) },
    });
    fireEvent.click(screen.getByText("Continue"));

    expect(mockProps.onVerified).toHaveBeenCalledWith(
      expect.objectContaining({
        isMinor: false,
        age: 25,
        requiresParentalConsent: false,
        contentRatingLevel: 3,
      }),
      `${year}-01-15`
    );
  });

  it("calls onVerified with minor result for 10-year-old", () => {
    const year = new Date().getFullYear() - 10;
    render(<AgeGate {...mockProps} />);
    fireEvent.change(screen.getByLabelText("Month"), {
      target: { value: "01" },
    });
    fireEvent.change(screen.getByLabelText("Day"), {
      target: { value: "15" },
    });
    fireEvent.change(screen.getByLabelText("Year"), {
      target: { value: String(year) },
    });
    fireEvent.click(screen.getByText("Continue"));

    expect(mockProps.onVerified).toHaveBeenCalledWith(
      expect.objectContaining({
        isMinor: true,
        requiresParentalConsent: true,
        contentRatingLevel: 1,
      }),
      `${year}-01-15`
    );
  });

  it("calls onVerified with teen result for 15-year-old", () => {
    const year = new Date().getFullYear() - 15;
    render(<AgeGate {...mockProps} />);
    fireEvent.change(screen.getByLabelText("Month"), {
      target: { value: "01" },
    });
    fireEvent.change(screen.getByLabelText("Day"), {
      target: { value: "15" },
    });
    fireEvent.change(screen.getByLabelText("Year"), {
      target: { value: String(year) },
    });
    fireEvent.click(screen.getByText("Continue"));

    expect(mockProps.onVerified).toHaveBeenCalledWith(
      expect.objectContaining({
        isMinor: true,
        requiresParentalConsent: false,
        contentRatingLevel: 2,
      }),
      `${year}-01-15`
    );
  });

  it("calls onCancel when back link clicked", () => {
    render(<AgeGate {...mockProps} />);
    fireEvent.click(screen.getByText("Back to Sign In"));
    expect(mockProps.onCancel).toHaveBeenCalled();
  });

  it("has numeric inputMode on all inputs", () => {
    render(<AgeGate {...mockProps} />);
    expect(screen.getByLabelText("Month").getAttribute("inputmode")).toBe("numeric");
    expect(screen.getByLabelText("Day").getAttribute("inputmode")).toBe("numeric");
    expect(screen.getByLabelText("Year").getAttribute("inputmode")).toBe("numeric");
  });

  it("shows error for invalid date like Feb 30", () => {
    render(<AgeGate {...mockProps} />);
    fireEvent.change(screen.getByLabelText("Month"), {
      target: { value: "02" },
    });
    fireEvent.change(screen.getByLabelText("Day"), {
      target: { value: "30" },
    });
    fireEvent.change(screen.getByLabelText("Year"), {
      target: { value: "2000" },
    });
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByRole("alert").textContent).toBe("Please enter a valid date");
  });
});
