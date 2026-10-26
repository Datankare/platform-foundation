/**
 * @jest-environment jsdom
 */
/**
 * TASK-181 — the shared refusal handler (platform/errors/refusal.ts) and its components
 * (components/refusal/): one decision per code, rendered the same way on every screen.
 */
import React from "react";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  REFUSAL_HANDLERS,
  announceSessionEnd,
  fetchWithProvisioningRetry,
  handleRefusal,
  networkRefusal,
  readRefusal,
  refusalKind,
  retryDelayMs,
} from "@/platform/errors/refusal";
import { PLATFORM_ERROR_CODES } from "@/platform/errors/registry";
import { RefusalNotice, TenantUnavailable } from "@/components/refusal/RefusalNotice";

const replace = jest.fn();
const signOut = jest.fn(async () => undefined);
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
jest.mock("@/platform/auth/context", () => ({ useAuth: () => ({ signOut }) }));

import { useRefusalSessionEnd } from "@/components/refusal/useRefusalSessionEnd";

const response = (status: number, body: unknown): Response =>
  ({
    status,
    ok: status < 400,
    clone() {
      return this;
    },
    json: async () => body,
  }) as unknown as Response;

describe("REFUSAL_HANDLERS", () => {
  it("decides every platform code, and nothing else", () => {
    expect(Object.keys(REFUSAL_HANDLERS).sort()).toEqual(
      Object.keys(PLATFORM_ERROR_CODES).sort()
    );
  });

  it.each([
    ["account.age_unverified", "age-gate"],
    ["account.consent_required", "consent-wait"],
    ["account.restricted", "restricted"],
    ["account.not_found", "signed-out-erased"],
    ["account.identity_conflict", "signed-out-erased"],
    ["account.not_provisioned", "not-provisioned"],
    ["tenant.suspended", "tenant-unavailable"],
    ["tenant.missing", "tenant-unavailable"],
    ["tenant.unknown_host", "tenant-unavailable"],
    ["rate.limited", "retry-after"],
    ["service.unavailable", "service-unavailable"],
    ["auth.required", "sign-in"],
    ["auth.permission_denied", "message"],
    ["app.translate.session_not_found", "message"],
    [undefined, "message"],
    ["not.a.code", "message"],
  ])("%s → %s", (code, kind) => {
    expect(refusalKind(code)).toBe(kind);
  });
});

describe("handleRefusal / readRefusal", () => {
  it("uses the server's message, the retry delay and the account status", () => {
    expect(
      handleRefusal("rate.limited", {
        message: "Slow down.",
        params: { retryAfterSeconds: 4.2 },
        status: 429,
      })
    ).toMatchObject({ kind: "retry-after", message: "Slow down.", retryAfterSeconds: 5 });
    expect(
      handleRefusal("account.restricted", { params: { status: "banned" } })
    ).toMatchObject({ kind: "restricted", accountStatus: "banned" });
  });

  it("falls back to the catalog's message, then the generic one", () => {
    expect(handleRefusal("account.not_provisioned").message).toMatch(/being set up/);
    expect(handleRefusal(undefined).message).toBe(
      "Something went wrong. Please try again."
    );
    expect(networkRefusal()).toMatchObject({ kind: "service-unavailable", code: "" });
  });

  it("reads a coded body, an `error`-only body and a body that is not JSON", async () => {
    expect(
      await readRefusal(
        response(403, { code: "account.consent_required", message: "Wait." })
      )
    ).toMatchObject({ kind: "consent-wait", message: "Wait.", status: 403 });
    expect(await readRefusal(response(400, { error: "Bad." }))).toMatchObject({
      kind: "message",
      message: "Bad.",
    });
    const broken = {
      status: 502,
      clone: () => ({ json: async () => Promise.reject(new SyntaxError("html")) }),
    } as unknown as Response;
    expect(await readRefusal(broken)).toMatchObject({ kind: "message", code: "" });
  });
});

describe("fetchWithProvisioningRetry", () => {
  it("retries with backoff while the account is being set up, then returns the answer", async () => {
    const waits: number[] = [];
    const send = jest
      .fn()
      .mockResolvedValueOnce(response(503, { code: "account.not_provisioned" }))
      .mockResolvedValueOnce(response(503, { code: "account.not_provisioned" }))
      .mockResolvedValueOnce(response(200, { ok: true }));
    const res = await fetchWithProvisioningRetry(send, {
      sleep: async (ms) => void waits.push(ms),
    });
    expect(res.status).toBe(200);
    expect(waits).toEqual([500, 1000]);
    expect(retryDelayMs(3)).toBe(2000);
  });

  it("stops after its attempts, and never retries another refusal", async () => {
    const stuck = jest
      .fn()
      .mockResolvedValue(response(503, { code: "account.not_provisioned" }));
    await fetchWithProvisioningRetry(stuck, {
      attempts: 2,
      sleep: async () => undefined,
    });
    expect(stuck).toHaveBeenCalledTimes(3);
    const down = jest
      .fn()
      .mockResolvedValue(response(503, { code: "service.unavailable" }));
    await fetchWithProvisioningRetry(down, { sleep: async () => undefined });
    expect(down).toHaveBeenCalledTimes(1);
  });
});

describe("RefusalNotice", () => {
  it("restricted: the status, and sign-out", () => {
    const onSignOut = jest.fn();
    render(
      <RefusalNotice
        refusal={handleRefusal("account.restricted", {
          message: "Restricted.",
          params: { status: "suspended" },
        })}
        onSignOut={onSignOut}
      />
    );
    expect(screen.getByText("Account status: suspended")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Sign out"));
    expect(onSignOut).toHaveBeenCalled();
  });

  it("retry-after: when to try again; service-unavailable: a retry", () => {
    const onRetry = jest.fn();
    const { rerender } = render(
      <RefusalNotice
        refusal={handleRefusal("rate.limited", { params: { retryAfterSeconds: 30 } })}
      />
    );
    expect(screen.getByText("You can try again in 30 seconds.")).toBeInTheDocument();
    rerender(
      <RefusalNotice refusal={handleRefusal("service.unavailable")} onRetry={onRetry} />
    );
    fireEvent.click(screen.getByText("Try again"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("sign-in, and 'Create an account' for a guest out of free uses", () => {
    const { rerender } = render(
      <RefusalNotice refusal={handleRefusal("auth.required")} />
    );
    expect(screen.getByText("Sign in").getAttribute("href")).toBe("/auth");
    rerender(<RefusalNotice refusal={handleRefusal("guest.allowance_exhausted")} />);
    expect(screen.getByText("Create an account")).toBeInTheDocument();
  });

  it("consent-wait is informational (status, not alert); a tenant refusal is a full page", () => {
    const { rerender } = render(
      <RefusalNotice
        refusal={handleRefusal("account.consent_required", { message: "Wait." })}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Wait.");
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(
      <TenantUnavailable
        refusal={handleRefusal("tenant.suspended", { message: "Off." })}
      />
    );
    expect(screen.getByText("This service is not available here")).toBeInTheDocument();
    rerender(
      <RefusalNotice refusal={handleRefusal("tenant.missing", { message: "Gone." })} />
    );
    expect(screen.getByRole("heading")).toHaveTextContent(
      "This service is not available here"
    );
  });
});

describe("useRefusalSessionEnd", () => {
  function Screen() {
    useRefusalSessionEnd();
    return null;
  }

  it("signs out once and shows sign-in with the code, however many calls were refused", async () => {
    render(<Screen />);
    act(() => {
      announceSessionEnd("account.not_found");
      announceSessionEnd("account.not_found");
    });
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/auth?error=account.not_found")
    );
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
  });
});
