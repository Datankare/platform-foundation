"use client";

import React, { useState, useRef, useEffect } from "react";

interface AdminPromptBarProps {
  panel: string;
  onPlanReceived: (plan: {
    message: string;
    actions: { tool: string; input: Record<string, unknown> }[];
  }) => void;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * AI-powered command bar for admin operations.
 * Sends natural language to the AI orchestrator, receives a plan.
 */
export default function AdminPromptBar({
  panel,
  onPlanReceived,
  disabled = false,
  placeholder = "What would you like to do?",
}: AdminPromptBarProps) {
  const [prompt, setPrompt] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [panel]);

  const handleSubmit = async () => {
    if (!prompt.trim() || isThinking) return;

    setIsThinking(true);
    setHistory((prev) => [prompt, ...prev.slice(0, 19)]);

    try {
      const res = await fetch("/api/admin/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim(), panel }),
      });

      if (!res.ok) {
        const err = await res.json();
        onPlanReceived({
          message: err.error || "Failed to process command",
          actions: [],
        });
        return;
      }

      const { plan } = await res.json();
      onPlanReceived(plan);
    } catch {
      /* justified */
      // Network failure — shown to user via onPlanReceived
      onPlanReceived({
        message: "Failed to connect to AI service",
        actions: [],
      });
    } finally {
      setIsThinking(false);
      setPrompt("");
      setHistoryIndex(-1);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
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
    <div className="mb-6">
      <div className="flex gap-2">
        <div className="flex-1 relative">
          <input
            ref={inputRef}
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled || isThinking}
            placeholder={isThinking ? "Thinking..." : placeholder}
            className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50 pr-10"
          />
          {isThinking && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>
        <button
          onClick={handleSubmit}
          disabled={!prompt.trim() || isThinking || disabled}
          className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-5 py-3 rounded-xl transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Run
        </button>
      </div>
      <p className="text-xs text-gray-600 mt-1.5 ml-1">
        Try: &quot;Create a moderator role with can_play and can_view_audit&quot; or
        &quot;Show all roles&quot;
      </p>
    </div>
  );
}
