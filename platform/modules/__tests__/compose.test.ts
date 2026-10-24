/**
 * platform/modules/__tests__/compose.test.ts — A core list plus the modules' entries (ADR-054 D4)
 */

import { definePlatformModule } from "../define";
import { getModules, registerModules, resetModuleRegistry } from "../registry";
import {
  composeValues,
  composeWithModules,
  CORE_OWNER,
  unionWithModules,
} from "../compose";
import type { PlatformModule } from "../types";

let appModules: readonly PlatformModule[];
beforeAll(() => {
  appModules = getModules();
});
beforeEach(() => resetModuleRegistry());
afterAll(() => {
  resetModuleRegistry();
  registerModules(appModules);
});

const one = definePlatformModule({
  id: "one",
  goals: ["one-a", "one-b"],
  consentFeatures: ["x", "y"],
});
const two = definePlatformModule({
  id: "two",
  goals: ["two-a"],
  consentFeatures: ["y", "z"],
});

const goals = () =>
  composeWithModules(
    "test goal",
    ["core-a"],
    (g) => g,
    (m) => m.goals
  );

describe("composeWithModules", () => {
  it("is the core's entries when no module is registered", () => {
    expect(goals()).toEqual([{ moduleId: CORE_OWNER, value: "core-a" }]);
    registerModules([]);
    expect(goals()).toEqual([{ moduleId: "core", value: "core-a" }]);
  });

  it("appends each module's entries in registration order, with their owners", () => {
    registerModules([two, one]);
    expect(goals()).toEqual([
      { moduleId: "core", value: "core-a" },
      { moduleId: "two", value: "two-a" },
      { moduleId: "one", value: "one-a" },
      { moduleId: "one", value: "one-b" },
    ]);
    expect(Object.isFrozen(goals())).toBe(true);
  });

  it("refuses a module entry the core already has, naming both", () => {
    registerModules([definePlatformModule({ id: "thief", goals: ["core-a"] })]);
    expect(goals).toThrow(
      /Platform module "thief": test goal "core-a" is already the core's/
    );
    // Every read refuses — a failed composition is never cached.
    expect(goals).toThrow(/already the core's/);
  });

  it("refuses an entry an earlier module already has, naming that module", () => {
    // Registration refuses shared goals itself; a list it does not police shows composition's own
    // check (both modules name consent feature "y").
    registerModules([one, two]);
    expect(() =>
      composeWithModules<string>(
        "unique feature",
        [],
        (f) => f,
        (m) => m.consentFeatures
      )
    ).toThrow(/module "two": unique feature "y" is already module "one"'s/);
  });

  it("composes once per registered set", () => {
    registerModules([one]);
    const fromModule = jest.fn((m: PlatformModule) => m.goals);
    const first = composeWithModules("counted", [], (g) => g, fromModule);
    const second = composeWithModules("counted", [], (g) => g, fromModule);
    expect(second).toBe(first);
    expect(fromModule).toHaveBeenCalledTimes(1);
    resetModuleRegistry();
    registerModules([one]);
    composeWithModules("counted", [], (g) => g, fromModule);
    expect(fromModule).toHaveBeenCalledTimes(2);
  });
});

describe("composeValues", () => {
  it("drops the owners", () => {
    registerModules([one]);
    expect(
      composeValues(
        "test goal values",
        ["core-a"],
        (g) => g,
        (m) => m.goals
      )
    ).toEqual(["core-a", "one-a", "one-b"]);
  });
});

describe("unionWithModules", () => {
  it("is the union, core first, each name once — modules may name the same feature", () => {
    registerModules([one, two]);
    expect(
      unionWithModules("test consent", ["w", "x"], (m) => m.consentFeatures)
    ).toEqual(["w", "x", "y", "z"]);
  });
});
