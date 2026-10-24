/**
 * Social Module — barrel exports and singleton.
 *
 * The public entry of the social module (ADR-054 D2). Its definition — the store slot, the five
 * social agents, their prompts and evals, the curator content type — is ./module.ts, which the
 * app lists in platform/modules/app-modules.ts.
 *
 * Usage:
 *   import { getSocialStore } from "@/platform/social";
 *   const store = getSocialStore();
 *
 * Environment variables:
 *   SOCIAL_STORE = "postgres" | "memory" (default: "memory"; "supabase" is read as "postgres")
 *
 * @module platform/social
 */

export type {
  Group,
  GroupStatus,
  Membership,
  MemberRole,
  GroupInvite,
  InviteStatus,
  GroupResult,
  InviteResult,
  MembershipResult,
  CreateGroupInput,
  CreateInviteInput,
  SocialStore,
} from "./types";

export { InMemorySocialStore } from "./memory-social-store";
export { PostgresSocialStore } from "./postgres-social-store";
export { GroupService, GROUP_LIMITS } from "./group-service";
export type { ScreenContentFn } from "./group-service";
export { InviteService } from "./invite-service";
export { createGuardianScreenFn } from "./guardian-adapter";

// Social agents (Sprint 4b)
export {
  createMatchmakerWorkflow,
  createGatekeeperWorkflow,
  createConciergeWorkflow,
  createAnalystWorkflow,
  createCuratorWorkflow,
} from "./agents";
export type {
  MatchmakerResult,
  GatekeeperResult,
  ConciergeResult,
  AnalystResult,
  CuratorResult,
} from "./agents";

// Store singleton (./store.ts — installed by the social module's SOCIAL_STORE slot)
export {
  SOCIAL_STORE_KEY,
  getSocialStore,
  setSocialStore,
  resetSocialStore,
} from "./store";
