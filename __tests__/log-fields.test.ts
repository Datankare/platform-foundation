/**
 * __tests__/log-fields.test.ts — every field a log line carries is classified (TASK-215, A-10)
 *
 * @guard a log call passing a field name that no register classifies as kept or redacted
 *
 * The logger redacts by field name (lib/logger.ts) and scans every text for e-mail and IP
 * addresses; what it cannot know is whether a new field's value is personal data. So every field
 * name a log call passes — `logger.error|warn|info|debug(message, { … })`, a scoped or traced
 * logger's, `logger.request` / `logger.response`, and `logCaught(logger, message, err, { … })` —
 * must be in lib/log-fields.ts LOG_FIELDS or the app's platform/observability/app-log-fields.ts, as "kept: <why>" or
 * "redacted: <why>". A new field fails here until someone says which, and why.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { productionSources } from "./helpers/route-policy";
import { APP_LOG_FIELDS, LOG_FIELDS } from "@/lib/log-fields";

const ROOT = join(__dirname, "..");
const LEVEL = /^(?:error|warn|info|debug)$/;

/** The field names each log call in `source` passes, with the line. */
export function logFieldNames(
  source: string,
  file = "probe.ts"
): { line: number; name: string }[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: { line: number; name: string }[] = [];
  const fieldsOf = (arg: ts.Expression | undefined): void => {
    if (!arg || !ts.isObjectLiteralExpression(arg)) return;
    for (const p of arg.properties) {
      if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name) {
        out.push({
          line: sf.getLineAndCharacterOfPosition(p.getStart(sf)).line + 1,
          name: p.name.getText(sf).replace(/^["']|["']$/g, ""),
        });
      }
    }
  };
  const isLogger = (e: ts.Expression): boolean => {
    const text = e.getText(sf);
    return /(?:^|\.)(?:\w*logger|log)$/i.test(text) || /withTrace\s*\(/.test(text);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      if (ts.isPropertyAccessExpression(c) && isLogger(c.expression)) {
        if (LEVEL.test(c.name.text)) fieldsOf(n.arguments[1]);
        else if (c.name.text === "request") fieldsOf(n.arguments[3]);
        else if (c.name.text === "response") fieldsOf(n.arguments[5]);
      } else if (ts.isIdentifier(c) && c.text === "logCaught") fieldsOf(n.arguments[3]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** "<file>:<line> <name>" for each field no register classifies. */
export function unclassifiedFields(
  files: readonly { file: string; text: string }[],
  registers: readonly Readonly<Record<string, string>>[]
): string[] {
  return files
    .flatMap(({ file, text }) =>
      logFieldNames(text, file)
        .filter(
          ({ name }) =>
            !registers.some((r) => Object.prototype.hasOwnProperty.call(r, name))
        )
        .map(({ line, name }) => `${file}:${line} ${name}`)
    )
    .sort();
}

describe("every log field is classified (TASK-215, A-10)", () => {
  const files = productionSources().map((file) => ({
    file,
    text: readFileSync(join(ROOT, file), "utf8"),
  }));

  it("finds a plausible number of log fields", () => {
    const names = new Set(
      files.flatMap((f) => logFieldNames(f.text, f.file).map((x) => x.name))
    );
    expect(names.size).toBeGreaterThan(100);
  });

  it("every field name a log call passes is in a register", () => {
    expect(unclassifiedFields(files, [LOG_FIELDS, APP_LOG_FIELDS])).toEqual([]);
  });

  it("every entry says kept or redacted, and why", () => {
    const bad = Object.entries({ ...LOG_FIELDS, ...APP_LOG_FIELDS }).filter(
      ([, d]) => !/^(?:kept|redacted): \S.{8,}/.test(d)
    );
    expect(bad).toEqual([]);
  });

  it("[self-test] a new field on any kind of log call is reported until classified", () => {
    const src = [
      'logger.info("signed in", { userId, clientEmailAddress: e });',
      'log.warn("x", { "visitorAddr": ip });',
      'logger.withTrace(t).error("y", { planted: 1 });',
      'logCaught(logger, "z", err, { plantedToo: v });',
      'logger.response("/r", "GET", 200, "id", 5, { plantedThree: 1 });',
    ].join("\n");
    expect(unclassifiedFields([{ file: "probe.ts", text: src }], [LOG_FIELDS])).toEqual([
      "probe.ts:1 clientEmailAddress",
      "probe.ts:2 visitorAddr",
      "probe.ts:3 planted",
      "probe.ts:4 plantedToo",
      "probe.ts:5 plantedThree",
    ]);
    expect(
      unclassifiedFields(
        [{ file: "probe.ts", text: src }],
        [
          LOG_FIELDS,
          {
            clientEmailAddress: "redacted: x",
            visitorAddr: "redacted: x",
            planted: "kept: x",
            plantedToo: "kept: x",
            plantedThree: "kept: x",
          },
        ]
      )
    ).toEqual([]);
  });
});
