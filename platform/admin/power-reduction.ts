/**
 * platform/admin/power-reduction.ts — A change that only takes power away (review 11 M-2)
 *
 * Every change to an agent's registration or a capability mapping is dual-controlled (052): a
 * second safety admin approves it. That held the kill switch too — suspending a misbehaving agent
 * waited for a second admin. A change that provably only REMOVES power is now applied at once by
 * the one admin making it, audited and alerted; anything else is held as before.
 *
 * Who may: the admin must hold the key's own tier permission — config_manage_safety for these
 * safety-tier keys, the permission an approver of the held change needs (writeGovernedConfig
 * checks it before anything runs). Not admin_manage_agents: that is the command bar's agent page
 * permission, and a reduction applied unheld must need no less than approving one would.
 *
 * "Provably" is a strict diff of the governed value, old -> new, that names every change and
 * accepts it only if each removes power. Any change it cannot prove — a new agent, a scope added,
 * a longer token lifetime, a reactivation, a new owner, any other field, a capability mapped, a
 * mapping removed or emptied or a required feature dropped, an unreadable or duplicated entry — makes the whole change not a reduction, so
 * a reduction cannot carry a widening with it (a mixed diff is held). No change at all is not a
 * reduction either.
 *
 *   agent.trusted_agents       [[agentId, {owner, scopes[], status, maxTokenTtl?}], …]
 *                              per agent present before and after (none added, none removed):
 *                              owner and every other field unchanged; status active -> suspended
 *                              or unchanged (never suspended -> active); scopes a subset; a
 *                              token lifetime only lowered (none set: none may be set).
 *   agent.capability_features  [[capability, features[]], …]
 *                              required features only added: the same capabilities mapped
 *                              before and after, each feature list a superset of its old one
 *                              (review 12 H1: removing or emptying a mapping widens for a
 *                              consumer that reads an absent capability as needing nothing).
 *
 * The diff is made against the value the write replaces, read in the writing transaction
 * (compare-and-set, setConfigWithHistory's expectPrevious): a concurrent change between the read
 * and the write fails the write instead of being undone by it.
 *
 * @module platform/admin
 */

/** The keys whose power-reducing changes are applied without a second admin. */
export const POWER_REDUCIBLE_KEYS: ReadonlySet<string> = new Set([
  "agent.trusted_agents",
  "agent.capability_features",
]);

export type PowerDiff =
  | { readonly reduces: true; readonly changes: readonly string[] }
  | { readonly reduces: false; readonly reason: string };

/** Whether `key`'s changes are diffed for a reduction at all. */
export function isPowerReducibleKey(key: string): boolean {
  return POWER_REDUCIBLE_KEYS.has(key);
}

