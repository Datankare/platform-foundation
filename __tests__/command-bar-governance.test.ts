/**
 * __tests__/command-bar-governance.test.ts — an action's rules bind its approver too (TASK-194,
 * C-2)
 *
 * @guard a command-bar approver not held to every rule its action's handler applies
 *
 * The approval decision asked an approver only for the action's page permission; the rules a
 * handler applies beyond it — the role-governance rules and an erasure's own — ran for the
 * requester alone. Now each such action names its rules in APPROVER_RULES (command-bar.ts), which
 * decideApproval evaluates for the approver against the held payload
 * (__tests__/db/approver-rules.db.test.ts proves it on the role matrix).
 *
 * This keeps the registry whole, by reading the code (TypeScript compiler API): for every
 * command-bar action, every rule function its handler reaches — in its own file, through the
 * functions it calls — must also be reached by its APPROVER_RULES entry's decision (`decide`). A
 * handler that starts applying a rule without an entry, or an entry that checks less than its
 * handler, fails.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { APPROVER_RULES, COMMAND_BAR_HANDLERS } from "@/app/api/admin/ai/command-bar";

/** The rules an approver must satisfy as the requester does (role-governance and erasure). */
const RULES = [
  "checkRoleAssignment",
  "checkPermissionGrant",
  "mayChangePlatformCatalog",
  "checkRoleEditable",
  "checkDefaultRoleGrant",
  "PROTECTED_ROLES",
];

const DIR = join(process.cwd(), "app/api/admin/ai/handlers");

/** name → the identifiers its body references, for every top-level function of the handlers. */
type Fns = Map<string, { file: string; refs: Set<string> }>;

function functionRefs(
  sources: readonly { name: string; text: string }[] = readdirSync(DIR)
    .filter((n) => n.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(DIR, name), "utf8") }))
): Fns {
  const out: Fns = new Map();
  for (const { name, text } of sources) {
    const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    const refsOf = (node: ts.Node) => {
      const refs = new Set<string>();
      const visit = (n: ts.Node) => {
        if (ts.isIdentifier(n)) refs.add(n.text);
        ts.forEachChild(n, visit);
      };
      visit(node);
      return refs;
    };
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && st.body)
        out.set(st.name.text, { file: name, refs: refsOf(st.body) });
      if (ts.isVariableStatement(st))
        for (const d of st.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.initializer)
            out.set(d.name.text, { file: name, refs: refsOf(d.initializer) });
    }
  }
  return out;
}

const FNS = functionRefs();

/** The rules `fn` reaches, through the functions of its file it references (each once). */
function rulesReached(fn: string, fns: Fns = FNS): Set<string> {
  const reached = new Set<string>();
  const seen = new Set<string>();
  const walk = (name: string, file?: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const def = fns.get(name);
    if (!def || (file && def.file !== file)) return;
    for (const r of def.refs) {
      if (RULES.includes(r)) reached.add(r);
      else if (fns.get(r)?.file === def.file) walk(r, def.file);
    }
  };
  walk(fn);
  return reached;
}

/** The handler function an action runs: `tool: handleX` or `tool: asActor(handleX)`. */
function handlerName(tool: string): string {
  const src = readFileSync(
    join(process.cwd(), "app/api/admin/ai/command-bar.ts"),
    "utf8"
  );
  const m = new RegExp(`^\\s+${tool}:\\s*(?:asActor\\()?(\\w+)`, "m").exec(
    src.slice(src.indexOf("export const COMMAND_BAR_HANDLERS"))
  );
  if (!m) throw new Error(`no handler entry for ${tool}`);
  return m[1];
}

describe("every action's rules bind its approver (TASK-194, C-2)", () => {
  it("reads the handlers (self-test)", () => {
    expect(rulesReached("handleChangeUserRole").has("checkRoleAssignment")).toBe(true);
    expect(rulesReached("handleCreateRole").has("mayChangePlatformCatalog")).toBe(true);
    expect(rulesReached("handlePurgeUserData").has("PROTECTED_ROLES")).toBe(true);
    expect(rulesReached("handleSearch").size).toBe(0);
  });

  it("[self-test] reports a planted approver that skips a rule its handler applies", () => {
    const fns = functionRefs([
      {
        name: "planted.ts",
        text: [
          "export async function handleGrant(i) { checkRoleAssignment(i); return grantIt(i); }",
          "function grantIt(i) { return checkPermissionGrant(i); }",
          "export function decideGrant(f) { return checkRoleAssignment(f); }",
        ].join("\n"),
      },
    ]);
    const handler = rulesReached("handleGrant", fns);
    const approver = rulesReached("decideGrant", fns);
    expect([...handler].sort()).toEqual(["checkPermissionGrant", "checkRoleAssignment"]);
    expect([...handler].filter((r) => !approver.has(r))).toEqual([
      "checkPermissionGrant",
    ]);
  });

  it.each(Object.keys(COMMAND_BAR_HANDLERS))(
    "%s: an approver is held to every rule its handler applies",
    (tool) => {
      const handler = rulesReached(handlerName(tool));
      // Each entry's pure decision (round 10, I-C: facts read once, then decided) — the function
      // whose rules are read here.
      const entry = (
        APPROVER_RULES as Record<string, { decide: { name: string } } | undefined>
      )[tool]?.decide;
      if (handler.size === 0) return; // no rule beyond the page permission
      expect({ tool, hasEntry: entry !== undefined }).toEqual({ tool, hasEntry: true });
      const approver = rulesReached(entry!.name);
      expect({ tool, missing: [...handler].filter((r) => !approver.has(r)) }).toEqual({
        tool,
        missing: [],
      });
    }
  );
});
