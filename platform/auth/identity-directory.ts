/**
 * platform/auth/identity-directory.ts — Finding an identity in the user pool by its address, for
 * the operator command that re-links accounts to a new pool (TASK-174)
 *
 * A read-only view of the identity provider: the users whose `email` is an address, with what the
 * re-link checks (platform/auth/identity-relink.ts) decide on — the subject, whether the address
 * is verified, whether the user is enabled and confirmed, how they sign in (a federated
 * provider), and the tenant the pool holds for them. The re-link never writes to the pool.
 *
 * The subject (TASK-177, ADR-012): a pool user's `sub` — a UUID, unique in the pool and never
 * reused, the same kind of value for a native and a federated user. It is what every token
 * verifier names a request's identity by (the platform's Cognito provider and Playform's alike:
 * the access token's `sub` claim), what users.cognito_sub holds and what every lookup
 * (account-identity.ts, user-provisioning.ts, permissions) is keyed by. The pool's username
 * (`Google_1093…` for a federated user) is never a subject; it is reported for the operator only.
 *
 * The Cognito implementation calls ListUsers with `email = "<address>"` — or, to learn whether an
 * account's current subject is already an identity of this pool (review 15 H1), `sub =
 * "<subject>"` — signed (SigV4) with the operator's credentials; it needs only
 * `cognito-idp:ListUsers` on the pool. ListUsers matches exactly (case-sensitive): an address is
 * asked as it is stored and in lower case (platform/auth/identity-relink.ts), and a subject's
 * answer is kept only when it is that very subject. It is its own small
 * client — not the app's provider — so a consumer with a provider of its own (an SDK-based one)
 * runs the same command. Credentials are passed in, never read here, never logged or returned.
 *
 * @module platform/auth
 */

import { signAwsJsonPost, type AwsCredentials } from "@/platform/auth/aws-sigv4";
import { COGNITO_POOL_ID } from "@/platform/providers/environment-contract";

/** The tenant attribute the platform sets (ADR-053 D2; the Cognito provider's TENANT_ATTRIBUTE). */
export const POOL_TENANT_ATTRIBUTE = "custom:tenant_id";

/** One user of the pool, as the re-link sees them. */
export interface DirectoryUser {
  /**
   * The identity's subject: the pool's `sub` attribute (a UUID) — what users.cognito_sub is set
   * to, and what a request's actor is resolved by.
   */
  readonly sub: string;
  /** The pool's username (a federated user's is `<provider>_<id>`): for the operator, never a subject. */
  readonly username: string;
  readonly email: string;
  /** `email_verified` is "true" — for a federated user, mapped from the provider's own claim. */
  readonly emailVerified: boolean;
  readonly enabled: boolean;
  /** CONFIRMED, EXTERNAL_PROVIDER, UNCONFIRMED, FORCE_CHANGE_PASSWORD, RESET_REQUIRED, … */
  readonly status: string;
  /** The federated providers the user signs in with (from `identities`); empty for a native user. */
  readonly providers: readonly string[];
  /** The tenant the pool holds for the user (custom:tenant_id); null when none. */
  readonly tenantId: string | null;
}

export interface IdentityDirectory {
  /** Which pool this is (for the record): its id. */
  readonly poolId: string;
  /** Every user whose address is exactly `email` (ListUsers' `email = "…"`: case-sensitive). */
  findByEmail(email: string): Promise<readonly DirectoryUser[]>;
  /**
   * The user whose subject (`sub`) is exactly `sub`, if this pool holds one (ListUsers' `sub =
   * "…"`): an account whose current subject this finds is already bound to an identity of this
   * pool and is never re-linked away from it (review 15 H1).
   */
  findBySub(sub: string): Promise<readonly DirectoryUser[]>;
}

/**
 * Whether a pool user's `email_verified` may be believed (review 16 L8): Cognito's own
 * verification (a native user — no federated provider) always; a federated user's only when every
 * provider it signs in with is trusted (AUTH_TRUSTED_EMAIL_IDPS, default Google: a provider whose
 * claim says the provider itself verified the address). Never Microsoft Entra ID's: its `email`
 * is a mutable attribute the account's own tenant sets, unverified (nOAuth). Provider names match
 * case-insensitively (review 17 L3: `google` names the pool's `Google`).
 */
export function emailClaimTrusted(
  providers: readonly string[] | undefined,
  trusted: ReadonlySet<string>
): boolean {
  if (providers === undefined) return false;
  const names = new Set([...trusted].map((t) => t.trim().toLowerCase()));
  return providers.every((p) => names.has(p.toLowerCase()));
}

/** The directory could not answer (the pool unreachable, credentials refused, throttled). */
export class DirectoryUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`identity directory unavailable: ${reason}`);
    this.name = "DirectoryUnavailableError";
  }
}

type Attr = { readonly Name: string; readonly Value: string };

/**
 * The federated providers a pool user signs in with, from their `identities` attribute: none (a
 * native user) when it is absent; `(unreadable)` — a provider no allow-list names, so never
 * trusted — when it cannot be read.
 *
 * Public (`@/platform/auth/identity-directory`): a consumer's own provider fills
 * TokenPayload.identityProviders with it from GetUser's `identities` attribute (TASK-176 trusted
 * address sync; docs/MIGRATION_v5_to_v6.md §1b, with an example) — e.g.
 * `identityProvidersOf('[{"providerName":"Google","userId":"1093…"}]')` is `["Google"]`. An
 * absent attribute reads as native only when the caller knows the client can read it (the
 * platform's provider also requires the pool username to be the sub).
 */
