/**
 * @jest-environment node
 */
/**
 * __tests__/sso-offered.test.ts — the sign-in page is rendered with the single sign-on providers
 * this deployment offers (TASK-222, SF-app-047): the ones the SSO start route lets begin
 * (isFeatureAvailable), in the screen's order, and none when none is configured.
 */
import { offeredSsoProviders } from "@/platform/auth/sso-offered";
import { isFeatureAvailable } from "@/platform/features";
import { SSO_PROVIDER_IDS } from "@/platform/auth/sso";
import AuthRoute from "@/app/auth/page";

const CONFIGURED = {
  AUTH_PROVIDER: "cognito",
  NEXT_PUBLIC_COGNITO_USER_POOL_ID: "us-east-1_fixture",
  NEXT_PUBLIC_COGNITO_CLIENT_ID: "fixture-client",
  NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN: "auth.example.test",
};

function withEnv<T>(vars: Record<string, string>, run: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return run();
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}

describe("offeredSsoProviders", () => {
  it("offers none when none is configured", () => {
    expect(offeredSsoProviders()).toEqual([]);
  });

  it("offers exactly the providers the start route lets begin", () => {
    withEnv({ ...CONFIGURED, SSO_PROVIDERS: "microsoft,google" }, () => {
      const offered = offeredSsoProviders();
      expect(offered).toEqual(
        SSO_PROVIDER_IDS.filter((p) => isFeatureAvailable(`sso_${p}`))
      );
      expect(offered).toEqual(["google", "microsoft"]);
    });
  });

  it("the sign-in page is rendered with them, so the buttons are in its first paint", () => {
    withEnv({ ...CONFIGURED, SSO_PROVIDERS: "google" }, () => {
      const page = AuthRoute() as { props: { ssoProviders?: string[] } };
      expect(page.props.ssoProviders).toEqual(["google"]);
    });
    expect(
      (AuthRoute() as { props: { ssoProviders?: string[] } }).props.ssoProviders
    ).toEqual([]);
  });
});
