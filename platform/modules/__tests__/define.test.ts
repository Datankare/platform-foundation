/**
 * platform/modules/__tests__/define.test.ts — definePlatformModule validates and freezes (ADR-054 D4)
 *
 * Every malformed declaration is refused where it is written, naming the module and the problem;
 * a valid one comes back complete (every list present) and frozen.
 */

import {
  definePlatformModule,
  ModuleDefinitionError,
  moduleContentType,
} from "../define";
import type { PlatformModuleInput } from "../types";
import { agent, fullModule, prompt, slot, suite } from "./fixtures";

const refuses = (input: PlatformModuleInput, problem: RegExp): void => {
  let thrown: unknown;
  try {
    definePlatformModule(input);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ModuleDefinitionError);
  expect((thrown as Error).message).toMatch(problem);
  expect((thrown as Error).message).toMatch(/\(ADR-054\)$/);
};

describe("definePlatformModule — a valid module", () => {
  it("fills in every list and keeps what was declared", () => {
    const mod = definePlatformModule({ id: "bare" });
    expect(mod).toEqual({
      id: "bare",
      dependsOn: [],
      providers: [],
      agents: [],
      prompts: [],
      evals: [],
      contentTypes: [],
      features: [],
      goals: [],
      rateRules: [],
      consentFeatures: [],
      accountStatusFeatures: [],
      moderationContentTypes: [],
      healthProbes: [],
      kits: [],
    });
    const full = definePlatformModule(fullModule("full"));
    expect(full.providers.map((s) => s.slot)).toEqual(["fullStore"]);
    expect(full.goals).toEqual(["full-goal"]);
  });

  it("freezes the module, its lists and its declarations", () => {
    const mod = definePlatformModule(fullModule("frozen"));
    expect(Object.isFrozen(mod)).toBe(true);
    expect(Object.isFrozen(mod.goals)).toBe(true);
    expect(Object.isFrozen(mod.providers[0])).toBe(true);
    expect(Object.isFrozen(mod.providers[0].values)).toBe(true);
    expect(Object.isFrozen(mod.agents[0])).toBe(true);
    expect(() => (mod.goals as string[]).push("late")).toThrow(TypeError);
  });

  it("does not share its lists with the caller's input", () => {
    const goals = ["one"];
    const mod = definePlatformModule({ id: "copy", goals });
    goals.push("two");
    expect(mod.goals).toEqual(["one"]);
  });

  it("freezes a durable slot's declaration", () => {
    const mod = definePlatformModule({
      id: "durable",
      providers: [
        slot({
          durable: {
            selections: ["postgres"],
            noun: "things",
            fallback: "memory things",
          },
        }),
      ],
    });
    expect(Object.isFrozen(mod.providers[0].durable)).toBe(true);
    expect(Object.isFrozen(mod.providers[0].durable?.selections)).toBe(true);
  });

  it("erases a content type's types without changing it", () => {
    const ct = {
      name: "fixture",
      agentId: "fixture-agent",
      build: (n: number) => ({
        tier: "fast" as const,
        messages: [{ role: "user" as const, content: String(n) }],
        maxTokens: 1,
      }),
      parse: (raw: string) => raw.length,
      schema: {},
      renderFallback: () => 0,
      toScreenText: (n: number) => String(n),
    };
    expect(moduleContentType(ct)).toBe(ct);
  });
});

