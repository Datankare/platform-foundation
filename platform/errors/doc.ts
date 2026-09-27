/**
 * platform/errors/doc.ts — Generates docs/API_ERRORS.md from the registry and English catalog
 *
 * The document is never edited by hand. __tests__/api-errors-doc.test.ts fails when it drifts;
 * regenerate with:  UPDATE_API_ERRORS_DOC=1 npx jest __tests__/api-errors-doc.test.ts
 *
 * @module platform/errors
 */

import {
  ERROR_CODES,
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
  guest: "Guest access",
  internal: "Internal",
  moderation: "Moderation",
  rate: "Rate limits",
  request: "Request validation",
  service: "Service availability",
};

function cell(s: string): string {
  return s.replace(/\|/g, "\\|");
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

export function renderApiErrorsDoc(): string {
  const codes = (Object.keys(ERROR_CODES) as ErrorCode[]).sort();
  const areas = [...new Set(codes.map((c) => c.split(".")[0]))];
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
    "",
    `**${codes.length} codes** in ${areas.length} areas.`,
    "",
  ];
  for (const area of areas) {
    out.push(`## ${AREA_TITLES[area] ?? area}`, "");
    const rows: string[][] = codes
      .filter((c) => c.split(".")[0] === area)
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
          cell(message),
          params,
          cell(spec.action),
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
  return out.join("\n").trimEnd();
}
