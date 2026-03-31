"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  PlayerProfile,
  ProfileUpdate,
  ProfileVisibility,
} from "@/platform/auth/profile";

export interface ProfileFormState {
  profile: PlayerProfile | null;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  success: boolean;

  // Editable fields
  displayName: string;
  language: string;
  timezone: string;
  emailOptIn: boolean;
  pushEnabled: boolean;

  // Visibility controls
  profileVis: ProfileVisibility;
  displayNameVis: ProfileVisibility;
  avatarVis: ProfileVisibility;
  languageVis: ProfileVisibility;
  timezoneVis: ProfileVisibility;
}

export interface ProfileFormActions {
  setDisplayName: (v: string) => void;
  setLanguage: (v: string) => void;
  setTimezone: (v: string) => void;
  setEmailOptIn: (v: boolean) => void;
  setPushEnabled: (v: boolean) => void;
  setProfileVis: (v: ProfileVisibility) => void;
  setDisplayNameVis: (v: ProfileVisibility) => void;
  setAvatarVis: (v: ProfileVisibility) => void;
  setLanguageVis: (v: ProfileVisibility) => void;
  setTimezoneVis: (v: ProfileVisibility) => void;
  handleSave: () => Promise<void>;
}

/**
 * Hook that manages profile form state and save logic.
 * Extracted from ProfilePage for SRP compliance (< 300 lines).
 */
export function useProfileForm(
  onLoadProfile: () => Promise<PlayerProfile | null>,
  onUpdateProfile: (
    update: ProfileUpdate
  ) => Promise<{ success: boolean; error?: string }>
): ProfileFormState & ProfileFormActions {
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const [displayName, setDisplayName] = useState("");
  const [language, setLanguage] = useState("en");
  const [timezone, setTimezone] = useState("UTC");
  const [emailOptIn, setEmailOptIn] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);

  const [profileVis, setProfileVis] = useState<ProfileVisibility>("private");
  const [displayNameVis, setDisplayNameVis] =
    useState<ProfileVisibility>("private");
  const [avatarVis, setAvatarVis] = useState<ProfileVisibility>("private");
  const [languageVis, setLanguageVis] =
    useState<ProfileVisibility>("private");
  const [timezoneVis, setTimezoneVis] =
    useState<ProfileVisibility>("private");

  const loadProfile = useCallback(async () => {
    setIsLoading(true);
    const data = await onLoadProfile();
    if (data) {
      setProfile(data);
      setDisplayName(data.displayName || "");
      setLanguage(data.languagePreference);
      setTimezone(data.timezone);
      setEmailOptIn(data.emailOptIn);
      setPushEnabled(data.pushNotificationsEnabled);
      setProfileVis(data.profileVisibility);
      setDisplayNameVis(data.displayNameVisibility);
      setAvatarVis(data.avatarVisibility);
      setLanguageVis(data.languageVisibility);
      setTimezoneVis(data.timezoneVisibility);
    }
    setIsLoading(false);
  }, [onLoadProfile]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  const handleSave = async () => {
    setError(null);
    setSuccess(false);
    setIsSaving(true);

    const update: ProfileUpdate = {
      displayName,
      languagePreference: language,
      timezone,
      emailOptIn,
      pushNotificationsEnabled: pushEnabled,
      profileVisibility: profileVis,
      displayNameVisibility: displayNameVis,
      avatarVisibility: avatarVis,
      languageVisibility: languageVis,
      timezoneVisibility: timezoneVis,
    };

    const result = await onUpdateProfile(update);
    if (result.success) {
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } else {
      setError(result.error || "Update failed");
    }
    setIsSaving(false);
  };

  return {
    profile,
    isLoading,
    isSaving,
    error,
    success,
    displayName,
    language,
    timezone,
    emailOptIn,
    pushEnabled,
    profileVis,
    displayNameVis,
    avatarVis,
    languageVis,
    timezoneVis,
    setDisplayName,
    setLanguage,
    setTimezone,
    setEmailOptIn,
    setPushEnabled,
    setProfileVis,
    setDisplayNameVis,
    setAvatarVis,
    setLanguageVis,
    setTimezoneVis,
    handleSave,
  };
}
