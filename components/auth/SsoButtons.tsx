"use client";

import React, { useState } from "react";
import type { SsoProvider } from "@/platform/auth/types";

interface SsoButtonsProps {
  onSsoClick: (provider: SsoProvider) => Promise<void>;
  disabled?: boolean;
  enabledProviders?: SsoProvider[];
}

const SSO_PROVIDERS: {
  id: SsoProvider;
  label: string;
  icon: string;
  bgColor: string;
  hoverColor: string;
}[] = [
  {
    id: "google",
    label: "Continue with Google",
    icon: "G",
    bgColor: "bg-white",
    hoverColor: "hover:bg-gray-100",
  },
  {
    id: "apple",
    label: "Continue with Apple",
    icon: "\uF8FF",
    bgColor: "bg-black",
    hoverColor: "hover:bg-gray-900",
  },
  {
    id: "microsoft",
    label: "Continue with Microsoft",
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
  enabledProviders = ["google", "apple", "microsoft"],
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
          {loadingProvider === provider.id ? "Connecting..." : provider.label}
        </button>
      ))}
    </div>
  );
}
