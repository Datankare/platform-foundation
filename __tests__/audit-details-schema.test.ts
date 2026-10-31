/**
 * @jest-environment node
 */
/**
 * __tests__/audit-details-schema.test.ts — what an audit record's details may hold, held to every
 * call site (TASK-193, audit A-2, A-3, A-4; the schema: platform/auth/audit-details.ts)
 *
 * An audit record outlives the account it is about, so its details are allowlisted per action
 * (per `type` for admin_action), each key with a kind; no kind holds a raw address, and free text
 * is erased with the account. This test reads every call site (the TypeScript compiler API): each
 * literal `{ action, details: { … } }` — and the operator console's recorded(actor, type, details)
 * — may carry only the keys its action's schema allows, so a new key is registered with its kind
 * before it ships instead of being dropped at write time. A spread the scan cannot read names its
 * reason in SPREADS. And the writer's rules themselves: unknown keys dropped and named, every
 * address-shaped string replaced, free text bounded; the erasure's list of free-text keys is the
 * schema's.
 *
 * Shown failing on the code before TASK-193: the operator's "make tenant admin" record carried the
 * typed address (`email`), and nothing allowlisted any record's keys.
 */

import * as ts from "typescript";
import { productionSources, read } from "./helpers/route-policy";
import {
  allowedDetailKeys,
  AUDIT_DETAIL_KINDS,
  AUDIT_DETAILS_SCHEMA,
  AUDIT_TEXT_KEYS,
  COMMON_DETAIL_KEYS,
  sanitizeAuditDetails,
} from "@/platform/auth/audit-details";
import { CROSS_TENANT_ERASURE, USER_DATA_TABLES } from "@/platform/auth/user-data";

/** "<file>:<expression>" of a spread inside details the scan cannot read, and why it is safe. */
const SPREADS: Readonly<Record<string, string>> = {
  "platform/jobs/operator.ts:entry.details":
    "the run-now outcome repeats its own attempt record's details (job_run_now: type, kind) — a literal the scan reads at the attempt",
  "platform/tenancy/admin.ts:details":
    "recorded()'s own parameter: every call of recorded() passes a literal the scan reads",
  "platform/gdpr/erasure-attestation.ts:details":
    "recorded()'s own parameter: every call of recorded() passes a literal the scan reads",
  "platform/auth/audit.ts:entry.details":
    "the writer's own copy (audited's outcome records) of a record it was given: sanitized at write",
  "platform/auth/audit.ts:tagged.details":
    "the writer's own copy (audited's outcome records) of a record it was given: sanitized at write",
};

interface Site {
  readonly file: string;
  readonly line: number;
  readonly actions: readonly string[];
  readonly types: readonly (string | undefined)[];
  readonly keys: readonly string[];
  readonly spreads: readonly string[];
}

/** The string values an expression can take: a literal, or each branch of a conditional. */
function literals(e: ts.Expression | undefined): string[] | undefined {
  if (!e) return undefined;
  if (ts.isAsExpression(e) || ts.isParenthesizedExpression(e))
    return literals(e.expression);
  if (ts.isStringLiteralLike(e)) return [e.text];
  if (ts.isConditionalExpression(e)) {
    const a = literals(e.whenTrue);
    const b = literals(e.whenFalse);
    return a && b ? [...a, ...b] : undefined;
  }
  // A parameter whose type is a union of string literals (`type: "job_replayed" | "job_discarded"`).
  if (ts.isIdentifier(e)) {
    for (let n: ts.Node | undefined = e.parent; n; n = n.parent) {
      if (ts.isFunctionLike(n)) {
        const param = n.parameters.find(
          (q) => ts.isIdentifier(q.name) && q.name.text === e.text
        );
        const t = param?.type;
        if (t && ts.isUnionTypeNode(t)) {
          const out = t.types.map((u) =>
            ts.isLiteralTypeNode(u) && ts.isStringLiteral(u.literal)
              ? u.literal.text
              : null
          );
          if (out.every((x) => x !== null)) return out as string[];
        }
      }
    }
  }
  return undefined;
}

