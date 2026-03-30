"use client";

import React from "react";

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
  title = "PLAYFORM",
  subtitle = "Platform Foundation",
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
              <span className="text-blue-400">FORM</span>
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

      <p className="text-xs text-gray-500 mt-8">
        Foundation as Fabric · Continuous Confidence
      </p>
    </div>
  );
}
