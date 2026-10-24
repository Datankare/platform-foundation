/**
 * platform/social/module.ts — The social module (ADR-021, ADR-054 D2)
 *
 * Groups, memberships and invites; the five social agents with their prompts and evals; the
 * curator content type; the "social" moderation content type; the Teams feature; the social
 * store slot (SOCIAL_STORE, durable — refused as memory in production, TASK-107). Its files,
 * tests, kit and migration (015) are listed in platform/modules/manifest.json.
 *
 * @module platform/social
 */

import { definePlatformModule, moduleContentType } from "@/platform/modules/define";
import { defineSuite } from "@/prompts/evals/types";
import { ANALYST_V1 } from "@/prompts/social/analyst-v1";
import { CONCIERGE_V1 } from "@/prompts/social/concierge-v1";
import { CURATOR_V1 } from "@/prompts/social/curator-v1";
import { GATEKEEPER_V1 } from "@/prompts/social/gatekeeper-v1";
import { MATCHMAKER_V1 } from "@/prompts/social/matchmaker-v1";
import { ANALYST_EVAL } from "@/prompts/evals/social/analyst.eval";
import { CONCIERGE_EVAL } from "@/prompts/evals/social/concierge.eval";
import { CURATOR_EVAL } from "@/prompts/evals/social/curator.eval";
import { GATEKEEPER_EVAL } from "@/prompts/evals/social/gatekeeper.eval";
import { MATCHMAKER_EVAL } from "@/prompts/evals/social/matchmaker.eval";
import { SOCIAL_AGENT_CONFIGS } from "./agent-configs";
import { CURATOR_CONTENT_TYPE } from "./content/curator-content";
import { InMemorySocialStore } from "./memory-social-store";
import { PostgresSocialStore } from "./postgres-social-store";
import { SOCIAL_STORE_KEY, setSocialStore } from "./store";

export const SOCIAL_MODULE = definePlatformModule({
  id: "social",
  providers: [
    {
      slot: "socialStore",
      envVar: "SOCIAL_STORE",
      values: ["postgres", "supabase", "memory"],
      defaultValue: "memory",
      // Fail closed (TASK-107): a silent memory fallback shared one membership across users and
      // lost it on restart.
      durable: {
        selections: ["postgres", "supabase"],
        noun: "groups and memberships",
        fallback: "an in-memory social store",
      },
      singletonKeys: [SOCIAL_STORE_KEY],
      init: (selection) => {
        const durable = selection === "postgres" || selection === "supabase";
        setSocialStore(durable ? new PostgresSocialStore() : new InMemorySocialStore());
      },
    },
  ],
  agents: SOCIAL_AGENT_CONFIGS,
  prompts: [MATCHMAKER_V1, GATEKEEPER_V1, CONCIERGE_V1, ANALYST_V1, CURATOR_V1],
  evals: [
    defineSuite(MATCHMAKER_EVAL),
    defineSuite(GATEKEEPER_EVAL),
    defineSuite(CONCIERGE_EVAL),
    defineSuite(ANALYST_EVAL),
    defineSuite(CURATOR_EVAL),
  ],
  contentTypes: [moduleContentType(CURATOR_CONTENT_TYPE)],
  features: [
    {
      id: "teams",
      needs:
        "nothing — sample data until TASK-108 defines participation (offered as a preview)",
      check: () => ({ available: true, preview: true }),
    },
  ],
  // Chat messages and group posts: standard screening, with context.
  moderationContentTypes: [{ name: "social", severityReduction: false }],
  kits: ["__tests__/contract/social-store-contract.ts"],
});
