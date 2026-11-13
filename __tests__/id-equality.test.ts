/**
 * @jest-environment node
 */
/**
 * __tests__/id-equality.test.ts — authorization never compares ids with `===` (TASK-194 rebase,
 * round 2, finding 9)
 *
 * @guard an id compared in a case it may not be stored in
 *
 * The self-change rule compared `userId === admin.userId`: the admin's own id in upper case is
 * the same account to Postgres and passed. Every id comparison in the authorization code goes
 * through platform/auth/same-id.ts sameId. This scan reads the authorization code (AUTHZ) and
 * fails on an equality — any of the four operators `===`, `!==`, `==`, `!=` — whose either side
 * names an account's or actor's id (ID_NAME; `uid`, `uuid` and `guid` among them), unless:
 *
 *   - the other side is a literal (a string, a number, null, true or false): a sentinel, not
 *     another id;
 *   - the comparison sits inside an `InMemory…` class (the memory twin of a Postgres store: it
 *     finds records by the ids its caller gives it; a Postgres store or factory in the same file
 *     is scanned) — round 4, item 2;
 *   - or the site is in ALLOWED with its reason.
 *
 * A case fold (`x.toLowerCase()` / `toUpperCase()`) is an equality on ids by hand: the operand
 * stands for what it folds, so a fold on either side — or both — is caught (round 4, item 3).
 * scanSource is the scan of one source, self-tested on planted lines.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import * as ts from "typescript";
import { sameId } from "@/platform/auth/same-id";

const ROOT = join(__dirname, "..");

/**
 * The authorization code: every directory where a self, owner, claimer, requester, independence
 * or tenant rule is decided (round 3, finding 5 — found by grep for self / own / owner / claim
 * rules): accounts and sign-in, approvals and holds, tenancy, erasure, the agent runtime and its
 * gating, moderation (self-review, claimer), social groups (owner), jobs (operators), app
 * sessions (participants, turns), the action pipeline, every route, and an app's own lib/.
 */
const AUTHZ = [
  "platform/auth",
  "platform/admin",
  "platform/tenancy",
  "platform/gdpr",
  "platform/agents",
  "platform/moderation",
  "platform/social",
  "platform/jobs",
  "platform/app-framework",
  "platform/action-pipeline",
  "app/api",
  "lib",
];

/**
 * A name of an account's, actor's or record's id: ends in Id / _id / By / _by / sub / owner /
 * principal (any case) — `userId`, `decidedBy`, `requested_by`, `ownerId`, `principalOf(x)`.
 */
const ID_NAME = /(?:id|by|sub|owner|principal(?:of)?)$/i;
const NOT_ID =
  /^(?:valid|paid|void|grid|hybrid|android|fluid|rapid|solid|liquid|vivid|bid|kid|lid|mid|rid|aid|did|hid)$/i;

/** "<file> <expression>": a comparison that decides no access, and why. */
const ALLOWED: Readonly<Record<string, string>> = {
  "platform/agents/workflow-loop.ts approved.label !== step.tool.id":
    "an approved action's tool label against the step's tool name: names of tools, not of any account or actor — no access decided",
  "platform/agents/postgres-budget-store.ts tenant.agentId !== TENANT_TOTAL_AGENT":
    "a budget row against the tenant-total sentinel row's fixed key: which row it is, no access decided",
  "platform/auth/user-provisioning.ts row.key !== current.keyId":
    "a banned-address hash's key id against the current hashing key's id: which key made the hash, no account compared and no access decided",
  "platform/auth/identity-relink.ts a.accountId === b.accountId":
    "samePlan: two re-link plans built by the server from the same rows compared for drift — equality of snapshots, no access decided",
  "platform/auth/identity-relink.ts a.merge?.accountId === b.merge?.accountId":
    "samePlan: two re-link plans compared for drift, both possibly without a merge (undefined equals undefined) — no access decided",
};

/**
 * An in-memory store's class (`InMemory…`, the memory twin of a Postgres store, for tests and a
 * single process): its comparisons find records by the ids its caller gives it — the services
 * above it decide who may (the owner, the invitee, the claimer, the independent approver, with
 * sameId). Only the class itself is exempt: a Postgres store or a factory in the same file is
 * scanned (round 4, item 2).
 */
function insideInMemoryClass(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isClassDeclaration(p) && p.name && /^InMemory/.test(p.name.text)) return true;
  }
  return false;
}

function files(): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    const abs = join(ROOT, p);
    if (statSync(abs).isDirectory()) {
      for (const n of readdirSync(abs)) {
        if (n === "__tests__" || n === "node_modules") continue;
        walk(`${p}/${n}`);
      }
    } else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  };
  for (const p of AUTHZ) walk(p);
  return out;
}

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** The name an operand stands for: its identifier, last property, key, or the callee's name. */
function nameOf(e: ts.Expression): string | undefined {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isAsExpression(e)
  ) {
    e = e.expression;
  }
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
    return e.argumentExpression.text;
  }
  // A case fold (`x.userId.toLowerCase()`) stands for what it folds: an equality on ids by hand,
  // caught on either side (round 4, item 3).
  if (foldsCase(e)) {
    return nameOf(
      ((e as ts.CallExpression).expression as ts.PropertyAccessExpression).expression
    );
  }
  if (ts.isCallExpression(e)) return nameOf(e.expression);
  return undefined;
}

