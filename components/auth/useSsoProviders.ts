"use client";

/**
 * The SSO providers this deployment offers (ADR-050 D3, TASK-101), from GET /api/features.
 * Until it answers — or if it cannot — none are offered; email sign-in still works.
 */

import { useEffect, useState } from "react";
import type { SsoProvider } from "@/platform/auth/types";
import { SSO_PROVIDER_IDS } from "@/platform/auth/sso";

interface FeaturesBody {
  features?: Record<string, { available?: boolean }>;
}

export function useSsoProviders(): SsoProvider[] {
  const [providers, setProviders] = useState<SsoProvider[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/features")
      .then((res) => (res.ok ? (res.json() as Promise<FeaturesBody>) : null))
      .then((data) => {
        if (cancelled || !data?.features) return;
        const features = data.features;
        setProviders(
          SSO_PROVIDER_IDS.filter((p) => features[`sso_${p}`]?.available === true)
        );
      })
      .catch(() => {
        /* justified */
        // No feature list — offer no SSO.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return providers;
}
