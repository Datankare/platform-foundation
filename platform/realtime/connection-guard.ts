/**
 * platform/realtime/middleware.ts — Realtime connection middleware
 *
 * Auth validation and rate limiting for realtime connections.
 * Applied before channel subscription and stream creation.
 *
 * GenAI Principles:
 *   P13 — Control plane: rate limiting per connection
 *   P15 — Agent identity: validates actor type and delegation chain
 *   P17 — Cognition-commitment: only 'inform' and 'checkpoint' allowed without approval for agents
 *
 * @module platform/realtime
 */

import type { ActorType, MessageIntent, RealtimeMessage } from "./types";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RealtimeMiddlewareConfig {
  /** Maximum connections per user (default: 5) */
  maxConnectionsPerUser?: number;
  /** Maximum subscribers per channel (default: 100) */
  maxSubscribersPerChannel?: number;
  /** Intents that agents can use without approval */
  agentAllowedIntents?: MessageIntent[];
}

const DEFAULT_CONFIG: Required<RealtimeMiddlewareConfig> = {
  maxConnectionsPerUser: 5,
  maxSubscribersPerChannel: 100,
  agentAllowedIntents: ["inform", "checkpoint"],
};

// ---------------------------------------------------------------------------
// Connection tracking
// ---------------------------------------------------------------------------

const connectionCounts = new Map<string, number>();
const channelSubscriberCounts = new Map<string, number>();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ConnectionRequest {
  actorType: ActorType;
  actorId: string;
  channel: string;
  onBehalfOf?: string;
}

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Validate a connection request — checks auth and rate limits.
 */
export function validateConnection(
  request: ConnectionRequest,
  config?: RealtimeMiddlewareConfig
): ValidationResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Check actor identity
  if (!request.actorId) {
    return { allowed: false, reason: "Actor ID is required" };
  }

  // Check per-user connection limit
  const currentConnections = connectionCounts.get(request.actorId) ?? 0;
  if (currentConnections >= cfg.maxConnectionsPerUser) {
    logger.warn("Realtime connection limit exceeded", {
      actorId: request.actorId,
      current: currentConnections,
      max: cfg.maxConnectionsPerUser,
    });
    return {
      allowed: false,
      reason: `Connection limit exceeded (${cfg.maxConnectionsPerUser})`,
    };
  }

  // Check per-channel subscriber limit
  const channelSubs = channelSubscriberCounts.get(request.channel) ?? 0;
  if (channelSubs >= cfg.maxSubscribersPerChannel) {
    return {
      allowed: false,
      reason: `Channel subscriber limit exceeded (${cfg.maxSubscribersPerChannel})`,
    };
  }

  // P15: Agent delegation validation
  if (request.actorType === "agent" && !request.onBehalfOf) {
    logger.warn("Agent connection without delegation chain", {
      actorId: request.actorId,
      channel: request.channel,
    });
    // Allow but log — agents should always declare delegation
  }

  return { allowed: true };
}

/**
 * P17: Validate message intent for the cognition-commitment boundary.
 * Agents can only use 'inform' and 'checkpoint' without explicit approval.
 * 'propose', 'commit', and 'rollback' require additional authorization.
 */
export function validateMessageIntent(
  message: Pick<RealtimeMessage, "actorType" | "intent">,
  config?: RealtimeMiddlewareConfig
): ValidationResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Users and system can use any intent
  if (message.actorType !== "agent") {
    return { allowed: true };
  }

  // Agents are restricted to allowed intents
  if (!cfg.agentAllowedIntents.includes(message.intent)) {
    return {
      allowed: false,
      reason: `Agent intent '${message.intent}' requires approval. Allowed: ${cfg.agentAllowedIntents.join(", ")}`,
    };
  }

  return { allowed: true };
}

/**
 * Track a new connection for rate limiting.
 */
export function trackConnection(actorId: string, channel: string): void {
  connectionCounts.set(actorId, (connectionCounts.get(actorId) ?? 0) + 1);
  channelSubscriberCounts.set(channel, (channelSubscriberCounts.get(channel) ?? 0) + 1);
}

/**
 * Release a connection.
 */
export function releaseConnection(actorId: string, channel: string): void {
  const userCount = connectionCounts.get(actorId) ?? 0;
  if (userCount > 0) {
    connectionCounts.set(actorId, userCount - 1);
  }
  const channelCount = channelSubscriberCounts.get(channel) ?? 0;
  if (channelCount > 0) {
    channelSubscriberCounts.set(channel, channelCount - 1);
  }
}

/**
 * Reset all tracking — for tests.
 */
export function resetConnectionTracking(): void {
  connectionCounts.clear();
  channelSubscriberCounts.clear();
}

/**
 * Get connection stats — for health monitoring.
 */
export function getConnectionStats(): {
  totalConnections: number;
  totalChannels: number;
  connectionsByUser: Record<string, number>;
} {
  let totalConnections = 0;
  const connectionsByUser: Record<string, number> = {};
  for (const [actorId, count] of connectionCounts) {
    connectionsByUser[actorId] = count;
    totalConnections += count;
  }
  return {
    totalConnections,
    totalChannels: channelSubscriberCounts.size,
    connectionsByUser,
  };
}