export function identityProvidersOf(identities: string | undefined): string[] {
  if (!identities) return [];
  try {
    const parsed = JSON.parse(identities) as unknown;
    if (!Array.isArray(parsed)) return ["(unreadable)"];
    const names = parsed.map(
      (i) => (i as { providerName?: unknown } | null)?.providerName
    );
    return names.every((p): p is string => typeof p === "string" && p.length > 0)
      ? names
      : ["(unreadable)"];
  } catch {
    return ["(unreadable)"];
  }
}

/** A pool user as ListUsers returns it, read into a DirectoryUser (null when it has no `sub`). */
export function directoryUserFrom(raw: Record<string, unknown>): DirectoryUser | null {
  const attrs = (Array.isArray(raw.Attributes) ? raw.Attributes : []) as Attr[];
  const attr = (name: string) =>
    attrs.find((a) => a && a.Name === name && typeof a.Value === "string")?.Value;
  const sub = attr("sub");
  const username = typeof raw.Username === "string" ? raw.Username : "";
  if (!sub || !username) return null;
  const providers = identityProvidersOf(attr("identities"));
  return {
    sub,
    username,
    email: attr("email") ?? "",
    emailVerified: attr("email_verified") === "true",
    enabled: raw.Enabled !== false,
    status: typeof raw.UserStatus === "string" ? raw.UserStatus : "UNKNOWN",
    providers,
    tenantId: attr(POOL_TENANT_ATTRIBUTE) ?? null,
  };
}

/** An address the ListUsers filter can carry: no quote, backslash or control character. */
export function filterSafeEmail(email: string): boolean {
  if (email.length > 254) return false;
  for (const ch of email) {
    const code = ch.charCodeAt(0);
    if (ch === '"' || ch === "\\" || code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** A pool `sub`: a UUID. */
const SUB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CognitoDirectoryOptions {
  readonly userPoolId: string;
  readonly region: string;
  readonly credentials: AwsCredentials;
  /** The endpoint (tests: a local server); default `https://cognito-idp.<region>.amazonaws.com/`. */
  readonly endpoint?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Throttling retries (TooManyRequestsException), with a growing pause; default 3. */
  readonly retries?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The user pool, read with ListUsers. */
export class CognitoIdentityDirectory implements IdentityDirectory {
  readonly poolId: string;
  private readonly host: string;
  private readonly endpoint: string;

  constructor(private readonly options: CognitoDirectoryOptions) {
    // Any region's pool, GovCloud's (us-gov-west-1_…) included (review 15 L7).
    if (!COGNITO_POOL_ID.test(options.userPoolId))
      throw new Error("The user pool id is not a Cognito pool id (region_id)");
    this.poolId = options.userPoolId;
    this.host = `cognito-idp.${options.region}.amazonaws.com`;
    this.endpoint = options.endpoint ?? `https://${this.host}/`;
  }

  async findByEmail(email: string): Promise<readonly DirectoryUser[]> {
    if (!filterSafeEmail(email))
      throw new Error("The address holds a character the pool's filter cannot carry");
    return this.list(`email = "${email}"`, "one address");
  }

  async findBySub(sub: string): Promise<readonly DirectoryUser[]> {
    // A subject is a UUID; anything else (a legacy id that is not one, a username) is no subject
    // of this pool and never reaches a filter. Only that very subject is kept (an exact match).
    if (!SUB.test(sub)) return [];
    return (await this.list(`sub = "${sub}"`, "one subject")).filter(
      (u) => u.sub === sub
    );
  }

  private async list(filter: string, what: string): Promise<DirectoryUser[]> {
    const users: DirectoryUser[] = [];
    let token: string | undefined;
    // Bounded: an address is held by a handful of users at most; 10 pages is a defect.
    for (let page = 0; page < 10; page++) {
      const out = await this.call("ListUsers", {
        UserPoolId: this.poolId,
        Filter: filter,
        Limit: 60,
        ...(token ? { PaginationToken: token } : {}),
      });
      for (const raw of (Array.isArray(out.Users) ? out.Users : []) as Record<
        string,
        unknown
      >[]) {
        const user = directoryUserFrom(raw);
        if (user) users.push(user);
      }
      token = typeof out.PaginationToken === "string" ? out.PaginationToken : undefined;
      if (!token) return users;
    }
    throw new DirectoryUnavailableError(`too many pages of users for ${what}`);
  }

  private async call(
    action: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const retries = this.options.retries ?? 3;
    const sleep =
      this.options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      const body = JSON.stringify(payload);
      const headers = await signAwsJsonPost({
        service: "cognito-idp",
        region: this.options.region,
        host: this.host,
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": `AWSCognitoIdentityProviderService.${action}`,
        },
        body,
        credentials: this.options.credentials,
      });
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        this.options.timeoutMs ?? 10_000
      );
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(this.endpoint, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
      } catch (err) {
        throw new DirectoryUnavailableError(
          err instanceof Error && err.name === "AbortError"
            ? "the pool did not answer in time"
            : "the pool could not be reached"
        );
      } finally {
        clearTimeout(timer);
      }
      let parsed: Record<string, unknown> = {};
      try {
        parsed = (await response.json()) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      if (response.ok) return parsed;
      const type =
        String(parsed.__type ?? "")
          .split("#")
          .pop() || `HTTP ${response.status}`;
      if (type === "TooManyRequestsException" && attempt < retries) {
        await sleep(250 * 2 ** attempt);
        continue;
      }
      // The pool's own message is not repeated: it can quote the request. Its type says enough.
      throw new DirectoryUnavailableError(type);
    }
  }
}
