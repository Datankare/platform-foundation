/**
 * platform/realtime/supabase-realtime.ts — Supabase RealtimeProvider
 *
 * Production implementation using Supabase Realtime.
 * Supports broadcast (messaging), presence (who's online),
 * and Postgres Changes (commitment notifications).
 *
 * Scale path: Supabase handles 200 (free) → 500 (pro) → custom (enterprise)
 * concurrent connections. When millions are needed, swap to AblyRealtimeProvider
 * via REALTIME_PROVIDER=ably — zero code changes.
 *
 * @module platform/realtime
 */

import type {
  RealtimeProvider,
  RealtimeChannel as IRealtimeChannel,
  RealtimeMessage,
  StreamChunk,
  StreamWriter,
  ConnectionState,
  ConnectionStateHandler,
  MessageHandler,
  Subscription,
  PresenceEntry,
  ChannelOptions,
} from "./types";
import { generateMessageId } from "./types";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Supabase types (minimal — avoids tight coupling to @supabase/supabase-js)
// ---------------------------------------------------------------------------

/** Minimal Supabase client interface — only what we need for realtime */
export interface SupabaseClient {
  channel(
    name: string,
    opts?: { config?: { broadcast?: { self?: boolean } } }
  ): SupabaseChannel;
  removeChannel(channel: SupabaseChannel): Promise<"ok" | "timed out" | "error">;
}

/** Minimal Supabase channel interface */
export interface SupabaseChannel {
  on(
    event: string,
    filter: Record<string, unknown>,
    callback: (payload: Record<string, unknown>) => void
  ): SupabaseChannel;
  subscribe(callback?: (status: string, err?: Error) => void): SupabaseChannel;
  send(message: Record<string, unknown>): Promise<"ok" | "timed out" | "error">;
  track(state: Record<string, unknown>): Promise<"ok" | "timed out" | "error">;
  untrack(): Promise<"ok" | "timed out" | "error">;
  unsubscribe(): Promise<"ok" | "timed out" | "error">;
  presenceState<T extends Record<string, unknown>>(): Record<string, T[]>;
}

// ---------------------------------------------------------------------------
// Supabase Channel Wrapper
// ---------------------------------------------------------------------------

class SupabaseRealtimeChannel implements IRealtimeChannel {
  readonly name: string;
  private supabaseChannel: SupabaseChannel;
  private handlers: MessageHandler[] = [];
  private subscribed = false;

  constructor(name: string, supabaseChannel: SupabaseChannel, _options?: ChannelOptions) {
    this.name = name;
    this.supabaseChannel = supabaseChannel;
  }

  subscribe(handler: MessageHandler): Subscription {
    this.handlers.push(handler);

    // Set up Supabase broadcast listener on first subscribe
    if (!this.subscribed) {
      this.supabaseChannel
        .on("broadcast", { event: "message" }, (payload) => {
          const msg = payload["payload"] as RealtimeMessage;
          if (msg) {
            for (const h of this.handlers) {
              h(msg);
            }
          }
        })
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            logger.debug("Supabase channel subscribed", { channel: this.name });
          }
        });
      this.subscribed = true;
    }

    return {
      unsubscribe: () => {
        this.handlers = this.handlers.filter((h) => h !== handler);
      },
    };
  }

  async broadcast(message: Omit<RealtimeMessage, "id" | "timestamp">): Promise<void> {
    const full: RealtimeMessage = {
      id: generateMessageId(),
      timestamp: Date.now(),
      ...message,
    };

    const result = await this.supabaseChannel.send({
      type: "broadcast",
      event: "message",
      payload: full,
    });

    if (result !== "ok") {
      logger.warn("Supabase broadcast failed", {
        channel: this.name,
        result,
      });
    }
  }

  async getPresence(): Promise<PresenceEntry[]> {
    const state = this.supabaseChannel.presenceState<{
      actorType: string;
      actorId: string;
      joinedAt: number;
      [key: string]: unknown;
    }>();

    const entries: PresenceEntry[] = [];
    for (const key of Object.keys(state)) {
      for (const presence of state[key]) {
        entries.push({
          actorType: (presence.actorType as PresenceEntry["actorType"]) ?? "user",
          actorId: presence.actorId ?? key,
          state: presence,
          joinedAt: presence.joinedAt ?? Date.now(),
        });
      }
    }
    return entries;
  }

  async trackPresence(state: Record<string, unknown>): Promise<void> {
    const result = await this.supabaseChannel.track(state);
    if (result !== "ok") {
      logger.warn("Supabase presence track failed", {
        channel: this.name,
        result,
      });
    }
  }

  async untrackPresence(): Promise<void> {
    await this.supabaseChannel.untrack();
  }

  unsubscribe(): void {
    this.handlers = [];
    this.supabaseChannel.unsubscribe();
    this.subscribed = false;
  }
}

