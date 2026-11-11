/**
 * __tests__/input-keys-guard.test.ts — every input key a handler reads is its tool schema's, or
 * one the server sets (TASK-194 round 11, item 2 and item 3; round 12, I-3 and nit 6)
 *
 * @guard a handler reading an input key its tool schema does not name
 *
 * The command bar and the config assistant refuse any input key their tool's schema does not name
 * (platform/admin/input-keys.ts, at every depth). A handler that reads a key its schema omits is
 * then a legitimate input refused — round 10 omitted P10's `confirmed`, and then `scope`, which
 * update_config and request_approval read. This compares, by reading the code
 * (__tests__/helpers/input-reads-scan.ts), each key a handler reads — through every function of
 * its files it passes its input to, an approver rule's `facts`, `beforeFacts` and `decide` among
 * them — with its schema's properties, both ways. A key the server sets for a tool, never a
 * caller, is listed per tool with why in the source (SERVER_SET_INPUTS, CONFIG_SERVER_SET_INPUTS),
 * and a caller's is refused as request.field_not_accepted. A handler that reads every key must
 * say how it bounds them (WHOLE). Anything the scan cannot follow fails — a call, a use of the
 * input it does not know, an approver rule member it cannot resolve or does not know (round 12,
 * I-3: the header promised this and the scan let some through).
 *
 * Its other half: no schema node is open (its value's own shape, keys unchecked) but a config
 * entry's value — the one place a key below the top is not the schema's.
 */

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { functionsOf, inputReads, type Functions } from "./helpers/input-reads-scan";
import {
  actionInputSchema,
  COMMAND_BAR_HANDLERS,
  SERVER_SET_INPUTS,
} from "@/app/api/admin/ai/command-bar";
import { PANEL_TOOL_SCHEMAS, SHARED_TOOLS } from "@/app/api/admin/ai/tool-schemas";
import { CONFIG_SERVER_SET_INPUTS, CONFIG_TOOLS } from "@/platform/admin/config-handlers";
import {
  isOpenNode,
  unknownInputKey,
  type InputSchemaNode,
} from "@/platform/admin/input-keys";
import type { AdminToolId } from "@/app/api/admin/ai/tool-permissions";
import { HELD_CURRENT_ROLE } from "@/app/api/admin/ai/handlers/roles";

const ROOT = process.cwd();
const HANDLERS_DIR = join(ROOT, "app/api/admin/ai/handlers");
const CONFIG_FILE = join(ROOT, "platform/admin/config-handlers.ts");
const COMMAND_BAR_FILE = join(ROOT, "app/api/admin/ai/command-bar.ts");

/** The members an approver rule may have: each is scanned (shared.ts ApproverRule). */
const RULE_MEMBERS = ["facts", "beforeFacts", "decide"];

