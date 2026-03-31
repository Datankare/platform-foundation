"use client";

import React, { useState } from "react";

const inputClass =
  "bg-[#0a0f1e] border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500";
const btnPrimary =
  "bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition";

interface PasswordPolicyPanelProps {
  minLength: number;
  rotationDays: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSpecial: boolean;
  passwordHistoryCount: number;
  onSave: (policy: {
    minLength: number;
    rotationDays: number;
    requireUppercase: boolean;
    requireLowercase: boolean;
    requireNumber: boolean;
    requireSpecial: boolean;
    passwordHistoryCount: number;
  }) => void;
  isSaving: boolean;
}

export function PasswordPolicyPanel({
  minLength: initMinLength,
  rotationDays: initRotation,
  requireUppercase: initUpper,
  requireLowercase: initLower,
  requireNumber: initNum,
  requireSpecial: initSpecial,
  passwordHistoryCount: initHistory,
  onSave,
  isSaving,
}: PasswordPolicyPanelProps) {
  const [minLength, setMinLength] = useState(initMinLength);
  const [rotation, setRotation] = useState(initRotation);
  const [upper, setUpper] = useState(initUpper);
  const [lower, setLower] = useState(initLower);
  const [num, setNum] = useState(initNum);
  const [special, setSpecial] = useState(initSpecial);
  const [history, setHistory] = useState(initHistory);

  return (
    <div>
      <h2 className="text-xl font-bold text-white mb-6">Password Policy</h2>
      <div className="bg-[#111827] rounded-xl border border-gray-800 p-6 max-w-lg space-y-4">
        <div>
          <label htmlFor="pp-minlen" className="block text-sm text-gray-400 mb-1">
            Minimum length
          </label>
          <input
            id="pp-minlen"
            type="number"
            min={6}
            value={minLength}
            onChange={(e) => setMinLength(Number(e.target.value))}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="pp-rotation" className="block text-sm text-gray-400 mb-1">
            Password rotation (days, 0 = disabled)
          </label>
          <input
            id="pp-rotation"
            type="number"
            min={0}
            value={rotation}
            onChange={(e) => setRotation(Number(e.target.value))}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="pp-history" className="block text-sm text-gray-400 mb-1">
            Password history count
          </label>
          <input
            id="pp-history"
            type="number"
            min={0}
            value={history}
            onChange={(e) => setHistory(Number(e.target.value))}
            className={inputClass}
          />
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={upper}
              onChange={(e) => setUpper(e.target.checked)}
              className="rounded border-gray-700"
            />
            <span className="text-sm text-gray-400">Require uppercase</span>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={lower}
              onChange={(e) => setLower(e.target.checked)}
              className="rounded border-gray-700"
            />
            <span className="text-sm text-gray-400">Require lowercase</span>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={num}
              onChange={(e) => setNum(e.target.checked)}
              className="rounded border-gray-700"
            />
            <span className="text-sm text-gray-400">Require number</span>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={special}
              onChange={(e) => setSpecial(e.target.checked)}
              className="rounded border-gray-700"
            />
            <span className="text-sm text-gray-400">Require special character</span>
          </label>
        </div>
        <button
          onClick={() =>
            onSave({
              minLength,
              rotationDays: rotation,
              requireUppercase: upper,
              requireLowercase: lower,
              requireNumber: num,
              requireSpecial: special,
              passwordHistoryCount: history,
            })
          }
          disabled={isSaving}
          className={btnPrimary}
        >
          {isSaving ? "Saving..." : "Save Policy"}
        </button>
      </div>
    </div>
  );
}
