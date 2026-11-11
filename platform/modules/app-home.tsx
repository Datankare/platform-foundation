/**
 * platform/modules/app-home.tsx — What the app's home page shows (CONSUMER SEAM, ADR-054)
 *
 * app/HomeClient.tsx renders the signed-in shell (identity, sign-out) and this component inside
 * it, so the core page never imports a module's UI. A consumer owns this file — the sync excludes
 * it — and renders its own home. Platform Foundation shows the translation demo.
 *
 * A composition root, with ./app-modules.ts: the only core files allowed to import a module
 * (eslint.config.mjs, import/no-restricted-paths).
 */

"use client";

import SpikeApp from "@/components/SpikeApp";
import { useAuth } from "@/platform/auth/context";

export default function AppHome() {
  // A guest's rejection offers no appeal: a guest has no account (TASK-210).
  const { isGuest } = useAuth();
  return <SpikeApp isGuest={isGuest} />;
}
