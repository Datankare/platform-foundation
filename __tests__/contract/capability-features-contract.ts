/**
 * __tests__/contract/capability-features-contract.ts
 * Capability→feature evaluation conformance kit (review 12 H1, review 13 P). Not a *.test.ts.
 *
 * The contract for deciding a capability from `agent.capability_features`
 * ([[capability, features[]], …]):
 *
 *   - a capability absent from the map is NOT allowed (never "no features required");
 *   - a malformed map allows nothing — and neither does a map that cannot be read (the config
 *     store down, the key missing). FAIL CLOSED: there is no fallback to a built-in map. A consumer
 *     that kept a built-in "fail-safe" map for a config outage must remove it: a built-in map is
 *     a second, ungoverned copy of the policy, and falling back to it turns "I could not read the
 *     policy" into "allow what the code shipped with" (consumer obligation, MIGRATION_v5_to_v6 §1b);
 *   - a mapped capability is allowed exactly when every listed feature is held; an explicitly
 *     empty list needs none.
 *
 * Two ways to run it:
 *
 *   1. A pure evaluator `(map, capability, held) => boolean` — the platform's
 *      evaluateCapabilityFeatures (platform/agents/capability-features.ts).
 *   2. A consumer's own decision, in its own signature — no adapter to write. Give the kit the
 *      three seams every consumer's decision has (where the map is read, where the account's
 *      features are checked, the decision itself), and it arranges each case through them:
 *
 *        runCapabilityFeaturesContract({
 *          serveMap: (map) => { configValue = map; },           // the config read returns map
 *          serveUnreadable: () => { configValue = THROW; },     // the config read throws
 *          holdFeatures: (held) => { heldFeatures = held; },    // checkAccountStatus allows these
 *          decide: (capability) => evaluateCapability(capability, identity, userId),
 *        });
 *
 *      `decide` may answer a boolean or anything with `allowed` (Playform's CapabilityDecision).
 *      With this shape the kit also proves the unreadable case. A consumer that reads the config
 *      MUST use this shape. consumerEvaluator() turns it into a pure evaluator, should a consumer
 *      want one.
 *
 * Its own capability names (review 14 L-5). The kit's cases are built from names — by default the
 * platform's ("full-pipeline", "translate", "open"; features "identify_song", "translate",
 * "speak"). A consumer passes ITS capability and feature names, and the names of any built-in or
 * former fallback map it had, as the second argument:
 *
 *   runCapabilityFeaturesContract(fixtures, {
 *     names: { multi: "acme.summarize", multiFeatures: ["read", "summarize"],
 *              single: "acme.read", singleFeature: "read", open: "acme.ping",
 *              unmapped: "acme.delete", fallback: ["acme.read", "acme.summarize"] },
 *   });
 *
 * Every fallback name is then proved not allowed when the map is unreadable, malformed, empty, or
 * does not map it — whatever the caller holds — so a consumer's fallback under its own names cannot
 * pass the kit by not being asked about (it could with fixed names). Names it omits default to the
 * platform's; the kit refuses names that collide.
 *
 * Consumers read the two governed agent keys with readCapabilityFeatures / readTrustedAgents /
 * evaluateGovernedCapability (platform/agents/governed-agent-config.ts): getConfigOrThrow semantics, never a
 * default.
 */

/** The evaluator under test: whether a caller holding `held` may use `capability`. */
export type CapabilityEvaluator = (
  map: unknown,
  capability: string,
  held: readonly string[]
) => boolean | Promise<boolean>;

/** A consumer's answer: a boolean, or a decision object carrying `allowed`. */
export type CapabilityAnswer = boolean | { readonly allowed: boolean };

/** A consumer's own decision, through the seams it already has (see the header). */
export interface ConsumerCapabilityFixtures {
  /** Arrange: the consumer's read of agent.capability_features returns `map`. */
  readonly serveMap: (map: unknown) => void | Promise<void>;
  /** Arrange: the consumer's read of agent.capability_features fails (throws). */
  readonly serveUnreadable: () => void | Promise<void>;
  /** Arrange: the account holds exactly these features (and no others). */
  readonly holdFeatures: (held: readonly string[]) => void | Promise<void>;
  /** Act: the consumer's own decision for `capability`. */
  readonly decide: (capability: string) => CapabilityAnswer | Promise<CapabilityAnswer>;
}

export type CapabilityFeaturesContractFixtures =
  { readonly evaluate: CapabilityEvaluator } | ConsumerCapabilityFixtures;

const allowedOf = (a: CapabilityAnswer): boolean =>
  typeof a === "boolean" ? a : Boolean(a && a.allowed === true);

/**
 * The documented adapter: a consumer's seams as a pure evaluator `(map, capability, held)`.
 */
