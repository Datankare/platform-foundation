/**
 * __tests__/provider-registry-modules.test.ts — Module provider slots are core slots in all but
 * name (ADR-054 D4)
 *
 * A fixture module's slots go through the registry exactly as the core's do: selected from their
 * setting (default when unset), reported by getActiveProviders after the core's, initialized
 * after the core's slots, held to the durable-store rules (no database: refused; production:
 * memory refused unless a CI harness opts out), reset with the core's singletons, and checked by
 * the environment contract. A slot that reuses a core slot's name, setting or singleton is
 * refused. The registry names no module.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "test-req",
}));

import {
  definePlatformModule,
  getModules,
  registerModules,
  resetModuleRegistry,
} from "@/platform/modules";
import type { ModuleProviderSlot, PlatformModule } from "@/platform/modules";
import { getSingleton, hasSingleton, setSingleton } from "@/platform/kernel/singleton";
import { productionDeployment, setNodeEnv } from "./helpers/production-env";

const ORIG = { ...process.env };
let appModules: readonly PlatformModule[];
const installed: string[] = [];

const fixtureSlot = (
  overrides: Partial<ModuleProviderSlot> = {}
): ModuleProviderSlot => ({
  slot: "widgetStore",
  envVar: "WIDGET_STORE",
  values: ["postgres", "memory"],
  defaultValue: "memory",
  durable: {
    selections: ["postgres"],
    noun: "widgets",
    fallback: "an in-memory widget store",
  },
  singletonKeys: ["platform.widget.store"],
  init: (selection, { warn }) => {
    installed.push(selection);
    setSingleton("platform.widget.store", selection);
    if (selection === "memory") warn("widgets are per instance");
  },
  ...overrides,
});

const WIDGETS = definePlatformModule({
  id: "widgets",
  providers: [
    fixtureSlot(),
    fixtureSlot({
      slot: "widgetCache",
      envVar: "WIDGET_CACHE",
      values: ["on", "off"],
      defaultValue: "off",
      durable: undefined,
      singletonKeys: [],
      init: (s) => void installed.push(`cache:${s}`),
    }),
  ],
});

async function boot() {
  const registry = await import("@/platform/providers/registry");
  registry.resetProviders();
  return { registry, run: () => registry.initProviders() };
}

beforeAll(() => {
  appModules = getModules();
});
beforeEach(() => {
  jest.resetModules();
  process.env = { ...ORIG };
  for (const k of [
    "WIDGET_STORE",
    "WIDGET_CACHE",
    "DATABASE_URL",
    "DATABASE_OWNER_URL",
    "E2E_IN_MEMORY_STORES",
    "DEPLOYMENT_HOST",
  ])
    delete process.env[k];
  installed.length = 0;
  resetModuleRegistry();
  registerModules([WIDGETS]);
});
afterEach(() => {
  process.env = { ...ORIG };
  setNodeEnv("test");
});
afterAll(() => {
  resetModuleRegistry();
  registerModules(appModules);
});

describe("module provider slots — selection", () => {
  it("defaults when unset, follows the core's slots, and is initialized after them", async () => {
    const { run, registry } = await boot();
    const selections = run();
    expect(Object.keys(selections).slice(-2)).toEqual(["widgetStore", "widgetCache"]);
    expect(selections.widgetStore).toBe("memory");
    expect(selections.widgetCache).toBe("off");
    expect(installed).toEqual(["memory", "cache:off"]);
    expect(registry.getActiveProviders().widgetCache).toBe("off");
  });

  it("reads the setting, and logs a selection outside the slot's values", async () => {
    process.env.WIDGET_CACHE = "sometimes";
    const { run } = await boot();
    expect(run().widgetCache).toBe("sometimes");
    const { logger } = jest.requireMock("@/lib/logger");
    expect(logger.warn).toHaveBeenCalledWith(
      'WIDGET_CACHE="sometimes" is not one of on, off — passed to the slot as given',
      { route: "platform/providers/registry" }
    );
    expect(installed).toContain("cache:sometimes");
  });

  it("routes the module's warnings to the registry's logger", async () => {
    const { run } = await boot();
    run();
    const { logger } = jest.requireMock("@/lib/logger");
    expect(logger.warn).toHaveBeenCalledWith("widgets are per instance");
  });

  it("logs the module selections with the core's", async () => {
    const { run } = await boot();
    run();
    const { logger } = jest.requireMock("@/lib/logger");
    expect(logger.info).toHaveBeenCalledWith(
      "Platform providers initialized",
      expect.objectContaining({ auth: "mock", widgetStore: "memory", widgetCache: "off" })
    );
  });

  it("initializes once", async () => {
    const { run } = await boot();
    run();
    run();
    expect(installed).toEqual(["memory", "cache:off"]);
  });
});

describe("module provider slots — durable store rules (ADR-048 D3, ADR-053 D4)", () => {
  it("refuses a durable selection without a database, before installing it", async () => {
    process.env.WIDGET_STORE = "postgres";
    const { run } = await boot();
    expect(run).toThrow(
      "WIDGET_STORE=postgres but DATABASE_URL is not set. Refusing to fall back to an in-memory widget store (ADR-053 D4)."
    );
    expect(installed).not.toContain("postgres");
  });

  it("installs a durable selection with a database", async () => {
    process.env.WIDGET_STORE = "postgres";
    process.env.DATABASE_URL = "postgresql://app_tenant:pw@pooler.example.test:6543/app";
    const { run } = await boot();
    run();
    expect(getSingleton("platform.widget.store", () => "none")).toBe("postgres");
  });

  it("refuses memory in production, and a CI harness may opt out", async () => {
    setNodeEnv("production");
    process.env.E2E_IN_MEMORY_STORES = "true";
    process.env.DEPLOYMENT_HOST = "ci";
    process.env.E2E_TEST_DOUBLE_AUTH = "true";
    // Every core store may stay memory under the harness, so the module slot is what is judged.
    const { registry } = await boot();
    expect(() => registry.initProviders()).not.toThrow();
    expect(installed).toContain("memory");
  });

  it("refuses memory in production without the harness, naming the slot", async () => {
    productionDeployment();
    const { run } = await boot();
    expect(run).toThrow(
      'WIDGET_STORE is unset or "memory" in production. Refusing to boot on in-memory widgets'
    );
    expect(installed).toEqual([]);
  });

  it("boots in production on the durable selection, and the non-durable slot needs nothing", async () => {
    productionDeployment();
    process.env.WIDGET_STORE = "postgres";
    const { run } = await boot();
    expect(run).not.toThrow();
    expect(installed).toEqual(["postgres", "cache:off"]);
  });

  it("lists only the durable slot among the contract's database selectors", async () => {
    const env = await import("@/platform/providers/environment-contract");
    expect(env.databaseSelectors()).toContain("WIDGET_STORE");
    expect(env.databaseSelectors()).not.toContain("WIDGET_CACHE");
  });

  it("makes the contract require DATABASE_URL for a durable module selection", async () => {
    const { checkEnvironmentContract } =
      await import("@/platform/providers/environment-contract");
    expect(
      checkEnvironmentContract({ DEPLOYMENT_HOST: "ci", WIDGET_STORE: "postgres" })
    ).toContain("DATABASE_URL is required (WIDGET_STORE=postgres) but not set");
    expect(
      checkEnvironmentContract({ DEPLOYMENT_HOST: "ci", WIDGET_STORE: "memory" }).some(
        (v) => v.startsWith("DATABASE_URL is required")
      )
    ).toBe(false);
  });
});

describe("module provider slots — reset", () => {
  it("clears the module's singletons with the core's", async () => {
    const { run, registry } = await boot();
    run();
    expect(hasSingleton("platform.widget.store")).toBe(true);
    expect(registry.providerSingletonKeys()).toEqual([
      ...registry.CORE_PROVIDER_SINGLETON_KEYS,
      "platform.widget.store",
    ]);
    registry.resetProviders();
    expect(hasSingleton("platform.widget.store")).toBe(false);
  });
});

describe("module provider slots — no reuse of a core slot", () => {
  it.each([
    ["name", { slot: "auth" }, /provider slot "auth" is already the core's/],
    [
      "setting",
      { envVar: "MODERATION_STORE" },
      /provider selector setting "MODERATION_STORE" is already the core's/,
    ],
  ])(
    "refuses a module slot reusing a core slot's %s",
    async (_what, overrides, problem) => {
      resetModuleRegistry();
      registerModules([
        definePlatformModule({ id: "thief", providers: [fixtureSlot(overrides)] }),
      ]);
      const registry = await import("@/platform/providers/registry");
      // Refused wherever the slots are read: boot, the selections, a reset.
      expect(() => registry.initProviders()).toThrow(problem);
      expect(() => registry.getActiveProviders()).toThrow(problem);
      expect(() => registry.resetProviders()).toThrow(problem);
    }
  );

  it("refuses a module slot declaring a core singleton", async () => {
    resetModuleRegistry();
    registerModules([
      definePlatformModule({
        id: "thief",
        providers: [fixtureSlot({ singletonKeys: ["platform.auth.provider"] })],
      }),
    ]);
    const registry = await import("@/platform/providers/registry");
    expect(() => registry.providerSingletonKeys()).toThrow(
      "Module provider slots declare core singleton keys: platform.auth.provider (ADR-054)"
    );
  });
});
