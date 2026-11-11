#!/usr/bin/env node
// scripts/check-credential-expiry.mjs — no credential reaches its expiry unnoticed (TASK-197,
// audit D-6)
//
// Nothing recorded when a credential expires: the CA bundles, IAM keys, the live journeys' users
// and TOTP seeds, the parity workflow's service-role key, a provider's plan, the AI and Google
// keys. docs/credential-register.json lists each credential this repository and its deployments
// hold — by name, where it lives and when it expires; never a value — and this check, run weekly
// (.github/workflows/credential-expiry.yml), holds them to it:
//
//   - a date within CREDENTIAL_LEAD_DAYS (default: the register's leadDays, else 30) or past
//     fails the run, naming the credential and where to rotate it;
//   - "unknown" (TASK-212, N-32) passes only while the row says until when the owner has to record
//     the date — "pending-owner-until": a real date, today or later and at most
//     PENDING_MAX_DAYS (90) ahead — and what the owner does to find it ("owner-step"). It warns
//     (::warning::) until then; the day after, it fails, as does an "unknown" without both: an
//     expiry nobody records is not tracked, it is forgotten;
//   - "never" must say why (a generated secret with no expiry, an address);
//   - anything else, or a row without a name or a place, fails.
//
// Certificates are also checked where they are used: at boot and at readiness
// (platform/observability/certificate-expiry.ts), from their own notAfter.
//
// Usage: node scripts/check-credential-expiry.mjs [register.json]. No dependencies; Node 20+.
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REGISTER = join(ROOT, "docs/credential-register.json");
const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** How far ahead an "unknown" row may put off recording its expiry (TASK-212, N-32). */
export const PENDING_MAX_DAYS = 90;

/** The UTC midnight of a real calendar day YYYY-MM-DD, or NaN (Date.parse rolls 02-31 over). */
function calendarDay(value) {
  if (typeof value !== "string" || !DATE.test(value)) return Number.NaN;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value
    ? t
    : Number.NaN;
}

/**
 * Each row's verdict: "ok", "expiring" (within the lead time), "expired", "unknown", "never", or
 * "invalid" with the reason.
 */
export function evaluate(register, now = Date.now(), leadOverride) {
  const lead = Number.isFinite(leadOverride)
    ? leadOverride
    : Number.isFinite(register?.leadDays)
      ? register.leadDays
      : 30;
  const rows = Array.isArray(register?.credentials) ? register.credentials : null;
  if (!rows)
    return {
      lead,
      results: [{ name: "(register)", verdict: "invalid", why: "no credentials list" }],
    };
  const results = rows.map((row) => {
    const name = typeof row?.name === "string" ? row.name : "";
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      return {
        name: name || "(unnamed)",
        verdict: "invalid",
        why: "name must be the setting's name",
      };
    }
    if (typeof row.where !== "string" || row.where.trim() === "") {
      return { name, verdict: "invalid", why: "where it lives is not given" };
    }
    const exp = row.expires;
    if (exp === "unknown") {
      const until = row["pending-owner-until"];
      const step = row["owner-step"];
      const at = calendarDay(until);
      if (!Number.isFinite(at)) {
        return {
          name,
          verdict: "invalid",
          why: '"unknown" needs "pending-owner-until": the date (YYYY-MM-DD) by which the owner records the expiry',
        };
      }
      if (typeof step !== "string" || step.trim().length < 10) {
        return {
          name,
          verdict: "invalid",
          why: '"unknown" needs "owner-step": what the owner does to find the expiry',
        };
      }
      const today = Math.floor(now / DAY_MS) * DAY_MS;
      if (at < today) {
        return {
          name,
          verdict: "invalid",
          why: `its expiry is still unknown and pending-owner-until ${until} has passed: record the date (${step.trim()})`,
        };
      }
      if (at > today + PENDING_MAX_DAYS * DAY_MS) {
        return {
          name,
          verdict: "invalid",
          why: `pending-owner-until ${until} is more than ${PENDING_MAX_DAYS} days ahead`,
        };
      }
      return { name, verdict: "unknown", where: row.where, until, step: step.trim() };
    }
    if (exp === "never") {
      return typeof row.note === "string" && row.note.trim().length > 10
        ? { name, verdict: "never" }
        : { name, verdict: "invalid", why: '"never" needs a note saying why' };
    }
    // A real calendar day: Date.parse rolls 2026-02-31 over into March (review round 1).
    if (!Number.isFinite(calendarDay(exp))) {
      return {
        name,
        verdict: "invalid",
        why: 'expires must be YYYY-MM-DD, "unknown" or "never"',
      };
    }
    const days = Math.floor((Date.parse(`${exp}T00:00:00Z`) - now) / DAY_MS);
    if (days < 0)
      return { name, verdict: "expired", expires: exp, days, where: row.where };
    if (days < lead)
      return { name, verdict: "expiring", expires: exp, days, where: row.where };
    return { name, verdict: "ok", expires: exp, days };
  });
  return { lead, results };
}

function summary(text) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    appendFileSync(file, `${text}\n`);
  } catch {
    // A summary that cannot be written is not a failure of the check.
  }
}

function main() {
  const path = process.argv[2] ?? DEFAULT_REGISTER;
  let register;
  try {
    register = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.log(
      `::error::the credential register could not be read (${e.code ?? e.name})`
    );
    return 1;
  }
  const leadRaw = (process.env.CREDENTIAL_LEAD_DAYS ?? "").trim();
  const leadOverride = leadRaw === "" ? undefined : Number(leadRaw);
  if (
    leadOverride !== undefined &&
    (!Number.isFinite(leadOverride) || leadOverride < 0)
  ) {
    console.log("::error::CREDENTIAL_LEAD_DAYS must be a non-negative number of days");
    return 1;
  }
  const { lead, results } = evaluate(register, Date.now(), leadOverride);
  let failed = 0;
  const lines = [];
  for (const r of results) {
    if (r.verdict === "expired") {
      failed++;
      console.log(
        `::error::${r.name} expired on ${r.expires} (${r.where}): rotate it now`
      );
      lines.push(`- ✗ ${r.name}: expired ${r.expires}`);
    } else if (r.verdict === "expiring") {
      failed++;
      console.log(
        `::error::${r.name} expires on ${r.expires}, in ${r.days} days (${r.where}): rotate it before then`
      );
      lines.push(`- ✗ ${r.name}: expires ${r.expires} (${r.days} days)`);
    } else if (r.verdict === "invalid") {
      failed++;
      console.log(`::error::${r.name}: ${r.why}`);
      lines.push(`- ✗ ${r.name}: ${r.why}`);
    } else if (r.verdict === "unknown") {
      console.log(
        `::warning::${r.name} (${r.where}): its expiry is unknown — record it in docs/credential-register.json by ${r.until} (${r.step}); after that day this check fails`
      );
      lines.push(`- ⚠ ${r.name}: expiry unknown — owner to record by ${r.until}`);
    } else {
      console.log(
        `ok ${r.name}${r.expires ? ` (${r.expires}, ${r.days} days)` : " (no expiry)"}`
      );
      lines.push(`- ✓ ${r.name}${r.expires ? `: ${r.expires}` : ": no expiry"}`);
    }
  }
  console.log(
    failed === 0
      ? `no credential expires within ${lead} days`
      : `${failed} credential(s) expiring, expired or not recorded properly`
  );
  summary(
    `### Credential expiry: ${failed === 0 ? "passed" : "failed"}\n\n${lines.join("\n")}`
  );
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
