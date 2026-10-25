/**
 * __tests__/validator-properties.test.ts — generated hostile input for every validator at an
 * input boundary (TASK-147)
 *
 * Hand-picked cases miss what nobody imagined. Each validator below is driven with generated
 * values of every shape — strings of any content and length, numbers, objects, arrays, nulls —
 * and two kinds of property are checked: it never throws (a throw at a boundary is an uncoded
 * 500), and what it accepts satisfies what callers rely on.
 *
 * The route bodies themselves are fuzzed through every privileged route against Postgres in
 * __tests__/db/route-role-matrix.db.test.ts.
 */

import fc from "fast-check";
import { NextRequest } from "next/server";
import { fuzzParams } from "@/__tests__/helpers/fuzz";
import { parseDeclaredBirthDate, MAX_DECLARED_AGE } from "@/platform/auth/coppa";
import { validateConfigValue } from "@/platform/auth/platform-config";
import { passwordRuleViolations, DEFAULT_POLICY } from "@/platform/auth/password-policy";
import {
  isTenantSlug,
  normaliseHost,
  validateTenantName,
} from "@/platform/tenancy/directory";
import { isTenantId } from "@/platform/providers/environment-contract";
import { sanitizeLanguageCode } from "@/lib/sanitize";
import { validateStreamRequest } from "@/platform/ai/stream-policy";
import { readRefreshCookie } from "@/platform/auth/auth-response";
import { readJsonObject, requireTextFields } from "@/platform/errors/request-body";
import { avatarUrlRefusal } from "@/platform/auth/profile-screening";
import { addressBucket } from "@/platform/rate-limit/client-ip";
import { isValidSchema } from "@/platform/agents/schema";
import type { EnhancedConfigEntry } from "@/platform/admin/types";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

fc.configureGlobal(fuzzParams());

