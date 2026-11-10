/**
 * __tests__/vendored-deepmerge.test.ts — the vendored deepmerge keeps every key an own property
 * (TASK-203; CVE-2026-93753, GHSA-gcqx-w48m-w2h4)
 *
 * Upstream deepmerge through 4.3.1 writes `destination[key] = …`: a `__proto__` key that is an own
 * property of a parsed object set the merged object's prototype. No upstream release fixes it, so
 * package.json overrides `deepmerge` with vendor/deepmerge (4.3.1's build, MIT, its authors
 * credited in the file), which defines each key instead. Upstream's line, run here as written,
 * shows the poisoning; the vendored module does not, and merges as before otherwise.
 *
 * @not-guard: tests one vendored module; reads package.json only to check the override that installs it
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const deepmerge = require("deepmerge") as {
  (a: unknown, b: unknown): Record<string, unknown>;
  all(list: unknown[]): Record<string, unknown>;
};

const parsed = () => JSON.parse('{"__proto__":{"polluted":true},"a":{"b":1}}');

describe("vendored deepmerge (TASK-203)", () => {
  it("is the vendored copy that jest-config and every other consumer resolve", () => {
    expect(require.resolve("deepmerge")).toBe(
      join(__dirname, "..", "vendor", "deepmerge", "index.js")
    );
    const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
    expect(pkg.overrides.deepmerge).toBe("$deepmerge");
    expect(pkg.devDependencies.deepmerge).toBe("file:vendor/deepmerge");
  });

  it("[self-test] upstream's assignment poisons the prototype with a parsed __proto__ key", () => {
    const destination: Record<string, unknown> = {};
    const source = parsed();
    for (const key of Object.keys(source)) destination[key] = source[key];
    expect((destination as { polluted?: boolean }).polluted).toBe(true);
  });

  it("keeps a parsed __proto__ key an own property: the prototype is untouched", () => {
    for (const merged of [
      deepmerge(parsed(), { a: { c: 2 } }),
      deepmerge({ a: { c: 2 } }, parsed()),
      deepmerge(Object.create(null), parsed()),
      deepmerge.all([{}, parsed(), { a: { c: 2 } }]),
    ]) {
      expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
      expect((merged as { polluted?: boolean }).polluted).toBeUndefined();
      expect(merged.a).toMatchObject({ b: 1 });
    }
  });

  it("a parsed target's own __proto__ key is carried as an own key (a source's is skipped, as upstream skips it)", () => {
    expect(
      Object.prototype.hasOwnProperty.call(deepmerge(parsed(), {}), "__proto__")
    ).toBe(true);
  });

  it("merges as upstream does otherwise: arrays concatenated, nested objects merged, inputs untouched", () => {
    const left = { x: [1], y: { z: 1 } };
    const right = { x: [2], y: { w: 2 }, v: "s" };
    expect(deepmerge(left, right)).toEqual({ x: [1, 2], y: { z: 1, w: 2 }, v: "s" });
    expect(left).toEqual({ x: [1], y: { z: 1 } });
  });
});
