/**
 * __tests__/capability-features-conformance.test.ts — the platform's capability evaluator holds
 * the consumer contract (review 12 H1): an absent capability is not allowed; and (review 13 P) the
 * kit runs a consumer's own decision in its own signature, and a map that cannot be read allows
 * nothing — the platform's reader (evaluateGovernedCapability) included.
 */

let served: { map?: unknown; unreadable?: boolean } = {};
jest.mock("@/platform/auth/platform-config", () => ({
  getConfigOrThrow: jest.fn(async (key: string) => {
    if (key !== "agent.capability_features") throw new Error(`unexpected key ${key}`);
    if (served.unreadable) throw new Error("config store down");
    return served.map;
  }),
  getConfig: jest.fn(async () => {
    throw new Error("getConfig must not be used for agent.capability_features");
  }),
}));

import {
  capabilityContractViolations,
  consumerEvaluator,
  contractNames,
  PF_CAPABILITY_NAMES,
  runCapabilityFeaturesContract,
  type ConsumerCapabilityFixtures,
} from "./contract/capability-features-contract";
import {
  evaluateCapabilityFeatures,
  requiredFeatures,
} from "@/platform/agents/capability-features";
import {
  evaluateGovernedCapability,
  GovernedAgentConfigUnreadableError,
  readCapabilityFeatures,
  readTrustedAgents,
} from "@/platform/agents/governed-agent-config";

describe("evaluateCapabilityFeatures — conformance (pure evaluator)", () => {
  runCapabilityFeaturesContract({
    evaluate: (map, cap, held) => evaluateCapabilityFeatures(map, cap, held).allowed,
  });
});

describe("evaluateGovernedCapability — conformance (consumer shape: reads the map itself, fail closed)", () => {
  let held: readonly string[] = [];
  runCapabilityFeaturesContract({
    serveMap: (map) => {
      served = { map };
    },
    serveUnreadable: () => {
      served = { unreadable: true };
    },
    holdFeatures: (h) => {
      held = h;
    },
    decide: (capability) => evaluateGovernedCapability(capability, held),
  });
});

describe("the kit catches a consumer that falls back to a built-in map (review 13 P)", () => {
  // Playform's evaluateCapability before review 13: a malformed, empty or unreadable map fell back
  // to a built-in map that allows "translate" to a caller holding "translate".
  const BUILT_IN: Record<string, readonly string[]> = { translate: ["translate"] };
  let map: unknown;
  let unreadable = false;
  let held: readonly string[] = [];
  const fallbackConsumer: ConsumerCapabilityFixtures = {
    serveMap: (m) => {
      map = m;
      unreadable = false;
    },
    serveUnreadable: () => {
      unreadable = true;
    },
    holdFeatures: (h) => {
      held = h;
    },
    decide: async (capability) => {
      let features = BUILT_IN;
      if (!unreadable && Array.isArray(map) && map.length > 0) {
        features = Object.fromEntries(map as [string, string[]][]);
      }
      const need = features[capability] ?? [];
      return { allowed: need.every((f) => held.includes(f)) };
    },
  };
  it("its malformed-map and unreadable answers are the ones the kit refuses", async () => {
    const evaluate = consumerEvaluator(fallbackConsumer);
    expect(await evaluate(null, "translate", ["translate"])).toBe(true); // kit expects false
    expect(await evaluate([], "translate", ["translate"])).toBe(true); // kit expects false
    expect(await evaluate([["x", []]], "speak", [])).toBe(true); // unmapped: kit expects false
    await fallbackConsumer.serveUnreadable();
    await fallbackConsumer.holdFeatures(["translate"]);
    expect(await fallbackConsumer.decide("translate")).toEqual({ allowed: true }); // kit: false
  });
});

// Review 14 L-5: a consumer runs the kit under its own capability names, and its fallback's.
const ACME = {
  multi: "acme.summarize",
  multiFeatures: ["acme.read", "acme.summarize"],
  single: "acme.read",
  singleFeature: "acme.read",
  open: "acme.ping",
  unmapped: "acme.delete",
  fallback: ["acme.read", "acme.summarize"],
} as const;

describe("evaluateCapabilityFeatures — conformance under a consumer's own names (review 14 L-5)", () => {
  runCapabilityFeaturesContract(
    { evaluate: (map, cap, held) => evaluateCapabilityFeatures(map, cap, held).allowed },
    { names: ACME }
  );
});

describe("evaluateGovernedCapability — conformance under a consumer's own names (review 14 L-5)", () => {
  let held: readonly string[] = [];
  runCapabilityFeaturesContract(
    {
      serveMap: (map) => {
        served = { map };
      },
      serveUnreadable: () => {
        served = { unreadable: true };
      },
      holdFeatures: (h) => {
        held = h;
      },
      decide: (capability) => evaluateGovernedCapability(capability, held),
    },
    { names: ACME }
  );
});

