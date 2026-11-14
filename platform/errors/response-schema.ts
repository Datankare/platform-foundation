/**
 * platform/errors/response-schema.ts — every field a route returns is one it declared (TASK-215,
 * audit A-13)
 *
 * A route's request body is read against a declared schema (request-body.ts, TASK-200 rule 5); what
 * it sent back was whatever its handler built — a row read whole, a record with a field added
 * later, a store's object passed through. Now each handler declares the body it answers with, as
 * `tenantRoute(handler, RESPONSE)` (platform/tenancy/route.ts), and every JSON answer is checked
 * against it before it leaves:
 *
 *   an object       the keys of its `properties`, each as it says; with `values`, any other key too
 *                   (a map keyed by data: a count per table, a setting per key), each value as
 *                   `values` says
 *   a list          each element as its `items` says
 *   a scalar        a string, number, boolean or null; an object or list given for it is not one
 *   a stored document  `json: "<why, four words or more>"` — a JSON value kept in a column and
 *                   returned as it is (an audit record's details, a setting's value): any value
 *                   there, and only there. Any other node with no type, properties, items or values
 *                   is read closed
 *
 * An error (status 400 and over) is checked against the registry's one error body (ERROR_BODY:
 * code, message, params, and the two compatibility aliases) — every route answers errors through
 * apiError (respond.ts). A body that is not JSON (a stream, a file, NDJSON) is not checked.
 *
 * What happens to a field nobody declared: outside production the answer fails (an Error naming the
 * fields), so a test or a developer sees it at once; in production it is removed from the answer and
 * the route and the field paths are logged (response.undeclared_fields) — never sent.
 * `__tests__/api-route-response-schema.test.ts` requires every exported handler to declare one.
 *
 * @module platform/errors
 */

import { NextResponse } from "next/server";
import type { InputSchemaNode } from "@/platform/admin/input-keys";
import { logger } from "@/lib/logger";

/** A response schema node: a body schema's, `values` for a map keyed by data, `json` for a document. */
export interface ResponseSchemaNode extends Omit<
  InputSchemaNode,
  "properties" | "items" | "openBecause"
> {
  readonly properties?: Readonly<Record<string, ResponseSchemaNode>>;
  readonly items?: ResponseSchemaNode;
  /** A map: any key, each value as this says (a count per table, a value per setting key). */
  readonly values?: ResponseSchemaNode;
  /** A stored JSON document returned as it is: why (four words or more). */
  readonly json?: string;
  /**
   * At the top of a handler's declaration only: the body its errors answer with, when it is more
   * than ERROR_BODY (errorBodyWith) — a tool's result and its run, beside the refusal's code.
   */
  readonly onError?: ResponseSchemaNode;
}

/** A handler's declared answer: the schema of its success body. */
export type ResponseSchema = ResponseSchemaNode;

/** Every error a route answers: apiError's body (platform/errors/respond.ts). */
export const ERROR_BODY: ResponseSchema = {
  type: "object",
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    // Each code's params, by the registry's kinds (id, number, list): a scalar or a list of them.
    params: {
      type: "object",
      values: {
        type: ["string", "number", "boolean", "array"],
        items: { type: ["string", "number"] },
      },
    },
    success: { type: "boolean" },
    error: { type: "string" },
  },
};

/** ERROR_BODY with fields of a handler's own beside it (its declaration's `onError`). */
export function errorBodyWith(
  extra: Readonly<Record<string, ResponseSchemaNode>>
): ResponseSchemaNode {
  return { type: "object", properties: { ...ERROR_BODY.properties, ...extra } };
}

/** A stored document's node: any value under it — declared, with its reason (four words or more). */
export function stored(why: string): ResponseSchemaNode {
  return { json: why };
}

const SCALARS = ["string", "number", "boolean", "null"] as const;
const SCALAR_LIST: ResponseSchemaNode = { type: "array", items: { type: [...SCALARS] } };

/** A message's params at the innermost level: each a scalar or a list of scalars. */
const INNER_PARAMS: ResponseSchemaNode = {
  type: "object",
  values: { type: [...SCALARS, "array"], items: SCALAR_LIST.items },
};

/** A message nested in another's params: its key and its own params (scalars, lists of them). */
const INNER_MESSAGE: ResponseSchemaNode = {
  type: "object",
  properties: { key: { type: "string" }, params: INNER_PARAMS },
};

/**
 * A message from the catalogue as a screen words it (ShownText: platform/i18n): its key, and the
 * values filled into it — each a scalar, a message of its own, or a list of either (one level).
 */
export const SHOWN: ResponseSchemaNode = {
  type: "object",
  properties: {
    key: { type: "string" },
    params: {
      type: "object",
      values: {
        type: [...SCALARS, "array", "object"],
        items: { type: [...SCALARS, "object"], properties: INNER_MESSAGE.properties },
        properties: INNER_MESSAGE.properties,
      },
    },
  },
};

