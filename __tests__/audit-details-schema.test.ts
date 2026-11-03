/**
 * @jest-environment node
 */
/**
 * __tests__/audit-details-schema.test.ts — what an audit record's details may hold, held to every
 * call site (TASK-193, audit A-2, A-3, A-4; the schema: platform/auth/audit-details.ts)
 *
 * @guard an audit record that carries free text or no subject
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
import {
  APP_AUDIT_DETAIL_KINDS,
  APP_AUDIT_DETAILS_SCHEMA,
} from "@/platform/auth/app-audit-details";
import {
  PLATFORM_AUDIT_DETAIL_KINDS,
  PLATFORM_AUDIT_DETAILS_SCHEMA,
} from "@/platform/auth/audit-details";

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
  /** Whether the record names the account it is about: its targetId, or a userId / user_id. */
  readonly subject?: boolean;
  /** Its text keys whose value is not a fixed literal: a person's free text (round 7, I-1). */
  readonly freeText?: readonly string[];
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

/**
 * The text keys (AUDIT_DETAIL_KINDS "text") of a details literal, its literal spreads included,
 * whose value is not a fixed string: a person's free text, which the erasure removes only from a
 * record naming the account it is about (round 7, I-1).
 */
function freeTextKeys(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
      const k = p.name.getText(sf).replace(/^["']|["']$/g, "");
      if (AUDIT_DETAIL_KINDS[k] !== "text") continue;
      // A shorthand (`reason,`) is its name's value: a parameter typed as a union of string
      // literals is a code (round 18, nit 4).
      const v = ts.isPropertyAssignment(p) ? p.initializer : p.name;
      if (!v || !literals(v)) out.push(k);
    } else if (ts.isSpreadAssignment(p)) {
      for (const o of unwrapSpread(p.expression)) out.push(...freeTextKeys(o, sf));
    }
  }
  return out;
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
    if (!text.includes("details") && !text.includes("recorded(")) continue;
    sites.push(...scanText(file, text));
  }
  return sites;
}

