"use client";

import React from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.auth.layout.${key}`, values);

interface AuthLayoutProps {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
}

/**
 * Shared layout for all auth pages (login, register, forgot password, MFA).
 * Provides consistent branding and centered card layout.
 * Override title/subtitle for each page.
 */
export default function AuthLayout({
  children,
  title = t("brand_title"),
  subtitle = t("brand_subtitle"),
}: AuthLayoutProps) {
  return (
    <div className="min-h-screen bg-[#0a0f1e] flex flex-col items-center justify-center px-4">
      <div className="mb-8 text-center">
        <h1 className="text-4xl font-black tracking-tight text-white">
          {title.includes("PLAY") ? (
            <>
              <span className="text-white">
                {title.substring(0, title.indexOf("FORM"))}
              </span>
              <span className="text-blue-400">{t("form")}</span>
            </>
          ) : (
            <span className="text-white">{title}</span>
          )}
        </h1>
        {subtitle && (
          <p className="text-xs tracking-[0.2em] text-gray-400 mt-2 uppercase">
            {subtitle}
          </p>
        )}
      </div>

      <div className="w-full max-w-md bg-[#111827] rounded-2xl p-8 border border-gray-800 shadow-xl">
        {children}
      </div>

      <p className="text-xs text-gray-400 mt-8">
        {t("foundation_as_fabric_continuous_confidence")}
      </p>
    </div>
  );
}