/** Any JSON-ish value, including the shapes routes trust by mistake. */
const anything = fc.oneof(
  fc.string(),
  fc.string({ unit: "binary", maxLength: 300 }),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.jsonValue(), { maxLength: 5 }),
  fc.dictionary(fc.string({ maxLength: 10 }), fc.jsonValue(), { maxKeys: 5 }),
  fc.jsonValue()
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("validators never throw, and accept only what callers rely on", () => {
  it("parseDeclaredBirthDate: a real past date, at most MAX_DECLARED_AGE years ago", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          anything,
          // A valid Date only: an invalid one (about 1 in 2000) throws in toISOString, failing the
          // property in the generator rather than in the validator.
          fc.date({ noInvalidDate: true }).map((d) => d.toISOString().slice(0, 10))
        ),
        (v) => {
          const r = parseDeclaredBirthDate(v);
          if (r === null) return true;
          return typeof v === "string" && r.age >= 0 && r.age <= MAX_DECLARED_AGE;
        }
      )
    );
  });

  it("validateConfigValue: never throws; what it accepts is stored as the setting's type", () => {
    const entry = (over: Partial<EnhancedConfigEntry>): EnhancedConfigEntry =>
      ({
        key: "k",
        value: 1,
        description: null,
        category: "c",
        updatedAt: "",
        defaultValue: 1,
        valueType: "number",
        minValue: 0,
        maxValue: 10,
        allowedValues: null,
        permissionTier: "standard",
        ...over,
      }) as EnhancedConfigEntry;
    fc.assert(
      fc.property(
        fc.constantFrom("number", "boolean", "string_enum", "json_array", "string"),
        fc.oneof(
          anything,
          fc.constantFrom(
            "5",
            " 7 ",
            "1e3",
            "0x10",
            "",
            "true",
            "false",
            "[1]",
            "{}",
            "NaN"
          ),
          fc.constant(Object.create(null) as unknown)
        ),
        (valueType, v) => {
          const e = entry({
            valueType: valueType as EnhancedConfigEntry["valueType"],
            allowedValues: ["a", "b"],
          });
          const r = validateConfigValue(e, v);
          if (!r.valid) return Array.isArray(r.errors) && r.errors.length > 0;
          // What is stored is the setting's own type, whatever the form sent.
          const out = r.value;
          if (valueType === "number")
            return typeof out === "number" && out >= 0 && out <= 10;
          if (valueType === "boolean") return typeof out === "boolean";
          if (valueType === "string_enum") return out === "a" || out === "b";
          if (valueType === "json_array") return Array.isArray(out);
          return typeof out === "string";
        }
      )
    );
  });

  it("passwordRuleViolations: never throws; an accepted password meets the length rule", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 200 }), (pw) => {
        const failed = passwordRuleViolations(pw, DEFAULT_POLICY);
        return failed.length > 0 || pw.length >= DEFAULT_POLICY.minLength;
      })
    );
  });

  it("tenant slugs, names, hosts and ids: what is accepted is well-formed", () => {
    fc.assert(
      fc.property(anything, fc.string({ maxLength: 300 }), (v, s) => {
        if (isTenantSlug(v) && !/^[a-z0-9-]{1,40}$/.test(v)) return false;
        const name = validateTenantName(v);
        if (
          name !== null &&
          (name.length < 2 ||
            name.length > 100 ||
            [...name].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20))
        )
          return false;
        if (isTenantId(v) && !UUID.test(v)) return false;
        const host = normaliseHost(s);
        if (host !== null && (/[\s:/[\]]/.test(host) || host !== host.toLowerCase()))
          return false;
        return true;
      })
    );
  });

  it("sanitizeLanguageCode: letters, digits and hyphens only, and bounded", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: "binary", maxLength: 500 }),
          fc.string({ unit: fc.constantFrom(..."abcxyzABCXYZ0189-"), maxLength: 200 }),
          anything
        ),
        (v) => {
          const out = sanitizeLanguageCode(v as string);
          return /^[a-z\d-]{1,35}$/i.test(out);
        }
      )
    );
  });

  it("validateStreamRequest: never throws; an accepted body has a bounded text prompt and no system prompt", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          anything,
          fc.record({
            prompt: anything,
            system: fc.option(anything),
            tier: fc.option(anything),
          })
        ),
        (body) => {
          const r = validateStreamRequest(body);
          if (!r.ok) return typeof r.code === "string";
          const b = body as Record<string, unknown>;
          return (
            typeof b.prompt === "string" &&
            b.prompt.trim() !== "" &&
            b.system === undefined
          );
        }
      )
    );
  });

  it("readRefreshCookie: a bounded id and a token, or nothing", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ maxLength: 9000 }), fc.string({ unit: "binary" })),
        (v) => {
          const r = readRefreshCookie(v);
          return (
            r === null || (/^[\w-]{1,128}$/.test(r.userId) && r.refreshToken.length > 0)
          );
        }
      )
    );
  });

  it("readJsonObject: a plain object, or a coded 4xx — for any body", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.jsonValue().map((v) => JSON.stringify(v)),
          fc.string({ maxLength: 200 })
        ),
        async (raw) => {
          const req = new NextRequest("http://localhost/x", {
            method: "POST",
            body: raw,
          });
          const r = await readJsonObject(req);
          if (r.ok) {
            return (
              typeof r.body === "object" && r.body !== null && !Array.isArray(r.body)
            );
          }
          return r.response.status >= 400 && r.response.status < 500;
        }
      )
    );
  });

  it("requireTextFields: passes only when every named field is non-empty text", () => {
    const headers = new Headers();
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom("a", "b", "c"), anything), (body) => {
        const refused = requireTextFields(body, ["a", "b"], { headers });
        const ok = ["a", "b"].every((k) => typeof body[k] === "string" && body[k] !== "");
        return refused === null ? ok : !ok && refused.status === 400;
      })
    );
  });

  it("avatarUrlRefusal: an accepted address is https on a public host, without credentials", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.webUrl({ withQueryParameters: true }), fc.string()),
        (v) => {
          if (avatarUrlRefusal(v) !== undefined) return true;
          const u = new URL(v);
          return (
            u.protocol === "https:" &&
            !u.username &&
            !u.password &&
            u.hostname.includes(".") &&
            !/^[\d.]+$/.test(u.hostname)
          );
        }
      )
    );
  });

  it("addressBucket: never throws, is deterministic, and keeps an IPv6 /64 together", () => {
    fc.assert(
      fc.property(fc.oneof(fc.ipV4(), fc.ipV6(), fc.string({ maxLength: 100 })), (a) => {
        return addressBucket(a) === addressBucket(a);
      })
    );
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 8, maxLength: 8 }),
        fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 4, maxLength: 4 }),
        (groups, tail) => {
          const hex = (n: number) => n.toString(16);
          const one = groups.map(hex).join(":");
          const two = [...groups.slice(0, 4), ...tail].map(hex).join(":");
          return addressBucket(one) === addressBucket(two);
        }
      )
    );
  });

  it("isValidSchema: never throws for any schema and value", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom("type", "required", "properties", "items", "enum"),
          anything
        ),
        anything,
        (schema, data) => typeof isValidSchema(schema, data) === "boolean"
      )
    );
  });
});
