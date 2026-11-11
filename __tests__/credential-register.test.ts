/**
 * TASK-197 (audit D-6): every credential is recorded with its expiry, and an expiry is caught
 * before it arrives.
 *
 * @guard a secret with no register row, or a credential near or past its expiry
 *
 *   - the register (docs/credential-register.json — each repository keeps its own) has a row
 *     for every secret a workflow reads, and (TASK-212, N-33) for every secret the code reads —
 *     every setting app/, lib/ and platform/ read whose name says it is a secret, or a URL that
 *     carries a password — save the few named below with why; every row is well formed (a scan,
 *     not a list);
 *   - scripts/check-credential-expiry.mjs fails on a credential within the lead time or past
 *     it; an "unknown" expiry passes (with a warning) only until its row's
 *     "pending-owner-until", at most 90 days ahead, with the owner's step (TASK-212, N-32) — then
 *     it fails, here in CI as in the weekly check; and it prints no value;
 *   - the CA bundles a deployment is given are checked from their own notAfter at boot (an
 *     alert) and at readiness (the "certificates" probe).
 */

jest.mock("@/platform/observability/alert", () => ({ raiseAlert: jest.fn() }));

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { raiseAlert } from "@/platform/observability/alert";
import {
  certificateExpiries,
  checkCertificatesAtBoot,
  createCertificateExpiryProbe,
} from "@/platform/observability/certificate-expiry";

const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "scripts/check-credential-expiry.mjs");
const REGISTER = join(ROOT, "docs/credential-register.json");
const DAY = 86_400_000;

interface Row {
  name: string;
  where: string;
  expires: string;
  note?: string;
}

const register = (): { leadDays?: number; credentials: Row[] } =>
  JSON.parse(readFileSync(REGISTER, "utf8"));

/** Every `secrets.NAME` the workflows read (GITHUB_TOKEN is GitHub's own, per run). */
function workflowSecrets(): string[] {
  const dir = join(ROOT, ".github/workflows");
  const names = new Set<string>();
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    for (const m of readFileSync(join(dir, f), "utf8").matchAll(
      /\bsecrets\.([A-Z][A-Z0-9_]*)/g
    )) {
      if (m[1] !== "GITHUB_TOKEN") names.add(m[1]);
    }
  }
  return [...names].sort();
}

/**
 * TASK-212 (N-33): what makes a setting a secret, by its name — a secret, password, private key,
 * token, key or key id, a DSN, a CA bundle — and the URLs that carry a password. A deployment
 * secret the code reads must have a register row, as a workflow's does.
 */
const SECRET_NAME =
  /SECRET|PASSWORD|PRIVATE|TOKEN|_KEY$|_KEY_|KEY_ID$|_DSN$|_CA$|CA_CERT$/;
const CREDENTIAL_URLS = new Set(["DATABASE_URL", "DATABASE_OWNER_URL", "VALKEY_URL"]);
/** Names that look like a secret and are not one, or are read only to be refused — each with why. */
const NOT_A_HELD_SECRET: Readonly<Record<string, string>> = {
  NEXT_PUBLIC_GOOGLE_API_KEY:
    "read only to refuse it at boot (G-13): a NEXT_PUBLIC_ value is shipped to browsers, so it is never set",
  SUPABASE_SERVICE_ROLE_KEY:
    "read only to name it in a boot refusal (TASK-201): its value is never used, and it is being removed",
  SENTRY_DSN:
    'not a secret: a DSN only lets events be sent (Sentry, "Data Source Name (DSN)": safe to keep public)',
};

/**
 * Every setting the code in `dirs` reads by name — process.env.X, process.env["X"], env.X,
 * env["X"], raw(env, "X"), resolveSetting("X", …) and the environment contract's declarations
 * (name: "X") — outside tests.
 */
function settingsTheCodeReads(
  root: string,
  dirs = ["app", "lib", "platform"]
): Set<string> {
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]+)/g,
    /process\.env\[\s*"([A-Z][A-Z0-9_]+)"\s*\]/g,
    /\benv\.([A-Z][A-Z0-9_]+)/g,
    /\benv\[\s*"([A-Z][A-Z0-9_]+)"\s*\]/g,
    /\braw\(\s*env\s*,\s*"([A-Z][A-Z0-9_]+)"/g,
    /\bresolveSetting\(\s*"([A-Z][A-Z0-9_]+)"/g,
    /\bname:\s*"([A-Z][A-Z0-9_]+)"/g,
  ];
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "__tests__" || e.name.startsWith("."))
        continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(?:ts|tsx|mjs|js)$/.test(e.name) && !/\.test\.[tj]sx?$/.test(e.name)) {
        const text = readFileSync(p, "utf8");
        for (const re of patterns) for (const m of text.matchAll(re)) names.add(m[1]);
      }
    }
  };
  for (const d of dirs) if (existsSync(join(root, d))) walk(join(root, d));
  return names;
}

