/**
 * TASK-197 (audit D-2): every external dependency a provider selection reaches has a readiness
 * probe, or a stated reason it has none.
 *
 * @guard a provider selection whose external dependency has no readiness probe and no reason
 *
 * Readiness checked the database, the cache and the Cognito pool's shape. A revoked AI key, an
 * exhausted credit balance, a retired model (TASK-186), a restricted Google key and a rotated
 * rate-limit token all left it "ready": nothing probed them, and nothing required it. Now:
 *
 *   - every selection of every slot — the core's (platform/providers/dependency-coverage.ts,
 *     typed so a new selection does not compile uncovered) and every registered module's
 *     (ModuleProviderSlot.coverage, checked here) — is "local", names a probe, or is exempt
 *     with a reason;
 *   - each probe a selection names is in fact registered at readiness for that selection
 *     (buildReadinessProbes, what instrumentation.ts registers);
 *   - a probe that makes a billed call is cached (CachedHealthProbe, audit X-13).
 */

jest.mock("@/platform/data", () => ({
  ...jest.requireActual("@/platform/data"),
  hasDatabase: () => true,
}));

import { getModules } from "@/platform/modules/registry";
import type { DependencyCoverage } from "@/platform/modules/types";
import { CORE_DEPENDENCY_COVERAGE } from "@/platform/providers/dependency-coverage";
import { buildReadinessProbes } from "@/platform/providers/readiness-probes";
import { CachedHealthProbe } from "@/platform/observability/health";

/** The setting that selects each core slot (as the registry reads it). */
const CORE_SETTING: Readonly<Record<keyof typeof CORE_DEPENDENCY_COVERAGE, string>> = {
  auth: "AUTH_PROVIDER",
  cache: "CACHE_PROVIDER",
  ai: "AI_PROVIDER",
  errorReporter: "ERROR_REPORTER",
  realtime: "REALTIME_PROVIDER",
  moderationStore: "MODERATION_STORE",
  strikeStore: "STRIKE_STORE",
  reviewQueueStore: "REVIEW_QUEUE_STORE",
  embeddingProvider: "EMBEDDING_PROVIDER",
  appStateStore: "APP_STATE_STORE",
  trajectoryStore: "TRAJECTORY_STORE",
  budgetStore: "BUDGET_STORE",
  proposalStore: "PROPOSAL_STORE",
  effectLedger: "EFFECT_LEDGER",
  approvalPolicyStore: "APPROVAL_POLICY_STORE",
  guestUsageStore: "GUEST_USAGE_STORE",
  rateLimiter: "RATE_LIMIT_STORE",
  jobStore: "JOB_STORE",
};

interface Row {
  readonly owner: string;
  readonly setting: string;
  readonly selection: string;
  readonly coverage: DependencyCoverage | undefined;
}

function rows(): Row[] {
  const core: Row[] = Object.entries(CORE_DEPENDENCY_COVERAGE).flatMap(([slot, map]) =>
    Object.entries(map as Record<string, DependencyCoverage>).map(
      ([selection, coverage]) => ({
        owner: `core.${slot}`,
        setting: CORE_SETTING[slot as keyof typeof CORE_SETTING],
        selection,
        coverage,
      })
    )
  );
  const modules: Row[] = getModules().flatMap((m) =>
    m.providers.flatMap((slot) =>
      slot.values.map((selection) => ({
        owner: `${m.id}.${slot.slot}`,
        setting: slot.envVar,
        selection,
        coverage: slot.coverage?.[selection],
      }))
    )
  );
  return [...core, ...modules];
}

/**
 * Whether a probe's check takes the timeout it is given and passes it on: its first parameter is
 * named, and that name is used in its body (TASK-197 review round 3, N4).
 */
