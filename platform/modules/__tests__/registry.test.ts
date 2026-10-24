/**
 * platform/modules/__tests__/registry.test.ts — Registering an app's modules (ADR-054 D4)
 *
 * Registration checks the set as a whole (ids, dependencies, shared contributions), is
 * idempotent for the same set — including a bundle-duplicated copy of it — and refuses a
 * different set once one is registered. The set lives in the globalThis carrier (ADR-032).
 */

import { definePlatformModule, ModuleDefinitionError } from "../define";
import {
  getModule,
  getModules,
  hasRegisteredModules,
  isModuleEnabled,
  moduleFingerprint,
  registerModules,
  resetModuleRegistry,
} from "../registry";
import type { PlatformModule } from "../types";
import { getSingleton } from "@/platform/kernel/singleton";
import { fullModule } from "./fixtures";

let appModules: readonly PlatformModule[];
beforeAll(() => {
  appModules = getModules();
});
beforeEach(() => resetModuleRegistry());
afterAll(() => {
  resetModuleRegistry();
  registerModules(appModules);
});

const a = definePlatformModule(fullModule("alpha"));
const b = definePlatformModule({ ...fullModule("beta"), dependsOn: ["alpha"] });

function refused(modules: readonly PlatformModule[], problem: RegExp): void {
  let thrown: unknown;
  try {
    registerModules(modules);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ModuleDefinitionError);
  expect((thrown as Error).message).toMatch(problem);
  expect(hasRegisteredModules()).toBe(false);
}

describe("registerModules", () => {
  it("starts empty", () => {
    expect(getModules()).toEqual([]);
    expect(hasRegisteredModules()).toBe(false);
    expect(isModuleEnabled("alpha")).toBe(false);
  });

  it("registers a set in order and answers what is enabled", () => {
    registerModules([a, b]);
    expect(getModules().map((m) => m.id)).toEqual(["alpha", "beta"]);
    expect(isModuleEnabled("beta")).toBe(true);
    expect(isModuleEnabled("gamma")).toBe(false);
    expect(getModule("alpha")).toBe(a);
    expect(getModule("gamma")).toBeUndefined();
    expect(Object.isFrozen(getModules())).toBe(true);
  });

  it("registers an empty set — an app with no modules", () => {
    registerModules([]);
    expect(hasRegisteredModules()).toBe(true);
    expect(getModules()).toEqual([]);
    expect(getModules()).toBe(getModules());
  });

  it("is idempotent for the same set", () => {
    registerModules([a, b]);
    const first = getModules();
    registerModules([a, b]);
    expect(getModules()).toBe(first);
  });

  it("is idempotent for a duplicated copy of the same set (another bundle's)", () => {
    registerModules([a, b]);
    const copyA = definePlatformModule(fullModule("alpha"));
    const copyB = definePlatformModule({ ...fullModule("beta"), dependsOn: ["alpha"] });
    expect(copyA).not.toBe(a);
    expect(moduleFingerprint(copyA)).toBe(moduleFingerprint(a));
    expect(() => registerModules([copyA, copyB])).not.toThrow();
    expect(getModule("alpha")).toBe(a); // the first registration stands
  });

  it("refuses a different set once one is registered", () => {
    registerModules([a]);
    expect(() => registerModules([a, b])).toThrow(
      /Platform modules are already registered \(alpha\); the set an app runs with is registered once, at boot/
    );
    expect(() => registerModules([])).toThrow(/already registered/);
    resetModuleRegistry();
    registerModules([]);
    expect(() => registerModules([a])).toThrow(/already registered \(none\)/);
  });

  it("refuses the same id with a different declaration", () => {
    registerModules([a]);
    const changed = definePlatformModule({
      ...fullModule("alpha"),
      goals: ["alpha-goal", "more"],
    });
    expect(moduleFingerprint(changed)).not.toBe(moduleFingerprint(a));
    expect(() => registerModules([changed])).toThrow(/already registered/);
  });

  it("anchors the set in the globalThis carrier (ADR-032)", () => {
    registerModules([a]);
    const carried = getSingleton<{ modules: readonly PlatformModule[] } | null>(
      "platform.modules.registered",
      () => null
    );
    expect(carried?.modules.map((m) => m.id)).toEqual(["alpha"]);
  });
});