/** The secrets among the settings the code reads, less the named exceptions. */
function secretsTheCodeReads(root: string): string[] {
  return [...settingsTheCodeReads(root)]
    .filter((n) => SECRET_NAME.test(n) || CREDENTIAL_URLS.has(n))
    .filter((n) => !(n in NOT_A_HELD_SECRET))
    .sort();
}

function check(reg: unknown, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cred-"));
  const file = join(dir, "register.json");
  writeFileSync(file, JSON.stringify(reg));
  const r = spawnSync("node", [SCRIPT, file], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const day = (offset: number) =>
  new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const row = (expires: string, extra: Partial<Row> = {}): Row => ({
  name: "SOME_KEY",
  where: "a repository secret",
  expires,
  ...extra,
});

describe("the credential register (TASK-197, audit D-6)", () => {
  it("has a row for every secret a workflow reads", () => {
    const recorded = new Set(register().credentials.map((r) => r.name));
    const secrets = workflowSecrets();
    expect(secrets.length).toBeGreaterThan(0);
    expect(secrets.filter((s) => !recorded.has(s))).toEqual([]);
  });

  it("has a row for every secret the code reads (TASK-212, N-33)", () => {
    const recorded = new Set(register().credentials.map((r) => r.name));
    const secrets = secretsTheCodeReads(ROOT);
    // The platform's own: the contract's keys, the database URLs, the cache's token.
    expect(secrets).toEqual(
      expect.arrayContaining([
        "GUEST_TOKEN_SECRET",
        "DATABASE_URL",
        "UPSTASH_REDIS_REST_TOKEN",
      ])
    );
    expect(secrets.filter((s) => !recorded.has(s))).toEqual([]);
  });

  it("[self-test] the scan finds a secret however it is read, and only a secret", () => {
    const root = mkdtempSync(join(tmpdir(), "secrets-"));
    mkdirSync(join(root, "lib", "__tests__"), { recursive: true });
    mkdirSync(join(root, "app"));
    writeFileSync(
      join(root, "lib", "a.ts"),
      [
        "const a = process.env.ONE_SECRET;",
        'const b = process.env["TWO_TOKEN"];',
        "const c = env.THREE_API_KEY;",
        'const d = raw(env, "FOUR_KEY_ID");',
        'const e = resolveSetting("FIVE_PASSWORD", env);',
        'const f = { name: "SIX_PRIVATE_KEY" };',
        "const g = process.env.VALKEY_URL;",
        "const h = process.env.PLAIN_SETTING;",
        "const i = process.env.SENTRY_DSN;",
        "const j = env.SERVICE_URL;",
      ].join("\n")
    );
    writeFileSync(join(root, "lib", "a.test.ts"), "process.env.IN_A_TEST_SECRET;");
    writeFileSync(join(root, "lib", "__tests__", "b.ts"), "process.env.FIXTURE_TOKEN;");
    writeFileSync(join(root, "app", "page.tsx"), 'const k = env["SEVEN_SECRET"];');
    expect(secretsTheCodeReads(root)).toEqual([
      "FIVE_PASSWORD",
      "FOUR_KEY_ID",
      "ONE_SECRET",
      "SEVEN_SECRET",
      "SIX_PRIVATE_KEY",
      "THREE_API_KEY",
      "TWO_TOKEN",
      "VALKEY_URL",
    ]);
    // Each exception says why, and is one the code does read here.
    for (const [name, why] of Object.entries(NOT_A_HELD_SECRET)) {
      expect(why.length).toBeGreaterThan(30);
      expect(settingsTheCodeReads(ROOT).has(name)).toBe(true);
    }
  });

  it("is well formed: every row has a name, a place and a date, unknown or never-with-a-reason", () => {
    // Expiry itself is the scheduled check's (credential-expiry.yml): a unit test that failed on
    // a calendar date would break every build on that day, not notify the owner ahead of it.
    const out = execFileSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import { evaluate } from ${JSON.stringify(SCRIPT)};
         import { readFileSync } from "node:fs";
         const r = evaluate(JSON.parse(readFileSync(process.argv[1], "utf8")));
         console.log(JSON.stringify(r.results.filter((x) => x.verdict === "invalid")));`,
        REGISTER,
      ],
      { encoding: "utf8" }
    );
    expect(JSON.parse(out)).toEqual([]);
    expect(register().credentials.length).toBeGreaterThan(0);
  });

  it("[self-test] fails on a credential within the lead time, or past it, naming where it lives", () => {
    const soon = check({ leadDays: 30, credentials: [row(day(10))] });
    expect(soon.code).toBe(1);
    expect(soon.out).toContain("::error::SOME_KEY expires on");
    expect(soon.out).toContain("a repository secret");
    const past = check({ credentials: [row(day(-1))] });
    expect(past.code).toBe(1);
    expect(past.out).toContain("::error::SOME_KEY expired on");
    expect(check({ credentials: [row(day(45))] }).code).toBe(0);
    expect(
      check({ credentials: [row(day(45))] }, { CREDENTIAL_LEAD_DAYS: "60" }).code
    ).toBe(1);
    expect(
      check({ credentials: [row(day(45))] }, { CREDENTIAL_LEAD_DAYS: "x" }).code
    ).toBe(1);
  });

  it("unknown passes only until its pending-owner-until, with the owner's step (TASK-212, N-32)", () => {
    const step = "aws iam list-access-keys --user-name some-user";
    const pending = (until: string, extra: Partial<Row> = {}) =>
      row("unknown", {
        ...extra,
        ...({ "pending-owner-until": until, "owner-step": step } as object),
      });
    const warned = check({ credentials: [pending(day(30))] });
    expect(warned.code).toBe(0);
    expect(warned.out).toContain("::warning::SOME_KEY");
    expect(warned.out).toContain(`by ${day(30)}`);
    expect(warned.out).toContain(step);
    expect(check({ credentials: [pending(day(0))] }).code).toBe(0);
    const passed = check({ credentials: [pending(day(-1))] });
    expect(passed.code).toBe(1);
    expect(passed.out).toContain(`pending-owner-until ${day(-1)} has passed`);
    const bare = check({ credentials: [row("unknown")] });
    expect(bare.code).toBe(1);
    expect(bare.out).toContain('"unknown" needs "pending-owner-until"');
    expect(check({ credentials: [pending(day(91))] }).code).toBe(1);
    expect(check({ credentials: [pending("2026-02-31")] }).code).toBe(1);
    expect(
      check({
        credentials: [row("unknown", { "pending-owner-until": day(10) } as Partial<Row>)],
      }).out
    ).toContain('"unknown" needs "owner-step"');
  });

  it("[self-test] the CI test fails on an unknown whose day has passed, as the weekly check does", () => {
    const out = execFileSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import { evaluate } from ${JSON.stringify(SCRIPT)};
         const r = evaluate({ credentials: [{ name: "K", where: "w", expires: "unknown",
           "pending-owner-until": "2026-01-01", "owner-step": "read the key's creation date" }] },
           Date.parse("2026-01-02T08:00:00Z"));
         console.log(r.results[0].verdict);`,
      ],
      { encoding: "utf8" }
    );
    expect(out.trim()).toBe("invalid");
  });

  it("refuses a malformed row", () => {
    for (const bad of [
      row("soon"),
      row("2026-02-31"),
      row("never"),
      row(day(100), { name: "lower_case" }),
      row(day(100), { where: "" }),
    ]) {
      expect(check({ credentials: [bad] }).code).toBe(1);
    }
    expect(
      check({ credentials: [row("never", { note: "a generated secret: no expiry" })] })
        .code
    ).toBe(0);
    expect(check({}).code).toBe(1);
  });
});

