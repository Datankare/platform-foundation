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

const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300";

/**
 * Each provider's mark, drawn (TASK-222, SF-app-047): the Apple mark was the private-use
 * character U+F8FF, which only Apple's own fonts draw — everywhere else a box. Decorative: the
 * button's text names the provider.
 */
function ProviderMark({ id }: { readonly id: SsoProvider }) {
  const common = {
    width: 18,
    height: 18,
    "aria-hidden": true,
    focusable: false,
    "data-provider-mark": id,
  } as const;
  if (id === "google")
    return (
      <svg {...common} viewBox="0 0 48 48">
        <path
          fill="#EA4335"
          d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.7 17.8 9.5 24 9.5z"
        />
        <path
          fill="#4285F4"
          d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"
        />
        <path
          fill="#FBBC05"
          d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"
        />
        <path
          fill="#34A853"
          d="M24 48c6.5 0 11.9-2.1 15.8-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.4 2.3-6.2 0-11.5-4.2-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"
        />
      </svg>
    );
  if (id === "apple")
    return (
      <svg {...common} viewBox="0 0 24 24" fill="currentColor">
        <path d="M16.37 12.6c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.72-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.88-.76-1.48.02-2.85.86-3.61 2.19-1.54 2.67-.39 6.62 1.11 8.79.73 1.06 1.6 2.25 2.74 2.21 1.1-.04 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.08 2.65-2.14.84-1.23 1.18-2.42 1.2-2.48-.03-.01-2.3-.88-2.32-3.5zM14.19 6.13c.6-.73 1.01-1.75.9-2.76-.87.04-1.92.58-2.54 1.31-.56.65-1.05 1.68-.92 2.67.97.08 1.96-.49 2.56-1.22z" />
      </svg>
    );
  return (
    <svg {...common} viewBox="0 0 24 24">
      <rect x="1" y="1" width="10.5" height="10.5" fill="#F25022" />
      <rect x="12.5" y="1" width="10.5" height="10.5" fill="#7FBA00" />
      <rect x="1" y="12.5" width="10.5" height="10.5" fill="#00A4EF" />
      <rect x="12.5" y="12.5" width="10.5" height="10.5" fill="#FFB900" />
    </svg>
  );
}

/** Each provider's look; its button text is the catalog's (screens.auth.sso.continue_with_*). */
const SSO_PROVIDERS: { id: SsoProvider; className: string }[] = [
  { id: "google", className: "bg-white hover:bg-gray-100 text-gray-800" },
  {
    id: "apple",
    className: "bg-black hover:bg-gray-900 text-white border border-gray-700",
  },
  { id: "microsoft", className: "bg-[#2F2F2F] hover:bg-[#3F3F3F] text-white" },
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
          type="button"
          key={provider.id}
          onClick={() => handleClick(provider.id)}
          disabled={disabled || loadingProvider !== null}
          className={`w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${provider.className} disabled:opacity-40 disabled:cursor-not-allowed ${FOCUS}`}
        >
          <ProviderMark id={provider.id} />
          {loadingProvider === provider.id
            ? t("connecting")
            : t(`continue_with_${provider.id}`)}
        </button>
      ))}
    </div>
  );
}
