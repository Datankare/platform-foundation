import React from "react";
import type { ProfileVisibility } from "@/platform/auth/profile";
import { renderMessage } from "@/platform/errors/messages";

/** The choices, in order; each one's text is the catalog's (screens.auth.visibility.*). */
const VISIBILITY_OPTIONS: readonly ProfileVisibility[] = ["private", "friends", "public"];

interface VisibilitySelectProps {
  value: ProfileVisibility;
  onChange: (v: ProfileVisibility) => void;
  label: string;
}

/**
 * Per-field visibility control — Private / Friends / Public.
 * Used in ProfilePage for each sensitive field.
 */
export default function VisibilitySelect({
  value,
  onChange,
  label,
}: VisibilitySelectProps) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-gray-400 w-16">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ProfileVisibility)}
        className="bg-[#0a0f1e] border border-gray-700 rounded-lg px-2 py-1 text-xs text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        {VISIBILITY_OPTIONS.map((v) => (
          <option key={v} value={v}>
            {renderMessage(`screens.auth.visibility.${v}`)}
          </option>
        ))}
      </select>
    </div>
  );
}
