/**
 * platform/observability/certificate-expiry.ts — the CA certificates a deployment is given,
 * checked for expiry at boot and at readiness (TASK-197, audit D-6)
 *
 * Nothing recorded or checked when a credential expires. The certificates are the one kind the
 * platform can check itself: DATABASE_SSL_CA and VALKEY_CA_CERT hold PEM bundles whose
 * `notAfter` is in the certificate. At boot, a certificate past its date or within
 * CERT_LEAD_DAYS (30) raises an alert (`credentials.certificate_expiring` — log, metric, error
 * report); readiness carries a probe ("certificates"; optional, ADR-056 D4) that is unhealthy for
 * an expired one and degraded within the lead time. The other credentials — keys, tokens, plans —
 * carry no date the code can read: they are in the credential register (docs/
 * credential-register.json), which a scheduled check holds to their recorded dates.
 *
 * Only the certificates' dates and subjects are read; nothing is logged but the setting's name,
 * the subject and the date.
 *
 * @module platform/observability
 */

import { X509Certificate } from "node:crypto";
import { raiseAlert } from "./alert";
import type { HealthCheckResult, HealthProbe } from "./types";

/** The settings that hold a CA bundle (PEM; newlines may be written as \n). */
export const CERTIFICATE_SETTINGS = ["DATABASE_SSL_CA", "VALKEY_CA_CERT"] as const;
/** Warn this many days before a certificate's notAfter. */
export const CERT_LEAD_DAYS = 30;
export const CERTIFICATE_PROBE = "certificates";

const DAY_MS = 86_400_000;

export interface CertificateExpiry {
  readonly setting: string;
  readonly subject: string;
  readonly notAfter: string;
  /** Days left (negative: expired). */
  readonly daysLeft: number;
}

/** Every certificate in each setting's bundle, with its expiry. An unreadable one is skipped. */
export function certificateExpiries(
  env: Readonly<Record<string, string | undefined>> = process.env,
  now: number = Date.now()
): CertificateExpiry[] {
  const out: CertificateExpiry[] = [];
  for (const setting of CERTIFICATE_SETTINGS) {
    const raw = env[setting];
    if (!raw || !raw.trim()) continue;
    const pem = raw.replace(/\\n/g, "\n");
    const blocks = pem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g
    );
    for (const block of blocks ?? []) {
      try {
        const cert = new X509Certificate(block);
        const at = Date.parse(cert.validTo);
        out.push({
          setting,
          subject: cert.subject.replace(/\n/g, ", "),
          notAfter: new Date(at).toISOString(),
          daysLeft: Math.floor((at - now) / DAY_MS),
        });
      } catch {
        // Not a certificate the platform can read: the connection that uses it will say so.
      }
    }
  }
  return out;
}

/** The certificates past their date or within the lead time. */
export function expiringCertificates(
  env: Readonly<Record<string, string | undefined>> = process.env,
  now: number = Date.now(),
  leadDays: number = CERT_LEAD_DAYS
): CertificateExpiry[] {
  return certificateExpiries(env, now).filter((c) => c.daysLeft < leadDays);
}

/** The boot check: an alert for each certificate past its date or within the lead time. */
export function checkCertificatesAtBoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  now: number = Date.now()
): CertificateExpiry[] {
  const expiring = expiringCertificates(env, now);
  for (const c of expiring) {
    raiseAlert({
      name: "credentials.certificate_expiring",
      message:
        c.daysLeft < 0
          ? `${c.setting}: a CA certificate expired on ${c.notAfter} — connections that verify it fail; replace the bundle`
          : `${c.setting}: a CA certificate expires on ${c.notAfter} (${c.daysLeft} days) — replace the bundle before then`,
      tags: { setting: c.setting, notAfter: c.notAfter },
    });
  }
  return expiring;
}

/** Readiness: unhealthy when a certificate has expired, degraded within the lead time. */
export function createCertificateExpiryProbe(
  env: Readonly<Record<string, string | undefined>> = process.env,
  now: () => number = Date.now
): HealthProbe {
  return {
    name: CERTIFICATE_PROBE,
    async check(): Promise<HealthCheckResult> {
      const all = certificateExpiries(env, now());
      const expired = all.filter((c) => c.daysLeft < 0);
      const soon = all.filter((c) => c.daysLeft >= 0 && c.daysLeft < CERT_LEAD_DAYS);
      return {
        name: CERTIFICATE_PROBE,
        status: expired.length ? "unhealthy" : soon.length ? "degraded" : "healthy",
        latencyMs: 0,
        detail:
          all.length === 0
            ? "no CA bundle configured"
            : [...expired, ...soon].map((c) => `${c.setting} ${c.notAfter}`).join("; ") ||
              `${all.length} certificate(s) valid beyond ${CERT_LEAD_DAYS} days`,
        checkedAt: new Date().toISOString(),
      };
    },
  };
}
