/**
 * @jest-environment node
 */
/**
 * scripts/load-test-target.sh — the load test's target check (TASK-143), run as load-test.yml runs
 * it. Review finding 10: the workflow matched the dispatcher's input with `grep -E`, line by
 * line, so a value whose first line was valid passed — and its next line reached $GITHUB_OUTPUT
 * as an output of its own. The check is now of the whole value, and a newline or carriage return
 * is refused outright.
 */
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const SCRIPT = join(process.cwd(), "scripts/load-test-target.sh");

function target(value?: string) {
  const r = spawnSync("bash", value === undefined ? [SCRIPT] : [SCRIPT, value], {
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("the load test's target", () => {
  it.each([
    [undefined, "local=true\nport=3000\nurl=http://localhost:3000\n"],
    ["http://localhost:3000/", "local=true\nport=3000\nurl=http://localhost:3000\n"],
    ["http://127.0.0.1:8080", "local=true\nport=8080\nurl=http://127.0.0.1:8080\n"],
    ["http://localhost", "local=true\nport=80\nurl=http://localhost\n"],
    ["https://app.example.com", "local=false\nurl=https://app.example.com\n"],
    ["https://app.example.com:8443", "local=false\nurl=https://app.example.com:8443\n"],
  ])("accepts %p", (value, out) => {
    expect(target(value)).toEqual({ code: 0, out, err: "" });
  });

  it.each([
    ["a newline after a valid first line", "http://localhost:3000\nlocal=false"],
    [
      "an output smuggled after an https origin",
      "https://a.example.com\nurl=https://evil",
    ],
    ["a carriage return", "http://localhost:3000\rlocal=false"],
    ["a trailing newline", "https://app.example.com\n"],
    ["plain http elsewhere", "http://app.example.com"],
    ["a path", "https://app.example.com/api"],
    ["a query", "https://app.example.com?x=1"],
    ["credentials", "https://user:pw@app.example.com"],
    ["a shell expansion", "https://$(id).example.com"],
    ["spaces", "https://app.example.com x"],
    ["a port out of range", "http://localhost:99999"],
    ["a port of zero", "http://localhost:0"],
    ["another scheme", "file:///etc/passwd"],
  ])("refuses %s", (_label, value) => {
    const r = target(value);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/target_url/);
  });

  it("is what the workflow runs, with the input as an argument", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github/workflows/load-test.yml"),
      "utf8"
    );
    expect(workflow).toContain('bash scripts/load-test-target.sh "${INPUT_URL:-');
    expect(workflow).not.toMatch(/grep -qE/);
  });
});
