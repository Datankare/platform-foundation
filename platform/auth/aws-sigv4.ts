/**
 * platform/auth/aws-sigv4.ts — AWS Signature Version 4 for the few administrative AWS calls the
 * platform makes (ADR-053 D2: setting a user's tenant in Cognito)
 *
 * Web Crypto only, like guest-token.ts, so it runs on Node and Edge; no AWS SDK. It signs a
 * JSON POST to a regional service endpoint — the only request shape the platform needs — and
 * nothing more general.
 *
 * Credentials are passed in; this module never reads the environment, and never logs or
 * returns them.
 *
 * @module platform/auth
 */

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface SignedRequestInput {
  readonly service: string;
  readonly region: string;
  /** e.g. "cognito-idp.us-east-1.amazonaws.com" */
  readonly host: string;
  /** Header values that are signed (lower-case names), besides host and x-amz-date. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly credentials: AwsCredentials;
  /** Signing time; default now. */
  readonly now?: Date;
}

const enc = new TextEncoder();

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join(
    ""
  );
}

async function sha256Hex(data: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(data)));
}

async function hmac(
  key: ArrayBuffer | Uint8Array<ArrayBuffer>,
  data: string
): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

/** The amz date (YYYYMMDD'T'HHMMSS'Z') and its date stamp. */
export function amzDate(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/**
 * The headers to send for a SigV4-signed POST to "/" with no query string: the given headers,
 * plus host, x-amz-date, x-amz-security-token (when a session token is given) and
 * authorization.
 */
export async function signAwsJsonPost(
  input: SignedRequestInput
): Promise<Record<string, string>> {
  const { amzDate: date, dateStamp } = amzDate(input.now ?? new Date());
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v.trim();
  headers["host"] = input.host;
  headers["x-amz-date"] = date;
  if (input.credentials.sessionToken) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  }

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    await sha256Hex(input.body),
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    date,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmac(
    enc.encode(`AWS4${input.credentials.secretAccessKey}`),
    dateStamp
  );
  const kRegion = await hmac(kDate, input.region);
  const kService = await hmac(kRegion, input.service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));

  const out: Record<string, string> = { ...headers };
  delete out["host"]; // fetch sets it from the URL
  out["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}