/** Handlers that read every key, and the keys they bound it to (each must be the schema's). */
const WHOLE: Readonly<Record<string, { why: string; keys: () => string[] }>> = {
  handleUpdatePasswordPolicy: {
    why: "maps each key through FIELDS; applyPasswordPolicyChange refuses any other",
    keys: () => {
      const src = readFileSync(join(HANDLERS_DIR, "config.ts"), "utf8");
      const body = /const FIELDS[^{]*\{([^}]*)\}/.exec(src)?.[1] ?? "";
      return [...body.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    },
  },
};

/** The handler function an action runs: `tool: handleX` or `tool: asActor(handleX)`. */
function commandBarHandler(tool: string): string {
  const src = readFileSync(COMMAND_BAR_FILE, "utf8");
  const block = src.slice(src.indexOf("export const COMMAND_BAR_HANDLERS"));
  const m = new RegExp(`^\\s+${tool}:\\s*(?:asActor\\()?(\\w+)`, "m").exec(block);
  if (!m) throw new Error(`no handler entry for ${tool}`);
  return m[1];
}

/** The approver rule object an action names in APPROVER_RULES, if any. */
function approverRule(tool: string): string | undefined {
  const src = readFileSync(COMMAND_BAR_FILE, "utf8");
  const start = src.indexOf("export const APPROVER_RULES");
  const block = src.slice(start, src.indexOf("};", start));
  return new RegExp(`^\\s+${tool}:\\s*(\\w+)`, "m").exec(block)?.[1];
}

/** The handler a config tool runs: `execute: async (input) => (await handleX(input …`. */
function configHandler(toolId: string): string {
  const src = readFileSync(CONFIG_FILE, "utf8");
  const at = src.indexOf(`id: "${toolId}"`);
  const m = /execute:\s*async\s*\([^)]*\)\s*=>[\s(]*await\s+(\w+)\(/.exec(src.slice(at));
  if (at < 0 || !m) throw new Error(`no handler for ${toolId}`);
  return m[1];
}

/** A key as the scan names it: a constant's read as `[NAME]`, by its value. */
const CONSTANTS: Readonly<Record<string, string>> = {
  [`[HELD_CURRENT_ROLE]`]: HELD_CURRENT_ROLE,
};
const keyName = (k: string) => CONSTANTS[k] ?? k;

/** Each read of `starts` its schema does not name (nor the server sets for it), and all else. */
function mismatches(
  label: string,
  fns: Functions,
  starts: readonly string[],
  schema: InputSchemaNode,
  serverSet: Readonly<Record<string, unknown>> = {}
): string[] {
  const named = Object.keys(schema.properties ?? {});
  const out: string[] = [];
  for (const start of starts) {
    const reads = inputReads(fns, start);
    for (const key of reads.keys.keys())
      if (!named.includes(keyName(key)) && !(keyName(key) in serverSet))
        out.push(`${label}: reads ${key} (${[...reads.keys.get(key)!].join(", ")})`);
    for (const fn of reads.whole) {
      const bound = WHOLE[fn];
      if (!bound) out.push(`${label}: ${fn} reads every key, unbounded`);
      else
        for (const key of bound.keys())
          if (!named.includes(key)) out.push(`${label}: ${fn} reads ${key}`);
    }
    for (const fn of reads.dynamic) out.push(`${label}: ${fn} reads a computed key`);
    for (const what of reads.unresolved) out.push(`${label}: ${what}`);
  }
  return out;
}

const handlerFiles = () =>
  readdirSync(HANDLERS_DIR)
    .filter((n) => n.endsWith(".ts"))
    .map((n) => join(HANDLERS_DIR, n));

/** The members of approver rule `rule` that no approver rule has (round 12, I-3; round 13). */
function unregisteredMembers(rule: string, fns: Functions): string[] {
  return [
    ...[...fns.keys()].filter((k) => k.startsWith(`${rule}.`)),
    ...[...fns.unresolvedMembers.keys()].filter((k) => k.startsWith(`${rule}.`)),
  ].filter((m) => !RULE_MEMBERS.includes(m.slice(rule.length + 1)));
}

/**
 * What a command-bar action's handler and its approver rule start from, and what of the rule
 * cannot be scanned: a member it cannot resolve, or one no rule has (round 12, I-3).
 */
function commandBarStarts(
  tool: string,
  fns: Functions
): { starts: string[]; problems: string[] } {
  const rule = approverRule(tool);
  if (!rule) return { starts: [commandBarHandler(tool)], problems: [] };
  const problems = [
    ...unregisteredMembers(rule, fns).map(
      (m) => `${tool}: ${m} is no member an approver rule has (not scanned)`
    ),
    ...[...fns.unresolvedMembers]
      .filter(([k]) => k.startsWith(`${rule}.`))
      .map(([k, why]) => `${tool}: ${k} cannot be followed — ${why}`),
  ];
  if (!fns.has(`${rule}.decide`))
    problems.push(`${tool}: ${rule} has no decide it can follow`);
  return {
    starts: [
      commandBarHandler(tool),
      ...RULE_MEMBERS.map((m) => `${rule}.${m}`).filter((m) => fns.has(m)),
    ],
    problems,
  };
}

describe("every key a handler reads is its schema's, or the server's (round 11, item 2)", () => {
  it("[self-test] reads the code: a key a handler reads that its schema omits is caught", () => {
    const fns = functionsOf([CONFIG_FILE]);
    const update = CONFIG_TOOLS.find((t) => t.id === "update_config")!;
    const props = { ...(update.inputSchema as InputSchemaNode).properties };
    // The round-10 schemas: no scope.
    delete (props as Record<string, unknown>).scope;
    expect(
      mismatches(
        "update_config",
        fns,
        ["handleUpdateConfig"],
        { properties: props },
        CONFIG_SERVER_SET_INPUTS.update_config
      )
    ).toEqual([
      expect.stringMatching(/^update_config: reads scope \(handleUpdateConfig/),
    ]);
    // A rule's own reads are followed (the erasure's beforeFacts reads userId), a factory-built
    // member's too (delete_role's facts read role_name through roleNamed's computed key).
    const bar = functionsOf(handlerFiles());
    expect(inputReads(bar, "purgeUserDataRule.beforeFacts").keys.has("userId")).toBe(
      true
    );
    expect([...inputReads(bar, "deleteRoleRule.facts").keys.keys()]).toEqual([
      "role_name",
    ]);
    expect([...inputReads(bar, "duplicateRoleRule.facts").keys.keys()]).toEqual([
      "source_role",
    ]);
    expect(inputReads(bar, "handleChangeUserRole").keys.has("[HELD_CURRENT_ROLE]")).toBe(
      true
    );
    // A handler that reads every key (through `input ?? {}`) is seen as one.
    expect([...inputReads(bar, "handleUpdatePasswordPolicy").whole]).toEqual([
      "handleUpdatePasswordPolicy",
    ]);
  });

  it.each(
    (Object.keys(COMMAND_BAR_HANDLERS) as AdminToolId[]).filter((t) => t !== "search")
  )("command bar: %s", (tool) => {
    const fns = functionsOf(handlerFiles());
    const { starts, problems } = commandBarStarts(tool, fns);
    expect([
      ...problems,
      ...mismatches(tool, fns, starts, actionInputSchema(tool), SERVER_SET_INPUTS[tool]),
    ]).toEqual([]);
  });

  it.each(CONFIG_TOOLS.map((t) => t.id))("config assistant: %s", (toolId) => {
    const fns = functionsOf([CONFIG_FILE]);
    const schema = CONFIG_TOOLS.find((t) => t.id === toolId)!
      .inputSchema as InputSchemaNode;
    expect(
      mismatches(
        toolId,
        fns,
        [configHandler(toolId)],
        schema,
        CONFIG_SERVER_SET_INPUTS[toolId]
      )
    ).toEqual([]);
  });

  it("every server-set key is read by its tool's handler, and is no key of its schema", () => {
    const out: string[] = [];
    const bar = functionsOf(handlerFiles());
    for (const [tool, keys] of Object.entries(SERVER_SET_INPUTS)) {
      const read = new Set(
        commandBarStarts(tool, bar).starts.flatMap((s) =>
          [...inputReads(bar, s).keys.keys()].map(keyName)
        )
      );
      const named = Object.keys(actionInputSchema(tool as AdminToolId).properties ?? {});
      for (const k of Object.keys(keys ?? {})) {
        if (!read.has(k)) out.push(`${tool}.${k}: not read`);
        if (named.includes(k)) out.push(`${tool}.${k}: in its schema`);
      }
    }
    const cfg = functionsOf([CONFIG_FILE]);
    for (const [tool, keys] of Object.entries(CONFIG_SERVER_SET_INPUTS)) {
      const read = new Set(inputReads(cfg, configHandler(tool)).keys.keys());
      const schema = CONFIG_TOOLS.find((t) => t.id === tool)!
        .inputSchema as InputSchemaNode;
      for (const k of Object.keys(keys)) {
        if (!read.has(k)) out.push(`${tool}.${k}: not read`);
        if (k in (schema.properties ?? {})) out.push(`${tool}.${k}: in its schema`);
      }
    }
    expect(out).toEqual([]);
  });
});

// Round 12, I-3: each way an input can get past a reading of the code, planted.
describe("the scan reports what it cannot follow (round 12, I-3)", () => {
  const plant = (text: string): Functions => {
    const dir = mkdtempSync(join(tmpdir(), "input-reads-"));
    const file = join(dir, "planted.ts");
    writeFileSync(file, text);
    return functionsOf([file]);
  };
  const reads = (text: string, fn = "h") => inputReads(plant(text), fn);

  it.each([
    [
      "computed destructuring",
      "function h(input: any) { const { [k]: v } = input; }",
      "dynamic",
    ],
    ["`k in input`", "function h(input: any) { return k in input ? 1 : 0; }", "dynamic"],
    [
      "`for (… in input)`",
      "function h(input: any) { for (const k in input) log(k); }",
      "whole",
    ],
    [
      "a rest element",
      "function h(input: any) { const { a, ...rest } = input; }",
      "whole",
    ],
    [
      "an alias assigned later",
      "function h(input: any) { let x; x = input; }",
      "unresolved",
    ],
    [
      "the input inside an object",
      "function h(input: any) { g({ input }); }",
      "unresolved",
    ],
    ["the input inside a list", "function h(input: any) { g([input]); }", "unresolved"],
    ["the input returned", "function h(input: any) { return input; }", "unresolved"],
    [
      "a call it cannot follow",
      "function h(input: any) { other.run(input); }",
      "unresolved",
    ],
  ] as const)("%s", (_name, text, kind) => {
    const r = reads(text);
    const got = {
      dynamic: r.dynamic.size > 0,
      whole: r.whole.size > 0,
      unresolved: r.unresolved.size > 0,
    };
    expect(got[kind]).toBe(true);
  });

  it('`"x" in input` and a literal-bound factory key are reads, not failures', () => {
    expect([
      ...reads(`function h(input: any) { return "x" in input; }`).keys.keys(),
    ]).toEqual(["x"]);
    const fns = plant(`
      function named(key: string) { return (input: any) => input[key]; }
      export const r = { facts: named("role_name"), decide: (input: any) => input.b };
    `);
    expect([...inputReads(fns, "r.facts").keys.keys()]).toEqual(["role_name"]);
  });

  // Round 13, nit 3: a name two files define, and a rest parameter, are not followed.
  it("a function two files define, or a rest parameter, is reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "input-reads-"));
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    writeFileSync(
      a,
      "export function h(input: any) { return check(input); }\nfunction check(i: any) { return i.a; }"
    );
    writeFileSync(b, "function check(i: any) { return i.secret; }");
    const twice = inputReads(functionsOf([a, b]), "h");
    expect([...twice.unresolved]).toEqual([
      expect.stringMatching(/^check \(defined in more than one file/),
    ]);
    const rest = reads(
      "function h(input: any) { log(1, input); }\nfunction log(n: number, ...xs: any[]) { return xs; }"
    );
    expect([...rest.unresolved]).toEqual([
      expect.stringMatching(/^log \(the input passed to its rest parameter/),
    ]);
  });

  // Round 13, nit 4: a rule member no approver rule has is reported by the guard.
  it("the guard reports a member no approver rule has", () => {
    const fns = plant(`
      function decideX(input: any) { return input.a; }
      export const someRule = { facts: (input: any) => input.a, decide: decideX, extra: decideX };
    `);
    const members = [...fns.keys()].filter((k) => k.startsWith("someRule."));
    expect(
      members.filter((m) => !RULE_MEMBERS.includes(m.slice("someRule.".length)))
    ).toEqual(["someRule.extra"]);
    expect(unregisteredMembers("someRule", fns)).toEqual(["someRule.extra"]);
  });

  it("an approver rule member it cannot resolve, or no rule has, is reported", () => {
    const fns = plant(`
      function named(key: string) { return (input: any) => input[key]; }
      function decideX(input: any) { return input.a; }
      export const okRule = { facts: named("a"), decide: decideX };
      export const badRule = { facts: named(KEY), decide: decideX, extra: decideX };
      export const methodRule = { decide(input: any) { return input.a; } };
    `);
    expect(fns.unresolvedMembers.get("badRule.facts")).toMatch(/factory it cannot bind/);
    expect(fns.unresolvedMembers.get("methodRule.decide")).toMatch(/a method/);
    expect(fns.has("badRule.extra")).toBe(true);
    expect(fns.unresolvedMembers.has("okRule.facts")).toBe(false);
  });
});

/** The keys `starts` read, with a whole reader's bound keys. */
function readKeys(fns: Functions, starts: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const start of starts) {
    const reads = inputReads(fns, start);
    reads.keys.forEach((_, k) => keys.add(k));
    for (const fn of reads.whole) for (const k of WHOLE[fn]?.keys() ?? []) keys.add(k);
  }
  return keys;
}

// The other direction (round 11: set_approval_policy's schema required `default_approver`, and
// its handler never read it — the admin's choice taken and dropped).
describe("every key a schema names is read by its handler (round 11, item 2)", () => {
  it.each(
    (Object.keys(COMMAND_BAR_HANDLERS) as AdminToolId[]).filter((t) => t !== "search")
  )("command bar: %s", (tool) => {
    const fns = functionsOf(handlerFiles());
    const read = readKeys(fns, commandBarStarts(tool, fns).starts);
    const named = Object.keys(actionInputSchema(tool).properties ?? {});
    expect({ tool, unread: named.filter((k) => !read.has(k)) }).toEqual({
      tool,
      unread: [],
    });
  });

  it.each(CONFIG_TOOLS.map((t) => t.id))("config assistant: %s", (toolId) => {
    const fns = functionsOf([CONFIG_FILE]);
    const read = readKeys(fns, [configHandler(toolId)]);
    const schema = CONFIG_TOOLS.find((t) => t.id === toolId)!
      .inputSchema as InputSchemaNode;
    const named = Object.keys(schema.properties ?? {});
    expect({ toolId, unread: named.filter((k) => !read.has(k)) }).toEqual({
      toolId,
      unread: [],
    });
  });
});

describe("the key check reads every depth (round 11, item 3)", () => {
  const schema: InputSchemaNode = {
    type: "object",
    properties: {
      name: { type: "string" },
      rules: {
        type: "array",
        items: { type: "object", properties: { max_risk: { type: "string" } } },
      },
      tags: { type: "array", items: { type: "string" } },
      value: { description: "open: the entry's own shape" },
    },
  };

  it.each([
    [
      { name: "x", why: "t" },
      { field: "why", allowed: ["name", "rules", "tags", "value"] },
    ],
    [
      { rules: [{ max_risk: "x" }, { note: "t" }] },
      { field: "rules[1].note", allowed: ["max_risk"] },
    ],
    [{ name: { first: "t" } }, { field: "name.first", allowed: [] }],
    [{ tags: [{ a: 1 }] }, { field: "tags[0].a", allowed: [] }],
    [{ name: [{ a: 1 }] }, { field: "name[0]", allowed: [] }],
    [{ rules: { 0: { max_risk: "x" } } }, { field: "rules.0", allowed: [] }],
  ])("refuses %j", (input, expected) => {
    expect(unknownInputKey(schema, input)).toEqual(expected);
  });

  it("walks no deeper than the schema: a deeply nested list is refused at once", () => {
    let deep: unknown = [];
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    expect(unknownInputKey(schema, { name: deep })).toEqual({
      field: "name[0]",
      allowed: [],
    });
  });

  it.each([
    [{ name: "x", rules: [{ max_risk: "x" }], tags: ["a"] }],
    [{ value: { anything: { at: ["any", { depth: 1 }] } } }],
    [{}],
  ])("takes %j", (input) => {
    expect(unknownInputKey(schema, input)).toBeNull();
  });

  it("no schema node is open but a config entry's value", () => {
    const open: string[] = [];
    const walk = (node: InputSchemaNode | undefined, path: string) => {
      if (!node) return;
      if (isOpenNode(node)) open.push(path);
      for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, `${path}.${k}`);
      if (node.items) walk(node.items, `${path}[]`);
    };
    for (const t of [...SHARED_TOOLS, ...Object.values(PANEL_TOOL_SCHEMAS).flat()])
      walk(t.input_schema as InputSchemaNode, t.name);
    for (const t of CONFIG_TOOLS) walk(t.inputSchema as InputSchemaNode, t.id);
    expect(open.sort()).toEqual([
      "request_approval.proposedValue",
      "update_config.value",
    ]);
  });
});
