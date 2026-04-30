/**
 * platform/social/agents/index.ts — Social agent barrel exports
 *
 * @module platform/social/agents
 */

export { createMatchmakerWorkflow } from "./matchmaker";
export type { MatchmakerResult } from "./matchmaker";

export { createGatekeeperWorkflow } from "./gatekeeper";
export type { GatekeeperResult } from "./gatekeeper";

export { createConciergeWorkflow } from "./concierge";
export type { ConciergeResult } from "./concierge";

export { createAnalystWorkflow } from "./analyst";
export type { AnalystResult } from "./analyst";

export { createCuratorWorkflow } from "./curator";
export type { CuratorResult } from "./curator";
