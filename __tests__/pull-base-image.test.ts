/**
 * @jest-environment node
 */
/**
 * scripts/pull-base-image.sh (ADR-055 D1, TASK-122), with `curl` and `docker` replaced by stubs
 * on PATH (the registries are not reachable from a test). Review finding 11: the default base
 * image is a tag, and when Docker Hub refused the pull the script pulled that TAG from the mirror —
 * whatever content the mirror held under it. Now every pull is by digest, the digest comes from
 * Docker Hub (or the pin) and never from the mirror, a pin that differs from Docker Hub fails, a
 * pulled image that is not the digest fails, and with no digest to trust nothing is pulled.
 */
import { spawnSync } from "child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(process.cwd(), "scripts/pull-base-image.sh");
const D1 = `sha256:${"a".repeat(64)}`;
const D2 = `sha256:${"b".repeat(64)}`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pull-base-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Stubs {
  /** The digest Docker Hub's registry answers for the tag; null: it cannot be reached. */
  hub: string | null;
  /** Which repositories' pulls succeed (by repo name, e.g. "node", "mirror.gcr.io/library/node"). */
  pulls: string[];
  /** The digest a pulled image actually is (default: the one asked for). */
  actual?: string;
}

function run(stubs: Stubs, env: Record<string, string> = {}, args: string[] = []) {
  const log = join(dir, "calls.log");
  writeFileSync(
    join(dir, "curl"),
    `#!/usr/bin/env bash
echo "curl $*" >> "${log}"
${stubs.hub === null ? "exit 7" : ""}
case "$*" in
  *auth.docker.io*) echo '{"token":"t0k"}' ;;
  *-fsSI*) printf 'HTTP/1.1 200 OK\\r\\ndocker-content-digest: ${stubs.hub}\\r\\n\\r\\n' ;;
esac
`
  );
  writeFileSync(
    join(dir, "docker"),
    `#!/usr/bin/env bash
echo "docker $*" >> "${log}"
for ref; do :; done
repo=$(printf '%s' "$ref" | sed 's/@.*//')
asked=$(printf '%s' "$ref" | sed 's/.*@//')
case "$1" in
  pull)
    case " ${stubs.pulls.join(" ")} " in *" $repo "*) exit 0 ;; esac
    exit 1 ;;
  image)
    echo "$repo@${stubs.actual ?? "$asked"}" ;;
esac
`
  );
  chmodSync(join(dir, "curl"), 0o755);
  chmodSync(join(dir, "docker"), 0o755);
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      PULL_RETRY_DELAY_SECONDS: "0",
      ...env,
    } as unknown as NodeJS.ProcessEnv,
  });
  let calls = "";
  try {
    calls = readFileSync(log, "utf8");
  } catch {
    // nothing was called
  }
  return { code: r.status, out: r.stdout, err: r.stderr, calls };
}

const pulled = (calls: string) =>
  calls
    .split("\n")
    .filter((l) => l.startsWith("docker pull"))
    .map((l) => l.replace("docker pull -q ", ""));

describe("pulling the base image by digest", () => {
  it("resolves the tag's digest on Docker Hub and pulls that digest", () => {
    const r = run({ hub: D1, pulls: ["node"] });
    expect(r.code).toBe(0);
    expect(r.out).toBe(`node:24.22.1-trixie-slim ${D1}\n`);
    expect(pulled(r.calls)).toEqual([`node@${D1}`]);
  });

  it("falls back to the SAME digest from the mirror when Docker Hub refuses the pull", () => {
    const r = run({ hub: D1, pulls: ["mirror.gcr.io/library/node"] });
    expect(r.code).toBe(0);
    expect(r.out).toBe(`mirror.gcr.io/library/node:24.22.1-trixie-slim ${D1}\n`);
    expect(pulled(r.calls)).toEqual([
      `node@${D1}`,
      `node@${D1}`,
      `node@${D1}`,
      `mirror.gcr.io/library/node@${D1}`,
    ]);
    // Never a tag from the mirror.
    expect(r.calls).not.toMatch(/mirror\.gcr\.io\/library\/node:24/);
  });

  it("fails when the mirror's image is not the digest asked for", () => {
    const r = run({ hub: D1, pulls: ["mirror.gcr.io/library/node"], actual: D2 });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/was pulled but its content is not that digest/);
    expect(r.out).toBe("");
  });

  it("fails when the mirror does not have the digest", () => {
    const r = run({ hub: D1, pulls: [] });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/could not pull node@sha256:a+ from Docker Hub or the mirror/);
  });

  it("refuses to pull anything when no digest can be trusted (Docker Hub unreachable, no pin)", () => {
    const r = run({ hub: null, pulls: ["node", "mirror.gcr.io/library/node"] });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(
      /cannot verify .* a mirror's copy of a tag is never trusted unverified/
    );
    expect(pulled(r.calls)).toEqual([]);
  });

  it("uses a pinned digest when Docker Hub cannot be asked, from the mirror too", () => {
    const r = run(
      { hub: null, pulls: ["mirror.gcr.io/library/node"] },
      { BASE_IMAGE_DIGEST: D1 }
    );
    expect(r.code).toBe(0);
    expect(r.out).toBe(`mirror.gcr.io/library/node:24.22.1-trixie-slim ${D1}\n`);
  });

  it("fails when the pin differs from what Docker Hub says the tag is", () => {
    const r = run({ hub: D2, pulls: ["node"] }, { BASE_IMAGE_DIGEST: D1 });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(
      /is now sha256:b+ on Docker Hub, not the pinned BASE_IMAGE_DIGEST/
    );
    expect(pulled(r.calls)).toEqual([]);
  });

  it("accepts the pin in the image argument, and refuses a malformed pin", () => {
    expect(
      run({ hub: D1, pulls: ["node"] }, {}, [`node:24.22.1-trixie-slim@${D1}`]).out
    ).toBe(`node:24.22.1-trixie-slim ${D1}\n`);
    const bad = run({ hub: D1, pulls: ["node"] }, { BASE_IMAGE_DIGEST: "sha256:short" });
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/must be sha256:<64 hex digits>/);
  });

  it("needs a pin for an image that is not an official Docker Hub one, and never mirrors it", () => {
    expect(
      run({ hub: D1, pulls: ["ghcr.io/org/node"] }, {}, ["ghcr.io/org/node:24"]).err
    ).toMatch(/not an official Docker Hub image: pin its digest/);
    const r = run({ hub: null, pulls: [] }, { BASE_IMAGE_DIGEST: D1 }, [
      "ghcr.io/org/node:24",
    ]);
    expect(r.code).toBe(1);
    expect(r.calls).not.toMatch(/mirror/);
  });

  it("is what CI and the load test build with, by digest", () => {
    for (const wf of ["ci.yml", "load-test.yml"]) {
      const text = readFileSync(join(process.cwd(), ".github/workflows", wf), "utf8");
      expect(text).toContain('pulled="$(bash scripts/pull-base-image.sh)"');
      expect(text).toContain('--build-arg BASE_IMAGE_DIGEST="$digest"');
    }
    const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^ARG BASE_IMAGE_DIGEST=$/m);
    expect(
      dockerfile.match(
        /^FROM \$\{BASE_IMAGE\}\$\{BASE_IMAGE_DIGEST:\+@\}\$\{BASE_IMAGE_DIGEST\}/gm
      )
    ).toHaveLength(2);
  });
});
