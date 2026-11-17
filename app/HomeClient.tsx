/**
 * app/HomeClient.tsx — the home page, in the app's frame
 *
 * The app's one header (components/app/ui/AppShell.tsx: who is signed in, Home, Assistant
 * (TASK-211), Your account (TASK-210), Sign out, or Sign in for a guest) above the app's home —
 * the consumer seam platform/modules/app-home.tsx, so this core page imports no module's UI
 * (ADR-054). Until TASK-224 this page drew its own white bar above the dark app (SF-app-001).
 * A signed-out visitor goes to sign-in and comes back here (the shell, E-113).
 */

"use client";

import AppHome from "@/platform/modules/app-home";
import { AppShell } from "@/components/app/ui/AppShell";

export default function HomeClient() {
  return (
    <AppShell wide>
      <AppHome />
    </AppShell>
  );
}
