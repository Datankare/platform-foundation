/**
 * @jest-environment jsdom
 *
 * Review 7 negative control: the jest-dom matchers the component suites rely on are installed
 * and actually assert — a failing match throws. A matcher that silently passed would make every
 * component test that uses it vacuous.
 */
import "@testing-library/jest-dom";
import { render } from "@testing-library/react";

it("jest-dom matchers assert (negative control)", () => {
  const { container } = render(
    <div>
      <span>hello</span>
    </div>
  );
  expect(container.querySelector("span")).toBeInTheDocument();
  expect(() => expect(container.querySelector("p")).toBeInTheDocument()).toThrow();
  expect(() =>
    expect(container.querySelector("span")).toHaveTextContent("nope")
  ).toThrow();
  expect(() => expect(container.querySelector("span")).not.toBeInTheDocument()).toThrow();
  expect(typeof (expect(1) as unknown as Record<string, unknown>).toBeVisible).toBe(
    "function"
  );
});
