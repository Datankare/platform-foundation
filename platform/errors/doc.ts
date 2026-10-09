/**
 * platform/errors/doc.ts — Generates the API error references from the registry and English catalog
 *
 *   docs/API_ERRORS.md      — the platform's codes (synced to consuming apps unchanged);
 *   docs/APP_API_ERRORS.md  — the consuming app's own `app.*` codes (consumer-owned, ADR-051 D1).
 *
 * Neither is edited by hand. __tests__/api-errors-doc.test.ts fails when either drifts;
 * regenerate with:  UPDATE_API_ERRORS_DOC=1 npx jest __tests__/api-errors-doc.test.ts
 *
 * @module platform/errors
 */

import {
  ERROR_CODES,
  isAppErrorCode,
  messageKey,
  type ErrorCode,
  type ErrorCodeSpec,
} from "@/platform/errors/registry";
import { CATALOGS, DEFAULT_LOCALE, lookup } from "@/platform/errors/messages";

const AREA_TITLES: Readonly<Record<string, string>> = {
  account: "Account",
  approvals: "Approvals",
  auth: "Authentication and sign-in",
  content: "Content",
  feature: "Optional features",
  guest: "Guest access",
  internal: "Internal",
  moderation: "Moderation",
  rate: "Rate limits",
  request: "Request validation",
  service: "Service availability",
};

/**
 * Text safe inside a Markdown table cell. Backslashes are escaped first, so a backslash already in
 * the text cannot combine with the escape added for a pipe (CodeQL js/incomplete-sanitization).
 */
export function escapeTableCell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/** A Markdown table padded the way Prettier formats it, so the generated file is format-clean. */
function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  );
  const line = (cells: string[]): string =>
    `| ${cells.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
  return [
    line(header),
    `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
    ...rows.map(line),
  ];
}

/** The reference table for a set of codes, grouped by area. */
function codeSections(codes: ErrorCode[], areaOf: (code: string) => string): string[] {
  const out: string[] = [];
  const areas = [...new Set(codes.map(areaOf))];
  for (const area of areas) {
    const title =
      AREA_TITLES[area] ??
      area.charAt(0).toUpperCase() + area.slice(1).replace(/_/g, " ");
    out.push(`## ${title}`, "");
    const rows: string[][] = codes
      .filter((c) => areaOf(c) === area)
      .map((code) => {
        const spec: ErrorCodeSpec = ERROR_CODES[code];
        const params =
          spec.params
            .map((p) => `\`${p.name}\` (${p.kind}${p.optional ? ", optional" : ""})`)
            .join(", ") || "—";
        const message = lookup(CATALOGS[DEFAULT_LOCALE], messageKey(code)) ?? "(missing)";
        return [
          `\`${code}\``,
          String(spec.status),
          escapeTableCell(message),
          params,
          escapeTableCell(spec.action),
        ];
      });
    out.push(
      ...table(
        ["Code", "HTTP", "Message (en)", "Params", "What the caller should do"],
        rows
      )
    );
    out.push("");
  }
  return out;
}

export function renderApiErrorsDoc(): string {
  const codes = (Object.keys(ERROR_CODES) as ErrorCode[])
    .filter((c) => !isAppErrorCode(c))
    .sort();
  const areaOf = (c: string) => c.split(".")[0];
  const areas = new Set(codes.map(areaOf));
  const out: string[] = [
    "# API Errors",
    "",
    "<!-- GENERATED from platform/errors/registry.ts and messages/en.json — do not edit by hand. -->",
    "<!-- Regenerate: UPDATE_API_ERRORS_DOC=1 npx jest __tests__/api-errors-doc.test.ts -->",
    "",
    "Every error the API returns has this body (ADR-051 D3):",
    "",
    "```json",
    "{",
    '  "code": "request.missing_fields",',
    '  "message": "Required: email.",',
    '  "params": { "fields": ["email"] }',
    "}",
    "```",
    "",
    "- **`code`** is stable — act on it. A code is never repurposed; a new meaning gets a new code.",
    "- **`message`** is rendered for the request's locale (`Accept-Language`, English fallback). Show it; never parse it.",
    "- **`params`** are the values the message used, so a client can render the message in its own locale from the catalog key `errors.<code>`. Param kinds: `id` — an identifier, shown verbatim and never translated; `number`; `list` — identifiers, joined in the locale's list style.",
    "- Until Sprint 7B the body also carries `success: false` and `error` (equal to `message`) — deprecated aliases for older screens. Do not build on them.",
    "- `internal.error` always carries a `requestId` to quote when reporting a problem, and never internal detail. A `retryAfterSeconds` param is also sent as the `Retry-After` header.",
    "- An app built on the platform adds its own codes, `app.<area>.<name>`, documented in [APP_API_ERRORS.md](APP_API_ERRORS.md).",
    "",
    `**${codes.length} codes** in ${areas.size} areas.`,
    "",
    ...codeSections(codes, areaOf),
  ];
  return out.join("\n").trimEnd();
}

/** docs/APP_API_ERRORS.md — the consuming app's own codes (app-codes.ts). */
export function renderAppApiErrorsDoc(): string {
  const codes = (Object.keys(ERROR_CODES) as ErrorCode[]).filter(isAppErrorCode).sort();
  const areaOf = (c: string) => c.split(".")[1];
  const out: string[] = [
    "# App API Errors",
    "",
    "<!-- GENERATED from platform/errors/app-codes.ts and messages/app/en.json — do not edit by hand. -->",
    "<!-- Regenerate: UPDATE_API_ERRORS_DOC=1 npx jest __tests__/api-errors-doc.test.ts -->",
    "",
    "The errors this app returns in addition to the platform's ([API_ERRORS.md](API_ERRORS.md)). Same body,",
    "same rules: act on `code`, show `message`, re-render from `errors.<code>` with `params`.",
    "",
  ];
  if (codes.length === 0) {
    out.push("This app declares no codes of its own.");
  } else {
    out.push(
      `**${codes.length} codes** in ${new Set(codes.map(areaOf)).size} areas.`,
      "",
      ...codeSections(codes, areaOf)
    );
  }
  return out.join("\n").trimEnd();
}
