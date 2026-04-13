/**
 * platform/realtime/mock-realtime.ts — Mock RealtimeProvider
 *
 * In-memory implementation for tests and local development.
 * No external dependencies. Synchronous broadcast within process.
 *
 * @module platform/realtime
 */

import type {
  RealtimeProvider,
  RealtimeChannel,
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

// ---------------------------------------------------------------------------
// Mock Channel
// ---------------------------------------------------------------------------

class MockChannel implements RealtimeChannel {
  readonly name: string;
  private handlers: MessageHandler[] = [];
  private presence: PresenceEntry[] = [];
  private _options: ChannelOptions;

  constructor(name: string, options?: ChannelOptions) {
    this.name = name;
    this._options = options ?? {};
  }

  subscribe(handler: MessageHandler): Subscription {
    this.handlers.push(handler);
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
    // Notify all handlers synchronously (in-process)
    for (const handler of this.handlers) {
      handler(full);
    }
  }

  async getPresence(): Promise<PresenceEntry[]> {
    return [...this.presence];
  }

  async trackPresence(state: Record<string, unknown>): Promise<void> {
    const entry: PresenceEntry = {
      actorType: "user",
      actorId: "mock-user",
      state,
      joinedAt: Date.now(),
    };
    this.presence.push(entry);
  }

  async untrackPresence(): Promise<void> {
    this.presence = [];
  }

  unsubscribe(): void {
    this.handlers = [];
    this.presence = [];
  }

  /** Test helper: get handler count */
  getHandlerCount(): number {
    return this.handlers.length;
  }

  /** Test helper: get channel options */
  getOptions(): ChannelOptions {
    return this._options;
  }
}

// ---------------------------------------------------------------------------
// Mock Stream Writer
// ---------------------------------------------------------------------------

class MockStreamWriter implements StreamWriter {
  private channel: MockChannel;
  private sessionId: string;
  private closed = false;

  constructor(channel: MockChannel, sessionId: string) {
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
// Mock Provider
// ---------------------------------------------------------------------------

export class MockRealtimeProvider implements RealtimeProvider {
  readonly name = "mock";
  private connectionState: ConnectionState = "disconnected";
  private stateHandlers: ConnectionStateHandler[] = [];
  private channels = new Map<string, MockChannel>();

  async connect(): Promise<void> {
    this.setConnectionState("connecting");
    this.setConnectionState("connected");
  }

  async disconnect(): Promise<void> {
    for (const ch of this.channels.values()) {
      ch.unsubscribe();
    }
    this.channels.clear();
    this.setConnectionState("disconnected");
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

  channel(name: string, options?: ChannelOptions): RealtimeChannel {
    if (!this.channels.has(name)) {
      this.channels.set(name, new MockChannel(name, options));
    }
    return this.channels.get(name)!;
  }

  async removeChannel(name: string): Promise<void> {
    const ch = this.channels.get(name);
    if (ch) {
      ch.unsubscribe();
      this.channels.delete(name);
    }
  }

  createStream(sessionId: string): StreamWriter {
    const ch = this.channel(`stream:${sessionId}`) as MockChannel;
    return new MockStreamWriter(ch, sessionId);
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
    return 1; // Mock: 1ms
  }

  /** Test helper: get channel count */
  getChannelCount(): number {
    return this.channels.size;
  }

  /** Test helper: get a specific mock channel */
  getMockChannel(name: string): MockChannel | undefined {
    return this.channels.get(name);
  }

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    for (const handler of this.stateHandlers) {
      handler(state);
    }
  }
}

/**
 * Create a mock realtime provider.
 */
export function createMockRealtimeProvider(): RealtimeProvider {
  return new MockRealtimeProvider();
}
