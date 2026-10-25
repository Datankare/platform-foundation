/**
 * __tests__/helpers/test-jwt.ts — access tokens signed as a Cognito pool signs them, for tests
 * (review 8 M5: the provider checks every token's signature before GetUser)
 *
 * One RS256 key pair per test process; TEST_JWKS is its public half, given to the provider as
 * its pool's keys (CognitoConfig.jwks). signJwt signs synchronously (node:crypto), so a test can
 * build a token inline.
 */

import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { JSONWebKeySet } from "jose";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const TEST_KID = "test-signing-key-1";
export const TEST_PUBLIC_KEY: KeyObject = pair.publicKey;
export const TEST_JWKS: JSONWebKeySet = {
  keys: [
    {
      ...(pair.publicKey.export({ format: "jwk" }) as Record<string, string>),
      kid: TEST_KID,
      alg: "RS256",
      use: "sig",
    },
  ],
};

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

/** A JWT over `payload`, signed RS256 with the test key (header fields may be overridden). */
export function signJwt(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = {},
  key: KeyObject = pair.privateKey
): string {
  const input = `${b64({ alg: "RS256", typ: "JWT", kid: TEST_KID, ...header })}.${b64(payload)}`;
  const signature = createSign("RSA-SHA256")
    .update(input)
    .sign(key)
    .toString("base64url");
  return `${input}.${signature}`;
}

/** A second key pair: a token it signs is not the pool's. */
export const OTHER_KEY_PAIR = generateKeyPairSync("rsa", { modulusLength: 2048 });
