import React from "react";
import type { ProfileVisibility } from "@/platform/auth/profile";

const VISIBILITY_OPTIONS: { value: ProfileVisibility; label: string }[] = [
  { value: "private", label: "Private" },
  { value: "friends", label: "Friends" },
  { value: "public", label: "Public" },
];

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
      <label className="text-xs text-gray-500 w-16">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ProfileVisibility)}
        className="bg-[#0a0f1e] border border-gray-700 rounded-lg px-2 py-1 text-xs text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        {VISIBILITY_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
