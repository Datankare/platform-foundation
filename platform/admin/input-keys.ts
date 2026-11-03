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
