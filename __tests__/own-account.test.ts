/**
 * @jest-environment node
 */
/**
 * __tests__/own-account.test.ts — an account's own data routes store a new account first, and
 * only a new one (TASK-225; platform/auth/own-account.ts)
 */

const mockResolve = jest.fn();
const mockProvision = jest.fn();
jest.mock("@/platform/auth/account-identity", () => ({
  resolveAccount: (...a: unknown[]) => mockResolve(...a),
}));
jest.mock("@/platform/auth/user-provisioning", () => ({
  provisionAccount: (...a: unknown[]) => mockProvision(...a),
}));

import { storeOwnAccount } from "@/platform/auth/own-account";

const USER = { sub: "0b8c3f8e-6b0e-4a63-9d1e-5d9a3c1e2f40", email: "new@example.test" };

beforeEach(() => {
  mockResolve.mockReset();
  mockProvision.mockReset();
});

describe("storeOwnAccount (TASK-225)", () => {
  it("[hostile:self] an account already stored is left exactly as it is: nothing provisioned", async () => {
    mockResolve.mockResolvedValue({ kind: "bound", accountId: "another-id" });
    expect(await storeOwnAccount(USER)).toBe("ready");
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("a new account is stored, with its address", async () => {
    mockResolve.mockResolvedValue({ kind: "unprovisioned", accountId: USER.sub });
    mockProvision.mockResolvedValue({ outcome: "created", accountId: USER.sub });
    expect(await storeOwnAccount(USER)).toBe("ready");
    expect(mockProvision).toHaveBeenCalledWith(USER.sub, { email: USER.email });
  });

  it("[hostile:erased] an erased identity is not stored again", async () => {
    mockResolve.mockResolvedValue({ kind: "unprovisioned", accountId: USER.sub });
    mockProvision.mockResolvedValue({ outcome: "erased" });
    expect(await storeOwnAccount(USER)).toBe("erased");
  });

  it("[hostile:store-down] a binding that cannot be read, or a row that cannot be made: unavailable", async () => {
    mockResolve.mockRejectedValue(new Error("down"));
    expect(await storeOwnAccount(USER)).toBe("unavailable");
    expect(mockProvision).not.toHaveBeenCalled();
    mockResolve.mockResolvedValue({ kind: "unprovisioned", accountId: USER.sub });
    mockProvision.mockResolvedValue({ outcome: "failed" });
    expect(await storeOwnAccount(USER)).toBe("unavailable");
  });

  it("an identity whose id another account holds is not stored here: the routes' guard decides", async () => {
    mockResolve.mockResolvedValue({ kind: "conflict" });
    expect(await storeOwnAccount(USER)).toBe("ready");
    expect(mockProvision).not.toHaveBeenCalled();
  });
});
