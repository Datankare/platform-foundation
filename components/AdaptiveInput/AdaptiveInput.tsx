/**
 * components/AdaptiveInput/AdaptiveInput.tsx — Adaptive input component
 *
 * Generic input component driven entirely by the agent output contract.
 * Supports light and dark themes via explicit `variant` prop — does NOT
 * depend on OS prefers-color-scheme.
 *
 * L18: Every color value is in the THEMES map. Visual outcome for every
 * state is documented in the theme definition.
 *
 * @module components/AdaptiveInput
 */

"use client";

import React, { useCallback, useRef } from "react";
import type { InputMode, ConductorOutput, ActionItem } from "@/platform/input/types";

// ── Theme ─────────────────────────────────────────────────────────────

type Variant = "light" | "dark";

interface ThemeClasses {
  pillInactive: string;
  intentText: string;
  intentConfidence: string;
  listeningText: string;
  border: string;
  textarea: string;
  micDefault: string;
  micRecording: string;
  uploadBtn: string;
  counterNormal: string;
  actionSecondary: string;
  processingText: string;
}

/**
 * All color decisions in one place. No dark: variants, no OS dependency.
 * Consumer picks "light" or "dark" based on their background.
 */
const THEMES: Record<Variant, ThemeClasses> = {
  light: {
    pillInactive: "bg-gray-100 text-gray-600 hover:bg-gray-200",
    intentText: "text-gray-400",
    intentConfidence: "text-gray-300",
    listeningText: "text-gray-500",
    border: "border-gray-200",
    textarea: "text-gray-900 placeholder-gray-400",
    micDefault: "text-gray-400 hover:text-gray-600 hover:bg-gray-100",
    micRecording: "bg-red-100 text-red-600",
    uploadBtn: "text-gray-400 hover:text-gray-600 hover:bg-gray-100",
    counterNormal: "text-gray-400",
    actionSecondary: "bg-gray-100 text-gray-700 hover:bg-gray-200",
    processingText: "text-gray-500",
  },
  dark: {
    pillInactive: "bg-gray-700/50 text-gray-300 hover:bg-gray-600",
    intentText: "text-gray-500",
    intentConfidence: "text-gray-600",
    listeningText: "text-gray-400",
    border: "border-gray-600",
    textarea: "text-white placeholder-gray-500",
    micDefault: "text-gray-500 hover:text-gray-300 hover:bg-gray-700",
    micRecording: "bg-red-900/40 text-red-400",
    uploadBtn: "text-gray-500 hover:text-gray-300 hover:bg-gray-700",
    counterNormal: "text-gray-500",
    actionSecondary: "bg-gray-700 text-gray-300 hover:bg-gray-600",
    processingText: "text-gray-400",
  },
};

// ── Props ─────────────────────────────────────────────────────────────

export interface AdaptiveInputProps {
  readonly output: ConductorOutput;
  readonly text: string;
  readonly maxChars?: number;
  readonly isRecording?: boolean;
  readonly isProcessing?: boolean;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /** Theme variant — "light" for light backgrounds, "dark" for dark (default: "light") */
  readonly variant?: Variant;
  readonly onTextChange: (text: string) => void;
  readonly onModeSelect: (mode: InputMode) => void;
  readonly onAction: (actionId: string) => void;
  readonly onMicToggle: () => void;
  readonly onUpload: () => void;
  readonly languageBar?: React.ReactNode;
  readonly audioFeedback?: React.ReactNode;
}

// ── Mode Configuration ────────────────────────────────────────────────

const MODE_CONFIG: Record<
  InputMode,
  { label: string; ariaLabel: string; title: string }
> = {
  text: {
    label: "Text",
    ariaLabel: "Text input mode",
    title: "Type or paste text to process",
  },
  speech: {
    label: "Speech",
    ariaLabel: "Speech input mode",
    title: "Use your mic to speak — transcribed in real time",
  },
  music: {
    label: "Music",
    ariaLabel: "Music identification mode",
    title: "Hold your mic near a song to identify it",
  },
  file: {
    label: "File",
    ariaLabel: "File upload mode",
    title: "Upload audio, PDF, or text files to extract content",
  },
};

/** Pill order: text → speech → file → music */
const MODES: InputMode[] = ["text", "speech", "file", "music"];

// ── Component ─────────────────────────────────────────────────────────

export default function AdaptiveInput({
  output,
  text,
  maxChars = 2500,
  isRecording = false,
  isProcessing = false,
  placeholder = "Type, speak, or drop a file...",
  disabled = false,
  variant = "light",
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
  const t = THEMES[variant];

  const handleUploadClick = useCallback(() => {
    onUpload();
    fileInputRef.current?.click();
  }, [onUpload]);

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onTextChange(e.target.value);
    },
    [onTextChange]
  );

  const intentDisplay = output.intent?.displayLabel ?? null;
  const intentConfidence = output.intent?.confidence ?? 0;
  const actions = output.intent?.actions ?? [];

  return (
    <div className="w-full max-w-2xl mx-auto" data-testid="adaptive-input">
      {/* Mode Pills + Intent Indicator */}
      <div
        className="flex items-center gap-2 mb-3"
        role="group"
        aria-label="Input mode selection"
      >
        {MODES.map((mode) => {
          const isActive = output.mode === mode;
          const config = MODE_CONFIG[mode];
          return (
            <button
              key={mode}
              type="button"
              onClick={() => onModeSelect(mode)}
              aria-pressed={isActive}
              aria-label={config.ariaLabel}
              title={config.title}
              disabled={disabled}
              className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                isActive ? "bg-blue-600 text-white" : t.pillInactive
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
            {intentConfidence > 0 && (
              <span
                className={`ml-1 ${t.intentConfidence}`}
                data-testid="intent-confidence"
              >
                {Math.round(intentConfidence * 100)}%
              </span>
            )}
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
          <span>Listening...</span>
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
          aria-label="Input text"
          data-testid="input-textarea"
        />

        {/* Inline Toolbar (mic + upload) */}
        <div className="absolute bottom-2 right-2 flex gap-1">
          <button
            type="button"
            onClick={onMicToggle}
            disabled={disabled}
            aria-label={isRecording ? "Stop recording" : "Start recording"}
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
            aria-label="Upload file"
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

      {/* Character Counter */}
      <div
        className="mt-1 text-right text-xs"
        role="status"
        aria-label={`${charCount} of ${maxChars} characters used`}
        data-testid="char-counter"
      >
        <span className={isOverLimit ? "text-red-500" : t.counterNormal}>
          {charCount}/{maxChars}
        </span>
      </div>

      {/* Language Bar Slot */}
      {languageBar}

      {/* Action Buttons */}
      {actions.length > 0 && (
        <div
          className="flex gap-2 mt-3"
          role="group"
          aria-label="Available actions"
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
                  ? "bg-blue-600 text-white hover:bg-blue-700"
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
          Processing...
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
