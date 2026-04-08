import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import ErrorBoundary from "@/components/ErrorBoundary";
import { AuthContextProvider } from "@/platform/auth/context";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Platform Foundation",
  description: "Production-grade application platform — GenAI-native",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <ErrorBoundary>
          <AuthContextProvider>{children}</AuthContextProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
