"use client";

import React, { useState } from "react";
import { renderMessage } from "@/platform/errors/messages";
import { adminCall } from "@/components/admin/ui/admin-call";
import { Field, TextInput } from "@/components/admin/ui/Field";
import {
  OutcomeList,
  refusedOutcome,
  type OutcomeEntry,
} from "@/components/admin/ui/Outcome";
import { Reading } from "@/components/admin/ui/PanelState";
import { BUTTON } from "@/components/admin/ui/tokens";
import type { ActionPlan } from "@/components/admin/ActionConfirmPanel";

interface AdminPromptBarProps {
  panel: string;
  onPlanReceived: (plan: ActionPlan) => void;
  disabled?: boolean;
  /** Example commands the admin can run here (section-hints.ts), shown under the input. */
  placeholder?: string;
  /** What the command bar can do on this section, in words (section-hints.ts sectionScope). */
  scope?: string | null;
}

const p = (key: string) => renderMessage(`screens.admin_console.plan.${key}`);

/**
 * The command bar: a request in words, sent to the planner, answered with a plan to confirm.
 *
 * TASK-216 (SF-admin-017 to 019, 007): the input has a visible label, and its examples and what
 * it can do on this section are help text under it — tied to it, not a placeholder that is cut
 * on a phone and gone at the first key; it does not take focus when a section opens (a phone's
 * keyboard no longer opens by itself); what was typed stays when the planner refuses or cannot
 * be reached, with why beside it — only a received plan clears it; and "working on it" is a
 * status a screen reader hears. Up and Down recall earlier requests.
 */
export default function AdminPromptBar({
  panel,
  onPlanReceived,
  disabled = false,
  placeholder = renderMessage("screens.admin_console.hints.generic"),
  scope = null,
}: AdminPromptBarProps) {
  const [prompt, setPrompt] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  // Why no plan came: the planner's refusal, or no answer at all. What was typed is kept.
  const [refused, setRefused] = useState<OutcomeEntry | null>(null);
  /** No plan: why, and that the request is still there to change or run again. */
  const notPlanned = (refusal: Parameters<typeof refusedOutcome>[0]) =>
    setRefused(refusedOutcome(refusal, { next: p("kept") }));

  const handleSubmit = async () => {
    const asked = prompt.trim();
    if (!asked || isThinking) return;

    setIsThinking(true);
    setRefused(null);
    setHistory((prev) => [asked, ...prev.slice(0, 19)]);
    setHistoryIndex(-1);

    // Every refusal through the shared call helper: the catalogue's sentence for its code, and
    // a request that got no answer said as that (TASK-181, TASK-186, TASK-216).
    const answer = await adminCall("/api/admin/ai", {
      method: "POST",
      json: { prompt: asked, panel },
    });
    setIsThinking(false);
    if (!answer.ok) {
      notPlanned(answer.refusal);
      return;
    }
    const plan = answer.body.plan as ActionPlan | undefined;
    if (!plan || !Array.isArray(plan.actions)) {
      notPlanned({
        kind: "message",
        code: "",
        message: p("connect_failed"),
        params: {},
      });
      return;
    }
    setPrompt("");
    onPlanReceived(plan);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const nextIndex = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(nextIndex);
      if (history[nextIndex]) setPrompt(history[nextIndex]);
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const nextIndex = historyIndex - 1;
      if (nextIndex < 0) {
        setHistoryIndex(-1);
        setPrompt("");
      } else {
        setHistoryIndex(nextIndex);
        setPrompt(history[nextIndex]);
      }
    }
  };

  return (
    <div className="mb-6" data-command-bar="true">
      <div className="flex flex-wrap items-start gap-2">
        <Field
          label={p("label")}
          className="flex-1 basis-64"
          help={
            <>
              <span className="block" data-command-examples="true">
                {placeholder}
              </span>
              {scope ? (
                <span className="block" data-command-scope="true">
                  {scope}
                </span>
              ) : null}
            </>
          }
        >
          {(control) => (
            <TextInput
              {...control}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={disabled || isThinking}
              autoComplete="off"
            />
          )}
        </Field>
        {/* Level with the input, under the label's line. */}
        <button
          onClick={() => void handleSubmit()}
          disabled={!prompt.trim() || isThinking || disabled}
          className={`mt-5 ${BUTTON.primary} px-5 py-2`}
        >
          {p("run")}
        </button>
      </div>
      {/* Always there, so "working" is announced when it appears (4.1.3). */}
      <div className="mt-1 min-h-5">
        <Reading text={isThinking ? p("thinking") : ""} />
      </div>
      <OutcomeList
        outcomes={refused ? [refused] : []}
        label={p("refused_label")}
        onDismiss={() => setRefused(null)}
        // The input keeps focus: what was typed is still there to change.
        focusNewest={false}
      />
    </div>
  );
}