describe("CA certificates: boot and readiness (TASK-197, audit D-6)", () => {
  let pem = "";
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "cert-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        "/CN=replay-ca",
        "-days",
        "20",
        "-keyout",
        join(dir, "k.pem"),
        "-out",
        join(dir, "c.pem"),
      ],
      { stdio: "ignore" }
    );
    pem = readFileSync(join(dir, "c.pem"), "utf8");
  });
  beforeEach(() => (raiseAlert as jest.Mock).mockReset());

  it("reads each certificate's notAfter, also from a one-line \\n value", () => {
    const [c] = certificateExpiries({ VALKEY_CA_CERT: pem.replace(/\n/g, "\\n") });
    expect(c.setting).toBe("VALKEY_CA_CERT");
    expect(c.subject).toContain("replay-ca");
    expect(c.daysLeft).toBeGreaterThanOrEqual(19);
    expect(c.daysLeft).toBeLessThanOrEqual(20);
  });

  it("alerts at boot for a certificate within 30 days, and readiness degrades", async () => {
    const env = { DATABASE_SSL_CA: pem };
    expect(checkCertificatesAtBoot(env)).toHaveLength(1);
    expect(raiseAlert).toHaveBeenCalledWith(
      expect.objectContaining({ name: "credentials.certificate_expiring" })
    );
    expect((await createCertificateExpiryProbe(env).check()).status).toBe("degraded");
  });

  it("an expired certificate is unhealthy; none configured, or far off, is healthy and silent", async () => {
    const later = () => Date.now() + 40 * DAY;
    expect(
      (await createCertificateExpiryProbe({ DATABASE_SSL_CA: pem }, later).check()).status
    ).toBe("unhealthy");
    expect((await createCertificateExpiryProbe({}).check()).status).toBe("healthy");
    expect(checkCertificatesAtBoot({}, Date.now())).toEqual([]);
    expect(
      checkCertificatesAtBoot({ DATABASE_SSL_CA: pem }, Date.now() - 30 * DAY)
    ).toEqual([]);
    expect(raiseAlert).not.toHaveBeenCalled();
  });
});