export function consumerEvaluator(fx: ConsumerCapabilityFixtures): CapabilityEvaluator {
  return async (map, capability, held) => {
    await fx.serveMap(map);
    await fx.holdFeatures(held);
    return allowedOf(await fx.decide(capability));
  };
}

/** The capability and feature names the kit's cases use (review 14 L-5). */
export interface CapabilityContractNames {
  /** A capability needing several features. */
  readonly multi: string;
  /** Its features (at least two). */
  readonly multiFeatures: readonly string[];
  /** A capability needing one feature. */
  readonly single: string;
  readonly singleFeature: string;
  /** A capability mapped to no feature (an explicit "none required"). */
  readonly open: string;
  /** A capability the map never names. */
  readonly unmapped: string;
  /**
   * Capabilities a built-in or former fallback map of the consumer allowed: each must be refused
   * whenever the governed map does not allow it.
   */
  readonly fallback: readonly string[];
}

/** The platform's names: the kit's default. */
export const PF_CAPABILITY_NAMES: CapabilityContractNames = Object.freeze({
  multi: "full-pipeline",
  multiFeatures: ["identify_song", "translate", "speak"],
  single: "translate",
  singleFeature: "translate",
  open: "open",
  unmapped: "speak",
  fallback: ["translate", "full-pipeline", "open"],
});

/** The names, completed from the platform's and checked: distinct, non-empty, usable. */
export function contractNames(
  given: Partial<CapabilityContractNames> = {}
): CapabilityContractNames {
  const n: CapabilityContractNames = { ...PF_CAPABILITY_NAMES, ...given };
  const caps = [n.multi, n.single, n.open, n.unmapped];
  const bad = (why: string) => {
    throw new Error(`runCapabilityFeaturesContract: names ${why}`);
  };
  if (caps.some((c) => typeof c !== "string" || c.length === 0)) bad("must be non-empty");
  if (new Set(caps).size !== caps.length)
    bad("multi, single, open and unmapped must differ");
  if (new Set(n.multiFeatures).size < 2) bad("multiFeatures needs two distinct features");
  if (!n.singleFeature) bad("singleFeature must be non-empty");
  if (n.fallback.some((c) => typeof c !== "string" || c.length === 0))
    bad("fallback names must be non-empty");
  return n;
}

/** A variant of `name` that is not `name` (another case, else a trailing space). */
const otherCase = (name: string) =>
  name.toUpperCase() !== name
    ? name.toUpperCase()
    : name.toLowerCase() !== name
      ? name.toLowerCase()
      : `${name}_`;

/** One case of the contract: its name, and the violation it found (null: it holds). */
export interface CapabilityContractCase {
  readonly group: string;
  readonly name: string;
  readonly violation: () => Promise<string | null>;
}

/**
 * The contract's cases for `fx` under `names` — what runCapabilityFeaturesContract registers, one
 * test each. Exported so a meta-test can run them and see which a non-conforming decision fails.
 */
