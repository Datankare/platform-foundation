/**
 * app/auth/page.tsx — Authentication route
 *
 * Renders the AuthPage component (login/register/forgot/MFA/verify).
 * Unauthenticated users land here. Authenticated users go on to the page they asked for
 * (`?redirect=`), or to /.
 *
 * The single sign-on providers offered are read here, on the server, so their buttons are in the
 * first paint and nothing moves under the email form (platform/auth/sso-offered.ts, SF-app-047).
 */

import type { Metadata } from "next";
import AuthPageClient from "./AuthPageClient";
import { renderMessage } from "@/platform/errors/messages";
import { offeredSsoProviders } from "@/platform/auth/sso-offered";

export const metadata: Metadata = {
  title: renderMessage("screens.app.meta.auth_title"),
  description: renderMessage("screens.app.meta.auth_description"),
};

export default function AuthRoute() {
  return <AuthPageClient ssoProviders={offeredSsoProviders()} />;
}
