/**
 * __tests__/cognito-admin-actions.test.ts — the Cognito administrative key's needs, stated once
 * (N-23)
 *
 * @guard a Cognito action signed with the administrative key that the contract, ENV_REFERENCE or
 * the IAM policy in TENANCY_OPERATIONS §3.3 does not name — or a documented action no code signs
 *
 * The contract's hint and ENV_REFERENCE once named six actions and "shared mode only", while
 * erasure (in every mode) needs ListUsers and AdminDeleteUser: an operator who followed either got
 * a deployment where no identity is ever erased. COGNITO_ADMIN_ACTIONS
 * (platform/providers/environment-contract.ts) is the one list — the live inline policy
 * `cognito-tenancy-and-erasure`; this test holds the provider, the hint and both documents to it.
 * The provider is the repository's own (Playform keeps its own Cognito provider and its own copy
 * of this test, which reads its modules).
 */
import { readFileSync } from "fs";
import { join } from "path";
import * as ts from "typescript";
import {
  COGNITO_ADMIN_ACTIONS,
  COGNITO_ADMIN_POLICY,
  ENVIRONMENT_CONTRACT,
} from "@/platform/providers/environment-contract";

const ROOT = join(__dirname, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

/** The actions a source signs with administrative credentials: callCognito(config, "X", body, creds). */
export function signedActions(text: string): string[] {
  const sf = ts.createSourceFile("p.ts", text, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "callCognito" &&
      n.arguments.length >= 4 &&
      ts.isStringLiteralLike(n.arguments[1])
    )
      found.add(n.arguments[1].text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...found].sort();
}

/** The actions of the IAM policy shown in TENANCY_OPERATIONS §3.3. */
function policyActions(doc: string): string[] {
  const section = doc.slice(doc.indexOf("### 3.3 The IAM key"));
  const json = /```json\n([\s\S]*?)```/.exec(section)?.[1] ?? "{}";
  const policy = JSON.parse(json) as { Statement: { Action: string[] }[] };
  return policy.Statement.flatMap((s) => s.Action)
    .map((a) => a.replace(/^cognito-idp:/, ""))
    .sort();
}

/** The actions the policy-simulator command of TENANCY_OPERATIONS §3.3 asks about. */
export function simulatedActions(doc: string): string[] {
  const section = doc.slice(doc.indexOf("### 3.3 The IAM key"));
  const command =
    /^aws iam simulate-principal-policy .*$/m.exec(
      section.slice(0, section.indexOf("\n### 3.4"))
    )?.[0] ?? "";
  return [...command.matchAll(/\bcognito-idp:([A-Za-z]+)/g)]
    .map((m) => m[1])
    .filter((a) => a !== "REGION")
    .sort();
}

describe("the Cognito administrative key's actions are stated once (N-23)", () => {
  const listed = [...COGNITO_ADMIN_ACTIONS].sort();

  it("the provider signs exactly the listed actions", () => {
    expect(signedActions(read("platform/auth/cognito-provider.ts"))).toEqual(listed);
  });

  it("the contract's hint names every action, the policy and any tenancy mode", () => {
    const hint = ENVIRONMENT_CONTRACT.find(
      (s) => s.name === "COGNITO_ADMIN_ACCESS_KEY_ID"
    )!.shapeHint;
    for (const a of listed) expect(hint).toContain(a);
    expect(hint).toContain(COGNITO_ADMIN_POLICY);
    expect(hint).toMatch(/any tenancy mode/);
  });

  it("TENANCY_OPERATIONS §3.3's policy is the list, and is named", () => {
    const doc = read("docs/TENANCY_OPERATIONS.md");
    expect(policyActions(doc)).toEqual(listed);
    expect(doc).toContain(`\`${COGNITO_ADMIN_POLICY}\``);
  });

  it("§3.3's policy-simulator check asks about exactly the listed actions, on one line a shell can paste (ADR-057 D7)", () => {
    const doc = read("docs/TENANCY_OPERATIONS.md");
    expect(simulatedActions(doc)).toEqual(listed);
    const command = /^aws iam simulate-principal-policy .*$/m.exec(doc)![0];
    // zsh-paste-safe: no comment, no unquoted parenthesis; the query is single-quoted.
    expect(command).not.toMatch(/#/);
    expect(command.replace(/'[^']*'/g, "")).not.toMatch(/[()`!]/);
    expect(command).toContain(
      "--resource-arns arn:aws:cognito-idp:REGION:ACCOUNT:userpool/POOL_ID"
    );
  });

  it("[self-test] the simulator reader sees an action missing from, or added to, the command", () => {
    const doc = (actions: string) =>
      `### 3.3 The IAM key\n\naws iam simulate-principal-policy --action-names ${actions} --output text\n\n### 3.4 Next`;
    expect(
      simulatedActions(doc("cognito-idp:AdminGetUser cognito-idp:ListUsers"))
    ).toEqual(["AdminGetUser", "ListUsers"]);
    expect(simulatedActions(doc("cognito-idp:AdminGetUser"))).not.toEqual([
      "AdminGetUser",
      "ListUsers",
    ]);
    expect(simulatedActions("### 3.3 The IAM key\n\nno command\n\n### 3.4 Next")).toEqual(
      []
    );
  });

  it("ENV_REFERENCE names every action and the policy, and does not limit the key to shared mode", () => {
    const row = read("docs/ENV_REFERENCE.md")
      .split("\n")
      .find((l) => l.startsWith("| `COGNITO_ADMIN_ACCESS_KEY_ID`"))!;
    for (const a of listed) expect(row).toContain(`\`${a}\``);
    expect(row).toContain(COGNITO_ADMIN_POLICY);
    expect(row).toMatch(/any tenancy mode/);
  });

  it("[self-test] finds a signed action and ignores an unsigned one", () => {
    const planted = [
      'await callCognito(this.config, "AdminDisableUser", { a: 1 }, creds);',
      'await callCognito(this.config, "SignUp", { a: 1 });',
    ].join("\n");
    expect(signedActions(planted)).toEqual(["AdminDisableUser"]);
  });
});