/** The keys of an object literal, with its literal spreads' keys; unreadable spreads apart. */
function keysOf(
  obj: ts.ObjectLiteralExpression,
  sf: ts.SourceFile
): { keys: string[]; spreads: string[]; type?: ts.Expression } {
  const keys: string[] = [];
  const spreads: string[] = [];
  let type: ts.Expression | undefined;
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
      const k = p.name.getText(sf).replace(/^["']|["']$/g, "");
      keys.push(k);
      if (k === "type") type = ts.isPropertyAssignment(p) ? p.initializer : p.name;
    } else if (ts.isSpreadAssignment(p)) {
      const inner = unwrapSpread(p.expression);
      if (inner.length) {
        for (const o of inner) {
          const sub = keysOf(o, sf);
          keys.push(...sub.keys);
          spreads.push(...sub.spreads);
        }
      } else if (!ts.isObjectLiteralExpression(p.expression)) {
        spreads.push(p.expression.getText(sf));
      }
    }
  }
  return { keys, spreads, type };
}

/** The object literals a spread expression can contribute: `cond ? {…} : {}` or `{…}`. */
function unwrapSpread(e: ts.Expression): ts.ObjectLiteralExpression[] {
  if (ts.isParenthesizedExpression(e)) return unwrapSpread(e.expression);
  if (ts.isObjectLiteralExpression(e)) return [e];
  if (ts.isConditionalExpression(e)) {
    const a = unwrapSpread(e.whenTrue);
    const b = unwrapSpread(e.whenFalse);
    return [...a, ...b];
  }
  return [];
}

