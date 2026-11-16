"use client";

import React from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.auth.layout.${key}`, values);

interface AuthLayoutProps {
  children: React.ReactNode;
}

/**
 * Shared layout for all auth pages (login, register, forgot password, MFA).
 * Provides consistent branding and centered card layout.
 *
 * The brand is two catalogue parts, the second in the accent colour (it was cut out of one
 * string by searching it for "PLAY" and "FORM" — SF-app-051), read as one word. The page's
 * content is its `main` landmark. No internal tagline: "Platform Foundation" and "Foundation as
 * Fabric · Continuous Confidence" named the code base, not anything a person signs in to (E-110).
 */
export default function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <main className="min-h-screen bg-[#0a0f1e] flex flex-col items-center justify-center px-4 py-10">
      <div className="mb-8 text-center">
        <h1 className="text-4xl font-black tracking-tight text-white">
          <span className="text-white">{t("brand_first")}</span>
          <span className="text-blue-400">{t("brand_second")}</span>
        </h1>
      </div>

      <div className="w-full max-w-md bg-[#111827] rounded-2xl p-6 sm:p-8 border border-gray-800 shadow-xl">
        {children}
      </div>
    </main>
  );
}
