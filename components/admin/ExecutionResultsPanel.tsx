"use client";

import React from "react";

interface ExecutionResult {
  tool: string;
  success: boolean;
  result?: string;
  error?: string;
}

interface ExecutionResultsPanelProps {
  results: ExecutionResult[];
  onDismiss: () => void;
}

/**
 * Shows execution results in a clean table format.
 * No raw JSON — structured display with status indicators.
 */
export default function ExecutionResultsPanel({
  results,
  onDismiss,
}: ExecutionResultsPanelProps) {
  const allSuccess = results.every((r) => r.success);

  return (
    <div
      className={`rounded-xl border p-5 mb-6 ${
        allSuccess
          ? "bg-green-900/10 border-green-800"
          : "bg-amber-900/10 border-amber-800"
      }`}
    >
      <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">
        Execution Results
      </p>
      <div className="bg-[#0a0f1e] rounded-lg overflow-hidden">
        <table className="w-full text-sm text-left border-collapse">
          <thead>
            <tr>
              <th className="text-xs text-gray-500 uppercase py-2 px-3 border-b border-gray-800 w-8">
                Status
              </th>
              <th className="text-xs text-gray-500 uppercase py-2 px-3 border-b border-gray-800 w-40">
                Action
              </th>
              <th className="text-xs text-gray-500 uppercase py-2 px-3 border-b border-gray-800">
                Result
              </th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={i}>
                <td className="py-2 px-3 border-b border-gray-800/50">
                  <span className={r.success ? "text-green-400" : "text-red-400"}>
                    {r.success ? "✓" : "✕"}
                  </span>
                </td>
                <td className="py-2 px-3 border-b border-gray-800/50">
                  <code
                    className={`text-xs px-1.5 py-0.5 rounded ${
                      r.success
                        ? "bg-green-900/20 text-green-400"
                        : "bg-red-900/20 text-red-400"
                    }`}
                  >
                    {r.tool}
                  </code>
                </td>
                <td className="py-2 px-3 border-b border-gray-800/50 text-sm text-gray-300">
                  {r.success ? r.result : r.error}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        onClick={onDismiss}
        className="mt-3 text-sm text-gray-400 hover:text-gray-300 transition"
      >
        Dismiss
      </button>
    </div>
  );
}
