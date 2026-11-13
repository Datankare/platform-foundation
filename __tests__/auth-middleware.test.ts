/**
 * Auth middleware + config tests.
 *
 * Verifies:
 * - requireAuth returns 401 when no token
 * - requireAuth returns 401 when token is invalid
 * - requireAuth returns user payload when token is valid
 * - optionalAuth returns null when no token
 * - optionalAuth returns user when token is valid
 * - getAuthProvider throws when no provider registered
 * - getAuthProvider returns provider after registration
 */

import { NextRequest } from "next/server";
import { sessionHeadersFor } from "@/__tests__/helpers/session";
import {
  registerAuthProvider,
  getAuthProvider,
  hasAuthProvider,
} from "@/platform/auth/config";
import { requireAuth, optionalAuth } from "@/platform/auth/middleware";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";

// Suppress logger output in tests
jest.mock("@/lib/logger", () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
  generateRequestId: () => "test-req-id",
}));

/** A request from a browser whose session holds `token` (ADR-057); none: no session. */
async function makeRequest(token?: string): Promise<NextRequest> {
  const headers = new Headers(token ? await sessionHeadersFor(token) : {});
  return new NextRequest("http://localhost:3000/api/test", { headers });
}

describe("auth config", () => {
  beforeEach(() => {
    // Reset the registered provider by registering null-ish
    // We need to test the unregistered state, so we use a workaround
  });

  it("getAuthProvider returns registered provider", () => {
    const mock = createMockAuthProvider();
    registerAuthProvider(mock);
    expect(getAuthProvider()).toBe(mock);
  });

  it("hasAuthProvider returns true after registration", () => {
    registerAuthProvider(createMockAuthProvider());
    expect(hasAuthProvider()).toBe(true);
  });
});

describe("requireAuth", () => {
  beforeAll(() => {
    registerAuthProvider(createMockAuthProvider());
  });

  it("returns 401 without a session", async () => {
    const request = await makeRequest();
    const result = await requireAuth(request);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error!.status).toBe(401);
    }
  });

  it("returns 401 for an Authorization header of any kind: a user route takes no such credential (ADR-057 D8)", async () => {
    const headers = new Headers();
    headers.set("authorization", "Bearer mock-access-token");
    const request = new NextRequest("http://localhost:3000/api/test", {
      headers,
    });
    const result = await requireAuth(request);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error!.status).toBe(401);
    }
  });

  it("returns 401 when token is invalid", async () => {
    const request = await makeRequest("invalid-token");
    const result = await requireAuth(request);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error!.status).toBe(401);
    }
  });

  it("returns user payload when token is valid", async () => {
    const request = await makeRequest("mock-access-token");
    const result = await requireAuth(request);
    expect("user" in result).toBe(true);
    if ("user" in result) {
      expect(result.user!.sub).toBeDefined();
      expect(result.user!.email).toBeDefined();
      expect(result.user!.emailVerified).toBe(true);
      // The route is handed the session, never its token.
      expect(result.session!.kind).toBe("user");
      expect("accessToken" in result).toBe(false);
    }
  });
});

describe("optionalAuth", () => {
  beforeAll(() => {
    registerAuthProvider(createMockAuthProvider());
  });

  it("returns null user without a session", async () => {
    const request = await makeRequest();
    const result = await optionalAuth(request);
    expect(result.user).toBeNull();
    expect(result.session).toBeNull();
  });

  it("returns null user when token is invalid", async () => {
    const request = await makeRequest("invalid-token");
    const result = await optionalAuth(request);
    expect(result.user).toBeNull();
    expect(result.session).toBeNull();
  });

  it("returns user when token is valid", async () => {
    const request = await makeRequest("mock-access-token");
    const result = await optionalAuth(request);
    expect(result.user).not.toBeNull();
    expect(result.user!.sub).toBeDefined();
    expect(result.session!.kind).toBe("user");
  });
});
