/**
 * __tests__/role-writes.test.ts — a user's role changes only through assignUserRole (TASK-194, C-5)
 *
 * @guard a write of a user's role outside the one audited writer
 *
 * The role rules were wired into the admin pages and the command bar, while the operator's
 * "make administrator" set users.role_id on its own, with no rule: one operator could demote a
 * super_admin by making their address a tenant's admin. Now every statement that changes
 * users.role_id is in platform/auth/role-assignment.ts, which applies checkRoleAssignment. This
 * reads every SQL text in the production sources (string and template literals) and fails on an
 * UPDATE of users that sets role_id anywhere else. A new account's role is set by the INSERT
 * that creates it (user provisioning: the default role, which carries no staff permission —
 * role-governance rule 4); that is not a change of role and is listed.
 */

import * as ts from "typescript";
import { productionSources, read } from "./helpers/route-policy";

const ROLE_WRITER = "platform/auth/role-assignment.ts";

/** INSERTs into users that set role_id: a new account's role, never a change. */
const ACCOUNT_CREATION: Readonly<Record<string, string>> = {
  "platform/auth/user-provisioning.ts":
    "creates the account on its first request with the default role (DEFAULT_USER_ROLE), which rule 4 keeps free of staff permissions",
};

const UPDATE_ROLE =
  /\bupdate\s+(?:public\.)?users\s[\s\S]*?\bset\s[\s\S]*?\brole_id\s*=/i;
const INSERT_ROLE = /\binsert\s+into\s+(?:public\.)?users\s*\([^)]*\brole_id\b/i;

/** Every string and template literal's text in `src`. */
function literals(file: string, src: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) out.push(n.getText());
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function offenders(files: readonly { path: string; text: string }[]) {
  const updates: string[] = [];
  const inserts: string[] = [];
  for (const { path, text } of files) {
    for (const sql of literals(path, text)) {
      if (UPDATE_ROLE.test(sql) && path !== ROLE_WRITER) updates.push(path);
      if (INSERT_ROLE.test(sql) && !(path in ACCOUNT_CREATION)) inserts.push(path);
    }
  }
  return { updates: [...new Set(updates)], inserts: [...new Set(inserts)] };
}

describe("users.role_id changes only through assignUserRole (TASK-194, C-5)", () => {
  const files = productionSources().map((f) => ({ path: f, text: read(f) }));

  it("finds the one writer (self-test)", () => {
    const writer = files.find((f) => f.path === ROLE_WRITER);
    expect(
      writer && literals(ROLE_WRITER, writer.text).some((s) => UPDATE_ROLE.test(s))
    ).toBe(true);
  });

  it("no other production statement changes a user's role", () => {
    expect(offenders(files)).toEqual({ updates: [], inserts: [] });
  });

  it("[self-test] recognises a role write in any literal form", () => {
    expect(
      offenders([
        { path: "a.ts", text: 'q("update users set role_id = $2 where id = $1")' },
        { path: "b.ts", text: "q(`UPDATE public.users u\n  SET role_id = (select 1)`)" },
        { path: "c.ts", text: 'q("insert into users (id, role_id) values ($1, $2)")' },
        { path: "d.ts", text: 'q("update users set last_login_at = now()")' },
      ])
    ).toEqual({ updates: ["a.ts", "b.ts"], inserts: ["c.ts"] });
  });
});
