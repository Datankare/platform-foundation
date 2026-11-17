/** @jest-environment jsdom */
/**
 * __tests__/assistant-answer.test.tsx — the assistant's answer: its formatting shown as formatting,
 * never as markup (TASK-224, SF-app-030)
 *
 * components/assistant/AnswerText.tsx renders the part of Markdown an answer uses — paragraphs,
 * lists, headings, code, bold and italic — as React elements built from the text. Nothing the model
 * writes is read as HTML: a tag in an answer is text on the page, never an element, and a link is
 * its words and its address in plain text, never a link to follow (OWASP LLM05). A partial answer
 * (still streaming) renders too.
 *
 * hostile:role n/a: rendering only
 * hostile:self n/a: no account is read
 * hostile:store-down n/a: no store is read
 * hostile:id-spelling n/a: no id is read
 */
import React from "react";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { AnswerText, parseBlocks, parseInline } from "@/components/assistant/AnswerText";

describe("AnswerText (SF-app-030)", () => {
  it("lists, bold, italic, code and headings are shown as formatting, not as typed marks", () => {
    const { container } = render(
      <AnswerText
        text={[
          "# Rainbows",
          "",
          "A **rainbow** is *sunlight* split by `raindrops`.",
          "",
          "- red",
          "- orange",
          "",
          "1. first",
          "2. second",
          "",
          "```",
          "const x = 1;",
          "```",
        ].join("\n")}
      />
    );
    expect(container.textContent).not.toMatch(/\*\*|`|^#|^- /m);
    expect(screen.getByText("rainbow").tagName).toBe("STRONG");
    expect(screen.getByText("sunlight").tagName).toBe("EM");
    expect(screen.getByText("raindrops").tagName).toBe("CODE");
    expect(container.querySelectorAll("ul > li")).toHaveLength(2);
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(container.querySelector("pre code")?.textContent).toBe("const x = 1;");
    expect(screen.getByText("Rainbows").tagName).toBe("P");
    // The page's own headings stay the page's: an answer adds none.
    expect(container.querySelector("h1,h2,h3,h4,h5,h6")).toBeNull();
  });

  it("markup in an answer is text: no element, no script, no image", () => {
    const { container } = render(
      <AnswerText text={'<img src=x onerror="alert(1)"> and <script>alert(2)</script>'} />
    );
    expect(container.querySelector("img,script")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("a link is its words and its address as plain text, never a link to follow", () => {
    const { container } = render(
      <AnswerText text="See [the docs](https://evil.example/login) for more." />
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("the docs (https://evil.example/login)");
  });

  it("a partial answer renders: an open fence or mark is shown as it stands", () => {
    expect(parseBlocks("```\nconst x")).toEqual([{ kind: "code", text: "const x" }]);
    expect(parseInline("a **bold")).toEqual([{ kind: "text", text: "a **bold" }]);
    const { container } = render(<AnswerText text={"Some text\nnext line"} />);
    expect(container.querySelectorAll("br")).toHaveLength(1);
  });

  it("snake_case words are not italic", () => {
    expect(parseInline("call my_var_name now")).toEqual([
      { kind: "text", text: "call my_var_name now" },
    ]);
  });
});
