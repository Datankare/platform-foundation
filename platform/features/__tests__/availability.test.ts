/**
 * ADR-050 D3 / TASK-104 — optional features are offered only when configured.
 *
 * The core's own features (SSO) and the mechanism: a module's features join the list when it is
 * registered, an undeclared feature is never offered, and a module cannot redeclare a core
 * feature (ADR-054 D4). The product features are tested with their modules
 * (__tests__/modules/*.module.test.ts).
 */
import { NextRequest } from "next/server";
import {
  CORE_FEATURE_REQUIREMENTS,
  featureAvailability,
  getFeatureRequirement,
  isFeatureAvailable,
  listFeatureRequirements,
} from "@/platform/features/availability";
import { requireFeature } from "@/platform/features/guard";
import { GET } from "@/app/api/features/route";
import {
  definePlatformModule,
  getModules,
  registerModules,
  resetModuleRegistry,
  type PlatformModule,
} from "@/platform/modules";

/** A module with one feature that reads a setting holding a secret. */
const FIXTURE = definePlatformModule({
  id: "fixture-features",
  features: [
    {
      id: "fixture_feature",
      needs: "FIXTURE_SECRET set (a secret: its value never leaves the server)",
      check: (env) => ({ available: (env.FIXTURE_SECRET ?? "") !== "" }),
    },
  ],
});

let appModules: readonly PlatformModule[];
beforeAll(() => {
  appModules = getModules();
});
function runWith(modules: readonly PlatformModule[]): void {
  resetModuleRegistry();
  registerModules(modules);
}
afterEach(() => runWith(appModules));

describe("featureAvailability", () => {
  it("an app with no modules offers only the core's features, none on a bare deployment", () => {
    runWith([]);
    expect(featureAvailability({})).toEqual({
      sso_google: { available: false },
      sso_apple: { available: false },
      sso_microsoft: { available: false },
    });
  });

  it("a registered module's features follow the core's, computed from the settings", () => {
    runWith([FIXTURE]);
    expect(listFeatureRequirements().map((f) => f.id)).toEqual([
      ...CORE_FEATURE_REQUIREMENTS.map((f) => f.id),
      "fixture_feature",
    ]);
    expect(featureAvailability({ FIXTURE_SECRET: "x" }).fixture_feature).toEqual({
      available: true,
    });
    expect(isFeatureAvailable("fixture_feature", {})).toBe(false);
  });

  it("a feature no registered module declares is not offered (fail closed)", () => {
    runWith([]);
    expect(getFeatureRequirement("fixture_feature")).toBeUndefined();
    expect(isFeatureAvailable("fixture_feature", { FIXTURE_SECRET: "x" })).toBe(false);
  });

  it("a module may not redeclare a core feature", () => {
    runWith([
      definePlatformModule({
        id: "sso-impostor",
        features: [
          {
            id: "sso_google",
            needs: "always offered",
            check: () => ({ available: true }),
          },
        ],
      }),
    ]);
    expect(() => listFeatureRequirements()).toThrow(
      /module "sso-impostor": feature "sso_google" is already the core's/
    );
  });

  it("every feature says what it needs", () => {
    for (const r of listFeatureRequirements()) expect(r.needs.length).toBeGreaterThan(10);
  });

  it("reads process.env by default", () => {
    runWith([]);
    expect(typeof isFeatureAvailable("sso_google")).toBe("boolean");
    expect(Object.keys(featureAvailability())).toHaveLength(3);
  });
});

describe("SSO providers (TASK-101)", () => {
  const COGNITO = {
    AUTH_PROVIDER: "cognito",
    NEXT_PUBLIC_COGNITO_USER_POOL_ID: "us-east-1_AbC123",
    NEXT_PUBLIC_COGNITO_CLIENT_ID: "client123",
    NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN:
      "us-east-1abc123.auth.us-east-1.amazoncognito.com",
  };

  it("offers exactly the listed providers when Cognito and the hosted domain are set", () => {
    const env = { ...COGNITO, SSO_PROVIDERS: "google" };
    expect(isFeatureAvailable("sso_google", env)).toBe(true);
    expect(isFeatureAvailable("sso_apple", env)).toBe(false);
    expect(isFeatureAvailable("sso_microsoft", env)).toBe(false);
  });

  it("offers none without the hosted domain, the list, Cognito, or its ids", () => {
    const { NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN: _d, ...noDomain } = COGNITO;
    expect(
      isFeatureAvailable("sso_google", { ...noDomain, SSO_PROVIDERS: "google" })
    ).toBe(false);
    expect(isFeatureAvailable("sso_google", COGNITO)).toBe(false);
    expect(
      isFeatureAvailable("sso_google", {
        ...COGNITO,
        AUTH_PROVIDER: "mock",
        SSO_PROVIDERS: "google",
      })
    ).toBe(false);
    expect(
      isFeatureAvailable("sso_google", {
        ...COGNITO,
        NEXT_PUBLIC_COGNITO_CLIENT_ID: "",
        SSO_PROVIDERS: "google",
      })
    ).toBe(false);
  });

  it("offers none for a malformed list", () => {
    expect(
      isFeatureAvailable("sso_google", { ...COGNITO, SSO_PROVIDERS: "google, apple" })
    ).toBe(false);
    expect(
      isFeatureAvailable("sso_google", { ...COGNITO, SSO_PROVIDERS: "Google" })
    ).toBe(false);
  });
});

describe("requireFeature", () => {
  const orig = { ...process.env };
  afterEach(() => {
    process.env = { ...orig };
  });

  it("refuses an unconfigured feature with feature.not_configured (501)", async () => {
    runWith([FIXTURE]);
    delete process.env.FIXTURE_SECRET;
    const res = requireFeature("fixture_feature");
    expect(res?.status).toBe(501);
    const body = await res?.json();
    expect(body.code).toBe("feature.not_configured");
    expect(body.params).toEqual({ feature: "fixture_feature" });
  });

  it("refuses a feature of a module the app does not run", async () => {
    runWith([]);
    process.env.FIXTURE_SECRET = "x";
    const res = requireFeature("fixture_feature");
    expect(res?.status).toBe(501);
    expect((await res?.json()).code).toBe("feature.not_configured");
  });

  it("lets a configured feature through", () => {
    runWith([FIXTURE]);
    process.env.FIXTURE_SECRET = "x";
    expect(requireFeature("fixture_feature")).toBeNull();
  });
});

describe("GET /api/features", () => {
  it("returns booleans only, never a setting's value", async () => {
    runWith([FIXTURE]);
    const orig = { ...process.env };
    process.env = { ...orig, FIXTURE_SECRET: "secret-fixture-value" };
    try {
      const res = await GET(new NextRequest("http://localhost/api/features"));
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
      const text = await res.text();
      expect(text).not.toMatch(/secret-fixture-value/);
      expect(JSON.parse(text).features.fixture_feature).toEqual({ available: true });
    } finally {
      process.env = { ...orig };
    }
  });
});