function scan(): Site[] {
  const sites: Site[] = [];
  for (const file of productionSources()) {
    if (!/\.tsx?$/.test(file)) continue;
    const text = read(file);
    if (!text.includes("details")) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node): void => {
      // { action: "…", details: { … } }
      if (ts.isObjectLiteralExpression(n)) {
        const prop = (name: string) =>
          n.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && p.name.getText(sf) === name
          );
        const action = prop("action");
        const details = prop("details");
        if (action && details && ts.isObjectLiteralExpression(details.initializer)) {
          const actions = literals(action.initializer);
          const k = keysOf(details.initializer, sf);
          if (actions) {
            sites.push({
              file,
              line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
              actions,
              types: literals(k.type) ?? [undefined],
              keys: k.keys,
              spreads: k.spreads,
            });
          }
        }
      }
      // recorded(actor, "type", { … }, act) — the operator console's writer (admin_action).
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "recorded" &&
        n.arguments.length >= 3 &&
        ts.isObjectLiteralExpression(n.arguments[2])
      ) {
        const k = keysOf(n.arguments[2], sf);
        sites.push({
          file,
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          actions: ["admin_action"],
          types: literals(n.arguments[1]) ?? [undefined],
          keys: ["type", ...k.keys],
          spreads: k.spreads,
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return sites;
}

const SITES = scan();

describe("audit details are allowlisted per action, at every call site (TASK-193)", () => {
  it("finds the call sites it means to (self-test)", () => {
    expect(SITES.length).toBeGreaterThan(60);
    const files = new Set(SITES.map((s) => s.file));
    for (const f of [
      "platform/tenancy/admin.ts",
      "app/api/admin/ai/handlers/restrictions.ts",
      "platform/moderation/review-service.ts",
      "platform/auth/gdpr-deletion.ts",
    ]) {
      expect([f, files.has(f)]).toEqual([f, true]);
    }
  });

  it("every key a call site writes is allowed for its action (and type)", () => {
    const problems: string[] = [];
    for (const s of SITES) {
      for (const action of s.actions) {
        for (const type of s.types) {
          const allowed = allowedDetailKeys(action, type) ?? new Set(COMMON_DETAIL_KEYS);
          for (const key of s.keys) {
            if (!allowed.has(key)) {
              problems.push(
                `${s.file}:${s.line} ${action}${type ? `:${type}` : ""} carries "${key}"`
              );
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("every spread the scan cannot read names why it is safe", () => {
    const unread = SITES.flatMap((s) => s.spreads.map((sp) => `${s.file}:${sp}`)).filter(
      (k) => !SPREADS[k]
    );
    expect(unread).toEqual([]);
  });

  it("no record carries a typed address (A-3): the operator's promotion names the account", () => {
    const promotion = SITES.find((s) => s.types.includes("tenant_admin_granted"));
    expect(promotion?.keys).toEqual(expect.arrayContaining(["tenantId"]));
    expect(promotion?.keys).not.toContain("email");
  });

  it("every schema key has a kind, and every kind is one the writer knows", () => {
    const kinds = new Set([
      "id",
      "code",
      "number",
      "boolean",
      "time",
      "list",
      "value",
      "text",
    ]);
    for (const [action, keys] of Object.entries(AUDIT_DETAILS_SCHEMA)) {
      for (const k of [...COMMON_DETAIL_KEYS, ...keys]) {
        expect([action, k, kinds.has(AUDIT_DETAIL_KINDS[k])]).toEqual([action, k, true]);
      }
    }
  });

  it("the erasure removes exactly the schema's free-text keys, in the tenant and in every other", () => {
    const listed = (sql: string) =>
      [...(sql.match(/array\[([^\]]*)\]/)?.[1] ?? "").matchAll(/'([^']+)'/g)].map(
        (m) => m[1]
      );
    const text = USER_DATA_TABLES.find((e) => e.name === "auditText");
    expect(text).toBeDefined();
    expect(listed(text!.erase).sort()).toEqual([...AUDIT_TEXT_KEYS].sort());
    const textSteps = CROSS_TENANT_ERASURE.filter((sql) => sql.includes("textErased"));
    expect(textSteps).toHaveLength(1);
    for (const sql of textSteps) {
      expect(listed(sql).sort()).toEqual([...AUDIT_TEXT_KEYS].sort());
    }
  });

  it("free text is erased only from records about the account, not ones naming it as an actor (round 1, item 6)", () => {
    const about =
      /target_id = \$1::uuid or details->>'user_id' = \$1::text or details->>'userId' = \$1::text/;
    const text = USER_DATA_TABLES.find((e) => e.name === "auditText")!;
    for (const sql of [
      text.erase,
      text.count,
      ...CROSS_TENANT_ERASURE.filter((q) => q.includes("textErased")),
    ]) {
      expect([sql, about.test(sql), /details::text ~\*/.test(sql)]).toEqual([
        sql,
        true,
        false,
      ]);
    }
    // Every cross-tenant statement reads one page range (bounded per transaction).
    for (const sql of CROSS_TENANT_ERASURE) {
      expect(sql).toContain("ctid >= $2::tid and ctid < $3::tid");
    }
  });
});

describe("the writer's rules (sanitizeAuditDetails)", () => {
  it("drops a key its action may not carry, and names it", () => {
    const r = sanitizeAuditDetails("role_changed", {
      oldRole: "free",
      newRole: "admin",
      email: "jane@example.com",
    });
    expect(r.details).toEqual({
      oldRole: "free",
      newRole: "admin",
      droppedKeys: ["email"],
    });
    expect(r.dropped).toEqual(["email"]);
  });

  it("an action with no schema keeps only the writer's own keys", () => {
    const r = sanitizeAuditDetails("admin_action", { type: "unknown_kind", whatever: 1 });
    expect(r.details).toEqual({ type: "unknown_kind", droppedKeys: ["whatever"] });
  });

  it("replaces every address-shaped string in a kind that can carry a person's, at any depth (A-2, A-3)", () => {
    const r = sanitizeAuditDetails("admin_action", {
      type: "config_updated_with_history",
      key: "jane@example.com",
      changeComment: "asked by jane@example.com",
      reason: 'User "jane@example.com" not found',
    });
    expect(JSON.stringify(r.details)).not.toMatch(/@/);
    expect(r.details.changeComment).toBe("asked by [address]");
    expect(r.details.reason).toBe('User "[address]" not found');
  });

  it("keeps a setting's value as it was set — a sender address, a connection string (round 1, item 9)", () => {
    const value = {
      from: "noreply@example.com",
      url: "postgres://svc@db.example.com:5432/app",
      list: ["a", "ops@x.co"],
    };
    const r = sanitizeAuditDetails("admin_action", {
      type: "config_updated_with_history",
      key: "email.from_address",
      previousValue: "old@example.com",
      newValue: value,
      changeComment: "asked by jane@example.com",
    });
    expect(r.details.newValue).toEqual(value);
    expect(r.details.previousValue).toBe("old@example.com");
    expect(r.details.changeComment).toBe("asked by [address]");
  });

  it("bounds free text and codes", () => {
    const r = sanitizeAuditDetails("admin_action", {
      type: "block_user_feature",
      feature: "x".repeat(500),
      reason: "y".repeat(5000),
    });
    expect((r.details.feature as string).length).toBe(200);
    expect((r.details.reason as string).length).toBe(1000);
  });
});
