/**
 * platform/auth/request-origin.ts — where a request says it comes from (ADR-057 D4)
 *
 * One of the three defences against cross-site request forgery (platform/auth/session.ts): a
 * state-changing request's Origin (else Referer) must be this deployment's own origin. Kept apart
 * from the session module because the page proxy uses it too, for the requests that have no
 * session yet (sign-in, sign-up, a guest's start) — and the proxy imports nothing that reaches a
 * database.
 *
 * The forwarded host and scheme headers are believed here, although a client can set them: the
 * threat is a page in the victim's browser, and such a page cannot choose them: Host and Origin
 * are forbidden request headers, and a cross-origin request carrying X-Forwarded-* (or any header
 * a form cannot send) is sent only after a preflight this app grants to no other origin. A client
 * that forges them is only lying about itself, and holds no one's cookie but its own.
 *
 * No server-only imports.
 *
 * @module platform/auth
 */

export interface OriginRequest {
  readonly method?: string;
  readonly headers: Headers;
  readonly nextUrl: {
    readonly origin: string;
    readonly protocol: string;
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether the request can change state (anything but GET, HEAD, OPTIONS). */
export function isStateChanging(request: { readonly method?: string }): boolean {
  return !SAFE_METHODS.has((request.method ?? "GET").toUpperCase());
}

/**
 * The origins this deployment answers as, for this request: the one the server sees, and the
 * one the browser addressed when a proxy in front forwards it (its host and scheme headers).
 */
function ownOrigins(request: OriginRequest): Set<string> {
  const own = new Set<string>([request.nextUrl.origin]);
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host"))
    ?.split(",")[0]
    ?.trim();
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    request.nextUrl.protocol.replace(/:$/, "");
  if (host && /^[\w.-]+(?::\d{1,5})?$/.test(host) && /^https?$/.test(proto)) {
    own.add(`${proto}://${host}`);
  }
  return own;
}

export type OriginVerdict = "same" | "cross" | "absent";

/**
 * This deployment's own origin, another, or nowhere (no Origin and no Referer). `Origin: null`
 * (a sandboxed or redirected sender) and anything unparseable are another origin.
 */
export function requestOriginVerdict(request: OriginRequest): OriginVerdict {
  const origin = request.headers.get("origin");
  const source = origin ?? request.headers.get("referer");
  if (source === null || source === "") return "absent";
  let parsed: string;
  try {
    parsed = new URL(source).origin;
  } catch {
    return "cross";
  }
  return parsed !== "null" && ownOrigins(request).has(parsed) ? "same" : "cross";
}
