/**
 * Re-linking accounts to a new identity pool (TASK-174) — the parts that need no database: the
 * account binding rule, the pool client (against a local server standing in for Cognito), the
 * pool's answer for an address, the command's arguments, settings and output. The database half
 * (the plan, the transaction, the sign-in afterwards) is __tests__/db/identity-relink.db.test.ts.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { AddressInfo } from "net";
import fc from "fast-check";
import { fuzzParams } from "./helpers/fuzz";
import {
  auditableAccountId,
  bindingOf,
  resolveAccount,
} from "@/platform/auth/account-identity";
import {
  CognitoIdentityDirectory,
  DirectoryUnavailableError,
  directoryUserFrom,
  filterSafeEmail,
  type DirectoryUser,
} from "@/platform/auth/identity-directory";
import * as relink from "@/platform/auth/identity-relink";
import {
  acceptableEmail,
  normaliseEmail,
  partial,
  poolIdentity,
  poolMoveTime,
  relinkIdentities,
  RelinkUsageError,
  subjectHint,
  type RelinkReport,
} from "@/platform/auth/identity-relink";
import {
  EXIT,
  missingSettings,
  parseArgs,
  runRelinkCommand,
  SUBJECT_FLAG_DEPRECATED,
} from "@/platform/auth/identity-relink-command";
import { storedEmail } from "@/platform/auth/user-provisioning";

fc.configureGlobal(fuzzParams());

const SUB = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const STRAY = "9e8d7c6b-5a49-4382-9716-151413121110";

/**
 * A pool user. Its username is NOT its sub (as for a federated user, `Google_…`): the subject is
 * always the sub (TASK-177), so a test that bound the username would fail here.
 */
const user = (over: Partial<DirectoryUser> = {}): DirectoryUser => {
  const sub = over.sub ?? SUB;
  const username = over.username ?? `user-${sub}`;
  return {
    sub,
    username,
    email: "staff@example.com",
    emailVerified: true,
    enabled: true,
    status: "CONFIRMED",
    providers: [],
    tenantId: null,
    ...over,
  };
};

describe("an identity's account is the row bound to its subject (account-identity)", () => {
  it("bound by cognito_sub, whatever the id: a re-linked account", () => {
    expect(bindingOf(SUB, [{ id: OTHER, cognito_sub: SUB }])).toEqual({
      kind: "bound",
      accountId: OTHER,
    });
  });

  it("no row: unprovisioned, created with the subject as its id", () => {
    expect(bindingOf(SUB, [])).toEqual({ kind: "unprovisioned", accountId: SUB });
  });

  it("a legacy row with the subject's id and no subject is that account", () => {
    expect(bindingOf(SUB, [{ id: SUB, cognito_sub: null }])).toEqual({
      kind: "bound",
      accountId: SUB,
    });
  });

  it("hostile: the subject's id held by an account bound to another subject — conflict, never that account", () => {
    expect(bindingOf(SUB, [{ id: SUB, cognito_sub: OTHER }])).toEqual({
      kind: "conflict",
    });
    // Ids compare in any case (a subject in upper case names the same id).
    expect(bindingOf(SUB.toUpperCase(), [{ id: SUB, cognito_sub: OTHER }])).toEqual({
      kind: "conflict",
    });
  });

  it("the binding wins over an id match: the row bound to the subject is the account", () => {
    expect(
      bindingOf(SUB, [
        { id: SUB, cognito_sub: OTHER },
        { id: OTHER, cognito_sub: SUB },
      ])
    ).toEqual({ kind: "bound", accountId: OTHER });
  });

  it("a subject that is not a UUID is matched only by the binding", () => {
    expect(bindingOf("sub-x", [{ id: SUB, cognito_sub: null }])).toEqual({
      kind: "unprovisioned",
      accountId: "sub-x",
    });
  });

  it("an authentication event is recorded under an id only: the subject without a database, nothing for a non-id", async () => {
    await expect(auditableAccountId(SUB)).resolves.toBe(SUB);
    await expect(auditableAccountId("not-an-id")).resolves.toBeUndefined();
    await expect(auditableAccountId(undefined)).resolves.toBeUndefined();
  });

  it("without a database the subject is the account", async () => {
    await expect(resolveAccount(SUB)).resolves.toEqual({
      kind: "unprovisioned",
      accountId: SUB,
    });
  });
});

describe("a pool user as ListUsers returns it", () => {
  const raw = (attrs: Record<string, string>, extra: Record<string, unknown> = {}) => ({
    Username: "u",
    Enabled: true,
    UserStatus: "CONFIRMED",
    Attributes: Object.entries(attrs).map(([Name, Value]) => ({ Name, Value })),
    ...extra,
  });

  it("reads the subject, address, verification, status, providers and tenant", () => {
    const attrs = {
      sub: SUB,
      email: "A@B.co",
      email_verified: "true",
      identities: JSON.stringify([{ providerName: "Google", userId: "1" }]),
      "custom:tenant_id": OTHER,
    };
    const federated = { Username: "Google_1093", UserStatus: "EXTERNAL_PROVIDER" };
    // TASK-177: the subject is the sub for every user — a federated one's username (Google_…)
    // is reported, never bound.
    expect(directoryUserFrom(raw(attrs, federated))?.sub).toBe(SUB);
    expect(directoryUserFrom(raw(attrs, federated))).toEqual({
      sub: SUB,
      username: "Google_1093",
      email: "A@B.co",
      emailVerified: true,
      enabled: true,
      status: "EXTERNAL_PROVIDER",
      providers: ["Google"],
      tenantId: OTHER,
    });
  });

  it("no subject: not a user it can link", () => {
    expect(directoryUserFrom(raw({ email: "a@b.co" }))).toBeNull();
    expect(directoryUserFrom(raw({ sub: SUB }, { Username: undefined }))).toBeNull();
  });

  it("email_verified anything but 'true' is unverified; Enabled false is disabled", () => {
    const u = directoryUserFrom(
      raw({ sub: SUB, email_verified: "True" }, { Enabled: false })
    )!;
    expect(u.emailVerified).toBe(false);
    expect(u.enabled).toBe(false);
  });

  it("hostile: unreadable identities name no real provider; junk shapes never throw", () => {
    for (const junk of ["{not json", "{}", JSON.stringify([{ userId: "1" }]), "[null]"])
      expect(directoryUserFrom(raw({ sub: SUB, identities: junk }))!.providers).toEqual([
        "(unreadable)",
      ]);
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (anything, name) => {
        const out = directoryUserFrom({ Attributes: anything, Username: name } as Record<
          string,
          unknown
        >);
        expect(out === null || typeof out.sub === "string").toBe(true);
      })
    );
  });
});