describe("definePlatformModule — refusals", () => {
  it.each(["", "Social", "song_id", "-social", "social-", "so--cial", "1st"])(
    "refuses the id %p",
    (id) => refuses({ id }, /the id must be lower-case words joined by hyphens/)
  );

  it("refuses a non-string id", () => {
    refuses({ id: 42 as unknown as string }, /Platform module "42"/);
  });

  it.each([
    ["a dependency on itself", { id: "self", dependsOn: ["self"] }, /depends on itself/],
    [
      "a malformed dependency",
      { id: "m", dependsOn: ["Bad"] },
      /dependency "Bad" is malformed/,
    ],
    [
      "a dependency twice",
      { id: "m", dependsOn: ["a", "a"] },
      /dependency "a" is declared twice/,
    ],
    [
      "an agent twice",
      { id: "m", agents: [agent("x"), agent("x")] },
      /agent "x" is declared twice/,
    ],
    [
      "a malformed agent id",
      { id: "m", agents: [agent("X Y")] },
      /agent "X Y" is malformed/,
    ],
    [
      "a prompt twice",
      { id: "m", prompts: [prompt("p"), prompt("p")] },
      /prompt "p" is declared twice/,
    ],
    ["a goal twice", { id: "m", goals: ["g", "g"] }, /goal "g" is declared twice/],
    [
      "a malformed goal",
      { id: "m", goals: ["Translate"] },
      /goal "Translate" is malformed/,
    ],
    [
      "a consent feature twice",
      { id: "m", consentFeatures: ["f", "f"] },
      /consent feature "f"/,
    ],
    [
      "a malformed account-status feature",
      { id: "m", accountStatusFeatures: ["a-b"] },
      /account-status feature "a-b" is malformed/,
    ],
    [
      "a moderation content type twice",
      {
        id: "m",
        moderationContentTypes: [
          { name: "c", severityReduction: false },
          { name: "c", severityReduction: true },
        ],
      },
      /moderation content type "c" is declared twice/,
    ],
    [
      "a kit outside __tests__",
      { id: "m", kits: ["platform/kit.ts"] },
      /kit "platform\/kit.ts" is malformed/,
    ],
    [
      "a kit path climbing out",
      { id: "m", kits: ["__tests__/../x.ts"] },
      /kit "__tests__\/..\/x.ts" is malformed/,
    ],
  ] as [string, PlatformModuleInput, RegExp][])("refuses %s", (_name, input, problem) =>
    refuses(input, problem)
  );

  it("refuses a feature without a check or without saying what it needs", () => {
    refuses(
      {
        id: "m",
        features: [{ id: "f", needs: " ", check: () => ({ available: true }) }],
      },
      /feature "f" needs a check and a description/
    );
    refuses(
      { id: "m", features: [{ id: "f", needs: "x", check: undefined as never }] },
      /feature "f" needs a check/
    );
    refuses(
      {
        id: "m",
        features: [
          { id: "f", needs: "x", check: () => ({ available: true }) },
          { id: "f", needs: "y", check: () => ({ available: true }) },
        ],
      },
      /feature "f" is declared twice/
    );
  });

  it("refuses a health probe without create, or twice", () => {
    refuses(
      { id: "m", healthProbes: [{ name: "p", create: undefined as never }] },
      /health probe "p" has no create/
    );
    const probe = {
      name: "p",
      create: () => ({
        name: "p",
        check: async () => ({ name: "p", status: "healthy" as const, checkedAt: "" }),
      }),
    };
    refuses(
      { id: "m", healthProbes: [probe, probe] },
      /health probe "p" is declared twice/
    );
  });

  it("refuses an eval suite for a prompt the module does not declare, or twice", () => {
    refuses(
      { id: "m", evals: [suite("elsewhere")] },
      /eval suite "elsewhere" is not for one of this module's prompts/
    );
    refuses(
      { id: "m", prompts: [prompt("p")], evals: [suite("p"), suite("p")] },
      /eval suite "p" is declared twice/
    );
  });

  it.each([
    ["no maxRequests", { id: "r:x", maxRequests: 0, windowSeconds: 60 }],
    ["a fractional window", { id: "r:x", maxRequests: 1, windowSeconds: 1.5 }],
    ["a negative window", { id: "r:x", maxRequests: 1, windowSeconds: -1 }],
  ])("refuses a rate rule with %s", (_name, rule) =>
    refuses(
      { id: "m", rateRules: [rule] },
      /rate rule "r:x" needs a positive whole maxRequests and windowSeconds/
    )
  );

  it("refuses a malformed or duplicated rule id", () => {
    refuses(
      { id: "m", rateRules: [{ id: "noprefix", maxRequests: 1, windowSeconds: 1 }] },
      /rate rule "noprefix" is malformed/
    );
    const rule = { id: "a:b", maxRequests: 1, windowSeconds: 1 };
    refuses({ id: "m", rateRules: [rule, rule] }, /rate rule "a:b" is declared twice/);
  });
});

describe("definePlatformModule — provider slot refusals", () => {
  it.each([
    [
      "a slot name twice",
      [slot(), slot({ envVar: "OTHER", singletonKeys: [] })],
      /provider slot "fixtureStore" is declared twice/,
    ],
    [
      "a setting twice",
      [slot(), slot({ slot: "other", singletonKeys: [] })],
      /selector setting "FIXTURE_STORE" is declared twice/,
    ],
    [
      "a singleton key twice across slots",
      [slot(), slot({ slot: "other", envVar: "OTHER" })],
      /singleton key "platform.fixture.store" is declared twice/,
    ],
    [
      "a malformed slot name",
      [slot({ slot: "Fixture" })],
      /provider slot "Fixture" is malformed/,
    ],
    [
      "a malformed setting",
      [slot({ envVar: "fixture_store" })],
      /selector setting "fixture_store" is malformed/,
    ],
    [
      "a malformed singleton key",
      [slot({ singletonKeys: ["fixture.store"] })],
      /singleton key "fixture.store" is malformed/,
    ],
    [
      "no init",
      [slot({ init: undefined as never })],
      /provider slot "fixtureStore" has no init/,
    ],
    [
      "no selections",
      [slot({ values: [] })],
      /provider slot "fixtureStore" declares no selections/,
    ],
    [
      "a malformed selection",
      [slot({ values: ["Postgres", "memory"] })],
      /selection "Postgres" is malformed/,
    ],
    [
      "a default outside its selections",
      [slot({ defaultValue: "redis" })],
      /defaults to "redis", which is not one of its selections/,
    ],
    [
      "a durable slot without its words",
      [slot({ durable: { selections: ["postgres"], noun: "", fallback: "x" } })],
      /is durable but does not say which selections are durable/,
    ],
    [
      "a durable selection outside its selections",
      [slot({ durable: { selections: ["supabase"], noun: "n", fallback: "f" } })],
      /names durable selection "supabase", which is not one of its selections/,
    ],
    [
      "a durable default",
      [
        slot({
          defaultValue: "postgres",
          durable: { selections: ["postgres"], noun: "n", fallback: "f" },
        }),
      ],
      /defaults to a durable selection; the default must work without a database/,
    ],
  ] as [string, PlatformModuleInput["providers"], RegExp][])(
    "refuses %s",
    (_name, providers, problem) => refuses({ id: "m", providers }, problem)
  );
});
