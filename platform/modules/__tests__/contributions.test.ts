/**
 * platform/modules/__tests__/contributions.test.ts — What boot does with the modules (ADR-054 D4)
 *
 * A module that reuses a name the core already has is refused at boot (assertModuleContributions,
 * run by initProviders), for every extensible list; module content types are registered once and
 * never replace another's; module health probes are built after the providers.
 */

import { definePlatformModule, moduleContentType } from "../define";
import { getModules, registerModules, resetModuleRegistry } from "../registry";
import {
  assertModuleContributions,
  createModuleHealthProbes,
  registerModuleContentTypes,
} from "../contributions";
import type { PlatformModule, PlatformModuleInput } from "../types";
import {
  getContentType,
  registerContentType,
  resetContentTypes,
} from "@/platform/content/registry";
import { AGENT_CONFIGS } from "@/platform/agents/agent-configs";
import { agent, fullModule, prompt, slot } from "./fixtures";

let appModules: readonly PlatformModule[];
beforeAll(() => {
  appModules = getModules();
});
beforeEach(() => {
  resetModuleRegistry();
  resetContentTypes();
});
afterAll(() => {
  resetModuleRegistry();
  registerModules(appModules);
  resetContentTypes();
});

const contentType = (name: string, agentId: string) =>
  moduleContentType({
    name,
    agentId,
    build: () => ({ tier: "fast" as const, messages: [], maxTokens: 1 }),
    parse: (raw: string) => raw,
    schema: {},
    renderFallback: () => "",
    toScreenText: (c: string) => c,
  });

describe("assertModuleContributions", () => {
  it("passes for modules that reuse nothing", () => {
    registerModules([definePlatformModule(fullModule("alpha"))]);
    expect(() => assertModuleContributions()).not.toThrow();
  });

  it.each([
    [
      "agent",
      { agents: [agent(AGENT_CONFIGS[0].id)] },
      /agent "audio-classifier" is already the core's/,
    ],
    [
      "prompt",
      { prompts: [prompt("safety-classify")] },
      /prompt "safety-classify" is already the core's/,
    ],
    [
      "feature",
      {
        features: [
          { id: "sso_apple", needs: "always", check: () => ({ available: true }) },
        ],
      },
      /feature "sso_apple" is already the core's/,
    ],
    ["goal", { goals: ["analyze"] }, /workflow goal "analyze" is already the core's/],
    [
      "rate rule",
      { rateRules: [{ id: "api:global", maxRequests: 1, windowSeconds: 1 }] },
      /rate rule "api:global" is already the core's/,
    ],
    [
      "moderation content type",
      { moderationContentTypes: [{ name: "generation", severityReduction: true }] },
      /moderation content type "generation" is already the core's/,
    ],
  ] as [string, Omit<PlatformModuleInput, "id">, RegExp][])(
    "refuses a module %s the core already has",
    (_kind, input, problem) => {
      registerModules([definePlatformModule({ id: "thief", ...input })]);
      expect(() => assertModuleContributions()).toThrow(
        new RegExp(`Platform module "thief": ${problem.source}`)
      );
    }
  );

  it("allows a module to name a core consent or account-status feature (a union)", () => {
    registerModules([
      definePlatformModule({
        id: "m",
        consentFeatures: ["generate"],
        accountStatusFeatures: ["update_profile"],
      }),
    ]);
    expect(() => assertModuleContributions()).not.toThrow();
  });

  it("refuses a content type hosted by an agent nobody declares", () => {
    registerModules([
      definePlatformModule({ id: "m", contentTypes: [contentType("c", "ghost")] }),
    ]);
    expect(() => assertModuleContributions()).toThrow(
      /module "m": content type "c" is hosted by agent "ghost", which neither the core nor a registered module declares/
    );
  });

  it("accepts a content type hosted by a core agent or the module's own", () => {
    registerModules([
      definePlatformModule({
        id: "m",
        agents: [agent("m-agent")],
        contentTypes: [contentType("own", "m-agent"), contentType("core", "conductor")],
      }),
    ]);
    expect(() => assertModuleContributions()).not.toThrow();
  });
});

describe("registerModuleContentTypes", () => {
  it("registers each module's content types, once", () => {
    registerModules([
      definePlatformModule({
        id: "m",
        agents: [agent("m-agent")],
        contentTypes: [contentType("c", "m-agent")],
      }),
    ]);
    registerModuleContentTypes();
    registerModuleContentTypes();
    expect(getContentType("c")?.agentId).toBe("m-agent");
  });

  it("refuses to replace a content type registered under the name with another host", () => {
    registerContentType(contentType("c", "someone-else"));
    registerModules([
      definePlatformModule({
        id: "m",
        agents: [agent("m-agent")],
        contentTypes: [contentType("c", "m-agent")],
      }),
    ]);
    expect(() => registerModuleContentTypes()).toThrow(
      /module "m": content type "c" is already registered with host agent "someone-else"/
    );
  });

  it("leaves a copy of the same content type as it is (another bundle's)", () => {
    const original = contentType("c", "m-agent");
    registerContentType(original);
    registerModules([
      definePlatformModule({
        id: "m",
        agents: [agent("m-agent")],
        contentTypes: [contentType("c", "m-agent")],
      }),
    ]);
    expect(() => registerModuleContentTypes()).not.toThrow();
    expect(getContentType("c")).toBe(original);
  });
});

describe("createModuleHealthProbes", () => {
  it("builds each declared probe when called, in registration order", () => {
    const create = jest.fn(() => ({
      name: "p",
      check: async () => ({ name: "p", status: "healthy" as const, checkedAt: "" }),
    }));
    const mod = definePlatformModule({
      id: "m",
      healthProbes: [{ name: "p", create }],
      providers: [slot()],
    });
    registerModules([mod, definePlatformModule(fullModule("alpha"))]);
    expect(create).not.toHaveBeenCalled();
    expect(createModuleHealthProbes().map((p) => p.name)).toEqual(["p", "alpha-probe"]);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