/** Whether an operand folds case (`x.toLowerCase()`): an equality on ids by hand. */
function foldsCase(e: ts.Expression): boolean {
  return (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    /^to(?:Lower|Upper)Case$/.test(e.expression.name.text)
  );
}

const isIdName = (n: string | undefined) =>
  n !== undefined && ID_NAME.test(n) && !NOT_ID.test(n);

/** The raw id comparisons in one source, as "<file>:<line> <expression>". */
function scanSource(file: string, text: string): string[] {
  const found: string[] = [];
  {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if (ts.isBinaryExpression(n) && EQUALITY.has(n.operatorToken.kind)) {
        const sides = [n.left, n.right];
        const literalSide = sides.some(
          (e) =>
            ts.isStringLiteralLike(e) ||
            ts.isNumericLiteral(e) ||
            e.kind === ts.SyntaxKind.NullKeyword ||
            e.kind === ts.SyntaxKind.TrueKeyword ||
            e.kind === ts.SyntaxKind.FalseKeyword ||
            ts.isTypeOfExpression(e) ||
            (ts.isIdentifier(e) && e.text === "undefined")
        );
        const ids = sides.some((e) => isIdName(nameOf(e)));
        if (!literalSide && ids && !insideInMemoryClass(n)) {
          const key = `${file} ${n.getText(sf)}`;
          if (!ALLOWED[key]) {
            found.push(
              `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${n.getText(sf)}`
            );
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return found;
}

function rawComparisons(): string[] {
  return files().flatMap((file) =>
    scanSource(file, readFileSync(join(ROOT, file), "utf8"))
  );
}

describe("ids are compared with sameId in authorization code (rebase round 2, finding 9)", () => {
  it("sameId: UUIDs in any case, any other id exactly, missing never", () => {
    const id = "0b5c6f4e-1d2a-4c3b-9e8f-7a6b5c4d3e2f";
    expect(sameId(id, id.toUpperCase())).toBe(true);
    expect(sameId(id, "1b5c6f4e-1d2a-4c3b-9e8f-7a6b5c4d3e2f")).toBe(false);
    expect(sameId("agent:Conductor", "agent:conductor")).toBe(false);
    expect(sameId("agent:x", "agent:x")).toBe(true);
    expect(sameId(undefined, undefined)).toBe(false);
    expect(sameId("", "")).toBe(false);
  });

  it("sameId: every spelling Postgres reads as the same UUID is the same id (round 3, finding 4)", () => {
    const id = "0b5c6f4e-1d2a-4c3b-9e8f-7a6b5c4d3e2f";
    const bare = id.replace(/-/g, "");
    for (const spelling of [
      bare,
      bare.toUpperCase(),
      `{${id}}`,
      `{${bare}}`,
      // Postgres takes a hyphen after any group of four hex digits.
      bare.replace(/(.{4})/g, "$1-").slice(0, -1),
      `${bare.slice(0, 4)}-${bare.slice(4)}`,
    ]) {
      expect([spelling, sameId(id, spelling), sameId(spelling, id)]).toEqual([
        spelling,
        true,
        true,
      ]);
    }
    // Not a UUID Postgres would read: never the same as one.
    expect(sameId(id, `${id}0`)).toBe(false);
    expect(sameId(id, `{${id}`)).toBe(false);
  });

  it("[self-test] catches a planted comparison: one-sided and two-sided case folds, a uid (round 4, item 3)", () => {
    const planted = [
      "if (a.userId.toLowerCase() === b) {}",
      "if (account.toLowerCase() === userId) {}",
      "if (x.toLowerCase() === y.ownerId.toLowerCase()) {}",
      "if (row.uid !== other) {}",
      "if (a.userId === b.userId) {}",
    ].join("\n");
    expect(scanSource("planted.ts", planted)).toHaveLength(5);
    // And never one on a literal, a status or a count.
    expect(
      scanSource("planted.ts", 'if (a.userId === "x" || p.status === q.status) {}')
    ).toEqual([]);
  });

  it("exempts only the InMemory… class: a Postgres class in the same source is scanned (round 5, item 8)", () => {
    const planted = [
      "class InMemoryX { has(a: R, b: R) { return a.ownerId === b.ownerId; } }",
      "class PgX { has(a: R, b: R) { return a.ownerId === b.ownerId; } }",
    ].join("\n");
    expect(scanSource("planted.ts", planted)).toEqual([
      "planted.ts:2 a.ownerId === b.ownerId",
    ]);
  });

  it("finds the comparisons it means to (self-test)", () => {
    expect(files()).toEqual(expect.arrayContaining(["platform/auth/entitlements.ts"]));
    expect(files().length).toBeGreaterThan(50);
  });

  it("no raw === / !== on an account's or actor's id", () => {
    expect(rawComparisons()).toEqual([]);
  });

  it("every allowlisted comparison still exists and names why", () => {
    const all = new Set<string>();
    for (const key of Object.keys(ALLOWED)) {
      const [file] = key.split(" ");
      if (readFileSync(join(ROOT, file), "utf8").includes(key.slice(file.length + 1)))
        all.add(key);
    }
    expect(Object.keys(ALLOWED).filter((k) => !all.has(k))).toEqual([]);
    expect(Object.values(ALLOWED).filter((r) => r.trim().length < 20)).toEqual([]);
  });
});
