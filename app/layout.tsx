import type { Metadata } from "next";
import { headers } from "next/headers";
import { Inter } from "next/font/google";
import "./globals.css";
import ErrorBoundary from "@/components/ErrorBoundary";
import { AuthContextProvider } from "@/platform/auth/context";
import SessionIdleWarning from "@/components/auth/SessionIdleWarning";
import { renderMessage } from "@/platform/errors/messages";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: renderMessage("screens.app.meta.site_title"),
  description: renderMessage("screens.app.meta.site_description"),
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the request makes every page render per request, so each gets the nonce of its own
  // Content Security Policy (proxy.ts, audit G-10); Next.js puts it on the scripts it renders.
  await headers();
  return (
    <html lang="en">
      <body className={inter.className}>
        <ErrorBoundary>
          <AuthContextProvider>
            {children}
            <SessionIdleWarning />
          </AuthContextProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
