/**
 * platform/rate-limit/rules.ts — Every rate limit rule this app enforces (ADR-052, ADR-054 D4)
 *
 * The core's rules (DEFAULT_RULES) then each registered module's (a module declares the rules its
 * routes enforce — song-id: SONG_IDENTIFY_RULE). A rule id is a counter's identity in the shared
 * store, so two rules with one id would share counts: composition refuses a duplicate.
 *
 * A route enforces a rule object directly (enforceRateLimit(request, DEFAULT_RULES.API_GLOBAL),
 * or the module's exported rule); this list is the inventory — what the boot check composes and
 * what a lookup by id resolves against.
 *
 * @module platform/rate-limit
 */

import { composeWithModules } from "@/platform/modules/compose";
import type { Contributed } from "@/platform/modules/types";
import { DEFAULT_RULES, type RateLimitRule } from "./types";

const CORE_RULES: readonly RateLimitRule[] = Object.freeze(Object.values(DEFAULT_RULES));

/** Every rule with its owner ("core" or the module id): the core's first. */
export function listRateRules(): readonly Contributed<RateLimitRule>[] {
  return composeWithModules(
    "rate rule",
    CORE_RULES,
    (r) => r.id,
    (m) => m.rateRules
  );
}

/** The rule with this id. Throws for an id neither the core nor a registered module declares. */
export function getRateRule(id: string): RateLimitRule {
  const found = listRateRules().find((r) => r.value.id === id);
  if (!found) {
    throw new Error(
      `Unknown rate limit rule: "${id}" — not declared by the core or a registered module`
    );
  }
  return found.value;
}
