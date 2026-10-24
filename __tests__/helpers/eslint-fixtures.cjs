/**
 * __tests__/helpers/eslint-fixtures.cjs — Lint virtual files with the repository's ESLint config
 *
 * Run as a child process by __tests__/module-lint.test.ts: ESLint loads eslint.config.mjs with a
 * dynamic import(), which jest's module sandbox cannot perform without experimental VM modules,
 * so the linting happens here, in plain Node, and the results go back as JSON.
 *
 * stdin:  { "files": [{ "filePath": "...", "code": "..." }], "configFor": ["path", ...] }
 * stdout: { "results": [{ "filePath", "messages": [{ "ruleId", "message" }] }],
 *           "configs": { "<path>": <rule entry for import/no-restricted-paths> } }
 */
"use strict";

const { ESLint } = require("eslint");

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const eslint = new ESLint({ cwd: process.cwd() });
  const results = [];
  for (const { filePath, code } of input.files) {
    const [result] = await eslint.lintText(code, { filePath });
    results.push({
      filePath,
      messages: result.messages.map((m) => ({ ruleId: m.ruleId, message: m.message })),
    });
  }
  const configs = {};
  for (const filePath of input.configFor ?? []) {
    const config = await eslint.calculateConfigForFile(filePath);
    configs[filePath] = config.rules["import/no-restricted-paths"] ?? null;
  }
  process.stdout.write(JSON.stringify({ results, configs }));
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
