/**
 * __tests__/rate-rules-routes.test.ts — Every route still finds its rate rule (ADR-052, ADR-054 D4)
 *
 * The core's rules stay in DEFAULT_RULES; a module's rules moved to the module (song-id:
 * SONG_IDENTIFY_RULE). A route that names DEFAULT_RULES.X must find X there, and a rule a route
 * imports from anywhere else must be one the core or a registered module declares — so a route
 * cannot enforce a rule the inventory (listRateRules) does not know, and moving a rule out of the
 * core cannot leave a route pointing at nothing.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { DEFAULT_RULES, listRateRules } from "@/platform/rate-limit";
import { sourceFiles } from "./helpers/import-graph";

const ROOT = process.cwd();
const routes = sourceFiles(join(ROOT, "app/api")).filter((f) => /\/route\.ts$/.test(f));

describe("rate rules per route", () => {
  it("self-test: finds the routes and their rule references", () => {
    expect(routes.length).toBeGreaterThan(40);
    const named = routes.flatMap((f) =>
      [...readFileSync(join(ROOT, f), "utf8").matchAll(/DEFAULT_RULES\.(\w+)/g)].map(
        (m) => m[1]
      )
    );
    expect(named).toContain("API_GLOBAL");
  });

  it("every DEFAULT_RULES.X a route names exists", () => {
    const missing = routes.flatMap((f) =>
      [...readFileSync(join(ROOT, f), "utf8").matchAll(/DEFAULT_RULES\.(\w+)/g)]
        .map((m) => m[1])
        .filter((key) => !(key in DEFAULT_RULES))
        .map((key) => `${f}: DEFAULT_RULES.${key}`)
    );
    expect(missing).toEqual([]);
  });

  it("every *_RULE a route imports is in the inventory (core or a registered module)", () => {
    const ids = new Set(listRateRules().map((r) => r.value.id));
    const unknown: string[] = [];
    for (const f of routes) {
      const src = readFileSync(join(ROOT, f), "utf8");
      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
        for (const name of m[1]
          .split(",")
          .map((n) => n.trim())
          .filter((n) => /_RULE$/.test(n))) {
          const mod = require(m[2].replace(/^@\//, `${ROOT}/`));
          if (!ids.has(mod[name]?.id)) unknown.push(`${f}: ${name} from ${m[2]}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it("the inventory has every rule once: the core's, then the modules'", () => {
    const all = listRateRules();
    expect(new Set(all.map((r) => r.value.id)).size).toBe(all.length);
    const core = all.slice(0, Object.keys(DEFAULT_RULES).length);
    expect(core.length).toBeGreaterThan(0);
    expect(core.every((r) => r.moduleId === "core")).toBe(true);
  });
});