describe("registerModules — refusals (nothing is registered)", () => {
  it("refuses a module listed twice", () =>
    refused([a, a], /module "alpha": is listed twice/));

  it("refuses a missing dependency", () =>
    refused([b], /module "beta": depends on module "alpha", which is not registered/));

  it("refuses a dependency cycle", () => {
    const x = definePlatformModule({ id: "x", dependsOn: ["y"] });
    const y = definePlatformModule({ id: "y", dependsOn: ["z"] });
    const z = definePlatformModule({ id: "z", dependsOn: ["x"] });
    refused([x, y, z], /dependency cycle: x → y → z → x/);
  });

  it("accepts dependencies listed in any order", () => {
    expect(() => registerModules([b, a])).not.toThrow();
  });

  const clash = (overrides: Parameters<typeof definePlatformModule>[0]) =>
    definePlatformModule(overrides);

  it.each([
    [
      "provider slot",
      {
        id: "gamma",
        providers: [{ ...a.providers[0], envVar: "GAMMA_STORE", singletonKeys: [] }],
      },
      /provider slot "alphaStore" is already contributed by module "alpha"/,
    ],
    [
      "selector setting",
      {
        id: "gamma",
        providers: [{ ...a.providers[0], slot: "gammaStore", singletonKeys: [] }],
      },
      /selector setting "ALPHA_STORE"/,
    ],
    [
      "singleton key",
      {
        id: "gamma",
        providers: [{ ...a.providers[0], slot: "gammaStore", envVar: "GAMMA_STORE" }],
      },
      /singleton key "platform.alpha.store"/,
    ],
    ["agent", { id: "gamma", agents: a.agents }, /agent "alpha-agent"/],
    ["prompt", { id: "gamma", prompts: a.prompts }, /prompt "alpha-prompt"/],
    ["feature", { id: "gamma", features: a.features }, /feature "alpha_feature"/],
    ["goal", { id: "gamma", goals: ["alpha-goal"] }, /goal "alpha-goal"/],
    ["rate rule", { id: "gamma", rateRules: a.rateRules }, /rate rule "alpha:rule"/],
    [
      "moderation content type",
      { id: "gamma", moderationContentTypes: a.moderationContentTypes },
      /moderation content type "alpha-content"/,
    ],
    [
      "health probe",
      { id: "gamma", healthProbes: a.healthProbes },
      /health probe "alpha-probe"/,
    ],
  ] as [string, Parameters<typeof definePlatformModule>[0], RegExp][])(
    "refuses a %s two modules contribute",
    (_kind, input, problem) => refused([a, clash(input)], problem)
  );

  it("refuses a content type two modules contribute", () => {
    const ct = {
      name: "shared",
      agentId: "alpha-agent",
      build: () => ({ tier: "fast" as const, messages: [], maxTokens: 1 }),
      parse: () => null,
      schema: {},
      renderFallback: () => null,
      toScreenText: () => "",
    };
    const one = definePlatformModule({ id: "one", contentTypes: [ct] });
    const two = definePlatformModule({ id: "two", contentTypes: [ct] });
    refused(
      [one, two],
      /module "two": content type "shared" is already contributed by module "one"/
    );
  });

  it("allows two modules the same consent or account-status feature (a union, not a claim)", () => {
    const one = definePlatformModule({ id: "one", consentFeatures: ["shared_use"] });
    const two = definePlatformModule({
      id: "two",
      consentFeatures: ["shared_use"],
      accountStatusFeatures: ["shared_use"],
    });
    expect(() => registerModules([one, two])).not.toThrow();
  });
});