/** JSON with object keys sorted at every depth: equal values, equal text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const not = (reason: string): PowerDiff => ({ reduces: false, reason });

/** `value` as [id, entry] pairs with unique ids, or why it is not. */
function pairs(
  value: unknown,
  entryOk: (v: unknown) => boolean
): Map<string, unknown> | string {
  if (!Array.isArray(value)) return "not a list of pairs";
  const out = new Map<string, unknown>();
  for (const p of value) {
    if (
      !Array.isArray(p) ||
      p.length !== 2 ||
      typeof p[0] !== "string" ||
      !entryOk(p[1])
    ) {
      return "an entry is not an [id, value] pair";
    }
    if (out.has(p[0])) return `"${p[0]}" appears twice`;
    out.set(p[0], p[1]);
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** The agent fields a reduction may change (each only downwards). */
const LOWERABLE: ReadonlySet<string> = new Set(["status", "scopes", "maxTokenTtl"]);

/** The strict diff of agent.trusted_agents, old -> new. */
function trustedAgentsDiff(before: unknown, after: unknown): PowerDiff {
  const agentOk = (v: unknown) => isRecord(v) && isStringList(v.scopes);
  const old = pairs(before, agentOk);
  if (typeof old === "string") return not(`the current registry: ${old}`);
  const next = pairs(after, agentOk);
  if (typeof next === "string") return not(`the new registry: ${next}`);
  const changes: string[] = [];
  for (const id of next.keys()) {
    if (!old.has(id)) return not(`agent "${id}" would be added`);
  }
  for (const [id, was] of old) {
    const now = next.get(id) as Record<string, unknown> | undefined;
    if (!now) return not(`agent "${id}" would be removed (suspend it instead)`);
    const w = was as Record<string, unknown>;
    // Every field but the three that can be lowered must be unchanged.
    const rest = (r: Record<string, unknown>) =>
      canonical(Object.fromEntries(Object.entries(r).filter(([k]) => !LOWERABLE.has(k))));
    if (rest(w) !== rest(now))
      return not(
        `agent "${id}": a field other than status, scopes or maxTokenTtl would change`
      );
    if (w.status !== now.status) {
      if (w.status === "active" && now.status === "suspended") {
        changes.push(`suspend ${id}`);
      } else {
        return not(
          `agent "${id}": status ${String(w.status)} -> ${String(now.status)} is not a suspension`
        );
      }
    }
    const wasScopes = new Set(w.scopes as string[]);
    const nowScopes = new Set(now.scopes as string[]);
    for (const sc of nowScopes) {
      if (!wasScopes.has(sc)) return not(`agent "${id}": scope "${sc}" would be added`);
    }
    const dropped = [...wasScopes].filter((sc) => !nowScopes.has(sc));
    if (dropped.length) changes.push(`narrow ${id} (-${dropped.join(", -")})`);
    if (w.maxTokenTtl !== now.maxTokenTtl) {
      const before = w.maxTokenTtl;
      const later = now.maxTokenTtl;
      if (
        typeof before === "number" &&
        typeof later === "number" &&
        Number.isFinite(later) &&
        later > 0 &&
        later < before
      ) {
        changes.push(`lower ${id}'s token lifetime ${before}s -> ${later}s`);
      } else {
        return not(
          `agent "${id}": token lifetime ${String(before)} -> ${String(later)} is not a decrease`
        );
      }
    }
  }
  return changes.length ? { reduces: true, changes } : not("nothing would change");
}

/**
 * The strict diff of agent.capability_features, old -> new: required features only added to
 * mappings that exist (review 12 H1).
 *
 * A mapping lists the features a capability requires. Adding a feature to an existing mapping
 * asks more of every caller: a reduction. Everything else is held. Removing a mapping, emptying
 * one, or removing them all is a WIDENING for a consumer that reads an absent capability as
 * "no features required" (the user gate passes vacuously) — Playform's evaluateCapability did —
 * and the platform cannot tell how a consumer reads it, so it is never applied unheld. (The
 * consumer contract — docs/adr/ADR-040, platform/agents/capability-features.ts — is that an
 * absent capability is not allowed; under it a removal would narrow, but a contract a consumer
 * may not yet honour is not what an unheld change is proved against.) A capability newly mapped
 * is held too: under the contract it is newly allowed.
 */
function capabilityFeaturesDiff(before: unknown, after: unknown): PowerDiff {
  const old = pairs(before, isStringList);
  if (typeof old === "string") return not(`the current mapping: ${old}`);
  const next = pairs(after, isStringList);
  if (typeof next === "string") return not(`the new mapping: ${next}`);
  for (const cap of old.keys()) {
    if (!next.has(cap)) {
      return not(
        `capability "${cap}": its mapping would be removed (a consumer may read an absent capability as needing no features)`
      );
    }
  }
  const changes: string[] = [];
  for (const [cap, features] of next) {
    if (!old.has(cap)) return not(`capability "${cap}" would be mapped`);
    const was = new Set(old.get(cap) as string[]);
    const now = new Set(features as string[]);
    for (const f of was) {
      if (!now.has(f)) {
        return not(`capability "${cap}": required feature "${f}" would be removed`);
      }
    }
    const added = [...now].filter((f) => !was.has(f));
    if (added.length) changes.push(`require ${added.join(", ")} for ${cap}`);
  }
  return changes.length ? { reduces: true, changes } : not("nothing would change");
}

/**
 * Whether changing `key` from `before` to `after` only removes power, and every change it makes.
 * Not a reduction for any other key.
 */
export function powerReduction(key: string, before: unknown, after: unknown): PowerDiff {
  if (key === "agent.trusted_agents") return trustedAgentsDiff(before, after);
  if (key === "agent.capability_features") return capabilityFeaturesDiff(before, after);
  return not(`"${key}" is not a key whose reductions apply without a second admin`);
}

/** Every agent suspended: the registry with each active agent's status set to suspended. */
export function everyAgentSuspended(registry: unknown): unknown {
  if (!Array.isArray(registry)) return registry;
  return registry.map((p) =>
    Array.isArray(p) && p.length === 2 && isRecord(p[1]) && p[1].status === "active"
      ? [p[0], { ...p[1], status: "suspended" }]
      : p
  );
}
