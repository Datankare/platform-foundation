/**
 * platform/admin/input-keys.ts — every key of an action's input is one its schema names, at every
 * depth (TASK-194 round 10, I-A; round 11, item 3)
 *
 * A held action's input is its hold's payload and its proposal step's input. Free text under a
 * key no schema names — at the top or nested, in a rule of a list, say — would be stored there
 * and pass the erasure's register of free-text keys (AUDIT_TEXT_KEYS). So a key is refused, by
 * its path ("rules[0].note"), wherever its schema does not name it:
 *
 *   an object        only the keys of its `properties` (none, when it has none)
 *   a list           each element as its `items` says; with no `items`, an object or a list
 *                    in it is refused as it stands (the walk is only as deep as the schema)
 *   a scalar         an object or list given for it is closed: none of its keys is named
 *   an open value    a schema node with no `type`, `properties`, `items` or `enum` — a config
 *                    entry's value (update_config `value`, request_approval `proposedValue`), whose
 *                    shape is the entry's own; __tests__/input-keys-guard.test.ts allows only those
 *
 * A route body (platform/errors/request-body.ts, readJsonBody — TASK-200, rule 5) is stricter: an
 * open node below the top is open only when it says why — `openBecause: "<why, four words or
 * more>"` (isMarkedOpen), each listed with its reason in open-input-register.json
 * (__tests__/open-input-register.test.ts). One that does not (a field declared `{}`) is read closed
 * (closeUnmarkedOpen): no key under it is named, so every key is refused. The body itself is never
 * open: a top-level open node is read closed, marked or not. The command bar and the config assistant keep the rule above (their two open values
 * are pinned by path in __tests__/input-keys-guard.test.ts, and their schemas, sent to the model
 * as tool definitions, carry no marker).
 *
 * Keys only: the values are the handlers' to check, as before. Chosen over setting
 * `additionalProperties: false` throughout and validating each input with the schema validator:
 * that would also enforce every type, bound and required field at the boundary, refusing inputs
 * the handlers read leniently today (a number sent as a string, a missing optional default) —
 * a change to every caller, not a check of the keys. Pure; no imports.
 */

/** The parts of a JSON Schema node this check reads. */
export interface InputSchemaNode {
  readonly type?: unknown;
  readonly properties?: Readonly<Record<string, InputSchemaNode>>;
  readonly items?: InputSchemaNode;
  readonly enum?: unknown;
  readonly description?: string;
  /**
   * A route body schema's open node says why its value is the caller's own shape (four words or
   * more); without it, readJsonBody reads the node closed (TASK-200, rule 5).
   */
  readonly openBecause?: string;
}

/** A key the schema does not name: its path, and the keys named where it was found. */
export interface UnknownInputKey {
  readonly field: string;
  readonly allowed: readonly string[];
}

/** A node whose value is the caller's own shape (a config entry's value): no key is checked. */
export function isOpenNode(node: InputSchemaNode | undefined): boolean {
  return (
    node !== undefined &&
    node.type === undefined &&
    node.properties === undefined &&
    node.items === undefined &&
    node.enum === undefined
  );
}

/** Whether an open node says why it is open: `openBecause` of four words or more (TASK-200). */
export function isMarkedOpen(node: InputSchemaNode | undefined): boolean {
  return (
    isOpenNode(node) &&
    typeof node?.openBecause === "string" &&
    node.openBecause.trim().split(/\s+/).filter(Boolean).length >= 4
  );
}

/** What an unmarked open node is read as in a route body: an object that names no key. */
const CLOSED: InputSchemaNode = Object.freeze({ type: "object", properties: {} });

const closedCache = new WeakMap<InputSchemaNode, InputSchemaNode>();

/**
 * The schema as a route body reads it (TASK-200, rule 5: a body schema of `{}` took every key): the
 * top never open — an open top node, marked or not, is read closed — and below it every open node
 * that does not say why (isMarkedOpen) read closed. Marked open nodes below the top, and every other
 * node, are kept as they are. The same schema object gives the same result.
 */
export function closeUnmarkedOpen(schema: InputSchemaNode): InputSchemaNode {
  // The body itself: never open, whatever it says.
  return isOpenNode(schema) ? CLOSED : closeBelow(schema);
}

function closeBelow(schema: InputSchemaNode): InputSchemaNode {
  const cached = closedCache.get(schema);
  if (cached) return cached;
  let out: InputSchemaNode;
  if (isOpenNode(schema)) {
    out = isMarkedOpen(schema) ? schema : CLOSED;
  } else {
    const properties = schema.properties
      ? Object.fromEntries(
          Object.entries(schema.properties).map(([k, v]) => [k, closeBelow(v)])
        )
      : undefined;
    out = {
      ...schema,
      ...(properties ? { properties } : {}),
      ...(schema.items ? { items: closeBelow(schema.items) } : {}),
    };
  }
  closedCache.set(schema, out);
  return out;
}

/**
 * The paths of a route body schema's open nodes that are read closed ("" for the top, which always
 * is): unmarked, or the top.
 */
export function unmarkedOpenNodes(schema: InputSchemaNode, path = ""): string[] {
  if (isOpenNode(schema)) return path !== "" && isMarkedOpen(schema) ? [] : [path];
  return [
    ...Object.entries(schema.properties ?? {}).flatMap(([k, v]) =>
      unmarkedOpenNodes(v, path === "" ? k : `${path}.${k}`)
    ),
    ...(schema.items ? unmarkedOpenNodes(schema.items, `${path}[]`) : []),
  ];
}