/** A message's params alone (SHOWN's), where a body carries them beside its own key. */
export const SHOWN_PARAMS: ResponseSchemaNode = SHOWN.properties!.params;

/** A setting's value as stored: whatever its type allows (a number, a text, a list, a document). */
export const SETTING_VALUE: ResponseSchemaNode = stored(
  "a governed setting's stored value, of the type its catalogue entry declares"
);

/** A tool's own result (an admin agent's configuration tool): what it read, or what it proposed. */
export const TOOL_RESULT: ResponseSchemaNode = stored(
  "a tool's own result: the settings it read, or the change it proposed and its approval"
);

/** What a workflow made of its caller's own content, returned to that caller. */
export const RUN_RESULT: ResponseSchemaNode = stored(
  "a workflow's own result for its caller: what it made of the caller's own content"
);

/** A run step's recorded input or output, as its trajectory keeps it. */
export const RUN_STEP_RECORD: ResponseSchemaNode = stored(
  "a run step's recorded input or output, as its trajectory keeps it"
);

/** One step of an agent's run (platform/agents trajectory): what it did, its input and output. */
export const RUN_STEP: ResponseSchemaNode = {
  type: "object",
  properties: {
    stepIndex: { type: "number" },
    action: { type: "string" },
    boundary: { type: "string" },
    cost: { type: "number" },
    durationMs: { type: "number" },
    timestamp: { type: "string" },
    input: RUN_STEP_RECORD,
    output: RUN_STEP_RECORD,
  },
};

/**
 * The declaration of a handler whose success is not JSON — a redirect, a stream, a file, NDJSON —
 * so no JSON body is declared (a JSON answer from it would have to be empty); its errors are still
 * held to ERROR_BODY.
 */
export const NOT_JSON: ResponseSchema = { type: "object", properties: {} };

const isMarkedOpen = (n: ResponseSchemaNode): boolean =>
  typeof n.json === "string" && n.json.trim().split(/\s+/).filter(Boolean).length >= 4;

/**
 * The paths of `value` that `schema` does not declare ("users[0].ip", "page.extra"), at any
 * depth; empty when every field is declared.
 */
export function undeclaredFields(
  schema: ResponseSchemaNode,
  value: unknown,
  path = ""
): string[] {
  if (value === null || typeof value !== "object") return [];
  if (isMarkedOpen(schema)) return [];
  const at = (k: string | number) =>
    typeof k === "number" ? `${path}[${k}]` : path === "" ? k : `${path}.${k}`;
  if (Array.isArray(value)) {
    if (!schema.items) return value.length > 0 ? [path === "" ? "[]" : path] : [];
    return value.flatMap((v, i) =>
      undeclaredFields(schema.items as ResponseSchemaNode, v, at(i))
    );
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const child = schema.properties?.[k] ?? schema.values;
    if (!child) {
      out.push(at(k));
      continue;
    }
    out.push(...undeclaredFields(child, v, at(k)));
  }
  return out;
}

/** `value` with every field `schema` does not declare removed (a copy; the input untouched). */
export function withoutUndeclared(schema: ResponseSchemaNode, value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (isMarkedOpen(schema)) return value;
  if (Array.isArray(value)) {
    if (!schema.items) return [];
    return value.map((v) => withoutUndeclared(schema.items as ResponseSchemaNode, v));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const child = schema.properties?.[k] ?? schema.values;
    if (child) out[k] = withoutUndeclared(child, v);
  }
  return out;
}

/** A route's answer carried a field nobody declared (outside production: the answer fails). */
export class UndeclaredResponseFieldError extends Error {
  constructor(
    readonly route: string,
    readonly fields: readonly string[]
  ) {
    super(
      `response.undeclared_fields: ${route} answered ${fields.join(", ")}, which its response schema does not declare`
    );
    this.name = "UndeclaredResponseFieldError";
  }
}

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;

/**
 * `response` checked against `schema` (its error body against ERROR_BODY): the same response when
 * every field is declared. Otherwise, outside production, UndeclaredResponseFieldError; in
 * production, the response without the undeclared fields, and a log line naming them.
 */
export async function checkedResponse(
  response: Response,
  schema: ResponseSchema,
  route: string
): Promise<Response> {
  const type = response.headers.get("content-type") ?? "";
  if (!JSON_TYPE.test(type) || response.body === null) return response;
  let body: unknown;
  try {
    body = JSON.parse(await response.clone().text());
  } catch {
    return response; // not JSON after all: nothing to check
  }
  const declared = response.status >= 400 ? (schema.onError ?? ERROR_BODY) : schema;
  const fields = undeclaredFields(declared, body);
  if (fields.length === 0) return response;
  if (process.env.NODE_ENV !== "production")
    throw new UndeclaredResponseFieldError(route, fields);
  logger.error("response.undeclared_fields: removed from the answer", {
    route,
    status: response.status,
    fields: fields.slice(0, 20),
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new NextResponse(JSON.stringify(withoutUndeclared(declared, body)), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
