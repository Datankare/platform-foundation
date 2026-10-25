/**
 * __tests__/guest-continuation.test.ts — Guests are bounded per address; a restricted account
 * does not carry on as a guest (audit X-20, A-6, G-8)
 *
 * Guest tokens are free to mint (20 an hour from one address) and each had its own allowance,
 * so one address got 100 paid requests an hour; an IPv6 client got a fresh bucket for every
 * address in its /64; and a banned user could sign out and continue as a stream of guests.
 */

import fc from "fast-check";
import { NextRequest } from "next/server";
import { fuzzParams } from "./helpers/fuzz";

fc.configureGlobal(fuzzParams());

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

const mockStanding = jest.fn();
jest.mock("@/platform/auth/account-status-guard", () => ({
  ...jest.requireActual("@/platform/auth/account-status-guard"),
  isInGoodStanding: (...a: unknown[]) => mockStanding(...a),
}));

import { addressBucket, resetRateLimiter } from "@/platform/rate-limit";
import {
  enforceGuestAllowance,
  getGuestUsageStore,
} from "@/platform/auth/guest-allowance";
import { mintGuestToken } from "@/platform/auth/guest-token";
import { registerAuthProvider } from "@/platform/auth/config";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";
import { POST as startGuest } from "@/app/api/auth/guest/route";
import { RESTRICTED_MARKER } from "@/platform/auth/restricted-marker";
import type { Actor } from "@/platform/auth/middleware";

const request = (ip: string, headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/process", {
    method: "POST",
    headers: { "x-forwarded-for": ip, ...headers },
  });

async function guestActor(): Promise<Actor> {
  const { guestId, expiresAt } = await mintGuestToken();
  return {
    kind: "guest",
    id: guestId,
    tenantId: "00000000-0000-4000-8000-000000000001",
    expiresAt,
  };
}

beforeAll(() => registerAuthProvider(createMockAuthProvider()));

beforeEach(async () => {
  jest.clearAllMocks();
  resetRateLimiter();
  await getGuestUsageStore().reset();
  mockStanding.mockResolvedValue(true);
});

describe("addressBucket (G-8)", () => {
  it.each([
    ["203.0.113.9", "203.0.113.9"],
    ["::ffff:203.0.113.9", "203.0.113.9"],
    ["2001:db8:aa:bb:1:2:3:4", "2001:db8:aa:bb::/64"],
    ["2001:db8:aa:bb::1", "2001:db8:aa:bb::/64"],
    ["2001:DB8:00AA:BB::FFFF", "2001:db8:aa:bb::/64"],
    ["[2001:db8::1]", "2001:db8:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["not-an-address", "unknown"],
    ["", "unknown"],
    ["unknown", "unknown"],
  ])("%s is counted as %s", (address, bucket) => {
    expect(addressBucket(address)).toBe(bucket);
  });

  it("puts every address of one /64 in one bucket (property)", () => {
    const hextet = fc.integer({ min: 0, max: 0xffff }).map((n) => n.toString(16));
    fc.assert(
      fc.property(
        fc.array(hextet, { minLength: 4, maxLength: 4 }),
        fc.array(hextet, { minLength: 4, maxLength: 4 }),
        fc.array(hextet, { minLength: 4, maxLength: 4 }),
        (prefix, a, b) => {
          const one = addressBucket([...prefix, ...a].join(":"));
          const two = addressBucket([...prefix, ...b].join(":"));
          return one === two && one.endsWith("::/64");
        }
      )
    );
  });

  it("never puts two different /64 prefixes in one bucket (property)", () => {
    const hextet = fc.integer({ min: 0, max: 0xffff });
    fc.assert(
      fc.property(
        fc.array(hextet, { minLength: 4, maxLength: 4 }),
        fc.array(hextet, { minLength: 4, maxLength: 4 }),
        (p, q) => {
          fc.pre(p.join() !== q.join());
          const full = (x: number[]) =>
            [...x, 1, 2, 3, 4].map((n) => n.toString(16)).join(":");
          return addressBucket(full(p)) !== addressBucket(full(q));
        }
      )
    );
  });
});

describe("guests' paid requests per address (A-6)", () => {
  it("stops a stream of fresh guest tokens from one address at the daily cap", async () => {
    let allowed = 0;
    for (let i = 0; i < 30; i++) {
      // A new token every time — each with its own untouched allowance.
      const outcome = await enforceGuestAllowance(await guestActor(), {
        request: request("198.51.100.20"),
      });
      if (!outcome.error) allowed++;
      else expect((await outcome.error.json()).code).toBe("guest.allowance_exhausted");
    }
    expect(allowed).toBe(20);
  });

  it("counts every address of an IPv6 /64 together", async () => {
    let allowed = 0;
    for (let i = 0; i < 30; i++) {
      const outcome = await enforceGuestAllowance(await guestActor(), {
        request: request(`2001:db8:1:2::${(i + 1).toString(16)}`),
      });
      if (!outcome.error) allowed++;
    }
    expect(allowed).toBe(20);
  });

  it("keeps different addresses apart", async () => {
    for (let i = 0; i < 20; i++) {
      await enforceGuestAllowance(await guestActor(), {
        request: request("198.51.100.21"),
      });
    }
    const other = await enforceGuestAllowance(await guestActor(), {
      request: request("198.51.100.22"),
    });
    expect(other.error).toBeUndefined();
  });

  it("refuses a guest's paid request with no address to count (fail closed)", async () => {
    const outcome = await enforceGuestAllowance(await guestActor());
    expect(outcome.error?.status).toBe(403);
    expect((await outcome.error!.json()).code).toBe("guest.allowance_exhausted");
  });

  it("never limits a signed-in user here", async () => {
    const outcome = await enforceGuestAllowance({
      kind: "user",
      id: "u",
      tenantId: "t",
      user: { sub: "u", email: "", emailVerified: true, iat: 0, exp: 0 },
    });
    expect(outcome).toEqual({ remaining: null });
  });
});

describe("POST /api/auth/guest — a restricted account (X-20)", () => {
  const guest = (headers: Record<string, string> = {}) =>
    startGuest(
      new NextRequest("http://localhost/api/auth/guest", {
        method: "POST",
        headers: { "x-forwarded-for": "198.51.100.30", ...headers },
      })
    );

  it("mints a guest token for an ordinary browser", async () => {
    const res = await guest();
    expect(res.status).toBe(200);
  });

  it("refuses a browser marked as a restricted account's", async () => {
    const res = await guest({ cookie: `${RESTRICTED_MARKER}=1` });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("auth.guest_refused");
  });

  it("refuses, and marks, a banned user who asks for a guest token while signed in", async () => {
    mockStanding.mockResolvedValue(false);
    const res = await guest({ authorization: "Bearer mock-access-token" });
    expect(res.status).toBe(403);
    expect(res.cookies.get(RESTRICTED_MARKER)).toMatchObject({
      value: "1",
      httpOnly: true,
      path: "/api/auth",
    });
  });

  it("refuses when the caller's standing cannot be read (fail closed)", async () => {
    mockStanding.mockRejectedValue(new Error("db down"));
    const res = await guest({ authorization: "Bearer mock-access-token" });
    expect(res.status).toBe(403);
  });

  it("does not hold an unverifiable token against the caller", async () => {
    const res = await guest({ authorization: "Bearer forged" });
    expect(res.status).toBe(200);
    expect(mockStanding).not.toHaveBeenCalled();
  });

  it("mints for a signed-in user in good standing", async () => {
    const res = await guest({ authorization: "Bearer mock-access-token" });
    expect(res.status).toBe(200);
  });
});
