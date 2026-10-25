/**
 * platform/cache/valkey-url.ts — VALKEY_URL, parsed and checked (review 10 M6, review 11 L-6)
 *
 * The one reader of a Valkey/Redis connection URL: the provider takes its connection options from
 * it, and the environment contract checks it at boot — the same rules, so a URL the provider
 * would refuse never boots. No dependency (the contract imports it without the client).
 *
 *   rediss://[user:password@]host[:port][/db]   (redis:// only for a local or CI run)
 *
 * Refused, each with the coded error config.valkey_url_invalid: a query string or fragment (the
 * client read them as options overriding TLS and timeouts); not a URL; another scheme; no host; a
 * path that is not a database number; a malformed percent-escape in the user or password (review
 * 11 L-6: decodeURIComponent threw a bare URIError); a user without a password (review 11 L-6: it
 * was passed on, and the server's answer — an AUTH error, or no authentication at all — told the
 * operator nothing; a password alone, `rediss://:password@host`, is the usual form).
 *
 * @module platform/cache
 */

/** A VALKEY_URL the platform will not use; `code` names it for the boot report. */
export class ValkeyUrlError extends Error {
  readonly code = "config.valkey_url_invalid";
  constructor(reason: string) {
    super(reason.startsWith("'") ? `VALKEY_URL${reason}` : `VALKEY_URL ${reason}`);
    this.name = "ValkeyUrlError";
  }
}

export interface ValkeyEndpoint {
  readonly tls: boolean;
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly db: number;
}

function decoded(part: string, what: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new ValkeyUrlError(
      `has a malformed percent-escape in its ${what} — encode a literal % as %25`
    );
  }
}

/** Parse `url` by the rules above; `allowPlaintext` admits redis:// (a local or CI run). */
export function parseValkeyUrl(url: string, allowPlaintext: boolean): ValkeyEndpoint {
  if (/[?#]/.test(url)) {
    throw new ValkeyUrlError(
      "must not carry a query string or fragment (rediss://[user:password@]host:port[/db]); connection options come from the environment, never the URL"
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValkeyUrlError("is not a URL (rediss://host:port)");
  }
  if (parsed.protocol !== "rediss:" && parsed.protocol !== "redis:") {
    throw new ValkeyUrlError("must start with rediss://");
  }
  if (parsed.protocol === "redis:" && !allowPlaintext) {
    throw new ValkeyUrlError(
      "must use rediss:// (TLS) in a deployment; redis:// is for local and CI runs only"
    );
  }
  if (!parsed.hostname) throw new ValkeyUrlError("names no host");
  const path = parsed.pathname.replace(/^\//, "");
  if (path !== "" && !/^\d{1,2}$/.test(path)) {
    throw new ValkeyUrlError("'s path must be a database number (/0 to /99) or nothing");
  }
  const username = parsed.username ? decoded(parsed.username, "user name") : undefined;
  const password = parsed.password ? decoded(parsed.password, "password") : undefined;
  if (username !== undefined && password === undefined) {
    throw new ValkeyUrlError(
      "names a user without a password — give both (rediss://user:password@host) or a password alone (rediss://:password@host)"
    );
  }
  return {
    tls: parsed.protocol === "rediss:",
    // URL keeps IPv6 literals bracketed; the socket wants the bare address.
    host: parsed.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: parsed.port ? Number(parsed.port) : 6379,
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
    db: path === "" ? 0 : Number(path),
  };
}
