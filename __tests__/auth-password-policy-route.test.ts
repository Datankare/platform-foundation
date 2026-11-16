/**
 * @jest-environment node
 */
/**
 * __tests__/auth-password-policy-route.test.ts — GET /api/auth/password-policy (TASK-222, E-112)
 *
 * Public, read by the sign-up, reset and new-password screens before anyone is signed in.
 *
 * hostile:rate-limit: the route is rate limited before it reads anything.
 * hostile:store-down: an unreadable store answers the strict built-in policy — the one the
 *   password-setting routes then enforce — never a looser one, never a 500.
 * hostile:disclosure: only the rules a person choosing a password needs: never the rotation or
 *   history settings, never whose policy it is.
 * hostile:tenant: the policy is read in the request's tenant, as the refusal reads it.
 */
// hostile:role n/a: the route is public — no role is asked for, and every caller gets the same rules
// hostile:self n/a: the route names no person, so there is no own or other account to tell apart
// hostile:id-spelling n/a: the route takes no id, parameter or body — only the request's tenant
import { NextRequest } from "next/server";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "test-req-id",
}));

const mockLimited: { next: Response | null } = { next: null };
jest.mock("@/platform/rate-limit", () => {
  const actual = jest.requireActual("@/platform/rate-limit");
  return {
    ...actual,
    enforceRateLimit: jest.fn(async () => mockLimited.next),
  };
});

const mockTx: {
  fail: boolean;
  rows: Record<string, unknown>[];
  tenants: (string | undefined)[];
} = {
  fail: false,
  rows: [],
  tenants: [],
};
jest.mock("@/platform/data", () => {
  const actual = jest.requireActual("@/platform/data");
  const { peekTenant } = jest.requireActual("@/platform/tenancy/context");
  return {
    ...actual,
    withTenantTx: async (fn: (tx: unknown) => unknown) => {
      mockTx.tenants.push(peekTenant()?.tenantId);
      if (mockTx.fail) throw new Error("connection refused");
      return fn({
        query: async () => ({ rows: mockTx.rows, rowCount: mockTx.rows.length }),
      });
    },
  };
});

import { GET } from "@/app/api/auth/password-policy/route";
import { enforceRateLimit, DEFAULT_RULES } from "@/platform/rate-limit";
import { DEFAULT_POLICY } from "@/platform/auth/password-rules";
import { apiError } from "@/platform/errors";

const req = () =>
  new NextRequest("http://localhost/api/auth/password-policy", { method: "GET" });

beforeEach(() => {
  mockLimited.next = null;
  mockTx.fail = false;
  mockTx.rows = [];
  mockTx.tenants = [];
  jest.clearAllMocks();
});

const BUILT_IN = {
  minLength: DEFAULT_POLICY.minLength,
  requireUppercase: DEFAULT_POLICY.requireUppercase,
  requireLowercase: DEFAULT_POLICY.requireLowercase,
  requireNumber: DEFAULT_POLICY.requireNumber,
  requireSpecial: DEFAULT_POLICY.requireSpecial,
};

describe("GET /api/auth/password-policy", () => {
  it("answers the stored tenant-wide policy — its rules only", async () => {
    mockTx.rows = [
      {
        rotation_days: 30,
        min_length: 14,
        require_uppercase: false,
        require_lowercase: true,
        require_number: true,
        require_special: true,
        password_history_count: 7,
      },
    ];
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      policy: {
        minLength: 14,
        requireUppercase: false,
        requireLowercase: true,
        requireNumber: true,
        requireSpecial: true,
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/rotation|history|user|role|tenant/i);
  });

  it("answers the built-in policy when none is stored", async () => {
    expect(await (await GET(req())).json()).toEqual({ policy: BUILT_IN });
  });

  it("[hostile:store-down] answers the strict built-in policy when the store cannot be read — never a 500", async () => {
    mockTx.fail = true;
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ policy: BUILT_IN });
  });

  it("is rate limited before anything is read", async () => {
    mockLimited.next = apiError("rate.limited", { request: req() });
    const res = await GET(req());
    expect(res.status).toBe(429);
    expect(enforceRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      DEFAULT_RULES.API_GLOBAL
    );
    expect(mockTx.tenants).toEqual([]);
  });

  it("is never kept by a cache: an administrator's change shows on the next screen", async () => {
    expect((await GET(req())).headers.get("cache-control")).toBe("no-store");
  });
});
