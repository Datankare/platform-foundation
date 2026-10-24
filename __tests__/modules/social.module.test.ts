/**
 * __tests__/modules/social.module.test.ts — The social module's contributions (ADR-054)
 *
 * The module runs alone (it depends on nothing). Its store slot is a durable slot, held to the
 * core's rules (TASK-107, ADR-048 D3, ADR-053 D4) and checked by the environment contract; its
 * five agents, their prompts and evals, the curator content type, the "social" content kind and
 * the Teams feature join the core's lists — and are absent from an app without the module.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "test-req",
}));

import { SOCIAL_MODULE } from "@/platform/social/module";
import { runWithModules, restoreAppModules } from "../helpers/modules";
import { productionDeployment, setNodeEnv } from "../helpers/production-env";

const AGENTS = ["matchmaker", "gatekeeper", "concierge", "analyst", "curator"];
const ORIG = { ...process.env };

beforeEach(() => {
  jest.resetModules();
  process.env = { ...ORIG };
  for (const k of [
    "SOCIAL_STORE",
    "DATABASE_URL",
    "DATABASE_OWNER_URL",
    "E2E_IN_MEMORY_STORES",
  ]) {
    delete process.env[k];
  }
  runWithModules([SOCIAL_MODULE]);
});

afterEach(() => {
  process.env = { ...ORIG };
});

afterAll(() => restoreAppModules());

async function boot(): Promise<() => unknown> {
  const registry = await import("@/platform/providers/registry");
  registry.resetProviders();
  return () => registry.initProviders();
}

describe("social module — store slot (TASK-107)", () => {
  it("is a durable slot", () => {
    expect(SOCIAL_MODULE.providers[0]).toMatchObject({
      slot: "socialStore",
      envVar: "SOCIAL_STORE",
      values: ["postgres", "supabase", "memory"],
      defaultValue: "memory",
      durable: { selections: ["postgres", "supabase"] },
      singletonKeys: ["platform.social.store"],
    });
  });

  it("uses the in-memory store outside production", async () => {
    (await boot())();
    const { getSocialStore } = await import("@/platform/social");
    // By name: the slot's store comes from the module copy this file registered.
    expect(getSocialStore().constructor.name).toBe("InMemorySocialStore");
  });

  it.each(["postgres", "supabase"])(
    "refuses SOCIAL_STORE=%s without a database instead of falling back to memory",
    async (type) => {
      process.env.SOCIAL_STORE = type;
      expect(await boot()).toThrow(
        `SOCIAL_STORE=${type} but DATABASE_URL is not set. Refusing to fall back to an in-memory social store (ADR-053 D4).`
      );
    }
  );

  it("installs the Postgres store when it is selected with a database", async () => {
    process.env.SOCIAL_STORE = "postgres";
    process.env.DATABASE_URL = "postgresql://app_tenant:pw@pooler.example.test:6543/app";
    (await boot())();
    const { getSocialStore } = await import("@/platform/social");
    expect(getSocialStore().constructor.name).toBe("PostgresSocialStore");
  });

  describe("in production (ADR-048 D3)", () => {
    // A contract-valid production boot with every core store durable, so the store that refuses
    // is the one under test.
    const production = productionDeployment;
    afterEach(() => setNodeEnv("test"));

    it("refuses the memory store", async () => {
      production();
      process.env.SOCIAL_STORE = "memory";
      expect(await boot()).toThrow(
        'SOCIAL_STORE is unset or "memory" in production. Refusing to boot on in-memory groups and memberships'
      );
    });

    it("refuses an unset store (it defaults to memory)", async () => {
      production();
      expect(await boot()).toThrow(/SOCIAL_STORE is unset or "memory" in production/);
    });

    it("boots on the Postgres store", async () => {
      production();
      process.env.SOCIAL_STORE = "postgres";
      expect(await boot()).not.toThrow();
    });

    it("an app without the module does not require the store", async () => {
      production();
      runWithModules([]);
      expect(await boot()).not.toThrow();
    });
  });

  it("makes SOCIAL_STORE=postgres require DATABASE_URL in the environment contract", async () => {
    const { checkEnvironmentContract } =
      await import("@/platform/providers/environment-contract");
    const env = { SOCIAL_STORE: "postgres", DEPLOYMENT_HOST: "ci" };
    expect(checkEnvironmentContract(env)).toContain(
      "DATABASE_URL is required (SOCIAL_STORE=postgres) but not set"
    );
    runWithModules([]);
    expect(checkEnvironmentContract(env)).not.toContain(
      "DATABASE_URL is required (SOCIAL_STORE=postgres) but not set"
    );
  });
});

describe("social module — agents, prompts, evals, content", () => {
  it("registers its five agents with the core's", async () => {
    const { registerPlatformAgents } = await import("@/platform/agents/agent-configs");
    const { listAgents, resetAgentRegistry } = await import("@/platform/agents/registry");
    resetAgentRegistry();
    registerPlatformAgents();
    for (const id of AGENTS) expect(listAgents()).toContain(id);
    resetAgentRegistry();
    runWithModules([]);
    registerPlatformAgents();
    for (const id of AGENTS) expect(listAgents()).not.toContain(id);
  });

  it("adds its prompts to the prompt registry, and only with the module", async () => {
    const { listPrompts, getPromptConfig } = await import("@/prompts");
    for (const name of AGENTS) expect(getPromptConfig(name).name).toBe(name);
    runWithModules([]);
    for (const name of AGENTS) expect(listPrompts()).not.toContain(name);
    expect(() => getPromptConfig("curator")).toThrow(/Unknown prompt: "curator"/);
  });

  it("adds an eval suite for each of its prompts", async () => {
    const { listEvalSuites } = await import("@/prompts/evals");
    expect(
      listEvalSuites()
        .map((s) => s.prompt)
        .filter((p) => AGENTS.includes(p))
        .sort()
    ).toEqual([...AGENTS].sort());
  });

  it("registers the curator content type at boot, hosted by its curator agent", async () => {
    const { resetContentTypes, getContentType } =
      await import("@/platform/content/registry");
    resetContentTypes();
    (await boot())();
    expect(getContentType("curator")?.agentId).toBe("curator");
  });

  it("adds the social content kind (standard screening) and the Teams preview", async () => {
    const { isModerationContentType, allowsSeverityReduction } =
      await import("@/platform/moderation/content-types");
    const { featureAvailability } = await import("@/platform/features/availability");
    expect(isModerationContentType("social")).toBe(true);
    expect(allowsSeverityReduction("social")).toBe(false);
    expect(featureAvailability({}).teams).toEqual({ available: true, preview: true });
  });
});
