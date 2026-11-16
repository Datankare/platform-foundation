/**
 * platform/auth/sso-offered.ts — the single sign-on providers this deployment offers, for the
 * sign-in page's server render (TASK-222, SF-app-047)
 *
 * The sign-in screen asked GET /api/features for them after it had drawn itself, then added a
 * button per provider above the email form — the form moved down under a person about to type.
 * The page is rendered per request (app/layout.tsx reads the request for its nonce), so it now
 * reads the same availability the SSO start route checks (platform/features, ADR-050 D3) while
 * it renders, and the buttons are there in the first paint: nothing moves.
 *
 * Server only: platform/features reads the deployment's settings.
 *
 * @module platform/auth
 */
import { isFeatureAvailable } from "@/platform/features";
import { SSO_PROVIDER_IDS } from "./sso";
import type { SsoProvider } from "./types";

/** The providers a person may sign in with here, in the order the screen shows them. */
export function offeredSsoProviders(): SsoProvider[] {
  return SSO_PROVIDER_IDS.filter((p) => isFeatureAvailable(`sso_${p}`));
}
