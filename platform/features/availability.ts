/**
 * platform/features/availability.ts — Optional features declare what they need (ADR-050 D3, TASK-104)
 *
 * A feature whose settings are absent is not offered: the UI asks `GET /api/features` and hides
 * it, and its route refuses with `feature.not_configured` instead of attempting and failing with
 * "please try again". Availability is computed from the same settings the providers read.
 *
 * The core declares its own features here (SSO). A product feature — music identification,
 * audio upload, speech input, Teams — is declared by its module (ADR-054 D4) and joins the list
 * when the app registers the module; a feature of a module the app does not run is not offered.
 *
 * `preview` marks a feature that is offered but not yet real (it shows sample data); the UI
 * labels it as a preview.
 *
 * Only booleans leave the server — never a setting's value.
 *
 * @module platform/features
 */

import {
  getAuthProviderSetting,
  getCognitoSettings,
  getSsoProviders,
  type EnvSource,
  type SsoProviderId,
} from "@/platform/providers/environment-contract";
import { composeValues } from "@/platform/modules/compose";
import type { FeatureRequirement, FeatureStatus } from "@/platform/modules/types";

export type { FeatureRequirement, FeatureStatus } from "@/platform/modules/types";
export type { EnvSource } from "@/platform/providers/environment-contract";

/** The core's own optional features. */
export type CoreFeatureId = "sso_google" | "sso_apple" | "sso_microsoft";

/** A feature id: the core's, or one a registered module declares. */
export type FeatureId = CoreFeatureId | (string & {});

/**
 * SSO through the Cognito hosted sign-in (TASK-101): Cognito auth with its pool and client, the
 * hosted sign-in domain, and the provider named in SSO_PROVIDERS. Whether the identity provider
 * is enabled on the Cognito app client is not visible from here — SSO_PROVIDERS is the
 * deployment's declaration that it is.
 */
function ssoReady(env: EnvSource, provider: SsoProviderId): FeatureStatus {
  const cognito = getCognitoSettings(env);
  return {
    available:
      getAuthProviderSetting(env) === "cognito" &&
      cognito.userPoolId !== "" &&
      cognito.clientId !== "" &&
      cognito.hostedUiDomain !== undefined &&
      getSsoProviders(env).includes(provider),
  };
}

const SSO_NEEDS =
  "AUTH_PROVIDER=cognito with its pool and client ids, NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN, and the provider in SSO_PROVIDERS (enabled on the Cognito app client)";

/** What each of the core's optional features needs. */
export const CORE_FEATURE_REQUIREMENTS: readonly FeatureRequirement[] = Object.freeze([
  { id: "sso_google", needs: SSO_NEEDS, check: (env) => ssoReady(env, "google") },
  { id: "sso_apple", needs: SSO_NEEDS, check: (env) => ssoReady(env, "apple") },
  { id: "sso_microsoft", needs: SSO_NEEDS, check: (env) => ssoReady(env, "microsoft") },
]);

/** The core's features then each registered module's, each id once (refused otherwise). */
export function listFeatureRequirements(): readonly FeatureRequirement[] {
  return composeValues(
    "feature",
    CORE_FEATURE_REQUIREMENTS,
    (f) => f.id,
    (m) => m.features
  );
}

/** What a feature needs, or undefined for a feature neither the core nor a module declares. */
export function getFeatureRequirement(id: FeatureId): FeatureRequirement | undefined {
  return listFeatureRequirements().find((f) => f.id === id);
}

/** Every registered feature's status, keyed by feature id — the body of GET /api/features. */
export function featureAvailability(
  env: EnvSource = process.env
): Record<string, FeatureStatus> {
  const out: Record<string, FeatureStatus> = {};
  for (const feature of listFeatureRequirements()) {
    out[feature.id] = feature.check(env);
  }
  return out;
}

/**
 * Whether a feature is offered. A feature no registered module declares is not (fail closed):
 * its route refuses with feature.not_configured, as for a module whose settings are absent.
 */
export function isFeatureAvailable(id: FeatureId, env: EnvSource = process.env): boolean {
  return getFeatureRequirement(id)?.check(env).available ?? false;
}
