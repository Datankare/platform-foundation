"use client";

import React from "react";
import type { PlayerProfile, ProfileUpdate } from "@/platform/auth/profile";
import { useProfileForm } from "@/hooks/useProfileForm";
import VisibilitySelect from "@/components/auth/VisibilitySelect";

interface ProfilePageProps {
  onLoadProfile: () => Promise<PlayerProfile | null>;
  onUpdateProfile: (
    update: ProfileUpdate
  ) => Promise<{ success: boolean; error?: string }>;
  onSignOut: () => void;
}

/**
 * Player profile page — view and edit own profile with visibility controls.
 * Decomposed: state in useProfileForm hook, visibility in VisibilitySelect.
 */
export default function ProfilePage({
  onLoadProfile,
  onUpdateProfile,
  onSignOut,
}: ProfilePageProps) {
  const form = useProfileForm(onLoadProfile, onUpdateProfile);

  if (form.isLoading) {
    return (
      <div className="min-h-screen bg-[#0a0f1e] flex items-center justify-center">
        <p className="text-gray-400">Loading profile...</p>
      </div>
    );
  }

  if (!form.profile) {
    return (
      <div className="min-h-screen bg-[#0a0f1e] flex items-center justify-center">
        <p className="text-gray-400">Profile not found.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0f1e] p-6">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold text-white">Your Profile</h1>
          <button
            onClick={onSignOut}
            className="text-sm text-gray-400 hover:text-gray-300 transition"
          >
            Sign Out
          </button>
        </div>

        {/* Profile Card */}
        <div className="bg-[#111827] rounded-2xl p-6 border border-gray-800 space-y-6">
          {/* Email (read-only) */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">Email</label>
            <p className="text-white text-sm">{form.profile.email || "—"}</p>
            <div className="flex items-center gap-2 mt-1">
              <span
                className={`text-xs px-2 py-0.5 rounded ${
                  form.profile.emailVerified
                    ? "bg-green-900/30 text-green-400"
                    : "bg-amber-900/30 text-amber-400"
                }`}
              >
                {form.profile.emailVerified ? "Verified" : "Unverified"}
              </span>
              {form.profile.mfaEnabled && (
                <span className="text-xs px-2 py-0.5 rounded bg-blue-900/30 text-blue-400">
                  MFA Enabled
                </span>
              )}
            </div>
          </div>

          {/* Display Name */}
          <div>
            <label
              htmlFor="profile-display-name"
              className="block text-sm text-gray-400 mb-1"
            >
              Display Name
            </label>
            <input
              id="profile-display-name"
              type="text"
              value={form.displayName}
              onChange={(e) => form.setDisplayName(e.target.value)}
              placeholder="Choose a display name"
              className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <VisibilitySelect
              value={form.displayNameVis}
              onChange={form.setDisplayNameVis}
              label="Visible:"
            />
          </div>

          {/* Language */}
          <div>
            <label
              htmlFor="profile-language"
              className="block text-sm text-gray-400 mb-1"
            >
              Language
            </label>
            <select
              id="profile-language"
              value={form.language}
              onChange={(e) => form.setLanguage(e.target.value)}
              className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="en">English</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="de">German</option>
              <option value="ja">Japanese</option>
              <option value="ko">Korean</option>
              <option value="zh">Chinese</option>
              <option value="hi">Hindi</option>
              <option value="ar">Arabic</option>
              <option value="pt">Portuguese</option>
            </select>
            <VisibilitySelect
              value={form.languageVis}
              onChange={form.setLanguageVis}
              label="Visible:"
            />
          </div>

          {/* Timezone */}
          <div>
            <label
              htmlFor="profile-timezone"
              className="block text-sm text-gray-400 mb-1"
            >
              Timezone
            </label>
            <input
              id="profile-timezone"
              type="text"
              value={form.timezone}
              onChange={(e) => form.setTimezone(e.target.value)}
              placeholder="UTC"
              className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <VisibilitySelect
              value={form.timezoneVis}
              onChange={form.setTimezoneVis}
              label="Visible:"
            />
          </div>

          {/* Avatar Visibility */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">Avatar Visibility</label>
            <VisibilitySelect
              value={form.avatarVis}
              onChange={form.setAvatarVis}
              label="Visible:"
            />
          </div>

          {/* Overall Profile Visibility */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">Profile Visibility</label>
            <VisibilitySelect
              value={form.profileVis}
              onChange={form.setProfileVis}
              label="Visible:"
            />
            <p className="text-xs text-gray-600 mt-1">
              Controls whether your profile appears in search results.
            </p>
          </div>

          {/* Communication Preferences */}
          <div className="border-t border-gray-800 pt-4">
            <h3 className="text-sm font-medium text-gray-300 mb-3">Communication</h3>
            <label className="flex items-center gap-3 mb-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.emailOptIn}
                onChange={(e) => form.setEmailOptIn(e.target.checked)}
                className="rounded border-gray-700"
              />
              <span className="text-sm text-gray-400">Email notifications</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={form.pushEnabled}
                onChange={(e) => form.setPushEnabled(e.target.checked)}
                className="rounded border-gray-700"
              />
              <span className="text-sm text-gray-400">Push notifications</span>
            </label>
          </div>

          {/* Account Info (read-only) */}
          <div className="border-t border-gray-800 pt-4">
            <h3 className="text-sm font-medium text-gray-300 mb-2">Account</h3>
            <p className="text-xs text-gray-500">
              Member since {new Date(form.profile.createdAt).toLocaleDateString()}
            </p>
            {form.profile.lastLoginAt && (
              <p className="text-xs text-gray-500">
                Last login {new Date(form.profile.lastLoginAt).toLocaleDateString()}
              </p>
            )}
          </div>

          {/* Error / Success */}
          {form.error && (
            <div
              role="alert"
              className="bg-red-900/30 border border-red-700 text-red-300 rounded-xl px-4 py-3 text-sm"
            >
              {form.error}
            </div>
          )}
          {form.success && (
            <div className="bg-green-900/30 border border-green-700 text-green-300 rounded-xl px-4 py-3 text-sm">
              Profile updated successfully.
            </div>
          )}

          {/* Save Button */}
          <button
            onClick={form.handleSave}
            disabled={form.isSaving}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl text-sm transition disabled:opacity-40"
          >
            {form.isSaving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