describe("the kit asks about the consumer's names, not only the platform's (review 14 L-5)", () => {
  // A consumer whose fallback map uses its own names: under the platform's fixed names the kit
  // never asked about them, and this consumer passed.
  const BUILT_IN: Record<string, readonly string[]> = { "acme.read": ["acme.read"] };
  let map: unknown;
  let unreadable = false;
  let held: readonly string[] = [];
  const acmeFallback: ConsumerCapabilityFixtures = {
    serveMap: (m) => {
      map = m;
      unreadable = false;
    },
    serveUnreadable: () => {
      unreadable = true;
    },
    holdFeatures: (h) => {
      held = h;
    },
    decide: async (capability) => {
      const parsed = evaluateCapabilityFeatures(map, capability, held);
      if (!unreadable && parsed.allowed) return { allowed: true };
      // The fallback: a built-in map, for an unreadable or malformed map only.
      if (unreadable || (!parsed.allowed && parsed.reason === "malformed_map")) {
        const need = BUILT_IN[capability];
        return { allowed: need !== undefined && need.every((f) => held.includes(f)) };
      }
      return { allowed: false };
    },
  };
  it("passes under the platform's names — they never reach its fallback", async () => {
    expect(await capabilityContractViolations(acmeFallback)).toEqual([]);
  });
  it("fails under its own names: the unreadable and malformed cases reach the fallback", async () => {
    const violations = await capabilityContractViolations(acmeFallback, ACME);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => /cannot be read.*acme\.read/.test(v))).toBe(true);
    expect(violations.some((v) => /malformed.*fallback acme\.read/.test(v))).toBe(true);
  });
  it("names default to the platform's, and colliding names are refused", () => {
    expect(contractNames()).toEqual(PF_CAPABILITY_NAMES);
    expect(contractNames({ single: "x" }).multi).toBe("full-pipeline");
    expect(() => contractNames({ single: "full-pipeline" })).toThrow(/must differ/);
    expect(() => contractNames({ multiFeatures: ["a", "a"] })).toThrow(/two distinct/);
    expect(() => contractNames({ unmapped: "" })).toThrow(/non-empty/);
    expect(() => contractNames({ fallback: [""] })).toThrow(/fallback/);
    expect(() => contractNames({ singleFeature: "" })).toThrow(/singleFeature/);
  });
});

describe("evaluateCapabilityFeatures — reasons", () => {
  const map = [["a", ["x", "y"]]];
  it("names why", () => {
    expect(evaluateCapabilityFeatures(map, "b", [])).toEqual({
      allowed: false,
      reason: "unmapped",
    });
    expect(evaluateCapabilityFeatures("nope", "a", [])).toEqual({
      allowed: false,
      reason: "malformed_map",
    });
    expect(evaluateCapabilityFeatures(map, "a", ["x"])).toEqual({
      allowed: false,
      reason: "missing_features",
      missing: ["y"],
    });
    expect(evaluateCapabilityFeatures(map, "a", ["x", "y"])).toEqual({
      allowed: true,
      required: ["x", "y"],
    });
  });
  it("requiredFeatures: null for absent or malformed, the list otherwise", () => {
    expect(requiredFeatures(map, "a")).toEqual(["x", "y"]);
    expect(requiredFeatures(map, "b")).toBeNull();
    expect(requiredFeatures({}, "a")).toBeNull();
  });
  it("evaluateGovernedCapability names an unreadable map", async () => {
    served = { unreadable: true };
    expect(await evaluateGovernedCapability("a", ["x", "y"])).toEqual({
      allowed: false,
      reason: "config_unreadable",
    });
  });
});

describe("the governed agent-config readers have getConfigOrThrow semantics (review 13 P)", () => {
  it("return the stored value, never a default", async () => {
    served = { map: [["a", []]] };
    expect(await readCapabilityFeatures()).toEqual([["a", []]]);
  });
  it("throw a coded error when the read fails", async () => {
    served = { unreadable: true };
    await expect(readCapabilityFeatures()).rejects.toBeInstanceOf(
      GovernedAgentConfigUnreadableError
    );
    await expect(readCapabilityFeatures()).rejects.toMatchObject({
      code: "service.unavailable",
      key: "agent.capability_features",
    });
    // The mock refuses any other key: readTrustedAgents asks for agent.trusted_agents.
    await expect(readTrustedAgents()).rejects.toMatchObject({
      key: "agent.trusted_agents",
    });
  });
});
