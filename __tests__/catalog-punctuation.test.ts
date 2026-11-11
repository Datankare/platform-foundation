/**
 * @jest-environment node
 */
/**
 * __tests__/catalog-punctuation.test.ts — no message ends a sentence twice (TASK-206, N-105)
 *
 * @guard a doubled full stop in a catalog message, or in a refusal the operator routes word
 *
 * `tenant.conflict` read "That could not be done: {reason}." and its reason was a sentence the
 * server wrote, so the operator console showed "…already awaiting approval..". Reasons are tokens
 * the catalog words now (N-102). Two checks:
 *
 *   1. Every message of every catalog (messages/en.json, messages/app/en.json), rendered in every
 *      branch of its select and plural arguments with plain values, has no doubled full stop
 *      (an ellipsis, three, is not one) and no space before a full stop.
 *   2. Every reason the operator routes can answer (platform/tenancy/admin.ts and
 *      platform/gdpr/erasure-attestation.ts — each `fail(code, "reason")`, and the directory's
 *      conflicts) is worded by its own branch, as operatorError answers it: one full stop, at the end.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import {
  parse,
  TYPE,
  type MessageFormatElement,
} from "@formatjs/icu-messageformat-parser";
import IntlMessageFormat from "intl-messageformat";
import { renderMessage } from "@/platform/errors/messages";
import { operatorError } from "@/platform/tenancy/operator-http";
import { TENANT_CONFLICT_REASON } from "@/platform/tenancy/directory";

const ROOT = join(__dirname, "..");
const CATALOGS = ["messages/en.json", "messages/app/en.json"].filter((f) =>
  existsSync(join(ROOT, f))
);

/** Every message of a catalog, by its dotted key. */
function messages(file: string): [string, string][] {
  const out: [string, string][] = [];
  const walk = (o: Record<string, unknown>, at: string) => {
    for (const [k, v] of Object.entries(o)) {
      const key = at ? `${at}.${k}` : k;
      if (typeof v === "string") out.push([key, v]);
      else if (v && typeof v === "object") walk(v as Record<string, unknown>, key);
    }
  };
  walk(JSON.parse(readFileSync(join(ROOT, file), "utf8")), "");
  return out;
}

/** The select options of each argument (every branch is rendered), and the other arguments. */
function argumentsOf(els: MessageFormatElement[], acc = new Map<string, Set<string>>()) {
  for (const el of els) {
    if (el.type === TYPE.select) {
      const opts = acc.get(el.value) ?? new Set<string>();
      for (const [k, o] of Object.entries(el.options)) {
        opts.add(k);
        argumentsOf(o.value, acc);
      }
      acc.set(el.value, opts);
    } else if (el.type === TYPE.plural) {
      acc.set(el.value, acc.get(el.value) ?? new Set(["#plural"]));
      for (const o of Object.values(el.options)) argumentsOf(o.value, acc);
    } else if (
      el.type === TYPE.argument ||
      el.type === TYPE.number ||
      el.type === TYPE.date
    ) {
      acc.set(el.value, acc.get(el.value) ?? new Set(["#plain"]));
    } else if (el.type === TYPE.tag) {
      argumentsOf(el.children, acc);
    }
  }
  return acc;
}

/** The message rendered once per branch of each select (the others at their first), and 1 and 2 for plurals. */
function renderings(key: string, source: string): string[] {
  const args = argumentsOf(parse(source, { ignoreTag: true }));
  const base: Record<string, string | number> = {};
  for (const [name, opts] of args) {
    const first = [...opts][0];
    base[name] = first === "#plural" ? 2 : first === "#plain" ? "value" : first;
  }
  const out = [renderMessage(key, base)];
  for (const [name, opts] of args) {
    for (const o of opts) {
      if (o === "#plain") continue;
      out.push(renderMessage(key, { ...base, [name]: o === "#plural" ? 1 : o }));
    }
  }
  return out;
}

const DOUBLED = /(?<!\.)\.\.(?!\.)|\s\.(?!\.)/;

describe("catalog punctuation (TASK-206, N-105)", () => {
  it.each(CATALOGS)("%s: no message, in any branch, ends a sentence twice", (file) => {
    const bad: string[] = [];
    for (const [key, source] of messages(file)) {
      for (const text of renderings(key, source)) {
        if (DOUBLED.test(text)) bad.push(`${key}: ${text}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every reason the operator routes answer is worded by its own branch, with one full stop", async () => {
    const sources = ["platform/tenancy/admin.ts", "platform/gdpr/erasure-attestation.ts"]
      .map((f) => readFileSync(join(ROOT, f), "utf8"))
      .join("\n");
    const reasons: [string, string][] = [];
    for (const m of sources.matchAll(
      /fail(?:<[^>]*>)?\(\s*(?:"(tenant\.[a-z_]+)"|err\.code),\s*"([a-z_]+)"/g
    ))
      reasons.push([m[1] ?? "tenant.domain_taken", m[2]]);
    for (const [code, reason] of Object.entries(TENANT_CONFLICT_REASON))
      reasons.push([code, reason]);
    // The codes whose answer words its reason (operatorError): tenant.invalid, tenant.conflict.
    const worded = reasons.filter(([code]) =>
      /^tenant\.(?:invalid|exists|slug_taken|domain_taken|state_conflict)$/.test(code)
    );
    expect(worded.length).toBeGreaterThan(20);
    const request = new NextRequest("http://localhost/api/operator/tenants");
    const params = {
      host: "acme.example",
      status: "pending",
      expected: "active",
      store: "s3",
    };
    const bad: string[] = [];
    for (const [code, reason] of worded) {
      const answer = (await operatorError(
        code as Parameters<typeof operatorError>[0],
        {
          reason,
          params: reason === "attestation_reason" ? { allowed: "a, b" } : params,
        },
        request
      ).json()) as { error: string; message: string };
      const unworded = renderMessage(`errors.${answer.error}`, {
        ...params,
        reason: "\u0000",
      });
      if (
        DOUBLED.test(answer.message) ||
        !/[^.]\.$/.test(answer.message) ||
        answer.message === unworded
      )
        bad.push(`${code} ${reason}: ${answer.message}`);
    }
    expect(bad).toEqual([]);
  });
  it("[self-test] a doubled full stop, a space before one and a branch that ends twice are reported", () => {
    const planted = [
      "That could not be done: {reason}..",
      "Saved .",
      "{state, select, on {On.} other {Off..}}",
    ];
    // Each planted source rendered in every branch, as the scan renders a catalog message.
    const direct = planted.filter((source) => {
      const args = argumentsOf(parse(source, { ignoreTag: true }));
      const values: Record<string, string> = {};
      for (const [name, opts] of args)
        values[name] = [...opts].find((o) => !o.startsWith("#")) ?? "x";
      const texts = [...(args.get("state") ?? new Set(["#"]))].map((o) =>
        String(
          new IntlMessageFormat(source, "en").format({
            ...values,
            state: o === "#" ? "x" : o,
          })
        )
      );
      return texts.some((t) => DOUBLED.test(t));
    });
    expect(direct).toEqual(planted);
    expect(DOUBLED.test("Loading...")).toBe(false);
  });
});
