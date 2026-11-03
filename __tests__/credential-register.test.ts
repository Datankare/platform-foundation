/**
 * TASK-197 (audit D-6): every credential is recorded with its expiry, and an expiry is caught
 * before it arrives.
 *
 *   - the register (docs/credential-register.json — each repository keeps its own) has a row
 *     for every secret a workflow reads, and every row is well formed (a scan, not a list);
 *   - scripts/check-credential-expiry.mjs fails on a credential within the lead time or past
 *     it, warns on "unknown", and prints no value;
 *   - the CA bundles a deployment is given are checked from their own notAfter at boot (an
 *     alert) and at readiness (the "certificates" probe).
 */

jest.mock("@/platform/observability/alert", () => ({ raiseAlert: jest.fn() }));

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

  it("fails on a credential within the lead time, or past it, naming where it lives", () => {
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

  it("warns on unknown and passes; refuses a malformed row", () => {
    const unknown = check({ credentials: [row("unknown")] });
    expect(unknown.code).toBe(0);
    expect(unknown.out).toContain("::warning::SOME_KEY");
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
