/**
 * @jest-environment node
 */
/**
 * __tests__/account-action-free-text.test.ts — an action about an account takes free text only
 * under a key the erasure knows (TASK-194 round 9, I-1)
 *
 * A held action's payload is kept on its hold and recorded as its proposal step's input
 * (action-pipeline proposeAction); an agent run's step records its input too (agents/runtime.ts:
 * what its workflow returned). Only those two record an input — a tool run records only its tool's
 * id (tool-invoker's stepInput), any other step only its ids. The erasure of the account strips
 * every audit text key (AUDIT_TEXT_KEYS, platform/auth/audit-details.ts) from each step and hold
 * about it (platform/auth/user-data.ts stepFreeText and proposalsAbout — the same key set in both,
 * round 10, I-B), keeping only an erasure's listed reason. So every string input of an action that
 * names an account (ACCOUNT_TARGET_FIELD) is that account, a listed code (FIXED, with why), or one
 * of those text keys — never free text under another name, which the erasure would keep; and a key
 * outside an action's schema is refused before anything is held or run (round 10, I-A).
 */

import { PANEL_TOOL_SCHEMAS, type AdminTool } from "@/app/api/admin/ai/tool-schemas";
import { ACCOUNT_TARGET_FIELD } from "@/app/api/admin/ai/held-summary";
import { AUDIT_TEXT_KEYS } from "@/platform/auth/audit-details";

/** "<tool>.<input>": a string input that is no free text, and why. */
const FIXED: Readonly<Record<string, string>> = {
  "block_user_feature.feature": "a feature's identifier, from the catalog",
  "unblock_user_feature.feature": "a feature's identifier, from the catalog",
  "change_user_role.new_role": "a role's name, from the catalog",
};

type Node = { type?: string; enum?: unknown[]; properties?: object; items?: Node };

/**
 * Each string input of an account action that is neither its account, FIXED, nor under a text
 * key — at every depth (round 11, item 3: the key check refuses any key a schema does not name,
 * nested too; the erasure strips a text key from a step or hold's input at its top, and with it
 * all below). So a string in a list or an object of an account action is free text the erasure
 * keeps unless its top-level key is a text key, or it is listed in FIXED by its path.
 */
function untracked(tools: readonly AdminTool[]): string[] {
  const out: string[] = [];
  const walk = (tool: string, account: string, top: string, path: string, spec: Node) => {
    if (spec.type === "string" && !spec.enum) {
      if (path === account || FIXED[`${tool}.${path}`]) return;
      if (!AUDIT_TEXT_KEYS.includes(top)) out.push(`${tool}.${path}`);
    }
    for (const [name, child] of Object.entries(
      (spec.properties ?? {}) as Record<string, Node>
    ))
      walk(tool, account, top, `${path}.${name}`, child);
    if (spec.items) walk(tool, account, top, `${path}[]`, spec.items);
  };
  for (const tool of tools) {
    const account = (ACCOUNT_TARGET_FIELD as Record<string, string | undefined>)[
      tool.name
    ];
    if (!account) continue;
    const properties = (tool.input_schema.properties ?? {}) as Record<string, Node>;
    for (const [name, spec] of Object.entries(properties))
      walk(tool.name, account, name, name, spec);
  }
  return out;
}

const tools = Object.values(PANEL_TOOL_SCHEMAS).flat();

it("reads the account actions (self-test)", () => {
  expect(
    tools.filter((t) => (ACCOUNT_TARGET_FIELD as Record<string, string>)[t.name]).length
  ).toBeGreaterThanOrEqual(3);
});

it("catches a planted account action with free text under a key the erasure does not know", () => {
  expect(
    untracked([
      {
        name: "block_user_feature",
        description: "x",
        input_schema: {
          properties: {
            user_id: { type: "string" },
            feature: { type: "string" },
            why_blocked: { type: "string" },
            reason: { type: "string" },
          },
        },
      },
    ])
  ).toEqual(["block_user_feature.why_blocked"]);
});

it("catches free text nested in a list or an object of an account action (round 11, item 3)", () => {
  expect(
    untracked([
      {
        name: "block_user_feature",
        description: "x",
        input_schema: {
          properties: {
            user_id: { type: "string" },
            feature: { type: "string" },
            evidence: {
              type: "array",
              items: { type: "object", properties: { note: { type: "string" } } },
            },
            reason: { type: "object", properties: { detail: { type: "string" } } },
          },
        },
      },
    ])
  ).toEqual(["block_user_feature.evidence[].note"]);
});

it("every string input of an account action is its account, a listed code or a text key", () => {
  expect(untracked(tools)).toEqual([]);
});

it("every listed code is still an input", () => {
  const inputs = new Set(
    tools.flatMap((t) =>
      Object.keys((t.input_schema.properties ?? {}) as object).map(
        (k) => `${t.name}.${k}`
      )
    )
  );
  expect(Object.keys(FIXED).filter((k) => !inputs.has(k))).toEqual([]);
});