/** The audit records one source writes (`file` names its sites): self-tested on planted lines. */
function scanText(file: string, text: string): Site[] {
  const sites: Site[] = [];
  {
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
            // Its targetId — given, or in a literal spread (`...(t ? { targetId: t } : {})`) — or
            // a userId / user_id in its details.
            const named =
              [
                n,
                ...n.properties.flatMap((p) =>
                  ts.isSpreadAssignment(p) ? unwrapSpread(p.expression) : []
                ),
              ].some((o) =>
                o.properties.some(
                  (p) =>
                    (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
                    p.name.getText(sf) === "targetId"
                )
              ) || k.keys.some((key) => key === "userId" || key === "user_id");
            sites.push({
              file,
              line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
              actions,
              types: literals(k.type) ?? [undefined],
              keys: k.keys,
              spreads: k.spreads,
              subject: named,
              freeText: freeTextKeys(details.initializer, sf),
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
          // recorded() names no targetId: its subject is a userId in its details (round 8, 4).
          subject: k.keys.some((key) => key === "userId" || key === "user_id"),
          freeText: freeTextKeys(n.arguments[2], sf),
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return sites;
}

/**
 * The records written in SQL — `insert into audit_log … 'admin_action'::audit_action,
 * jsonb_build_object('type', '<type>', '<key>', …)` (the jobs' recovery and expiry statements):
 * each a site too, its keys the object's string-literal keys.
 */
function scanSql(): Site[] {
  const sites: Site[] = [];
  for (const file of productionSources()) {
    if (!/\.tsx?$/.test(file)) continue;
    const text = read(file);
    for (const m of text.matchAll(
      /'admin_action'::audit_action,\s*jsonb_build_object\(/g
    )) {
      // The arguments up to the matching parenthesis, split at depth 0.
      const args: string[] = [];
      let depth = 0;
      let cur = "";
      for (let i = m.index! + m[0].length; i < text.length; i++) {
        const c = text[i];
        if (c === "(") depth++;
        if (c === ")" && depth-- === 0) break;
        if (c === "," && depth === 0) {
          args.push(cur.trim());
          cur = "";
        } else cur += c;
      }
      args.push(cur.trim());
      const keys = args
        .filter((_, i) => i % 2 === 0)
        .map((a) => a.match(/^'([^']+)'$/)?.[1])
        .filter((k): k is string => Boolean(k));
      const type = args[1]?.match(/^'([^']+)'$/)?.[1];
      sites.push({
        file,
        line: text.slice(0, m.index).split("\n").length,
        actions: ["admin_action"],
        types: [type],
        keys,
        spreads: [],
      });
    }
  }
  return sites;
}

const SQL_SITES = scanSql();
const SITES = [...scan(), ...SQL_SITES];

describe("audit details are allowlisted per action, at every call site (TASK-193)", () => {
  it("finds the records written in SQL (self-test)", () => {
    const types = SQL_SITES.flatMap((x) => x.types);
    expect(types).toEqual(
      expect.arrayContaining([
        "approval_withdrawn",
        "approval_run_recovered",
        "approval_apply_recovered",
      ])
    );
    expect(SQL_SITES.length).toBeGreaterThan(0);
    expect(SQL_SITES.every((x) => x.keys.includes("type"))).toBe(true);
  });

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

describe("the app's own audit details (platform/auth/app-audit-details.ts, TASK-194 rebase I-1)", () => {
  // The consumer seam: an app registers the details its own records carry there, never in the
  // platform's schema (which the sync overwrites, and which must not name an app's types).
  it("an app entry never redefines a platform key's kind or a platform action's keys", () => {
    expect(
      Object.keys(APP_AUDIT_DETAIL_KINDS).filter((k) => k in PLATFORM_AUDIT_DETAIL_KINDS)
    ).toEqual([]);
    expect(
      Object.keys(APP_AUDIT_DETAILS_SCHEMA).filter(
        (a) => a in PLATFORM_AUDIT_DETAILS_SCHEMA
      )
    ).toEqual([]);
  });

  it("the free-text keys are exactly these six: one moved off text fails here (round 2, finding 6)", () => {
    // Moving a key off "text" stops the erasure removing it with the account: a decision for
    // review, never a side effect of an edit to the kinds.
    expect([...AUDIT_TEXT_KEYS].sort()).toEqual(
      ["reason", "deviceName", "cause", "changeComment", "note", "reviewerNotes"].sort()
    );
  });

  it("an app kind is never free text: the erasure's text keys are the platform's alone", () => {
    expect(
      Object.entries(APP_AUDIT_DETAIL_KINDS)
        .filter(([, kind]) => (kind as string) === "text")
        .map(([k]) => k)
    ).toEqual([]);
    expect([...AUDIT_TEXT_KEYS].sort()).toEqual(
      Object.entries(PLATFORM_AUDIT_DETAIL_KINDS)
        .filter(([, kind]) => kind === "text")
        .map(([k]) => k)
        .sort()
    );
  });

  it("the merged schema is the platform's and the app's, nothing else", () => {
    expect(AUDIT_DETAILS_SCHEMA).toEqual({
      ...PLATFORM_AUDIT_DETAILS_SCHEMA,
      ...APP_AUDIT_DETAILS_SCHEMA,
    });
    expect(AUDIT_DETAIL_KINDS).toEqual({
      ...PLATFORM_AUDIT_DETAIL_KINDS,
      ...APP_AUDIT_DETAIL_KINDS,
    });
  });

  it("every schema entry is written by some call site in this repository (no entry nobody writes)", () => {
    const written = new Set<string>();
    for (const s of SITES) {
      for (const action of s.actions) {
        written.add(action);
        for (const type of s.types) if (type) written.add(`${action}:${type}`);
      }
    }
    expect(Object.keys(AUDIT_DETAILS_SCHEMA).filter((e) => !written.has(e))).toEqual([]);
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

  it("an approval decision keeps the decider's note (text: erased with the account the record names as its target — round 7, I-1) and the previous approver (an id) — round 6, P-2", () => {
    const r = sanitizeAuditDetails("admin_action", {
      type: "approval_decision",
      decision: "withdraw",
      note: "checked: no rows were erased",
      approvedBy: "00000000-0000-4000-8000-0000000000aa",
    });
    expect(r.dropped).toEqual([]);
    expect(r.details).toMatchObject({
      note: "checked: no rows were erased",
      approvedBy: "00000000-0000-4000-8000-0000000000aa",
    });
    expect(AUDIT_DETAIL_KINDS.note).toBe("text");
    expect(AUDIT_TEXT_KEYS).toContain("note");
    expect(AUDIT_DETAIL_KINDS.approvedBy).toBe("id");
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

/**
 * Round 7, I-1: free text a person wrote is erased with the account it is about — and the
 * erasure finds that account only by the record's targetId or its userId / user_id
 * (platform/auth/user-data.ts auditText). So a record carrying free text names its subject, or is
 * here with the reason its text is about no account.
 */
const TEXT_WITHOUT_SUBJECT: Readonly<Record<string, string>> = {
  "admin_action:config_updated_with_history changeComment":
    "a setting's change comment: about a setting, not an account (an account's id in it is replaced by auditMentions)",
  "admin_action:config_override_cleared changeComment":
    "a setting's change comment: about a setting, not an account",
  "admin_action:approval_withdrawn cause":
    "why a reduction of power withdrew held changes of a setting: about the setting's change, not an account",
  "admin_action:tenant_deletion_approved note":
    "an operator's note on a tenant's deletion: about a tenant, not an account",
  "admin_action:tenant_deletion_rejected note":
    "an operator's note on a tenant's deletion: about a tenant, not an account",
  "admin_action:tenant_suspended reason":
    "an operator's reason for suspending a tenant: about a tenant, not an account",
  "admin_action:tenant_resumed reason":
    "an operator's reason for resuming a tenant: about a tenant, not an account",
  "admin_action:tenant_deletion_requested reason":
    "an operator's reason for deleting a tenant: about a tenant, not an account (its accounts are erased with it)",
  "admin_action:tenant_restored reason":
    "an operator's reason for restoring a tenant: about a tenant, not an account",
  "admin_action:agents_emergency_suspended reason":
    "why agents were suspended: about agents, written by an admin — an agent is no account",
  "admin_action:approval_run_conflict reason":
    "a run's error (no person wrote it): an address in it is redacted at write, an account's id replaced by auditMentions",
  "admin_action:action_applied_not_recorded reason":
    "a run's error (no person wrote it): an address in it is redacted at write, an account's id replaced by auditMentions",
  "admin_action:approved_run_indeterminate reason":
    "a run's error code (no person wrote it): the registry code of a lost commit",
  "admin_action:approved_run_failed reason":
    "a run's error (no person wrote it): an address in it is redacted at write, an account's id replaced by auditMentions",
};

/** Each free-text key of a site that names no subject and is not allowlisted. */
function unnamedText(sites: readonly Site[]): string[] {
  const missing: string[] = [];
  for (const x of sites) {
    if (x.subject || !(x.freeText ?? []).length) continue;
    for (const action of x.actions)
      for (const type of x.types)
        for (const key of x.freeText!) {
          const id = `${type ? `${action}:${type}` : action} ${key}`;
          if (!TEXT_WITHOUT_SUBJECT[id]) missing.push(`${x.file}:${x.line} ${id}`);
        }
  }
  return missing;
}

/** Each allowlist key's "action:type key", as the sites carry it. */
function textSiteIds(sites: readonly Site[]): Set<string> {
  const ids = new Set<string>();
  for (const x of sites)
    for (const action of x.actions)
      for (const type of x.types)
        for (const key of x.freeText ?? [])
          ids.add(`${type ? `${action}:${type}` : action} ${key}`);
  return ids;
}

describe("free text names the account it is about (round 7, I-1)", () => {
  const sites = scan();

  it("finds records carrying free text (self-test)", () => {
    expect(sites.filter((x) => (x.freeText ?? []).length > 0).length).toBeGreaterThan(5);
  });

  it("[self-test] reports a planted record with free text and no subject — an audited entry and a recorded() call (round 8, item 4)", () => {
    const planted = scanText(
      "planted.ts",
      [
        'audited({ action: "admin_action", actorId: a, details: { type: "planted_x", note } }, act);',
        'recorded(operator, "planted_y", { tenantId, reason: why }, act);',
        'audited({ action: "admin_action", actorId: a, targetId: t, details: { type: "planted_z", note } }, act);',
        'recorded(operator, "planted_w", { userId: u, note }, act);',
      ].join("\n")
    );
    expect(unnamedText(planted)).toEqual([
      "planted.ts:1 admin_action:planted_x note",
      "planted.ts:2 admin_action:planted_y reason",
    ]);
  });

  // Round 18, nit 4: a shorthand key is its name's value — a code when the name is a parameter
  // typed as a union of string literals, free text otherwise.
  it("reads a shorthand key through its parameter's type (self-test)", () => {
    const planted = scanText(
      "planted.ts",
      [
        'function a(reason: "stale" | "refused") { audited({ action: "admin_action", actorId: x, details: { type: "planted_code", reason } }, act); }',
        'function b(reason: string) { audited({ action: "admin_action", actorId: x, details: { type: "planted_text", reason } }, act); }',
      ].join("\n")
    );
    expect(unnamedText(planted)).toEqual([
      "planted.ts:2 admin_action:planted_text reason",
    ]);
  });

  it("every allowlisted key is a record the scan finds (no dead entry) — round 8, item 4", () => {
    const ids = textSiteIds(sites);
    expect(Object.keys(TEXT_WITHOUT_SUBJECT).filter((k) => !ids.has(k))).toEqual([]);
  });

  it("every record carrying a person's free text names its subject, or says why not", () => {
    expect(unnamedText(sites)).toEqual([]);
  });
});
