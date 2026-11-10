"use client";

import React from "react";
import type { UserProfile, ProfileUpdate } from "@/platform/auth/profile";
import { useProfileForm } from "@/hooks/useProfileForm";
import VisibilitySelect from "@/components/auth/VisibilitySelect";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.auth.profile.${key}`, values);

interface ProfilePageProps {
  onLoadProfile: () => Promise<UserProfile | null>;
  onUpdateProfile: (
    update: ProfileUpdate
  ) => Promise<{ success: boolean; error?: string }>;
  onSignOut: () => void;
}

/**
 * User profile page — view and edit own profile with visibility controls.
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
        <p className="text-gray-400">{t("loading_profile")}</p>
      </div>
    );
  }

  if (!form.profile) {
    return (
      <div className="min-h-screen bg-[#0a0f1e] flex items-center justify-center">
        <p className="text-gray-400">{t("profile_not_found")}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0f1e] p-6">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold text-white">{t("your_profile")}</h1>
          <button
            onClick={onSignOut}
            className="text-sm text-gray-400 hover:text-gray-300 transition"
          >
            {t("sign_out")}
          </button>
        </div>

        {/* Profile Card */}
        <div className="bg-[#111827] rounded-2xl p-6 border border-gray-800 space-y-6">
          {/* Email (read-only) */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">{t("email")}</label>
            <p className="text-white text-sm">{form.profile.email || "—"}</p>
            <div className="flex items-center gap-2 mt-1">
              <span
                className={`text-xs px-2 py-0.5 rounded ${
                  form.profile.emailVerified
                    ? "bg-green-900/30 text-green-400"
                    : "bg-amber-900/30 text-amber-400"
                }`}
              >
                {form.profile.emailVerified ? t("verified") : t("unverified")}
              </span>
              {form.profile.mfaEnabled && (
                <span className="text-xs px-2 py-0.5 rounded bg-blue-900/30 text-blue-400">
                  {t("mfa_enabled")}
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
              {t("display_name")}
            </label>
            <input
              id="profile-display-name"
              type="text"
              value={form.displayName}
              onChange={(e) => form.setDisplayName(e.target.value)}
              placeholder={t("choose_a_display_name")}
              className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <VisibilitySelect
              value={form.displayNameVis}
              onChange={form.setDisplayNameVis}
              label={t("visible")}
            />
          </div>

          {/* Language */}
          <div>
            <label
              htmlFor="profile-language"
              className="block text-sm text-gray-400 mb-1"
            >
              {t("language")}
            </label>
            <select
              id="profile-language"
              value={form.language}
              onChange={(e) => form.setLanguage(e.target.value)}
              className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="en">{t("english")}</option>
              <option value="es">{t("spanish")}</option>
              <option value="fr">{t("french")}</option>
              <option value="de">{t("german")}</option>
              <option value="ja">{t("japanese")}</option>
              <option value="ko">{t("korean")}</option>
              <option value="zh">{t("chinese")}</option>
              <option value="hi">{t("hindi")}</option>
              <option value="ar">{t("arabic")}</option>
              <option value="pt">{t("portuguese")}</option>
            </select>
            <VisibilitySelect
              value={form.languageVis}
              onChange={form.setLanguageVis}
              label={t("visible")}
            />
          </div>

          {/* Timezone */}
          <div>
            <label
              htmlFor="profile-timezone"
              className="block text-sm text-gray-400 mb-1"
            >
              {t("timezone")}
            </label>
            <input
              id="profile-timezone"
              type="text"
              value={form.timezone}
              onChange={(e) => form.setTimezone(e.target.value)}
              placeholder={t("utc")}
              className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <VisibilitySelect
              value={form.timezoneVis}
              onChange={form.setTimezoneVis}
              label={t("visible")}
            />
          </div>

          {/* Avatar Visibility */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">
              {t("avatar_visibility")}
            </label>
            <VisibilitySelect
              value={form.avatarVis}
              onChange={form.setAvatarVis}
              label={t("visible")}
            />
          </div>

          {/* Overall Profile Visibility */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">
              {t("profile_visibility")}
            </label>
            <VisibilitySelect
              value={form.profileVis}
              onChange={form.setProfileVis}
              label={t("visible")}
            />
            <p className="text-xs text-gray-400 mt-1">
              {t("controls_whether_your_profile_appears")}
            </p>
          </div>

          {/* Communication Preferences */}
          <div className="border-t border-gray-800 pt-4">
            <h3 className="text-sm font-medium text-gray-300 mb-3">
              {t("communication")}
            </h3>
            <label className="flex items-center gap-3 mb-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.emailOptIn}
                onChange={(e) => form.setEmailOptIn(e.target.checked)}
                className="rounded border-gray-700"
              />
              <span className="text-sm text-gray-400">{t("email_notifications")}</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={form.pushEnabled}
                onChange={(e) => form.setPushEnabled(e.target.checked)}
                className="rounded border-gray-700"
              />
              <span className="text-sm text-gray-400">{t("push_notifications")}</span>
            </label>
          </div>

          {/* Account Info (read-only) */}
          <div className="border-t border-gray-800 pt-4">
            <h3 className="text-sm font-medium text-gray-300 mb-2">{t("account")}</h3>
            <p className="text-xs text-gray-400">
              {t("member_since", {
                date: new Date(form.profile.createdAt).toLocaleDateString(),
              })}
            </p>
            {form.profile.lastLoginAt && (
              <p className="text-xs text-gray-400">
                {t("last_login", {
                  date: new Date(form.profile.lastLoginAt).toLocaleDateString(),
                })}
              </p>
            )}
          </div>

          {/* Error / Success */}
          {form.error && (
            <div
              role="alert"
              aria-live="assertive"
              className="bg-red-900/30 border border-red-700 text-red-300 rounded-xl px-4 py-3 text-sm"
            >
              {form.error}
            </div>
          )}
          {form.success && (
            <div className="bg-green-900/30 border border-green-700 text-green-300 rounded-xl px-4 py-3 text-sm">
              {t("profile_updated_successfully")}
            </div>
          )}

          {/* Save Button */}
          <button
            onClick={form.handleSave}
            disabled={form.isSaving}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl text-sm transition disabled:opacity-40"
          >
            {form.isSaving ? t("saving") : t("save_changes")}
          </button>
        </div>
      </div>
    </div>
  );
}
