"use client";

/**
 * components/assistant/AssistantPanel.tsx — ask the assistant, read its answer as it is written
 * (TASK-211, N-118)
 *
 * The screen /api/stream exists for (ADR-018; the route's system prompt is the platform's,
 * prompts/assistant/stream-v1.ts): a signed-in user asks a question and the answer streams in
 * (hooks/useRealtimeStream.ts). Until TASK-211 no screen used the route or the hook. On the
 * assistant page (app/assistant), reached from the home page's bar.
 *
 *   - the question is bounded as the route bounds it (STREAM_MAX_PROMPT_CHARACTERS), with a count;
 *   - Ask sends it (also Ctrl/⌘+Enter); Stop ends the answer, which is then marked incomplete;
 *     Clear empties both;
 *   - the answer is a live region, read as it grows; an answer cut off at its length limit shows
 *     the route's notice (TASK-204, N-45);
 *   - a refusal is shown by its kind (components/refusal/RefusalNotice.tsx): rejected content links
 *     to its decision on the account page, a rate limit says when to retry, a provider outage
 *     offers "Try again". A refusal mid-answer (output withheld, the model declining) links to no
 *     decision: the user's own content was not blocked.
 *
 * Every string is the catalog's (messages/en.json, screens.assistant).
 */

import React, { useCallback, useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { STREAM_MAX_PROMPT_CHARACTERS } from "@/platform/ai/stream-policy";
import { RefusalNotice } from "@/components/refusal/RefusalNotice";
import { useRealtimeStream } from "@/hooks/useRealtimeStream";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.assistant.${key}`, values);

const BUTTON =
  "rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";
const INFO =
  "rounded-xl border border-gray-700 bg-gray-800/40 px-4 py-3 text-sm text-gray-300";

export default function AssistantPanel() {
  const [question, setQuestion] = useState("");
  const {
    startStream,
    text,
    isStreaming,
    refusal,
    refusedAt,
    truncated,
    stopped,
    abort,
    reset,
  } = useRealtimeStream();
  const [asked, setAsked] = useState("");

  const ask = useCallback(() => {
    const prompt = question.trim();
    if (!prompt || isStreaming) return;
    setAsked(prompt);
    startStream(prompt);
  }, [question, isStreaming, startStream]);

  const clear = useCallback(() => {
    reset();
    setQuestion("");
    setAsked("");
  }, [reset]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    ask();
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      ask();
    }
  };

  const hasAnswer = asked !== "";
  const waiting = isStreaming && text === "";

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="space-y-3">
        <label
          htmlFor="assistant-question"
          className="block text-sm font-medium text-gray-200"
        >
          {t("question_label")}
        </label>
        <textarea
          id="assistant-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={STREAM_MAX_PROMPT_CHARACTERS}
          rows={4}
          aria-describedby="assistant-question-hint"
          className="w-full resize-y rounded-xl border border-gray-700 bg-[#0a0f1e] p-3 text-sm text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
          placeholder={t("question_placeholder")}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id="assistant-question-hint" className="text-xs text-gray-400">
            {t("question_hint", {
              count: question.length,
              max: STREAM_MAX_PROMPT_CHARACTERS,
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            {isStreaming ? (
              <button
                type="button"
                onClick={abort}
                className={`${BUTTON} bg-gray-700 text-white hover:bg-gray-600`}
              >
                {t("stop")}
              </button>
            ) : (
              <button
                type="submit"
                disabled={question.trim() === ""}
                className={`${BUTTON} bg-blue-700 text-white hover:bg-blue-800`}
              >
                {t("ask")}
              </button>
            )}
            {(hasAnswer || question !== "") && (
              <button
                type="button"
                onClick={clear}
                className={`${BUTTON} border border-gray-700 text-gray-200 hover:bg-gray-800`}
              >
                {t("clear")}
              </button>
            )}
          </div>
        </div>
      </form>

      {hasAnswer && (
        <section
          aria-labelledby="assistant-answer"
          className="rounded-2xl border border-gray-800 bg-[#111827] p-4 sm:p-6"
        >
          <h2 id="assistant-answer" className="mb-2 text-lg font-semibold text-white">
            {t("answer_title")}
          </h2>
          <p className="mb-3 break-words text-xs text-gray-400">
            {t("asked", { question: asked })}
          </p>
          {waiting && (
            <p role="status" className="text-sm text-gray-400">
              {t("thinking")}
            </p>
          )}
          <div
            data-testid="assistant-answer"
            aria-live="polite"
            aria-busy={isStreaming}
            className="whitespace-pre-wrap break-words text-sm text-gray-100"
          >
            {text}
          </div>
          {stopped && !isStreaming && (
            <p role="status" className={`${INFO} mt-3`}>
              {t("stopped")}
            </p>
          )}
          {truncated && (
            <p role="status" className={`${INFO} mt-3`}>
              {truncated.notice}
            </p>
          )}
          {refusal && (
            <div className="mt-3">
              <RefusalNotice
                refusal={refusal}
                onRetry={() => startStream(asked)}
                offerAppeal={refusedAt === "request"}
              />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
