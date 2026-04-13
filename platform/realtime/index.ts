/**
 * platform/realtime/index.ts — Public API
 *
 * @module platform/realtime
 */

// Types
export type {
  RealtimeProvider,
  RealtimeChannel,
  RealtimeMessage,
  StreamChunk,
  StreamOptions,
  StreamWriter,
  ConnectionState,
  ConnectionStateHandler,
  MessageHandler,
  Subscription,
  PresenceEntry,
  ChannelOptions,
  MessageType,
  ActorType,
  MessageIntent,
  MemoryHint,
} from "./types";

// Helpers
export {
  generateMessageId,
  createMessage,
  isStreamMessage,
  isTrajectoryMessage,
  isApprovalMessage,
} from "./types";

// Providers
export { createMockRealtimeProvider, MockRealtimeProvider } from "./mock-realtime";
export {
  createSupabaseRealtimeProvider,
  SupabaseRealtimeProvider,
} from "./supabase-realtime";

// Middleware
export {
  validateConnection,
  validateMessageIntent,
  trackConnection,
  releaseConnection,
  resetConnectionTracking,
  getConnectionStats,
} from "./connection-guard";
export type { ConnectionRequest, RealtimeMiddlewareConfig } from "./connection-guard";

// Health
export { checkRealtimeHealth, createRealtimeHealthProbe } from "./health-probe";
export type { RealtimeHealthStatus } from "./health-probe";
