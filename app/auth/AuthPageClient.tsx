"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/platform/auth/context";
import { hasAuthProvider } from "@/platform/auth/config";
import AuthPage from "@/components/auth/AuthPage";

export default function AuthPageClient() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();
  const [providerReady, setProviderReady] = useState(false);

  useEffect(() => {
    async function init() {
      if (!hasAuthProvider()) {
        const { initAuth } = await import("@/platform/auth/auth-init");
        initAuth();
      }
      setProviderReady(true);
    }
    init();
  }, []);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace("/");
    }
  }, [isAuthenticated, isLoading, router]);

  if (isLoading || !providerReady) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (isAuthenticated) return null;

  return <AuthPage />;
}
