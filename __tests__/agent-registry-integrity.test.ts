/**
 * agent-registry-integrity.test.ts — ADR-039 D5 enforcement (Sprint 4b).
 *
 * Makes the registry-unification invariants binding:
 *   1. Roster completeness — every registered agent (listAgents) is documented in
 *      AGENT_ARCHITECTURE.md, so the doc can't fall behind the code.
 *   2. Zero bespoke — no module outside the runtime hand-rolls an agent trajectory
 *      (makeStep/buildTrajectory); every agent runs on the governed runtime.
 *
 * Self-tests first (Gotcha 64): the detector must fire on a planted fixture and see the known
 * agents before any "clean" result is trusted.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, sep } from "path";
import { registerPlatformAgents } from "@/platform/agents/agent-configs";
import { listAgents } from "@/platform/agents/registry";

const ROOT = process.cwd();
const AGENT_ARCH = readFileSync(join(ROOT, "docs", "AGENT_ARCHITECTURE.md"), "utf-8");

// The bespoke-trajectory signature: the hand-rolled helpers an agent uses when it does NOT run
// on the governed runtime. Deliberately narrow — makeStep/buildTrajectory exist only for
// hand-rolled trajectories and were removed everywhere outside platform/agents by ADR-039.
// NOT `traj-${` or `.steps.push(`: those false-positive on runtime placeholders and response
// projections (see ADR-039 F5 / the F4 design notes).
const BESPOKE = /\bmakeStep\s*\(|\bbuildTrajectory\s*\(/;

const RUNTIME_DIR = sep + join("platform", "agents") + sep;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (e === "__tests__" || e === "node_modules") continue;
      out.push(...tsFiles(p));
    } else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

function scanBespoke(roots: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const root of roots) {
    for (const f of tsFiles(join(ROOT, root))) {
      if (f.includes(RUNTIME_DIR)) continue; // the runtime legitimately constructs steps
      if (BESPOKE.test(readFileSync(f, "utf-8"))) {
        offenders.push(f.replace(ROOT + sep, ""));
      }
    }
  }
  return offenders;
}

describe("agent registry integrity (ADR-039 D5)", () => {
  beforeAll(() => registerPlatformAgents());

  it("self-test: the bespoke detector fires on hand-rolled trajectories, not on runtime calls", () => {
    expect(BESPOKE.test("const s = makeStep(0, 'a', 'cognition', {}, {}, 0, 0);")).toBe(
      true
    );
    expect(BESPOKE.test("this.currentTrajectory = buildTrajectory(id, []);")).toBe(true);
    expect(BESPOKE.test("const r = await invokeTool({ tool, input });")).toBe(false);
    expect(BESPOKE.test("await executeAgent('x', 't', 'user', id, wf);")).toBe(false);
  });

  it("self-test: sees the known registered agents", () => {
    const ids = listAgents();
    expect(ids).toEqual(
      expect.arrayContaining([
        "guardian-social",
        "sentinel",
        "config-manager",
        "command-bar",
        "conductor",
      ])
    );
    expect(ids.length).toBeGreaterThanOrEqual(12);
  });

  it("every registered agent id is documented in AGENT_ARCHITECTURE.md (roster completeness)", () => {
    const missing = listAgents().filter((id) => !AGENT_ARCH.includes(id));
    expect(missing).toEqual([]);
  });

  it("no module runs a bespoke agent trajectory outside the runtime (zero bespoke)", () => {
    const offenders = scanBespoke(["platform", "app", "lib"]);
    expect(offenders).toEqual([]);
  });
});
