/**
 * __tests__/operator-echo-bound.test.ts — a refusal repeats at most ECHO_MAX characters of an
 * operator's input (N-56, TASK-203)
 *
 * `tenant.invalid` said `"<the input>" is not a host name.` with the whole input — the message
 * travels in the coded error's `reason` param and the audit record of the attempt, so a megabyte
 * typed (or pasted) came back and was stored twice. Now the input is cut at ECHO_MAX characters,
 * with "…", and its control characters removed; an attestation naming an unknown store likewise.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());

import {
  ECHO_MAX,
  addTenantDomain,
  echoed,
  provisionTenant,
  removeTenantDomain,
} from "@/platform/tenancy/admin";
import { requestErasureAttestation } from "@/platform/gdpr/erasure-attestation";

const OPERATOR = { userId: "00000000-0000-4000-9000-0000000000e1" };
const TENANT = "00000000-0000-4000-8000-0000000000aa";
const HUGE = `not a host ${"x".repeat(1_000_000)}`;

const messageOf = (r: { ok: boolean; message?: string }) =>
  r.ok ? "" : (r.message ?? "");

describe("operator input echoed back is bounded (N-56)", () => {
  it("echoed: at most ECHO_MAX characters and an ellipsis; no control characters", () => {
    expect(echoed("short")).toBe("short");
    expect(echoed("x".repeat(ECHO_MAX))).toBe("x".repeat(ECHO_MAX));
    expect(echoed("y".repeat(ECHO_MAX + 1))).toBe(`${"y".repeat(ECHO_MAX)}…`);
    expect(echoed("a\u0000b\nc\u001bd\u0085e")).toBe("abcde");
    expect(echoed(undefined)).toBe("");
  });

  it("[hostile:id-spelling] a megabyte host name: the refusal repeats a bounded piece of it", async () => {
    for (const r of [
      await addTenantDomain(OPERATOR, TENANT, HUGE),
      await removeTenantDomain(OPERATOR, TENANT, HUGE),
      await provisionTenant(OPERATOR, { slug: "acme", name: "Acme", domains: [HUGE] }),
    ]) {
      expect(r).toMatchObject({ ok: false, code: "tenant.invalid" });
      expect(messageOf(r).length).toBeLessThan(ECHO_MAX + 40);
      expect(messageOf(r)).toContain("…");
    }
  });

  it("an attestation naming an unknown store: bounded too", async () => {
    const r = await requestErasureAttestation(
      OPERATOR,
      { tenantId: TENANT, userId: TENANT, store: HUGE },
      "deleted_in_old_pool",
      "a note"
    );
    expect(r).toMatchObject({ ok: false, code: "tenant.invalid" });
    expect(messageOf(r).length).toBeLessThan(ECHO_MAX + 40);
  });
});