export function capabilityContractCases(
  fx: CapabilityFeaturesContractFixtures,
  given: Partial<CapabilityContractNames> = {}
): readonly CapabilityContractCase[] {
  const n = contractNames(given);
  const evaluate = "evaluate" in fx ? fx.evaluate : consumerEvaluator(fx);
  const ok = async (map: unknown, cap: string, held: readonly string[]) =>
    Boolean(await evaluate(map, cap, held));
  const MAP: [string, string[]][] = [
    [n.multi, [...n.multiFeatures]],
    [n.single, [n.singleFeature]],
    [n.open, []],
  ];
  const everything = [...new Set([...n.multiFeatures, n.singleFeature])];
  const kase = (
    group: string,
    name: string,
    run: () => Promise<boolean>,
    want: boolean
  ): CapabilityContractCase => ({
    group,
    name,
    violation: async () => {
      const got = await run();
      return got === want
        ? null
        : `${name}: expected ${want ? "allowed" : "refused"}, got ${got ? "allowed" : "refused"}`;
    },
  });
  const cases: CapabilityContractCase[] = [];

  if (!("evaluate" in fx)) {
    const G =
      "a map that cannot be read allows nothing (fail closed, no built-in fallback)";
    const unreadable = async (cap: string, held: readonly string[]) => {
      await fx.serveUnreadable();
      await fx.holdFeatures(held);
      return allowedOf(await fx.decide(cap));
    };
    cases.push(
      kase(
        G,
        `${n.single}: every feature it needs held`,
        () => unreadable(n.single, [n.singleFeature]),
        false
      ),
      kase(
        G,
        `${n.multi}: every feature it needs held`,
        () => unreadable(n.multi, n.multiFeatures),
        false
      ),
      kase(
        G,
        `${n.open}: a capability needing nothing`,
        () => unreadable(n.open, []),
        false
      ),
      ...n.fallback.map((cap) =>
        kase(
          G,
          `fallback ${cap}: every feature held`,
          () => unreadable(cap, everything),
          false
        )
      ),
      kase(
        G,
        "allows again once the map can be read",
        async () =>
          !(await unreadable(n.single, [n.singleFeature])) &&
          (await ok(MAP, n.single, [n.singleFeature])),
        true
      )
    );
  }

  const A = "capability absent from the map";
  cases.push(
    kase(A, `${n.unmapped}: holding nothing`, () => ok(MAP, n.unmapped, []), false),
    kase(
      A,
      `${n.unmapped}: holding every feature`,
      () => ok(MAP, n.unmapped, [...everything, n.unmapped]),
      false
    ),
    kase(
      A,
      `${n.multi} is allowed while mapped`,
      () => ok(MAP, n.multi, n.multiFeatures),
      true
    ),
    kase(
      A,
      `${n.multi} is not allowed once its mapping is removed`,
      () =>
        ok(
          MAP.filter(([c]) => c !== n.multi),
          n.multi,
          n.multiFeatures
        ),
      false
    ),
    kase(
      A,
      `${n.single} under an empty map`,
      () => ok([], n.single, [n.singleFeature]),
      false
    ),
    ...n.fallback.flatMap((cap) => [
      kase(A, `fallback ${cap} under an empty map`, () => ok([], cap, everything), false),
      kase(
        A,
        `fallback ${cap} when the map does not name it`,
        () =>
          ok(
            MAP.filter(([c]) => c !== cap),
            cap,
            everything
          ),
        false
      ),
    ])
  );

  const M = "a malformed map allows nothing";
  const malformed: [string, unknown][] = [
    ["not a list", { [n.single]: [n.singleFeature] }],
    ["null", null],
    ["an entry not a pair", [[n.single]]],
    ["features not strings", [[n.single, [1]]]],
    ["features not a list", [[n.single, n.singleFeature]]],
    ["an empty object", {}],
    ["a string", n.single],
    [
      "a capability twice",
      [
        [n.single, []],
        [n.single, [n.singleFeature]],
      ],
    ],
  ];
  for (const [label, map] of malformed) {
    cases.push(
      kase(M, `${label}: ${n.single}`, () => ok(map, n.single, [n.singleFeature]), false)
    );
    for (const cap of n.fallback)
      cases.push(
        kase(M, `${label}: fallback ${cap}`, () => ok(map, cap, everything), false)
      );
  }

  const P = "a mapped capability";
  cases.push(
    kase(
      P,
      `${n.multi}: every listed feature held`,
      () => ok(MAP, n.multi, n.multiFeatures),
      true
    ),
    kase(
      P,
      `${n.single}: its feature and another held`,
      () => ok(MAP, n.single, [n.singleFeature, "zz-other"]),
      true
    ),
    kase(
      P,
      `${n.multi}: one listed feature missing`,
      () => ok(MAP, n.multi, n.multiFeatures.slice(1)),
      false
    ),
    kase(P, `${n.single}: its feature missing`, () => ok(MAP, n.single, []), false),
    kase(
      P,
      `${n.open}: an explicitly empty list needs no feature`,
      () => ok(MAP, n.open, []),
      true
    ),
    kase(
      P,
      `${n.single} is not matched in another case`,
      () => ok(MAP, otherCase(n.single), [n.singleFeature]),
      false
    ),
    kase(
      P,
      `${n.single} is not matched with a trailing space`,
      () => ok(MAP, `${n.single} `, [n.singleFeature]),
      false
    )
  );
  return cases;
}

/** The violations `fx` shows under `names` (empty: it conforms). */
export async function capabilityContractViolations(
  fx: CapabilityFeaturesContractFixtures,
  names: Partial<CapabilityContractNames> = {}
): Promise<string[]> {
  const out: string[] = [];
  for (const c of capabilityContractCases(fx, names)) {
    const v = await c.violation();
    if (v) out.push(`${c.group} — ${v}`);
  }
  return out;
}

/**
 * Register the contract as tests. `options.names`: the consumer's own capability, feature and
 * fallback names (default: the platform's).
 */
export function runCapabilityFeaturesContract(
  fx: CapabilityFeaturesContractFixtures,
  options: { readonly names?: Partial<CapabilityContractNames> } = {}
): void {
  const cases = capabilityContractCases(fx, options.names);
  const groups = [...new Set(cases.map((c) => c.group))];
  for (const group of groups) {
    describe(group, () => {
      for (const c of cases.filter((x) => x.group === group)) {
        it(c.name, async () => {
          expect(await c.violation()).toBeNull();
        });
      }
    });
  }
}
