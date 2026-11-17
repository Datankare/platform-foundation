/**
 * components/AdaptiveInput/AdaptiveInput.tsx — Adaptive input component
 *
 * Generic input component driven entirely by the agent output contract, in the app's one dark
 * look — it does NOT depend on the device's light or dark setting.
 *
 * L18: Every color value is in the THEMES map. Visual outcome for every
 * state is documented in the theme definition.
 *
 * @module components/AdaptiveInput
 */

"use client";

import React, { useCallback, useRef } from "react";
import type { InputMode, ConductorOutput, ActionItem } from "@/platform/input/types";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const msg = (key: string, values?: MessageValues) =>
  renderMessage(`screens.adaptive_input.${key}`, values);

// ── Theme ─────────────────────────────────────────────────────────────

/**
 * Every colour in one place: the app's one dark look (TASK-224 — the light variant, which no
 * screen used, put light boxes in a dark app's reach; the app is always dark, SCREEN-FINDINGS
 * P12). No `dark:` variants, no dependence on the device's setting. Every text colour here meets
 * 4.5:1 on the app's panels (gray-400 is the quietest).
 */
const THEME = {
  pillInactive: "bg-gray-700/50 text-gray-200 hover:bg-gray-600",
  intentText: "text-gray-400",
  listeningText: "text-gray-300",
  border: "border-gray-600",
  textarea: "text-white placeholder-gray-400",
  micDefault: "text-gray-300 hover:text-white hover:bg-gray-700",
  micRecording: "bg-red-900/40 text-red-300",
  uploadBtn: "text-gray-300 hover:text-white hover:bg-gray-700",
  counterNormal: "text-gray-400",
  actionSecondary: "bg-gray-700 text-gray-200 hover:bg-gray-600",
  processingText: "text-gray-300",
} as const;

// ── Props ─────────────────────────────────────────────────────────────

export interface AdaptiveInputProps {
  readonly output: ConductorOutput;
  readonly text: string;
  readonly maxChars?: number;
  readonly isRecording?: boolean;
  readonly isProcessing?: boolean;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly onTextChange: (text: string) => void;
  readonly onModeSelect: (mode: InputMode) => void;
  readonly onAction: (actionId: string) => void;
  readonly onMicToggle: () => void;
  readonly onUpload: () => void;
  readonly languageBar?: React.ReactNode;
  readonly audioFeedback?: React.ReactNode;
}

// ── Mode Configuration ────────────────────────────────────────────────

/** A mode's pill text, from the catalog (screens.adaptive_input.mode_<mode>_*). */
const modeConfig = (mode: InputMode) => ({
  label: msg(`mode_${mode}_label`),
  title: msg(`mode_${mode}_title`),
});

/**
 * Whether the count is announced: near the limit or over it, never on every keystroke
 * (SF-app-018 — a live region read on each key talked over the typing). Near is the last tenth,
 * and at least the last ten characters.
 */
export function countAnnounced(count: number, max: number): boolean {
  return count > max || max - count <= Math.max(10, Math.ceil(max / 10));
}

/** Pill order: text → speech → file → music */
const MODES: InputMode[] = ["text", "speech", "file", "music"];

// ── Component ─────────────────────────────────────────────────────────

