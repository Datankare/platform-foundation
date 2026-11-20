/**
 * No test takes a fixed port to be closed (TASK-229)
 *
 * @guard a test that reaches localhost or 127.0.0.1 on port 1, 9 or 9999 to mean "nothing listens"
 *
 * "Unreachable" tests used 127.0.0.1:1, :9 and localhost:9999. On macOS any process may listen on
 * those (no low-port restriction since 10.14): a developer's tool would answer and the test would
 * test it. They use helpers/closed-port.ts — a port the kernel just released — instead.
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { walkFiles } from "./helpers/repo-files";

const ROOT = join(__dirname, "..");
const FIXED = /\b(?:localhost|127\.0\.0\.1):(?:1|9|9999)(?![\d.])/;

describe("TASK-229: no fixed 'closed' port in a test", () => {
  it("[self-test] the fixed ports are found, a released one is not", () => {
    expect(FIXED.test('"postgresql://x@127.0.0.1:1/none"')).toBe(true);
    expect(FIXED.test('watch("http://127.0.0.1:9")')).toBe(true);
    expect(FIXED.test('"http://localhost:9999/health"')).toBe(true);
    expect(FIXED.test("`http://127.0.0.1:${CLOSED}/health`")).toBe(false);
    expect(FIXED.test('"http://localhost:3000/api/x"')).toBe(false);
    expect(FIXED.test('"http://127.0.0.1:9000"')).toBe(false);
  });

  it("no test uses one", () => {
    const found: string[] = [];
    for (const f of [
      ...walkFiles(join(ROOT, "__tests__"), (n) => /\.(?:ts|tsx|mjs|cjs|js)$/.test(n)),
      ...walkFiles(join(ROOT, "platform"), (n) => /\.test\.tsx?$/.test(n)),
      ...walkFiles(join(ROOT, "e2e"), (n) => /\.(?:ts|mjs|js)$/.test(n)),
    ]) {
      if (f.endsWith("closed-port-guard.test.ts")) continue;
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (FIXED.test(line)) found.push(`${relative(ROOT, f)}:${i + 1}`);
        });
    }
    expect(found).toEqual([]);
  });
});
