/** @jest-environment jsdom */
/**
 * __tests__/component.test.ts — the demo home (components/SpikeApp.tsx): its input rules, and
 * (TASK-210, N-117) a rejection that is a moderation decision linking to where it is appealed.
 * Platform Foundation's own (Playform's home is its own, sync-excluded with this file).
 */
import React from "react";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { handleRefusal } from "@/platform/errors/refusal";
import { renderMessage } from "@/platform/errors/messages";

import SpikeApp, { startClip, type SpikeAppProps } from "@/components/SpikeApp";
import { routeAnswer } from "@/__tests__/fixtures/route-responses";
import {
  canSubmitText,
  getCharState,
  MAX_CHARACTERS,
  canClearText,
} from "@/lib/inputValidation";

describe("SpikeApp — Component Behavior", () => {
  describe("MAX_CHARACTERS constant", () => {
    it("should be exactly 100", () => {
      expect(MAX_CHARACTERS).toBe(100);
    });
  });

  describe("getCharState", () => {
    it("should return correct state for empty string", () => {
      const state = getCharState("");
      expect(state.charCount).toBe(0);
      expect(state.charsLeft).toBe(100);
      expect(state.isOverLimit).toBe(false);
      expect(state.isEmpty).toBe(true);
    });

    it("should return correct state for normal text", () => {
      const state = getCharState("Hello world");
      expect(state.charCount).toBe(11);
      expect(state.charsLeft).toBe(89);
      expect(state.isOverLimit).toBe(false);
      expect(state.isEmpty).toBe(false);
    });

    it("should return correct state at exactly 100 characters", () => {
      const text = "a".repeat(100);
      const state = getCharState(text);
      expect(state.charCount).toBe(100);
      expect(state.charsLeft).toBe(0);
      expect(state.isOverLimit).toBe(false);
      expect(state.isEmpty).toBe(false);
    });

    it("should return correct state at 101 characters — over limit", () => {
      const text = "a".repeat(101);
      const state = getCharState(text);
      expect(state.charCount).toBe(101);
      expect(state.charsLeft).toBe(-1);
      expect(state.isOverLimit).toBe(true);
      expect(state.isEmpty).toBe(false);
    });

    it("should treat whitespace-only as empty", () => {
      const state = getCharState("     ");
      expect(state.isEmpty).toBe(true);
    });

    it("should show negative charsLeft when over limit", () => {
      const text = "a".repeat(110);
      const state = getCharState(text);
      expect(state.charsLeft).toBe(-10);
    });
  });

  describe("canSubmitText", () => {
    it("should return true for valid text not loading", () => {
      expect(canSubmitText("Hello world", false)).toBe(true);
    });

    it("should return false when loading", () => {
      expect(canSubmitText("Hello world", true)).toBe(false);
    });

    it("should return false for empty string", () => {
      expect(canSubmitText("", false)).toBe(false);
    });

    it("should return false for whitespace only", () => {
      expect(canSubmitText("     ", false)).toBe(false);
    });

    it("should return false for text over 100 characters", () => {
      expect(canSubmitText("a".repeat(101), false)).toBe(false);
    });

    it("should return true at exactly 100 characters", () => {
      expect(canSubmitText("a".repeat(100), false)).toBe(true);
    });

    it("should return false when both over limit AND loading", () => {
      expect(canSubmitText("a".repeat(101), true)).toBe(false);
    });

    it("should return false when empty AND loading", () => {
      expect(canSubmitText("", true)).toBe(false);
    });

    it("should not submit text that is exactly whitespace at limit", () => {
      expect(canSubmitText(" ".repeat(100), false)).toBe(false);
    });
  });

  describe("canClearText", () => {
    it("should return true when text exists and not loading", () => {
      expect(canClearText("Hello", false)).toBe(true);
    });

    it("should return false when text is empty", () => {
      expect(canClearText("", false)).toBe(false);
    });

    it("should return false when loading", () => {
      expect(canClearText("Hello", true)).toBe(false);
    });

    it("should return true even when text is over limit", () => {
      expect(canClearText("a".repeat(101), false)).toBe(true);
    });

    it("should return false when empty and loading", () => {
      expect(canClearText("", true)).toBe(false);
    });
  });
});

/** A route's own refusal for each code (route-responses.json): the body the screen reads. */
const REFUSAL_OF: Readonly<Record<string, Parameters<typeof routeAnswer>[0]>> = {
  "content.rejected": "POST /api/stream — refused (content rejected)",
  "account.restricted": "POST /api/admin/gdpr — refused (a suspended staff account)",
  "rate.limited": "POST /api/stream — refused (rate limited)",
};