function usesItsBudget(check: unknown): boolean {
  const source = typeof check === "function" ? check.toString() : "";
  const param = source.match(
    /^\s*(?:async\s+)?(?:check\s*)?\(\s*([A-Za-z_$][\w$]*)/
  )?.[1];
  if (!param) return false;
  const body = source.slice(source.indexOf(")") + 1);
  return new RegExp(`(?<![\\w$])${param.replace(/\$/g, "\\$")}(?![\\w$])`).test(body);
}

/** The probes readiness registers when `setting` is `selection` (the rest at their defaults). */
function probesFor(setting: string, selection: string) {
  const env: Record<string, string> = {
    [setting]: selection,
    // A selection's credentials, so its probe has something to probe.
    ANTHROPIC_API_KEY: "test-key",
    GOOGLE_API_KEY: "test-key",
  };
  const { required, degradedOnly } = buildReadinessProbes(env);
  return [...required, ...degradedOnly];
}

interface SlotLike {
  readonly slot: string;
  readonly values: readonly string[];
  readonly coverage?: Readonly<Record<string, unknown>>;
}

/** Selections a slot offers with no coverage entry, and coverage for selections it lacks. */
function coverageFindings(
  modules: readonly { id: string; providers: readonly SlotLike[] }[]
) {
  const missing: string[] = [];
  const extra: string[] = [];
  for (const m of modules) {
    for (const slot of m.providers) {
      for (const v of slot.values) {
        if (!slot.coverage?.[v]) missing.push(`${m.id}.${slot.slot}=${v}`);
      }
      for (const k of Object.keys(slot.coverage ?? {})) {
        if (!slot.values.includes(k)) extra.push(`${m.id}.${slot.slot}=${k}`);
      }
    }
  }
  return { missing, extra };
}

describe("every dependency a selection reaches has a readiness probe (TASK-197, audit D-2)", () => {
  it("[self-test] reports a planted selection with no probe and no exemption", () => {
    const planted = [
      {
        id: "planted",
        providers: [
          {
            slot: "plantedStore",
            values: ["memory", "remote"],
            coverage: { memory: { exempt: "in process" }, gone: { probe: "x" } },
          },
        ],
      },
    ];
    expect(coverageFindings(planted)).toEqual({
      missing: ["planted.plantedStore=remote"],
      extra: ["planted.plantedStore=gone"],
    });
  });

  it("covers every module slot's every selection, and nothing it does not have", () => {
    const { missing, extra } = coverageFindings(getModules());
    // Under `npm run test:core` (PF_TEST_MODULES=none) no module is registered: the core's rows
    // are still checked below.
    if (process.env.PF_TEST_MODULES !== "none")
      expect(getModules().length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it("states a reason for every exemption", () => {
    for (const r of rows()) {
      if (r.coverage && typeof r.coverage === "object" && "exempt" in r.coverage) {
        expect({
          who: `${r.owner}=${r.selection}`,
          len: r.coverage.exempt.length > 40,
        }).toEqual({ who: `${r.owner}=${r.selection}`, len: true });
      }
    }
  });

  it("registers, for each selection that names a probe, that probe", () => {
    const named = rows().filter(
      (r): r is Row & { coverage: { probe: string } } =>
        typeof r.coverage === "object" && "probe" in r.coverage
    );
    expect(named.length).toBeGreaterThan(5);
    const unregistered = named
      .filter(
        (r) => !probesFor(r.setting, r.selection).some((p) => p.name === r.coverage.probe)
      )
      .map((r) => `${r.owner}=${r.selection} names "${r.coverage.probe}"`);
    expect(unregistered).toEqual([]);
  });

  it("caches the probes that make billed calls (audit X-13)", () => {
    const required = new Set(
      buildReadinessProbes({
        ANTHROPIC_API_KEY: "test-key",
        GOOGLE_API_KEY: "test-key",
      }).required.map((x) => x.name)
    );
    const probes = probesFor("AI_PROVIDER", "anthropic");
    const billed = [
      "ai-provider",
      ...(getModules().length > 0
        ? ["song-identification", "google-tts", "google-translate"]
        : []),
    ];
    for (const name of billed) {
      const p = probes.find((x) => x.name === name);
      // By name: the modules' code is loaded in an isolated registry (jest.setup.ts), so its
      // CachedHealthProbe is another copy of the class.
      expect({ name, cached: p?.constructor.name }).toEqual({
        name,
        cached: CachedHealthProbe.name,
      });
      // Round 2 (the class): every billed probe has the paid-probe budget and failure cache —
      // song identification had neither.
      expect({ name, options: (p as unknown as { options?: unknown })?.options }).toEqual(
        {
          name,
          options: { budgetMs: 15_000, failureTtlMs: 60_000 },
        }
      );
      // Round 3 (N4): the wrapped probe takes the budget — its check declares the timeout
      // parameter and uses it (song identification's ignored it) — and a billed probe is
      // optional: it can degrade the report, never take the instance out of rotation.
      const inner = (p as unknown as { probe?: { check: unknown } })?.probe;
      expect({ name, budget: usesItsBudget(inner?.check) }).toEqual({
        name,
        budget: true,
      });
      expect({ name, required: required.has(name) }).toEqual({ name, required: false });
    }
  });

  it("registers no AI probe when the deployment does not call Anthropic", () => {
    expect(probesFor("AI_PROVIDER", "mock").some((p) => p.name === "ai-provider")).toBe(
      false
    );
  });
});
