/**
 * TASK-174 — a user actor is the account its identity is bound to, never the token's subject: an
 * account re-linked to a new identity pool keeps its id, and every account-keyed step that follows
 * requireActor (status, consent, export, erasure, sessions) reads `actor.id`. The binding's rule
 * is __tests__/identity-relink.test.ts; against Postgres, __tests__/db/identity-relink.db.test.ts.
 */
import { NextRequest } from "next/server";
import { registerAuthProvider } from "@/platform/auth/config";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";
import { requireActor } from "@/platform/auth/middleware";
import {
  resolveAccountRecord,
  type AccountResolution,
} from "@/platform/auth/account-identity";
import { syncEmailVerification } from "@/platform/auth/email-verification";
import { TokenVerificationUnavailableError } from "@/platform/auth/token-verification";

jest.mock("@/lib/logger", () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "test-req-id",
}));
jest.mock("@/platform/auth/account-identity", () => ({
  ...jest.requireActual("@/platform/auth/account-identity"),
  resolveAccountRecord: jest.fn(),
}));
jest.mock("@/platform/auth/email-verification", () => ({
  syncEmailVerification: jest.fn(async () => "unchanged"),
}));
const mockRecord = resolveAccountRecord as jest.MockedFunction<
  typeof resolveAccountRecord
>;
const mockSync = syncEmailVerification as jest.MockedFunction<
  typeof syncEmailVerification
>;
/** The binding only (the stored address where the test gives one). */
const mockResolve = {
  mockResolvedValue: (resolution: AccountResolution) =>
    mockRecord.mockResolvedValue({ resolution }),
  mockRejectedValue: (err: Error) => mockRecord.mockRejectedValue(err),
};

const ACCOUNT = "0f0e0d0c-0b0a-4000-8000-0000000000aa";
let token = "";
let sub = "";

beforeAll(async () => {
  const mock = createMockAuthProvider();
  registerAuthProvider(mock);
  token = (await mock.signIn("a@b.c", "x")).accessToken ?? "";
  sub = (await mock.verifyToken(token))?.sub ?? "";
});
beforeEach(() => {
  mockRecord.mockReset();
  mockSync.mockClear();
});

const req = () =>
  new NextRequest("http://localhost:3000/api/account/export", {
    headers: { authorization: `Bearer ${token}` },
  });

describe("requireActor resolves the identity's account", () => {
  it("a re-linked account: actor.id is the account's id; the subject stays on user.sub", async () => {
    mockResolve.mockResolvedValue({ kind: "bound", accountId: ACCOUNT });
    const r = await requireActor(req(), { allowGuests: false });
    expect(mockRecord).toHaveBeenCalledWith(sub);
    expect(r.actor).toMatchObject({ kind: "user", id: ACCOUNT, user: { sub } });
  });

  it("a first request: actor.id is the subject (the id the account is created with)", async () => {
    mockResolve.mockResolvedValue({ kind: "unprovisioned", accountId: sub });
    const r = await requireActor(req(), { allowGuests: true });
    expect(r.actor).toMatchObject({ kind: "user", id: sub });
  });

  it("hostile: the subject's id held by another identity's account — refused, never that account; not retryable (review 15 L4)", async () => {
    mockResolve.mockResolvedValue({ kind: "conflict" });
    const r = await requireActor(req(), { allowGuests: false });
    expect(r.actor).toBeUndefined();
    // A distinct, non-retryable code: account.not_provisioned (503) tells the client to retry.
    expect(r.error?.status).toBe(403);
    await expect(r.error!.json()).resolves.toMatchObject({
      code: "account.identity_conflict",
    });
  });

  it("the binding unreadable: 503 service.unavailable (accounts) — never the subject as a guess", async () => {
    mockResolve.mockRejectedValue(new Error("connection terminated"));
    const r = await requireActor(req(), { allowGuests: false });
    expect(r.error?.status).toBe(503);
    await expect(r.error!.json()).resolves.toMatchObject({
      code: "service.unavailable",
      params: { service: "accounts" },
    });
  });

  it("a guest is not resolved: guests have no account", async () => {
    const { mintGuestToken } = await import("@/platform/auth/guest-token");
    const { token: guest } = await mintGuestToken();
    const r = await requireActor(
      new NextRequest("http://localhost:3000/api/x", {
        headers: { authorization: `Bearer ${guest}` },
      }),
      { allowGuests: true }
    );
    expect(r.actor?.kind).toBe("guest");
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe("requireActor keeps users.email_verified in step (TASK-176)", () => {
  it("a bound account: its stored address and the verified claim are handed to the sync", async () => {
    const address = { email: "a@b.c", verified: false };
    mockRecord.mockResolvedValue({
      resolution: { kind: "bound", accountId: ACCOUNT },
      address,
    });
    const r = await requireActor(req(), { allowGuests: false });
    expect(r.actor).toMatchObject({ id: ACCOUNT });
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(mockSync).toHaveBeenCalledWith(
      ACCOUNT,
      address,
      expect.objectContaining({ sub, emailVerified: true })
    );
  });

  it("an account not provisioned yet, or a conflict: nothing to sync (provisioning stores the claim)", async () => {
    mockResolve.mockResolvedValue({ kind: "unprovisioned", accountId: sub });
    await requireActor(req(), { allowGuests: false });
    mockResolve.mockResolvedValue({ kind: "conflict" });
    await requireActor(req(), { allowGuests: false });
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("the provider cannot answer: 503, and neither the binding nor the flag is touched", async () => {
    const { getAuthProvider } = await import("@/platform/auth/config");
    const provider = getAuthProvider();
    const spy = jest
      .spyOn(provider, "verifyToken")
      .mockRejectedValueOnce(new TokenVerificationUnavailableError("Throttled"));
    const r = await requireActor(req(), { allowGuests: false });
    spy.mockRestore();
    expect(r.error?.status).toBe(503);
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });
});
