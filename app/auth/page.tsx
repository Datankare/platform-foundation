/**
 * app/auth/page.tsx — Authentication route
 *
 * Renders the AuthPage component (login/register/forgot/MFA/verify).
 * Unauthenticated users land here. Authenticated users are redirected to /.
 */

import type { Metadata } from "next";
import AuthPageClient from "./AuthPageClient";

export const metadata: Metadata = {
  title: "Sign In — Platform Foundation",
  description: "Sign in or create an account",
};

export default function AuthRoute() {
  return <AuthPageClient />;
}