/** The first key of `value` that `schema` does not name, at any depth; null when there is none. */
export function unknownInputKey(
  schema: InputSchemaNode | undefined,
  value: unknown,
  path = ""
): UnknownInputKey | null {
  if (value === null || typeof value !== "object") return null;
  if (isOpenNode(schema)) return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      // A list its schema gives no `items` holds no shape: an object or a list in it is refused
      // as it stands, never walked — so the walk is only ever as deep as the schema is.
      if (!schema?.items) {
        if (value[i] !== null && typeof value[i] === "object")
          return { field: `${path}[${i}]`, allowed: [] };
        continue;
      }
      const found = unknownInputKey(schema.items, value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  const properties = schema?.properties ?? {};
  const allowed = Object.keys(properties);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const at = path === "" ? key : `${path}.${key}`;
    if (!Object.prototype.hasOwnProperty.call(properties, key))
      return { field: at, allowed };
    const found = unknownInputKey(properties[key], child, at);
    if (found) return found;
  }
  return null;
}

/** How an input's keys are refused: the code and its params, or null when every key is one. */
export type InputKeyRefusal =
  | {
      readonly code: "request.field_not_accepted" | "request.unknown_input_none";
      readonly params: { readonly field: string };
    }
  | {
      readonly code: "request.unknown_input";
      readonly params: { readonly field: string; readonly allowed: readonly string[] };
    };

/**
 * Why `input`'s keys cannot be taken, or null (round 12, nits 1 and 2). A key the server sets for
 * this action (`serverSet`, at the top) is `request.field_not_accepted` — the server's to set,
 * never a caller's; any other key the schema does not name, at any depth, is
 * `request.unknown_input` with the keys allowed there, or `request.unknown_input_none` where
 * nothing is (an object given for a string, an element of a list of plain values).
 */
export function inputKeyRefusal(
  schema: InputSchemaNode | undefined,
  input: Readonly<Record<string, unknown>>,
  serverSet: ReadonlySet<string> = new Set()
): InputKeyRefusal | null {
  const server = Object.keys(input).find((k) => serverSet.has(k));
  if (server !== undefined)
    return { code: "request.field_not_accepted", params: { field: server } };
  const unknown = unknownInputKey(schema, input);
  if (unknown === null) return null;
  return unknown.allowed.length > 0
    ? {
        code: "request.unknown_input",
        params: { field: unknown.field, allowed: [...unknown.allowed] },
      }
    : { code: "request.unknown_input_none", params: { field: unknown.field } };
}

/**
 * A configuration value, as a route body declares one (TASK-203, N-31: every body read with a
 * schema, none left open): a scalar, a list of scalars, or a list of pairs — the two governed lists
 * whose entries hold more than text, `agent.capability_features` (`[capability, [feature, …]]`)
 * and `agent.trusted_agents` (`[agentId, { owner, scopes, status, maxTokenTtl, displayName }]`). A key no entry
 * of either has is refused here; the value itself is the entry's to check (validateConfigValue).
 * __tests__/db/config-value-schema.db.test.ts holds every seeded value and default to it, so a new
 * setting of another shape fails there before a route refuses it.
 */
export const CONFIG_VALUE_SCHEMA: InputSchemaNode = Object.freeze({
  description: "a configuration value: a scalar, a list, or a list of pairs",
  items: Object.freeze({
    items: Object.freeze({
      // A pair's second element: a list of names, or a trusted agent's record.
      properties: Object.freeze({
        owner: Object.freeze({ type: "string" }),
        scopes: Object.freeze({
          type: "array",
          items: Object.freeze({ type: "string" }),
        }),
        status: Object.freeze({ type: "string" }),
        maxTokenTtl: Object.freeze({ type: "number" }),
        displayName: Object.freeze({ type: "string" }),
      }),
      items: Object.freeze({ type: "string" }),
    }),
  }),
});

/**
 * One schema naming every key any of `nodes` names, at every depth (TASK-203, N-31): the body of a
 * route that takes several actions' inputs (the command bar's plan, the config assistant's tool)
 * names each action's keys and no other — the action's own schema then checks its input exactly.
 * An open node (no type, properties, items or enum) contributes nothing: the merge names only what
 * some node names, so a merged schema is never open.
 */
export function mergeInputSchemas(nodes: readonly InputSchemaNode[]): InputSchemaNode {
  const withProps = nodes.filter((n) => n.properties !== undefined);
  const withItems = nodes.filter((n) => n.items !== undefined);
  const keys = [...new Set(withProps.flatMap((n) => Object.keys(n.properties ?? {})))];
  const properties = Object.fromEntries(
    keys.map((k) => [
      k,
      mergeInputSchemas(
        withProps
          .map((n) => n.properties?.[k])
          .filter((x): x is InputSchemaNode => x !== undefined)
      ),
    ])
  );
  const merged: { type: string; properties: typeof properties; items?: InputSchemaNode } =
    {
      type: "object",
      properties,
    };
  if (withItems.length > 0)
    merged.items = mergeInputSchemas(withItems.map((n) => n.items!));
  return merged;
}

/**
 * `schema` with each open node below its top replaced by `replacement` (TASK-203, N-31): a tool
 * whose input has a value of the caller's own shape — the config assistant's `value` and
 * `proposedValue` — is read by a route against what that value may hold (CONFIG_VALUE_SCHEMA),
 * never left open.
 */
export function withOpenAs(
  schema: InputSchemaNode,
  replacement: InputSchemaNode
): InputSchemaNode {
  const below = (node: InputSchemaNode): InputSchemaNode =>
    isOpenNode(node)
      ? replacement
      : {
          ...node,
          ...(node.properties
            ? {
                properties: Object.fromEntries(
                  Object.entries(node.properties).map(([k, v]) => [k, below(v)])
                ),
              }
            : {}),
          ...(node.items ? { items: below(node.items) } : {}),
        };
  return isOpenNode(schema) ? schema : below(schema);
}