describe("SpikeApp — a moderation decision offers its appeal (TASK-210, N-117)", () => {
  const APPEAL = "See this decision and appeal it";
  const refuse = async (code: string, isGuest = false) => {
    // A route's own refusal with this code (the shared handler words it, TASK-181).
    const [status, body] = routeAnswer(REFUSAL_OF[code]!);
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status, json: async () => body }) as never;
    render(React.createElement(SpikeApp as React.FC<SpikeAppProps>, { isGuest }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "some text" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /translate/i }));
    });
  };

  it("rejected content: the decision's message, and the link to appeal it", async () => {
    await refuse("content.rejected");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(handleRefusal("content.rejected").message);
    expect(screen.getByRole("link", { name: APPEAL })).toHaveAttribute(
      "href",
      "/account"
    );
  });

  it("a restricted account: the same link", async () => {
    await refuse("account.restricted");
    expect(screen.getByRole("link", { name: APPEAL })).toBeInTheDocument();
  });

  it("a guest has no account: no link", async () => {
    await refuse("content.rejected", true);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: APPEAL })).toBeNull();
  });

  it("another refusal is no decision: no link", async () => {
    await refuse("rate.limited");
    expect(screen.queryByRole("link", { name: APPEAL })).toBeNull();
  });

  it("Clear removes the message and its link", async () => {
    await refuse("content.rejected");
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(screen.queryByRole("link", { name: APPEAL })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("SpikeApp — the demo home's words and failures (TASK-224)", () => {
  const typeAndSend = async (value = "hello") => {
    fireEvent.change(screen.getByRole("textbox"), { target: { value } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /translate/i }));
    });
  };

  it("no internal labels: no spike, version or motto (SF-app-011, E-110), no jargon (SF-app-012)", () => {
    const { container } = render(
      React.createElement(SpikeApp as React.FC<SpikeAppProps>)
    );
    expect(container.textContent).not.toMatch(
      /Spike|v0\.1|Foundation as Fabric|Continuous Confidence|SFW/
    );
    expect(container.textContent).toContain("suitable for everyone");
    // A section of the app's frame, never a page of its own.
    expect(container.querySelector("main")).toBeNull();
  });

  it("the server's own text is never shown: the catalogue's sentence is (SF-app-020)", async () => {
    // An answer that is not a translation, whatever text it carries (a refusal's body, answered
    // as if it were a 200): the screen says its own sentence, never the server's words.
    const [, body] = routeAnswer("POST /api/stream — refused (content rejected)");
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => body }) as never;
    render(React.createElement(SpikeApp as React.FC<SpikeAppProps>));
    await typeAndSend();
    expect(screen.getByRole("alert")).toHaveTextContent(
      renderMessage("screens.app.spike.something_went_wrong")
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      String((body as { error?: string }).error)
    );
  });

  it("a clip the browser refuses to play: onFail, once (SF-app-021)", async () => {
    const play = jest.fn().mockRejectedValue(new Error("NotAllowedError"));
    const OriginalAudio = global.Audio;
    const made: { onerror?: () => void }[] = [];
    global.Audio = jest.fn().mockImplementation(() => {
      const a: {
        play: jest.Mock;
        pause: jest.Mock;
        currentTime: number;
        onerror?: () => void;
      } = { play, pause: jest.fn(), currentTime: 0 };
      made.push(a);
      return a;
    }) as never;
    const createObjectURL = URL.createObjectURL;
    URL.createObjectURL = jest.fn(() => "blob:x");
    try {
      const onFail = jest.fn();
      startClip("AA==", { onEnd: jest.fn(), onFail });
      await new Promise((r) => setTimeout(r, 0));
      expect(play).toHaveBeenCalled();
      expect(onFail).toHaveBeenCalledTimes(1);
      made[0]?.onerror?.();
      expect(onFail).toHaveBeenCalledTimes(1);
    } finally {
      global.Audio = OriginalAudio;
      URL.createObjectURL = createObjectURL;
    }
  });

  it("the count is announced only near the limit (SF-app-018)", () => {
    render(React.createElement(SpikeApp as React.FC<SpikeAppProps>));
    const said = () => screen.getByTestId("char-announcement");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hello" } });
    expect(said().textContent).toBe("");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "a".repeat(95) } });
    expect(said().textContent).toBe("5 characters left.");
  });

  it("buttons are named by their visible words (WCAG 2.5.3)", () => {
    render(React.createElement(SpikeApp as React.FC<SpikeAppProps>));
    expect(screen.getByRole("button", { name: /^Speak$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Clear$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Translate & Speak/ })).toBeInTheDocument();
  });
});
