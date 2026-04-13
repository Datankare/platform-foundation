/**
 * platform/realtime/health-probe.ts — Realtime health monitoring
 *
 * Registers a health probe with the HealthRegistry (Sprint 3).
 * Monitors connection state and latency SLA compliance.
 *
 * Latency SLAs:
 *   - Broadcast: <200ms local, <500ms global
 *   - Connection: <3 seconds
 *
 * @module platform/realtime
 */

import type { RealtimeProvider, ConnectionState } from "./types";
import { getConnectionStats } from "./middleware";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export interface RealtimeHealthStatus {
  /** Whether the realtime provider is connected */
  connected: boolean;
  /** Current connection state */
  connectionState: ConnectionState;
  /** Measured latency in ms (-1 if unavailable) */
  latencyMs: number;
  /** Whether latency is within SLA (<200ms) */
  latencyWithinSla: boolean;
  /** Provider name */
  provider: string;
  /** Active connections */
  totalConnections: number;
  /** Active channels */
  totalChannels: number;
}

/** Latency SLA threshold in ms */
const LATENCY_SLA_MS = 200;

/**
 * Check realtime provider health.
 */
export async function checkRealtimeHealth(
  provider: RealtimeProvider
): Promise<RealtimeHealthStatus> {
  const connectionState = provider.getConnectionState();
  const connected = connectionState === "connected";

  let latencyMs = -1;
  let latencyWithinSla = false;

  if (connected) {
    try {
      latencyMs = await provider.getLatency();
      latencyWithinSla = latencyMs < LATENCY_SLA_MS;

      if (!latencyWithinSla) {
        logger.warn("Realtime latency exceeds SLA", {
          latencyMs,
          slaMs: LATENCY_SLA_MS,
          provider: provider.name,
        });
      }
    } catch (err) {
      logger.error("Realtime latency check failed", {
        error: err instanceof Error ? err.message : "Unknown error",
        provider: provider.name,
      });
    }
  }

  const stats = getConnectionStats();

  return {
    connected,
    connectionState,
    latencyMs,
    latencyWithinSla,
    provider: provider.name,
    totalConnections: stats.totalConnections,
    totalChannels: stats.totalChannels,
  };
}

/**
 * Create a health probe function compatible with HealthRegistry.
 * Returns { healthy: boolean, details: RealtimeHealthStatus }.
 */
export function createRealtimeHealthProbe(
  provider: RealtimeProvider
): () => Promise<{ healthy: boolean; details: RealtimeHealthStatus }> {
  return async () => {
    const status = await checkRealtimeHealth(provider);
    return {
      healthy: status.connected,
      details: status,
    };
  };
}