describe("the pool client (Cognito ListUsers, against a local stand-in)", () => {
  let answers: { status: number; body: unknown }[] = [];
  let calls: { headers: IncomingMessage["headers"]; body: Record<string, unknown> }[] =
    [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      calls.push({ headers: req.headers, body: JSON.parse(data) });
      const a = answers.length > 1 ? answers.shift()! : answers[0]!;
      res.writeHead(a.status, { "content-type": "application/x-amz-json-1.1" });
      res.end(JSON.stringify(a.body));
    });
  });
  let endpoint = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    answers = [];
    calls = [];
  });

  const directory = (over: Record<string, unknown> = {}) =>
    new CognitoIdentityDirectory({
      userPoolId: "us-east-1_TestPool1",
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIATESTTESTTESTTEST",
        secretAccessKey: "s".repeat(40),
      },
      endpoint,
      sleep: async () => undefined,
      ...over,
    });

  const listed = (sub: string, email: string) => ({
    Username: sub,
    Enabled: true,
    UserStatus: "CONFIRMED",
    Attributes: [
      { Name: "sub", Value: sub },
      { Name: "email", Value: email },
      { Name: "email_verified", Value: "true" },
    ],
  });

  it("asks ListUsers for the exact address, signed, and reads every page", async () => {
    answers = [
      { status: 200, body: { Users: [listed(SUB, "a@b.co")], PaginationToken: "p2" } },
      { status: 200, body: { Users: [listed(OTHER, "a@b.co")] } },
    ];
    const users = await directory().findByEmail("a@b.co");
    expect(users.map((u) => u.sub)).toEqual([SUB, OTHER]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers["x-amz-target"]).toBe(
      "AWSCognitoIdentityProviderService.ListUsers"
    );
    expect(String(calls[0]!.headers.authorization)).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIATESTTESTTESTTEST\/\d{8}\/us-east-1\/cognito-idp\/aws4_request/
    );
    expect(calls[0]!.body).toEqual({
      UserPoolId: "us-east-1_TestPool1",
      Filter: 'email = "a@b.co"',
      Limit: 60,
    });
    expect(calls[1]!.body.PaginationToken).toBe("p2");
  });

  it("throttled: retried with a pause, then answered", async () => {
    answers = [
      { status: 400, body: { __type: "TooManyRequestsException", message: "slow down" } },
      { status: 200, body: { Users: [listed(SUB, "a@b.co")] } },
    ];
    const sleeps: number[] = [];
    const users = await directory({
      sleep: async (ms: number) => void sleeps.push(ms),
    }).findByEmail("a@b.co");
    expect(users).toHaveLength(1);
    expect(sleeps).toEqual([250]);
  });

  it("refused: unavailable with the error's type only — never the pool's message", async () => {
    answers = [
      {
        status: 400,
        body: {
          __type: "com.amazon.coral#AccessDeniedException",
          message: "User arn:aws:iam::123456789012:user/x is not authorized",
        },
      },
    ];
    const err = await directory()
      .findByEmail("a@b.co")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DirectoryUnavailableError);
    expect((err as Error).message).toBe(
      "identity directory unavailable: AccessDeniedException"
    );
  });

  it("throttled beyond its retries: unavailable", async () => {
    answers = [{ status: 400, body: { __type: "TooManyRequestsException" } }];
    await expect(directory({ retries: 1 }).findByEmail("a@b.co")).rejects.toThrow(
      "TooManyRequestsException"
    );
    expect(calls).toHaveLength(2);
  });

  it("unreachable or silent: unavailable", async () => {
    await expect(
      directory({ endpoint: "http://127.0.0.1:1/" }).findByEmail("a@b.co")
    ).rejects.toThrow("the pool could not be reached");
    const slow = directory({
      fetch: ((_u: unknown, init: RequestInit) =>
        new Promise((_r, reject) =>
          init.signal!.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          )
        )) as unknown as typeof fetch,
      timeoutMs: 5,
    });
    await expect(slow.findByEmail("a@b.co")).rejects.toThrow("did not answer in time");
  });

  it("a page loop is bounded", async () => {
    answers = [{ status: 200, body: { Users: [], PaginationToken: "again" } }];
    await expect(directory().findByEmail("a@b.co")).rejects.toThrow("too many pages");
    expect(calls).toHaveLength(10);
  });

  it("hostile: an address the filter cannot carry is refused before any call", async () => {
    for (const bad of ['a"b@c.co', "a\\b@c.co", "a\nb@c.co", `${"a".repeat(250)}@c.co`]) {
      expect(filterSafeEmail(bad)).toBe(false);
      await expect(directory().findByEmail(bad)).rejects.toThrow("cannot carry");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a pool id that is not one", () => {
    expect(() => directory({ userPoolId: "us-east-1_x/../y" })).toThrow(
      "not a Cognito pool id"
    );
  });

  it("accepts any region's pool, GovCloud's included (review 15 L7)", () => {
    for (const id of [
      "us-gov-west-1_AbC123",
      "us-gov-east-1_X1",
      "ap-southeast-2_Z9",
      "eu-central-1_q",
    ])
      expect(directory({ userPoolId: id, region: id.split("_")[0] }).poolId).toBe(id);
    for (const bad of ["us-gov-west_AbC", "usgov-west-1_A", "US-EAST-1_A", "us-east-1_"])
      expect(() => directory({ userPoolId: bad })).toThrow("not a Cognito pool id");
  });

  it("asks ListUsers for a subject (sub) exactly (review 15 H1); a non-subject is never asked", async () => {
    answers = [{ status: 200, body: { Users: [listed(SUB, "a@b.co")] } }];
    const found = await directory().findBySub(SUB);
    expect(found.map((u) => u.sub)).toEqual([SUB]);
    expect(calls[0]!.body).toEqual({
      UserPoolId: "us-east-1_TestPool1",
      Filter: `sub = "${SUB}"`,
      Limit: 60,
    });
    // A user answered for another subject is not this one's.
    answers = [{ status: 200, body: { Users: [listed(OTHER, "a@b.co")] } }];
    await expect(directory().findBySub(SUB)).resolves.toEqual([]);
    calls = [];
    for (const bad of [`${SUB}" or sub ^= "`, "sub-x", ""])
      await expect(directory().findBySub(bad)).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("TASK-177: a federated user is found by its sub — a username (Google_…) is never a subject and never asked", async () => {
    const google = {
      ...listed(SUB, "a@b.co"),
      Username: "Google_109320000000000000001",
      UserStatus: "EXTERNAL_PROVIDER",
    };
    answers = [{ status: 200, body: { Users: [google] } }];
    const d = directory();
    expect("subjectAttribute" in d).toBe(false);
    const found = await d.findBySub(SUB);
    expect(found.map((u) => [u.sub, u.username])).toEqual([
      [SUB, "Google_109320000000000000001"],
    ]);
    expect(calls[0]!.body).toEqual({
      UserPoolId: "us-east-1_TestPool1",
      Filter: `sub = "${SUB}"`,
      Limit: 60,
    });
    calls = [];
    for (const bad of ["Google_109320000000000000001", 'x" or username ^= "', "u-1"])
      await expect(d.findBySub(bad)).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("the pool's answer for an address", () => {
  const email = "staff@example.com";
  it("one confirmed, enabled, verified user: that identity", () => {
    expect(poolIdentity(email, [user()])).toEqual({ user: user() });
  });

  it("a federated user verified by its provider's mapped claim: that identity", () => {
    const g = user({
      username: "Google_1093",
      status: "EXTERNAL_PROVIDER",
      providers: ["Google"],
    });
    expect(poolIdentity(email, [g])).toEqual({ user: g });
    expect(g.sub).toBe(SUB);
  });

  it("review 16 L8: a provider not allow-listed (Microsoft Entra ID) never counts as verified, whatever its mapped claim", () => {
    const entra = user({
      username: "EntraID_abc",
      status: "EXTERNAL_PROVIDER",
      providers: ["EntraID"],
    });
    const out = poolIdentity(email, [entra]);
    expect(out).toEqual({
      plan: expect.objectContaining({ status: "refused", code: "pool.unverified" }),
    });
    expect(JSON.stringify(out)).toContain("not trusted (AUTH_TRUSTED_EMAIL_IDPS)");
    expect(JSON.stringify(out)).toContain("never for Microsoft Entra ID");
    // Allow-listed explicitly: believed.
    expect(poolIdentity(email, [entra], new Set(["EntraID"]))).toEqual({ user: entra });
    // An unreadable identities attribute is never a trusted provider.
    expect(
      poolIdentity(email, [user({ providers: ["(unreadable)"] })], new Set(["Google"]))
    ).toEqual({ plan: expect.objectContaining({ code: "pool.unverified" }) });
    // A native user: the pool itself verified the address — always believed.
    expect(poolIdentity(email, [user()], new Set())).toEqual({ user: user() });
  });

  it("review 16 L4 (the reviewer's proof): an attacker's UNCONFIRMED, unverified sign-up with the address no longer blocks the verified owner's re-link", () => {
    const base = {
      email: "staff@x.example",
      enabled: true,
      providers: [],
      tenantId: null,
    };
    const owner = {
      ...base,
      username: "Google_1",
      sub: "11111111-1111-4111-8111-111111111111",
      emailVerified: true,
      status: "EXTERNAL_PROVIDER",
      providers: ["Google"],
    };
    const squatter = {
      ...base,
      username: "u-2",
      sub: "22222222-2222-4222-8222-222222222222",
      emailVerified: false,
      status: "UNCONFIRMED",
    };
    expect(poolIdentity("staff@x.example", [owner])).toEqual({ user: owner });
    expect(poolIdentity("staff@x.example", [owner, squatter])).toEqual({ user: owner });
  });

  it("review 16 L4: an unconfirmed or unverified squatter beside the one verified owner is ignored", () => {
    const owner = user({
      username: "Google_1",
      status: "EXTERNAL_PROVIDER",
      providers: ["Google"],
    });
    const squatter = user({ sub: OTHER, status: "UNCONFIRMED", emailVerified: false });
    const unverified = user({ sub: STRAY, emailVerified: false });
    const entra = user({
      sub: "1a2b3c4d-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
      providers: ["EntraID"],
      status: "EXTERNAL_PROVIDER",
    });
    expect(poolIdentity(email, [owner, squatter, unverified, entra])).toEqual({
      user: owner,
    });
    // Two that both prove the address: still ambiguous.
    expect(poolIdentity(email, [owner, user({ sub: OTHER })])).toEqual({
      plan: expect.objectContaining({ code: "pool.many" }),
    });
    // The one that proves it disabled: still ambiguous (never falls to another).
    expect(poolIdentity(email, [{ ...owner, enabled: false }, squatter])).toEqual({
      plan: expect.objectContaining({ code: "pool.many" }),
    });
  });

  it("the address compared trimmed and in any case; the same user listed twice is one", () => {
    expect(poolIdentity(email, [user({ email: " Staff@Example.COM " }), user()])).toEqual(
      {
        user: user({ email: " Staff@Example.COM " }),
      }
    );
  });

  it.each([
    ["none", [], "pool.none"],
    ["another address only", [user({ email: "other@example.com" })], "pool.none"],
    [
      "two users (a password one and an unlinked Google one)",
      [user(), user({ sub: OTHER, providers: ["Google"], status: "EXTERNAL_PROVIDER" })],
      "pool.many",
    ],
    ["disabled", [user({ enabled: false })], "pool.disabled"],
    ["unconfirmed", [user({ status: "UNCONFIRMED" })], "pool.unconfirmed"],
    [
      "must change password",
      [user({ status: "FORCE_CHANGE_PASSWORD" })],
      "pool.unconfirmed",
    ],
    ["unverified address", [user({ emailVerified: false })], "pool.unverified"],
    [
      "federated without the verified claim mapped",
      [
        user({
          emailVerified: false,
          providers: ["Google"],
          status: "EXTERNAL_PROVIDER",
        }),
      ],
      "pool.unverified",
    ],
  ])("refused: %s", (_label, users, code) => {
    const out = poolIdentity(email, users as DirectoryUser[]);
    expect(out).toEqual({ plan: expect.objectContaining({ status: "refused", code }) });
  });

  it("an unverified federated user is told to map the provider's claim", () => {
    const out = poolIdentity(email, [
      user({ emailVerified: false, providers: ["Google"], status: "EXTERNAL_PROVIDER" }),
    ]);
    expect(JSON.stringify(out)).toContain(
      "map the provider's email_verified claim to the pool's email_verified attribute"
    );
    expect(JSON.stringify(out)).toContain("Google, Sign in with Apple");
    expect(JSON.stringify(out)).toContain("never for Microsoft Entra ID");
  });
});

describe("addresses, hints and arguments", () => {
  it("normalises case and whitespace", () => {
    expect(normaliseEmail("  Staff@Example.COM\t")).toBe("staff@example.com");
  });

  it("hostile (review 15 M1): only ASCII letters are lower-cased — a lookalike is never folded onto an ASCII address", () => {
    // JavaScript's toLowerCase turns the Kelvin sign into "k" and U+0130 into "i̇".
    expect("\u212Aadmin@x.co".toLowerCase()).toBe("kadmin@x.co");
    expect(normaliseEmail("\u212Aadmin@x.co")).toBe("\u212Aadmin@x.co");
    expect(normaliseEmail("\u212Aadmin@x.co")).not.toBe(normaliseEmail("kadmin@x.co"));
    expect(storedEmail(" \u212AAdmin@X.co ")).toBe("\u212Aadmin@x.co");
    expect(storedEmail(" Staff@Example.COM\t")).toBe("staff@example.com");
    // The re-link refuses a non-ASCII address outright.
    expect(acceptableEmail("\u212Aadmin@x.co")).toBe(false);
    expect(acceptableEmail("j\u00f6rg@x.co")).toBe(false);
    fc.assert(
      fc.property(fc.string(), (text) => {
        const n = normaliseEmail(text);
        // Never a character that was not there: only A-Z become a-z. (An empty text is fine: the
        // characters that break the rule are listed, and there are none.)
        expect([...n].filter((ch) => !text.includes(ch) && !/[a-z]/.test(ch))).toEqual(
          []
        );
        expect(storedEmail(text)).toBe(n);
      })
    );
  });

  it("the pool move time: ISO 8601 with its zone, not in the future (review 15 H1)", () => {
    const now = Date.parse("2026-10-25T12:00:00Z");
    expect(poolMoveTime("2026-10-20T14:00:00Z", now)).toBe("2026-10-20T14:00:00.000Z");
    expect(poolMoveTime("2026-10-20T10:00:00-04:00", now)).toBe(
      "2026-10-20T14:00:00.000Z"
    );
    for (const bad of [
      undefined,
      "",
      "2026-10-20",
      "2026-10-20 14:00",
      "2026-10-20T14:00:00",
      "yesterday",
      "2026-13-40T99:00:00Z",
    ])
      expect(() => poolMoveTime(bad, now)).toThrow(RelinkUsageError);
    expect(() => poolMoveTime("2026-10-26T12:00:00Z", now)).toThrow("in the future");
  });

  it.each([
    ["staff@example.com", true],
    ["o'brien@example.com", true],
    ["a+tag@sub.example.co", true],
    ["no-at-sign", false],
    ["two@@example.com", false],
    ["a b@example.com", false],
    ['quote"@example.com', false],
    ["semi;colon@example.com", false],
    ["x@example.com' or '1'='1", false],
    ["%@example", false],
  ])("%s acceptable: %s", (email, ok) => {
    expect(acceptableEmail(email)).toBe(ok);
  });

  it("a subject is recorded as a hash prefix and printed as its first 8 characters", () => {
    expect(subjectHint(SUB)).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(subjectHint(SUB)).not.toContain(SUB.slice(0, 8));
    expect(subjectHint(SUB.toUpperCase())).toBe(subjectHint(SUB));
    expect(subjectHint(null)).toBeNull();
    expect(partial(SUB)).toBe(`${SUB.slice(0, 8)}…`);
    expect(partial(null)).toBe("(none)");
  });

  it("parses both flag forms; a dry run unless --apply", () => {
    expect(
      parseArgs([
        "--email",
        "a@b.co",
        "--created-before=2026-10-20T14:00:00Z",
        "--operator=Raman",
        "--reason",
        "pool moved",
        "--unverified-account",
        OTHER,
      ])
    ).toEqual({
      notes: [],
      request: {
        email: "a@b.co",
        createdBefore: "2026-10-20T14:00:00Z",
        unverifiedAccount: OTHER,
        apply: false,
        operator: "Raman",
        reason: "pool moved",
      },
    });
    expect(
      parseArgs([
        "--all-staff",
        "--subject",
        "sub",
        "--tenant",
        OTHER,
        "--created-before",
        "2026-10-20T14:00:00Z",
        "--merge-strays",
        "--skip-ambiguous",
        "--confirm-unverified",
        OTHER,
        "--confirm-unverified=" + STRAY,
        "--apply",
        "--operator",
        "o",
        "--reason",
        "r",
      ])
    ).toEqual({
      // TASK-177: `--subject sub` is accepted one release, as a no-op with a deprecation note.
      notes: [SUBJECT_FLAG_DEPRECATED],
      request: {
        scope: "all-staff",
        tenantId: OTHER,
        createdBefore: "2026-10-20T14:00:00Z",
        confirmUnverified: [OTHER, STRAY],
        mergeStrays: true,
        skipAmbiguous: true,
        apply: true,
        operator: "o",
        reason: "r",
      },
    });
    expect(parseArgs(["--help"])).toEqual({ help: true });
  });

  it.each([
    [["--email"], "needs a value"],
    [["--email", "--apply"], "needs a value"],
    [["--email", "a", "--email", "b"], "given twice"],
    [["--subject", "sub", "--subject", "sub"], "given twice"],
    [["--confirm-unverified"], "needs a value"],
    [["--apply", "--dry-run"], "together"],
    [["--all", "--all-staff"], "together"],
    [["--bogus"], "Unknown argument"],
    [["--apply=yes"], "Unknown argument"],
    // TASK-177: the subject is always the sub — `--subject username` (or anything but sub) is
    // refused, never ignored: it named a binding no verifier uses any more.
    [["--email", "a@b.co", "--subject", "username"], "--subject is removed"],
    [["--email", "a@b.co", "--subject=username"], "--subject is removed"],
    [["--email", "a@b.co", "--subject", "email"], "--subject is removed"],
    // TASK-176: no longer needed (the one pre-move account is the target) — refused, never ignored.
    [["--all-staff", "--accept-unverified"], "Unknown argument"],
  ])("refuses %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });

  const CA = "-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----";
  const good = {
    DATABASE_OWNER_URL: "postgresql://o:TOPSECRET@db.example.co:5432/postgres",
    DATABASE_SSL_CA: CA,
    COGNITO_USER_POOL_ID: "us-east-1_X",
    COGNITO_ADMIN_ACCESS_KEY_ID: "AKIA",
    COGNITO_ADMIN_SECRET_ACCESS_KEY: "s",
  };

  it("names a missing setting, never a value", () => {
    expect(missingSettings({})).toEqual([
      "DATABASE_OWNER_URL",
      "NEXT_PUBLIC_COGNITO_USER_POOL_ID (or COGNITO_USER_POOL_ID)",
      "COGNITO_ADMIN_ACCESS_KEY_ID and COGNITO_ADMIN_SECRET_ACCESS_KEY",
    ]);
    expect(missingSettings(good)).toEqual([]);
    expect(missingSettings({ ...good, COGNITO_USER_POOL_ID: "us-gov-west-1_X" })).toEqual(
      []
    );
  });

  it.each([["google"], ["Google, SignInWithApple"]])(
    "AUTH_TRUSTED_EMAIL_IDPS=%p is usable (review 17 L3)",
    (value) => {
      expect(missingSettings({ ...good, AUTH_TRUSTED_EMAIL_IDPS: value })).toEqual([]);
    }
  );

  it.each([["Google,,Apple"], ["Google;Apple"], ["Google,"], ["(unreadable)"]])(
    "AUTH_TRUSTED_EMAIL_IDPS=%p is refused, never run as trusting nobody (review 17 L3)",
    (value) => {
      expect(missingSettings({ ...good, AUTH_TRUSTED_EMAIL_IDPS: value })).toEqual([
        expect.stringMatching(/^AUTH_TRUSTED_EMAIL_IDPS has the wrong shape/),
      ]);
    }
  );

  it.each([
    [
      "sslmode in the URL (it would override DATABASE_SSL)",
      { DATABASE_OWNER_URL: `${good.DATABASE_OWNER_URL}?sslmode=disable` },
      "carries TLS options",
    ],
    [
      "sslmode=no-verify in the URL",
      {
        DATABASE_OWNER_URL: `${good.DATABASE_OWNER_URL}?application_name=x&sslmode=no-verify`,
      },
      "carries TLS options",
    ],
    [
      "plaintext to a remote database",
      { DATABASE_SSL: "disable" },
      "DATABASE_SSL=disable is for a database on this machine",
    ],
    [
      "verify-full without the CA",
      { DATABASE_SSL_CA: "" },
      "DATABASE_SSL_CA is required",
    ],
    [
      "an unknown DATABASE_SSL (never read as verify-full)",
      { DATABASE_SSL: "require" },
      "DATABASE_SSL has the wrong shape",
    ],
    [
      "a CA that is not a certificate",
      { DATABASE_SSL_CA: "not a cert" },
      "DATABASE_SSL_CA has the wrong shape",
    ],
    [
      "an owner URL of the wrong shape",
      { DATABASE_OWNER_URL: "set" },
      "DATABASE_OWNER_URL has the wrong shape",
    ],
    [
      "a pool id of the wrong shape",
      { COGNITO_USER_POOL_ID: "pool" },
      "has the wrong shape — expected <region>_<id>",
    ],
  ])(
    "refuses the database settings the contract refuses (review 15 L2): %s",
    (_l, over, message) => {
      const problems = missingSettings({ ...good, ...over });
      expect(problems.join("\n")).toContain(message);
      expect(problems.join("\n")).not.toContain("TOPSECRET");
    }
  );

  it("DATABASE_SSL=disable is accepted for a database on this machine", () => {
    for (const host of ["localhost", "127.0.0.1"])
      expect(
        missingSettings({
          ...good,
          DATABASE_OWNER_URL: `postgresql://o:pw@${host}:5432/postgres`,
          DATABASE_SSL: "disable",
          DATABASE_SSL_CA: "",
        })
      ).toEqual([]);
    expect(
      missingSettings({
        ...good,
        DATABASE_OWNER_URL: "postgresql://o:pw@localhost.evil.example:5432/postgres",
        DATABASE_SSL: "disable",
      }).join()
    ).toContain("DATABASE_SSL=disable");
  });
});

describe("the request is checked before anything is read", () => {
  const base = {
    apply: false,
    createdBefore: "2026-10-20T14:00:00Z",
    operator: "Raman",
    osUser: "raman",
    host: "mac",
    reason: "the pool was replaced",
  };
  const deps = {
    directory: {
      poolId: "us-east-1_X",
      findByEmail: jest.fn(async () => []),
      findBySub: jest.fn(async () => []),
    },
    invalidate: jest.fn(async () => undefined),
  };

  it.each([
    [{}, "either --email"],
    [{ email: "a@b.co", scope: "all" as const }, "either --email"],
    [{ email: "not an address" }, "--email is not"],
    [{ email: "a@b.co", tenantId: "nope" }, "--tenant"],
    [{ email: "a@b.co", mergeFrom: "x" }, "--merge-from"],
    [{ scope: "all" as const, mergeFrom: OTHER }, "--merge-from"],
    [{ email: "a@b.co", mergeStrays: true }, "bulk runs"],
    [{ email: "a@b.co", skipAmbiguous: true }, "bulk runs"],
    [{ email: "a@b.co", unverifiedAccount: "x" }, "--unverified-account"],
    [{ scope: "all" as const, unverifiedAccount: OTHER }, "--unverified-account"],
    [{ scope: "all" as const, confirmUnverified: ["x"] }, "--confirm-unverified"],
    [{ email: "\u212Aadmin@b.co" }, "plain ASCII"],
    [{ email: "a@b.co", createdBefore: "" }, "--created-before <time> is required"],
    [
      { email: "a@b.co", createdBefore: "2026-10-20" },
      "--created-before <time> is required",
    ],
    [{ email: "a@b.co", createdBefore: "2999-01-01T00:00:00Z" }, "in the future"],
    [{ email: "a@b.co", operator: " " }, "--operator"],
    [{ email: "a@b.co", operator: "x".repeat(201) }, "--operator"],
    [{ email: "a@b.co", reason: "why" }, "--reason"],
    [{ email: "a@b.co", reason: "line\nbreak in it" }, "control characters"],
    [{ email: "a@b.co", operator: "a\u001b[2Jb" }, "control characters"],
  ])("refuses %j", async (over, message) => {
    const err = await relinkIdentities({ ...base, ...over }, deps).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(RelinkUsageError);
    expect((err as Error).message).toContain(message);
    expect(deps.directory.findByEmail).not.toHaveBeenCalled();
  });
});

// ── The command's fixtures (shared by its two suites) ──

const out: string[] = [];
const err: string[] = [];
const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
const directory = {
  poolId: "us-east-1_X",
  findByEmail: async () => [],
  findBySub: async () => [],
};
const env = {
  DATABASE_OWNER_URL: "postgresql://owner:TOPSECRET@db.example/x",
  DATABASE_SSL_CA: "-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----",
};
const args = [
  "--email",
  "a@b.co",
  "--created-before",
  "2026-10-20T14:00:00Z",
  "--operator",
  "Raman",
  "--reason",
  "pool replaced",
];
const report = (over: Partial<RelinkReport>): RelinkReport => ({
  runId: "r1",
  applied: false,
  plans: [],
  chunks: [],
  invalidated: [],
  notInvalidated: [],
  unusedConfirmations: [],
  ...over,
});

const relinkPlan = {
  status: "relink" as const,
  email: "a@b.co",
  tenantId: OTHER,
  accountId: OTHER,
  role: "super_admin",
  accountStatus: "active",
  previousSubject: OTHER,
  newSubject: SUB,
  signsInWith: ["Google"],
  merge: { accountId: STRAY },
};

const appliedChunk = {
  index: 0,
  from: 0,
  to: 1,
  outcome: "applied" as const,
  relinked: 1,
};

describe("the command's output and exit code", () => {
  let spy: jest.SpyInstance;
  beforeEach(() => {
    out.length = 0;
    err.length = 0;
    spy = jest.spyOn(relink, "relinkIdentities");
  });
  afterEach(() => spy.mockRestore());

  it("usage: 2, with the usage text", async () => {
    await expect(runRelinkCommand(["--nope"], env, io, { directory })).resolves.toBe(2);
    expect(err.join("\n")).toContain("Unknown argument");
  });

  it("a malformed AUTH_TRUSTED_EMAIL_IDPS: 2, before anything is read — even with the pool given in code (review 17 L3)", async () => {
    await expect(
      runRelinkCommand(args, { ...env, AUTH_TRUSTED_EMAIL_IDPS: "Google,,Apple" }, io, {
        directory,
      })
    ).resolves.toBe(2);
    expect(err.join("\n")).toContain("AUTH_TRUSTED_EMAIL_IDPS has the wrong shape");
    expect(spy).not.toHaveBeenCalled();
  });

  it("missing settings: 2, named only — no value of any setting is printed", async () => {
    await expect(runRelinkCommand(args, env, io)).resolves.toBe(2);
    const all = [...out, ...err].join("\n");
    expect(all).toContain("NEXT_PUBLIC_COGNITO_USER_POOL_ID");
    expect(all).not.toContain("TOPSECRET");
    expect(all).not.toContain("DATABASE_OWNER_URL;");
  });

  it("a dry run with a re-link: 0, prints the change partially, says nothing changed", async () => {
    spy.mockResolvedValue(report({ plans: [relinkPlan] }));
    await expect(runRelinkCommand(args, env, io, { directory })).resolves.toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Dry run — pool us-east-1_X");
    expect(text).toContain(`subject ${OTHER.slice(0, 8)}… → ${SUB.slice(0, 8)}…`);
    expect(text).not.toContain(SUB.slice(9)); // a subject is never printed whole …
    expect(text).toContain(`removes the first-sign-in account ${STRAY}`); // … an account id is
    expect(text).toContain("Run the same command with --apply");
    expect(text).not.toContain("TOPSECRET");
  });

  it("refused: 1, the code and what to do", async () => {
    spy.mockResolvedValue(
      report({
        stoppedBy: "refusal",
        plans: [
          {
            status: "refused",
            email: "a@b.co",
            code: "pool.many",
            detail: "2 users of the current pool have this address",
          },
        ],
      })
    );
    await expect(runRelinkCommand(args, env, io, { directory })).resolves.toBe(1);
    expect(out.join("\n")).toContain("refused  a@b.co [pool.many]");
  });

  it.each([
    ["shared", "on every instance", EXIT.done],
    ["unreachable", "the shared cache did not answer", EXIT.appliedNotVoided],
    ["local-only", "no shared cache in this shell's settings", EXIT.appliedNotVoided],
  ] as const)(
    "applied, cache %s: says how far the invalidation reached (exit %s… see the table)",
    async (reach, says, code) => {
      spy.mockResolvedValue(
        report({
          applied: true,
          plans: [relinkPlan],
          chunks: [appliedChunk],
          invalidated: [OTHER, SUB],
        })
      );
      await expect(
        runRelinkCommand([...args, "--apply"], env, io, {
          directory,
          cacheReach: async () => reach,
        })
      ).resolves.toBe(code);
      const text = out.join("\n");
      expect(text).toContain("Applied — pool us-east-1_X");
      expect(text).toContain(says);
      expect(text).toContain("Check: run the same command again without --apply");
      if (code !== EXIT.done) expect(text).toContain("at most 60 s more");
    }
  );

  it("review 15 M2: an invalidation that failed after the commit — 'Applied' with a warning naming it (exit 5), never 'Nothing was changed'", async () => {
    spy.mockResolvedValue(
      report({
        applied: true,
        plans: [relinkPlan],
        chunks: [appliedChunk],
        invalidated: [OTHER],
        notInvalidated: [{ subject: SUB, error: "UPSTASH_REDIS_REST_TOKEN is not set" }],
      })
    );
    await expect(
      runRelinkCommand([...args, "--apply"], env, io, {
        directory,
        cacheReach: async () => "shared",
      })
    ).resolves.toBe(EXIT.appliedNotVoided);
    const text = [...out, ...err].join("\n");
    expect(text).toContain("Applied — pool");
    expect(text).toContain(`Not voided for 1 subject(s) (${SUB.slice(0, 8)}…`);
    expect(text).toContain("The change itself is committed.");
    expect(text).not.toContain("Nothing was changed");
    expect(text).not.toContain(SUB.slice(9));
  });

  it("review 15 L5: applied with addresses skipped (--skip-ambiguous) — 4, distinct from nothing changed (1)", async () => {
    const refusedPlan = {
      status: "refused" as const,
      email: "c@b.co",
      code: "pool.unverified" as const,
      detail: "not verified",
    };
    spy.mockResolvedValue(
      report({
        applied: true,
        plans: [relinkPlan, refusedPlan],
        chunks: [{ ...appliedChunk, to: 2 }],
        invalidated: [OTHER, SUB],
      })
    );
    const bulk = ["--all-staff", ...args.slice(2), "--skip-ambiguous", "--apply"];
    // A dry run that refused anything is 1, --skip-ambiguous or not (review 16 L5).
    spy.mockResolvedValue(report({ plans: [relinkPlan, refusedPlan] }));
    await expect(
      runRelinkCommand(
        bulk.filter((a) => a !== "--apply"),
        env,
        io,
        { directory }
      )
    ).resolves.toBe(EXIT.refused);
    expect(out.join("\n")).toContain("--apply would skip it and re-link the rest");
    out.length = 0;
    spy.mockResolvedValue(
      report({
        applied: true,
        plans: [relinkPlan, refusedPlan],
        chunks: [{ ...appliedChunk, to: 2 }],
        invalidated: [OTHER, SUB],
      })
    );
    await expect(
      runRelinkCommand(bulk, env, io, { directory, cacheReach: async () => "shared" })
    ).resolves.toBe(EXIT.appliedSomeSkipped);
    expect(out.join("\n")).toContain("Applied, with addresses refused and skipped");
    // Every address refused, nothing applied: 1.
    out.length = 0;
    spy.mockResolvedValue(report({ plans: [refusedPlan], chunks: [] }));
    await expect(runRelinkCommand(bulk, env, io, { directory })).resolves.toBe(
      EXIT.refused
    );
    expect(out.join("\n")).toContain("Nothing was changed");
  });

  it("review 15 M4: partly applied — which chunks committed, which did not, and run again (6)", async () => {
    const second = { ...relinkPlan, email: "d@b.co", accountId: STRAY, merge: undefined };
    spy.mockResolvedValue(
      report({
        applied: true,
        plans: [relinkPlan, second],
        stoppedBy: "failure",
        failure: { chunk: 1, message: "connection terminated" },
        chunks: [
          appliedChunk,
          { index: 1, from: 1, to: 2, outcome: "failed", relinked: 0 },
        ],
        invalidated: [OTHER, SUB],
      })
    );
    await expect(
      runRelinkCommand(["--all", ...args.slice(2), "--apply"], env, io, {
        directory,
        cacheReach: async () => "shared",
      })
    ).resolves.toBe(EXIT.partlyApplied);
    const text = out.join("\n");
    expect(text).toContain("chunk 1/2 (addresses 1–1): applied, 1 re-linked");
    expect(text).toContain(
      "chunk 2/2 (addresses 2–2): NOT applied — connection terminated; nothing in it changed"
    );
    expect(text).toContain("pending  d@b.co — NOT applied");
    expect(text).toContain("Run the same command again");
    expect(text).not.toContain("Nothing was changed");
  });
});

describe("the command's output and exit code (review 16)", () => {
  let spy: jest.SpyInstance;
  beforeEach(() => {
    out.length = 0;
    err.length = 0;
    spy = jest.spyOn(relink, "relinkIdentities");
  });
  afterEach(() => spy.mockRestore());

  it("review 16 L7: a commit whose outcome is unknown — 7, 'may have committed', the verify command; never 'Nothing was changed'", async () => {
    spy.mockResolvedValue(
      report({
        applied: false,
        plans: [relinkPlan],
        stoppedBy: "indeterminate",
        failure: { chunk: 0, message: "The database connection failed while committing" },
        chunks: [{ ...appliedChunk, outcome: "indeterminate", relinked: 0 }],
        invalidated: [OTHER, SUB],
      })
    );
    await expect(
      runRelinkCommand([...args, "--apply"], env, io, {
        directory,
        cacheReach: async () => "shared",
      })
    ).resolves.toBe(EXIT.indeterminate);
    const text = [...out, ...err].join("\n");
    expect(text).toContain(
      "UNKNOWN — the database connection failed while it was committing"
    );
    expect(text).toContain("MAY HAVE COMMITTED");
    expect(text).toContain("the same command without --apply");
    expect(text).not.toContain("Nothing was changed");
    expect(text).not.toContain("The change itself is committed");
  });

  it("review 16 D4f: lists each account that needs --confirm-unverified, and a confirmation that matched none", async () => {
    spy.mockResolvedValue(
      report({
        stoppedBy: "refusal",
        unusedConfirmations: [STRAY],
        plans: [
          {
            status: "refused",
            email: "typo@b.co",
            code: "account.needs_confirmation",
            detail: "never verified",
            needsConfirmation: { accountId: OTHER, tenantId: SUB, role: "super_admin" },
          },
        ],
      })
    );
    await expect(runRelinkCommand(args, env, io, { directory })).resolves.toBe(
      EXIT.refused
    );
    const text = out.join("\n");
    expect(text).toContain("need the operator's confirmation");
    expect(text).toContain(
      `--confirm-unverified ${OTHER}   (typo@b.co, tenant ${SUB}, role super_admin)`
    );
    expect(text).toContain(
      `--confirm-unverified ${STRAY} named no account that needs it`
    );
  });

  it("TASK-177: `--subject sub` still runs (a no-op, with a deprecation note); `--subject username` is refused before anything is read", async () => {
    spy.mockResolvedValue(
      report({
        plans: [{ status: "linked", email: "a@b.co", tenantId: OTHER, accountId: OTHER }],
      })
    );
    await expect(
      runRelinkCommand([...args, "--subject", "sub"], env, io, { directory })
    ).resolves.toBe(EXIT.done);
    expect(err).toContain(SUBJECT_FLAG_DEPRECATED);
    expect(spy).toHaveBeenCalledTimes(1);
    out.length = 0;
    err.length = 0;
    spy.mockClear();
    await expect(
      runRelinkCommand([...args, "--subject", "username"], env, io, { directory })
    ).resolves.toBe(EXIT.usage);
    expect(err.join("\n")).toContain("--subject is removed");
    expect(spy).not.toHaveBeenCalled();
    // Without the flag: no note at all.
    out.length = 0;
    err.length = 0;
    spy.mockResolvedValue(report({}));
    await runRelinkCommand(args, env, io, { directory });
    expect(err.join("\n")).not.toContain("--subject");
  });

  it("the exit codes are distinct", () => {
    expect(new Set(Object.values(EXIT)).size).toBe(Object.keys(EXIT).length);
  });

  it("nothing to do: 0", async () => {
    spy.mockResolvedValue(
      report({
        plans: [{ status: "linked", email: "a@b.co", tenantId: OTHER, accountId: OTHER }],
      })
    );
    await expect(runRelinkCommand(args, env, io, { directory })).resolves.toBe(0);
    expect(out.join("\n")).toContain("Nothing to change.");
  });

  it("the pool or the database unavailable: 3, nothing changed", async () => {
    spy.mockRejectedValue(new DirectoryUnavailableError("AccessDeniedException"));
    await expect(runRelinkCommand(args, env, io, { directory })).resolves.toBe(3);
    expect(err.join("\n")).toContain("Nothing was changed");
  });

  it("--help: 0", async () => {
    await expect(runRelinkCommand(["--help"], {}, io)).resolves.toBe(0);
    expect(out.join("\n")).toContain("TENANCY_OPERATIONS.md §6");
  });
});
