/**
 * platform/auth/auth-response-schema.ts — what an auth route answers (TASK-215, audit A-13)
 *
 * Every sign-in, challenge and account-recovery route answers through auth-response.ts: a
 * provider's result without its error text or any token, and a session as `{ success, userId }`
 * (the session is kept on the server, its id in an httpOnly cookie: ADR-057). AUTH_RESULT is that body — the fields of
 * platform/auth/types.ts AuthResult a client may be given — and each route declares it (with its own
 * extra fields) as its response schema (platform/errors/response-schema.ts).
 *
 * @module platform/auth
 */

import type {
  ResponseSchema,
  ResponseSchemaNode,
} from "@/platform/errors/response-schema";

const S: ResponseSchemaNode = { type: "string" };
const B: ResponseSchemaNode = { type: "boolean" };

/** The fields of an auth result a client is given (never a refresh or ID token, never an error's text). */
export const AUTH_RESULT_FIELDS: Readonly<Record<string, ResponseSchemaNode>> = {
  success: B,
  userId: S,
  // No token and no token lifetime (ADR-057 D1, TASK-214): the session is the server's, and its
  // cookie is httpOnly — a route answering one fails outside production and has it removed in
  // production (__tests__/response-schema.test.ts).
  mfaRequired: B,
  mfaSession: S,
  newPasswordRequired: B,
  challengeSession: S,
  emailVerificationRequired: B,
  // A result that asks for a next step may carry its code (authResultResponse passes it through).
  errorCode: S,
  errorParams: {
    type: "object",
    values: {
      type: ["string", "number", "boolean", "array"],
      items: { type: ["string", "number"] },
    },
  },
};

/** An auth route's answer: an auth result, and the route's own extra fields. */
export function authResultSchema(
  extra: Readonly<Record<string, ResponseSchemaNode>> = {}
): ResponseSchema {
  return { type: "object", properties: { ...AUTH_RESULT_FIELDS, ...extra } };
}
