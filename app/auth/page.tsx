/**
 * app/auth/page.tsx — Authentication route
 *
 * Renders the AuthPage component (login/register/forgot/MFA/verify).
 * Unauthenticated users land here. Authenticated users are redirected to /.
 */

import type { Metadata } from "next";
import AuthPageClient from "./AuthPageClient";
import { renderMessage } from "@/platform/errors/messages";

export const metadata: Metadata = {
  title: renderMessage("screens.app.meta.auth_title"),
  description: renderMessage("screens.app.meta.auth_description"),
};

export default function AuthRoute() {
  return <AuthPageClient />;
}