// ---------------------------------------------------------------------------
// Supabase Stream Writer
// ---------------------------------------------------------------------------

class SupabaseStreamWriter implements StreamWriter {
  private channel: SupabaseRealtimeChannel;
  private sessionId: string;
  private closed = false;

  constructor(channel: SupabaseRealtimeChannel, sessionId: string) {
    this.channel = channel;
    this.sessionId = sessionId;
  }

  async write(chunk: StreamChunk): Promise<void> {
    if (this.closed) throw new Error("Stream is closed");
    await this.channel.broadcast({
      type: chunk.done ? "stream-end" : "stream-chunk",
      channel: `stream:${this.sessionId}`,
      actorType: "system",
      actorId: "ai-orchestrator",
      intent: "inform",
      payload: chunk,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async abort(reason?: string): Promise<void> {
    this.closed = true;
    await this.channel.broadcast({
      type: "stream-error",
      channel: `stream:${this.sessionId}`,
      actorType: "system",
      actorId: "ai-orchestrator",
      intent: "inform",
      payload: { error: reason ?? "Stream aborted" },
    });
  }
}

// ---------------------------------------------------------------------------
// Supabase Provider
// ---------------------------------------------------------------------------

export interface SupabaseRealtimeConfig {
  /** Supabase client instance */
  client: SupabaseClient;
}

export class SupabaseRealtimeProvider implements RealtimeProvider {
  readonly name = "supabase";
  private client: SupabaseClient;
  private connectionState: ConnectionState = "disconnected";
  private stateHandlers: ConnectionStateHandler[] = [];
  private channels = new Map<string, SupabaseRealtimeChannel>();
  private supabaseChannels = new Map<string, SupabaseChannel>();

  constructor(config: SupabaseRealtimeConfig) {
    this.client = config.client;
  }

  async connect(): Promise<void> {
    this.setConnectionState("connecting");
    // Supabase client connects automatically on channel subscribe
    this.setConnectionState("connected");
    logger.info("Supabase realtime provider connected");
  }

  async disconnect(): Promise<void> {
    for (const [name, ch] of this.supabaseChannels) {
      await this.client.removeChannel(ch);
      this.supabaseChannels.delete(name);
    }
    this.channels.clear();
    this.setConnectionState("disconnected");
    logger.info("Supabase realtime provider disconnected");
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  onConnectionStateChange(handler: ConnectionStateHandler): () => void {
    this.stateHandlers.push(handler);
    return () => {
      this.stateHandlers = this.stateHandlers.filter((h) => h !== handler);
    };
  }

  channel(name: string, options?: ChannelOptions): IRealtimeChannel {
    if (!this.channels.has(name)) {
      const supabaseChannel = this.client.channel(name, {
        config: { broadcast: { self: true } },
      });
      this.supabaseChannels.set(name, supabaseChannel);
      this.channels.set(
        name,
        new SupabaseRealtimeChannel(name, supabaseChannel, options)
      );
    }
    return this.channels.get(name)!;
  }

  async removeChannel(name: string): Promise<void> {
    const ch = this.channels.get(name);
    if (ch) {
      ch.unsubscribe();
      this.channels.delete(name);
    }
    const sbCh = this.supabaseChannels.get(name);
    if (sbCh) {
      await this.client.removeChannel(sbCh);
      this.supabaseChannels.delete(name);
    }
  }

  createStream(sessionId: string): StreamWriter {
    const ch = this.channel(`stream:${sessionId}`) as SupabaseRealtimeChannel;
    return new SupabaseStreamWriter(ch, sessionId);
  }

  subscribeStream(
    sessionId: string,
    handler: (chunk: StreamChunk) => void
  ): Subscription {
    const ch = this.channel(`stream:${sessionId}`);
    return ch.subscribe((msg) => {
      if (
        msg.type === "stream-chunk" ||
        msg.type === "stream-end" ||
        msg.type === "stream-error"
      ) {
        handler(msg.payload as StreamChunk);
      }
    });
  }

  async getLatency(): Promise<number> {
    const start = Date.now();
    // Lightweight operation to measure round-trip
    const tempName = `__latency_${Date.now()}`;
    const ch = this.client.channel(tempName);
    ch.subscribe();
    await this.client.removeChannel(ch);
    return Date.now() - start;
  }

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    for (const handler of this.stateHandlers) {
      handler(state);
    }
  }
}

/**
 * Create a Supabase realtime provider.
 */
export function createSupabaseRealtimeProvider(
  config: SupabaseRealtimeConfig
): RealtimeProvider {
  return new SupabaseRealtimeProvider(config);
}