export default function AdaptiveInput({
  output,
  text,
  maxChars = 2500,
  isRecording = false,
  isProcessing = false,
  placeholder = msg("default_placeholder"),
  disabled = false,
  onTextChange,
  onModeSelect,
  onAction,
  onMicToggle,
  onUpload,
  languageBar,
  audioFeedback,
}: AdaptiveInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const charCount = text.length;
  const isOverLimit = charCount > maxChars;
  const t = THEME;

  const handleUploadClick = useCallback(() => {
    onUpload();
  }, [onUpload]);

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onTextChange(e.target.value);
    },
    [onTextChange]
  );

  const intentDisplay = output.intent?.displayLabel ?? null;
  const actions = output.intent?.actions ?? [];

  return (
    <div className="w-full max-w-2xl mx-auto" data-testid="adaptive-input">
      {/* Mode Pills + Intent Indicator */}
      <div
        className="flex flex-wrap items-center gap-2 mb-3"
        role="group"
        aria-label={msg("input_mode_selection")}
      >
        {MODES.map((mode) => {
          const isActive = output.mode === mode;
          const config = modeConfig(mode);
          return (
            <button
              key={mode}
              type="button"
              onClick={() => onModeSelect(mode)}
              aria-pressed={isActive}
              title={config.title}
              disabled={disabled}
              className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                isActive ? "bg-blue-700 text-white" : t.pillInactive
              } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
              data-testid={`mode-pill-${mode}`}
            >
              {config.label}
            </button>
          );
        })}
        {intentDisplay && (
          <span
            className={`ml-auto text-xs ${t.intentText} select-none`}
            aria-live="polite"
            data-testid="intent-bar"
          >
            {intentDisplay}
          </span>
        )}
      </div>

      {/* Audio Feedback Slot */}
      {audioFeedback}

      {/* Listening Badge */}
      {isRecording && (
        <div
          className={`mb-2 flex items-center gap-2 text-sm ${t.listeningText}`}
          aria-live="polite"
          data-testid="listening-badge"
        >
          <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          <span>{msg("listening")}</span>
        </div>
      )}

      {/* Input Area */}
      <div
        className={`relative border rounded-lg ${t.border} focus-within:border-blue-400 transition-colors`}
      >
        <textarea
          value={text}
          onChange={handleTextChange}
          placeholder={placeholder}
          disabled={disabled || isProcessing}
          maxLength={maxChars + 100}
          rows={4}
          className={`w-full px-4 py-3 pr-20 resize-none rounded-lg bg-transparent ${t.textarea} focus:outline-none disabled:opacity-50`}
          aria-label={msg("input_text")}
          data-testid="input-textarea"
        />

        {/* Inline Toolbar (mic + upload) */}
        <div className="absolute bottom-2 right-2 flex gap-1">
          <button
            type="button"
            onClick={onMicToggle}
            disabled={disabled}
            aria-label={isRecording ? msg("stop_recording") : msg("start_recording")}
            aria-pressed={isRecording}
            className={`p-2 rounded-md transition-colors ${
              isRecording ? t.micRecording : t.micDefault
            } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
            data-testid="mic-button"
          >
            <MicIcon />
          </button>
          <button
            type="button"
            onClick={handleUploadClick}
            disabled={disabled}
            aria-label={msg("upload_file")}
            className={`p-2 rounded-md ${t.uploadBtn} transition-colors ${
              disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
            }`}
            data-testid="upload-button"
          >
            <UploadIcon />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
            data-testid="file-input"
          />
        </div>
      </div>

      {/* Character Counter: shown always, announced only near or over the limit (SF-app-018) */}
      <div className="mt-1 text-right text-xs" data-testid="char-counter">
        <span
          aria-hidden="true"
          className={isOverLimit ? "text-red-400" : t.counterNormal}
        >
          {charCount}/{maxChars}
        </span>
        <span role="status" className="sr-only" data-testid="char-announcement">
          {countAnnounced(charCount, maxChars)
            ? msg("characters_used", { count: String(charCount), max: String(maxChars) })
            : ""}
        </span>
      </div>

      {/* Language Bar Slot */}
      {languageBar}

      {/* Action Buttons */}
      {actions.length > 0 && (
        <div
          className="flex gap-2 mt-3"
          role="group"
          aria-label={msg("available_actions")}
          data-testid="action-buttons"
        >
          {actions.map((action: ActionItem) => (
            <button
              key={action.id}
              type="button"
              onClick={() => onAction(action.id)}
              disabled={disabled || isProcessing || action.disabled}
              aria-label={action.label}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                action.primary
                  ? "bg-blue-700 text-white hover:bg-blue-800"
                  : t.actionSecondary
              } ${
                disabled || isProcessing || action.disabled
                  ? "opacity-50 cursor-not-allowed"
                  : "cursor-pointer"
              }`}
              data-testid={`action-${action.id}`}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}

      {/* Processing Indicator */}
      {isProcessing && (
        <div
          className={`mt-2 text-sm ${t.processingText}`}
          aria-live="polite"
          aria-busy="true"
          data-testid="processing-indicator"
        >
          {msg("processing")}
        </div>
      )}
    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────

function MicIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M8 1a2 2 0 0 0-2 2v4a2 2 0 1 0 4 0V3a2 2 0 0 0-2-2Z" fill="currentColor" />
      <path
        d="M4 6.5a.5.5 0 0 0-1 0 5 5 0 0 0 4.5 4.975V13.5H6a.5.5 0 0 0 0 1h4a.5.5 0 0 0 0-1H8.5v-2.025A5 5 0 0 0 13 6.5a.5.5 0 0 0-1 0 4 4 0 1 1-8 0Z"
        fill="currentColor"
      />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M8 10.5a.5.5 0 0 1-.5-.5V3.207L5.354 5.354a.5.5 0 1 1-.708-.708l3-3a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1-.708.708L8.5 3.207V10a.5.5 0 0 1-.5.5Z"
        fill="currentColor"
      />
      <path
        d="M2 13.5a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5Z"
        fill="currentColor"
      />
    </svg>
  );
}
