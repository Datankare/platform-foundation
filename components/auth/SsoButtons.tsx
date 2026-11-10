"use client";

import React, { useState } from "react";
import type { SsoProvider } from "@/platform/auth/types";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.auth.sso.${key}`, values);

interface SsoButtonsProps {
  onSsoClick: (provider: SsoProvider) => Promise<void>;
  disabled?: boolean;
  enabledProviders?: SsoProvider[];
}

/** Each provider's look; its button text is the catalog's (screens.auth.sso.continue_with_*). */
const SSO_PROVIDERS: {
  id: SsoProvider;
  icon: string;
  bgColor: string;
  hoverColor: string;
}[] = [
  {
    id: "google",
    icon: "G",
    bgColor: "bg-white",
    hoverColor: "hover:bg-gray-100",
  },
  {
    id: "apple",
    icon: "\uF8FF",
    bgColor: "bg-black",
    hoverColor: "hover:bg-gray-900",
  },
  {
    id: "microsoft",
    icon: "\u2756",
    bgColor: "bg-[#2F2F2F]",
    hoverColor: "hover:bg-[#3F3F3F]",
  },
];

/**
 * SSO sign-in buttons for Google, Apple, and Microsoft.
 * Provider-agnostic — calls onSsoClick with the provider ID.
 * The parent component handles the actual SSO flow via AuthProvider.
 */
export default function SsoButtons({
  onSsoClick,
  disabled = false,
  enabledProviders = [],
}: SsoButtonsProps) {
  const [loadingProvider, setLoadingProvider] = useState<SsoProvider | null>(null);

  const handleClick = async (provider: SsoProvider) => {
    setLoadingProvider(provider);
    try {
      await onSsoClick(provider);
    } finally {
      setLoadingProvider(null);
    }
  };

  const visibleProviders = SSO_PROVIDERS.filter((p) => enabledProviders.includes(p.id));

  return (
    <div className="flex flex-col gap-3">
      {visibleProviders.map((provider) => (
        <button
          key={provider.id}
          onClick={() => handleClick(provider.id)}
          disabled={disabled || loadingProvider !== null}
          className={`w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
            provider.id === "google"
              ? `${provider.bgColor} ${provider.hoverColor} text-gray-800`
              : `${provider.bgColor} ${provider.hoverColor} text-white`
          } disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          <span className="text-lg" aria-hidden="true">
            {provider.icon}
          </span>
          {loadingProvider === provider.id
            ? t("connecting")
            : t(`continue_with_${provider.id}`)}
        </button>
      ))}
    </div>
  );
}
