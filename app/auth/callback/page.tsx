/**
 * app/auth/callback/page.tsx — Where the identity provider returns the browser (TASK-101)
 *
 * Register <origin>/auth/callback on the identity provider's app client.
 */

import type { Metadata } from "next";
import SsoCallbackClient from "./SsoCallbackClient";

export const metadata: Metadata = {
  robots: { index: false },
};

export default function SsoCallbackRoute() {
  return <SsoCallbackClient />;
}
