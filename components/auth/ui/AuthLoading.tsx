"use client";

/**
 * components/auth/ui/AuthLoading.tsx — the sign-in page's wait, on the sign-in page's own dark
 * page (TASK-222, SF-app-003 for sign-in)
 *
 * While the sign-in page reads whether someone is already signed in, and while single sign-on
 * completes, the browser showed a grey line on the default white page between two dark ones,
 * not announced. This is the one wait both use: the dark page, its main landmark, and the line
 * as a status a screen reader reads.
 *
 * @module components/auth/ui
 */

import React from "react";

export function AuthLoading({ text }: { readonly text: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0f1e] px-4">
      <p role="status" className="text-gray-300">
        {text}
      </p>
    </main>
  );
}
