/**
 * Sprint 5 — Realtime + AI Streaming tests
 *
 * Covers: types, mock provider, middleware, health probe,
 * orchestrator streaming, provider registry extension.
 */

// ── Types ──

import {
  generateMessageId,
  createMessage,
  isStreamMessage,
  isTrajectoryMessage,
  isApprovalMessage,
} from "@/platform/realtime/types";
import type { RealtimeMessage } from "@/platform/realtime/types";

describe("Realtime types", () => {
  test("generateMessageId returns unique IDs", () => {
    const a = generateMessageId();
    const b = generateMessageId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^msg_/);
  });

  test("createMessage fills id and timestamp", () => {
    const msg = createMessage({
      type: "notification",
      channel: "test",
      actorType: "user",
      actorId: "u1",
      intent: "inform",
      payload: { text: "hello" },
    });
    expect(msg.id).toMatch(/^msg_/);
    expect(msg.timestamp).toBeGreaterThan(0);
    expect(msg.actorType).toBe("user");
  });

  test("isStreamMessage identifies stream types", () => {
    const chunk = createMessage({
      type: "stream-chunk",
      channel: "s",
      actorType: "system",
      actorId: "ai",
      intent: "inform",
      payload: {},
    });
    expect(isStreamMessage(chunk)).toBe(true);

    const notif = createMessage({
      type: "notification",
      channel: "s",
      actorType: "system",
      actorId: "ai",
      intent: "inform",
      payload: {},
    });
    expect(isStreamMessage(notif)).toBe(false);
  });

  test("isTrajectoryMessage checks type and trajectoryId", () => {
    const step = createMessage({
      type: "trajectory-step",
      channel: "t",
      actorType: "agent",
      actorId: "a1",
      intent: "checkpoint",
      trajectoryId: "traj-1",
      stepIndex: 0,
      payload: {},
    });
    expect(isTrajectoryMessage(step)).toBe(true);

    const noId = createMessage({
      type: "trajectory-step",
      channel: "t",
      actorType: "agent",
      actorId: "a1",
      intent: "checkpoint",
      payload: {},
    });
    expect(isTrajectoryMessage(noId)).toBe(false);
  });

  test("isApprovalMessage identifies approval types", () => {
    const req = createMessage({
      type: "approval-request",
      channel: "a",
      actorType: "agent",
      actorId: "a1",
      intent: "propose",
      payload: {},
    });
    expect(isApprovalMessage(req)).toBe(true);
  });
});

// ── Mock Provider ──

import { MockRealtimeProvider } from "@/platform/realtime/mock-realtime";
import type { StreamChunk } from "@/platform/realtime/types";

describe("MockRealtimeProvider", () => {
  let provider: MockRealtimeProvider;

  beforeEach(() => {
    provider = new MockRealtimeProvider();
  });

  test("starts disconnected", () => {
    expect(provider.getConnectionState()).toBe("disconnected");
  });

  test("connect transitions to connected", async () => {
    await provider.connect();
    expect(provider.getConnectionState()).toBe("connected");
  });

  test("disconnect transitions to disconnected", async () => {
    await provider.connect();
    await provider.disconnect();
    expect(provider.getConnectionState()).toBe("disconnected");
  });

  test("onConnectionStateChange fires on transitions", async () => {
    const states: string[] = [];
    provider.onConnectionStateChange((s) => states.push(s));
    await provider.connect();
    expect(states).toContain("connected");
  });

  test("onConnectionStateChange returns unsubscribe", async () => {
    const states: string[] = [];
    const unsub = provider.onConnectionStateChange((s) => states.push(s));
    unsub();
    await provider.connect();
    expect(states).toHaveLength(0);
  });

  test("channel creates and returns same channel by name", () => {
    const ch1 = provider.channel("test");
    const ch2 = provider.channel("test");
    expect(ch1).toBe(ch2);
  });

  test("channel subscribe and broadcast", async () => {
    const ch = provider.channel("test");
    const received: RealtimeMessage[] = [];
    ch.subscribe((msg) => received.push(msg));

    await ch.broadcast({
      type: "notification",
      channel: "test",
      actorType: "user",
      actorId: "u1",
      intent: "inform",
      payload: { text: "hi" },
    });

    expect(received).toHaveLength(1);
    expect(received[0].actorId).toBe("u1");
  });

  test("channel unsubscribe stops messages", async () => {
    const ch = provider.channel("test");
    const received: RealtimeMessage[] = [];
    const sub = ch.subscribe((msg) => received.push(msg));
    sub.unsubscribe();

    await ch.broadcast({
      type: "notification",
      channel: "test",
      actorType: "user",
      actorId: "u1",
      intent: "inform",
      payload: {},
    });

    expect(received).toHaveLength(0);
  });

  test("removeChannel cleans up", async () => {
    provider.channel("test");
    expect(provider.getChannelCount()).toBe(1);
    await provider.removeChannel("test");
    expect(provider.getChannelCount()).toBe(0);
  });

  test("presence tracking", async () => {
    const ch = provider.channel("room");
    await ch.trackPresence({ name: "Alice" });
    const presence = await ch.getPresence();
    expect(presence).toHaveLength(1);
    expect(presence[0].state).toEqual({ name: "Alice" });
  });

  test("untrackPresence clears presence", async () => {
    const ch = provider.channel("room");
    await ch.trackPresence({ name: "Alice" });
    await ch.untrackPresence();
    const presence = await ch.getPresence();
    expect(presence).toHaveLength(0);
  });

  test("createStream and subscribeStream", async () => {
    const chunks: StreamChunk[] = [];
    provider.subscribeStream("s1", (chunk) => chunks.push(chunk));

    const writer = provider.createStream("s1");
    await writer.write({ text: "hello ", done: false });
    await writer.write({
      text: "world",
      done: true,
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toBe("hello ");
    expect(chunks[1].done).toBe(true);
  });

  test("stream writer abort sends error", async () => {
    const chunks: StreamChunk[] = [];
    provider.subscribeStream("s1", (chunk) => chunks.push(chunk));

    const writer = provider.createStream("s1");
    await writer.abort("test error");

    expect(chunks).toHaveLength(1);
  });

  test("stream writer throws after close", async () => {
    const writer = provider.createStream("s1");
    await writer.close();
    await expect(writer.write({ text: "x", done: false })).rejects.toThrow(
      "Stream is closed"
    );
  });

  test("getLatency returns 1ms for mock", async () => {
    expect(await provider.getLatency()).toBe(1);
  });

  test("disconnect clears all channels", async () => {
    await provider.connect();
    provider.channel("a");
    provider.channel("b");
    expect(provider.getChannelCount()).toBe(2);
    await provider.disconnect();
    expect(provider.getChannelCount()).toBe(0);
  });
});

// ── Middleware ──

import {
  validateConnection,
  validateMessageIntent,
  trackConnection,
  releaseConnection,
  resetConnectionTracking,
  getConnectionStats,
} from "@/platform/realtime/connection-guard";

describe("Realtime middleware", () => {
  beforeEach(() => {
    resetConnectionTracking();
  });

  test("validateConnection allows valid request", () => {
    const result = validateConnection({
      actorType: "user",
      actorId: "u1",
      channel: "test",
    });
    expect(result.allowed).toBe(true);
  });

  test("validateConnection rejects empty actorId", () => {
    const result = validateConnection({
      actorType: "user",
      actorId: "",
      channel: "test",
    });
    expect(result.allowed).toBe(false);
  });

  test("validateConnection rejects when connection limit exceeded", () => {
    for (let i = 0; i < 5; i++) {
      trackConnection("u1", `ch${i}`);
    }
    const result = validateConnection({
      actorType: "user",
      actorId: "u1",
      channel: "ch5",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Connection limit");
  });

  test("validateConnection rejects when channel limit exceeded", () => {
    for (let i = 0; i < 100; i++) {
      trackConnection(`u${i}`, "busy-channel");
    }
    const result = validateConnection({
      actorType: "user",
      actorId: "u999",
      channel: "busy-channel",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Channel subscriber limit");
  });

  test("validateMessageIntent allows user any intent", () => {
    const result = validateMessageIntent({
      actorType: "user",
      intent: "commit",
    });
    expect(result.allowed).toBe(true);
  });

  test("validateMessageIntent allows agent inform", () => {
    const result = validateMessageIntent({
      actorType: "agent",
      intent: "inform",
    });
    expect(result.allowed).toBe(true);
  });

  test("validateMessageIntent allows agent checkpoint", () => {
    const result = validateMessageIntent({
      actorType: "agent",
      intent: "checkpoint",
    });
    expect(result.allowed).toBe(true);
  });

  test("validateMessageIntent blocks agent commit without approval", () => {
    const result = validateMessageIntent({
      actorType: "agent",
      intent: "commit",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("requires approval");
  });

  test("validateMessageIntent blocks agent propose without approval", () => {
    const result = validateMessageIntent({
      actorType: "agent",
      intent: "propose",
    });
    expect(result.allowed).toBe(false);
  });

  test("trackConnection and releaseConnection", () => {
    trackConnection("u1", "ch1");
    let stats = getConnectionStats();
    expect(stats.totalConnections).toBe(1);
    expect(stats.connectionsByUser["u1"]).toBe(1);

    releaseConnection("u1", "ch1");
    stats = getConnectionStats();
    expect(stats.totalConnections).toBe(0);
  });

  test("getConnectionStats returns channel count", () => {
    trackConnection("u1", "ch1");
    trackConnection("u2", "ch2");
    const stats = getConnectionStats();
    expect(stats.totalChannels).toBe(2);
  });
});

// ── Health Probe ──

import {
  checkRealtimeHealth,
  createRealtimeHealthProbe,
} from "@/platform/realtime/health-probe";
import { createMockRealtimeProvider } from "@/platform/realtime/mock-realtime";

describe("Realtime health probe", () => {
  test("reports disconnected when not connected", async () => {
    const provider = createMockRealtimeProvider();
    const health = await checkRealtimeHealth(provider);
    expect(health.connected).toBe(false);
    expect(health.connectionState).toBe("disconnected");
    expect(health.latencyMs).toBe(-1);
  });

  test("reports connected with latency when connected", async () => {
    const provider = createMockRealtimeProvider();
    await provider.connect();
    const health = await checkRealtimeHealth(provider);
    expect(health.connected).toBe(true);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.latencyWithinSla).toBe(true);
    expect(health.provider).toBe("mock");
  });

  test("createRealtimeHealthProbe returns probe function", async () => {
    const provider = createMockRealtimeProvider();
    await provider.connect();
    const probe = createRealtimeHealthProbe(provider);
    const result = await probe();
    expect(result.healthy).toBe(true);
    expect(result.details.provider).toBe("mock");
  });
});

// ── AI Streaming (Orchestrator) ──

import { createOrchestrator } from "@/platform/ai/orchestrator";
import { AIProviderError } from "@/platform/ai/provider";
import type { AIProvider, AIRequest, AIStreamChunk } from "@/platform/ai/types";

jest.mock("@/platform/ai/instrumentation", () => ({
  estimateCost: jest.fn().mockReturnValue(0.001),
  recordMetrics: jest.fn(),
}));

describe("Orchestrator streaming", () => {
  const mockRequest: AIRequest = {
    tier: "fast",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 100,
  };

  const mockOpts = { useCase: "test", requestId: "r1" };

  test("stream falls back to complete when provider has no stream()", async () => {
    const provider: AIProvider = {
      name: "no-stream",
      complete: jest.fn().mockResolvedValue({
        content: [{ type: "text", text: "hello world" }],
        model: "test",
        usage: { inputTokens: 5, outputTokens: 10 },
        stopReason: "end_turn",
      }),
    };

    const orch = createOrchestrator({ provider });
    const chunks: AIStreamChunk[] = [];
    for await (const chunk of orch.stream(mockRequest, mockOpts)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("hello world");
    expect(chunks[0].done).toBe(true);
    expect(chunks[0].usage).toBeDefined();
  });

  test("stream yields chunks from provider.stream()", async () => {
    async function* mockStream(): AsyncIterable<AIStreamChunk> {
      yield { text: "hello ", done: false };
      yield { text: "world", done: false };
      yield {
        text: "",
        done: true,
        usage: { inputTokens: 5, outputTokens: 10, cost: 0.001 },
      };
    }

    const provider: AIProvider = {
      name: "streaming",
      complete: jest.fn(),
      stream: jest.fn().mockReturnValue(mockStream()),
    };

    const orch = createOrchestrator({ provider });
    const chunks: AIStreamChunk[] = [];
    for await (const chunk of orch.stream(mockRequest, mockOpts)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0].text).toBe("hello ");
    expect(chunks[2].done).toBe(true);
  });

  test("stream throws when circuit breaker is open", async () => {
    const provider: AIProvider = {
      name: "test",
      complete: jest.fn().mockRejectedValue(new AIProviderError("fail", "transient")),
    };

    const orch = createOrchestrator({
      provider,
      circuitBreakerConfig: {
        failureThreshold: 1,
        recoveryTimeMs: 60000,
        halfOpenSuccessThreshold: 1,
      },
    });

    // Trip the circuit breaker
    try {
      await orch.complete(mockRequest, mockOpts);
    } catch {
      // expected
    }

    // Now stream should throw
    const chunks: AIStreamChunk[] = [];
    await expect(async () => {
      for await (const chunk of orch.stream(mockRequest, mockOpts)) {
        chunks.push(chunk);
      }
    }).rejects.toThrow("Circuit breaker");
  });
});

// ── Provider Registry ──

describe("Provider registry — realtime slot", () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.REALTIME_PROVIDER;
  });

  test("defaults to mock realtime", async () => {
    const { getActiveProviders, resetProviders } =
      await import("@/platform/providers/registry");
    resetProviders();
    const selections = getActiveProviders();
    expect(selections.realtime).toBe("mock");
  });

  test("reads REALTIME_PROVIDER from env", async () => {
    process.env.REALTIME_PROVIDER = "supabase";
    const { getActiveProviders, resetProviders } =
      await import("@/platform/providers/registry");
    resetProviders();
    const selections = getActiveProviders();
    expect(selections.realtime).toBe("supabase");
    delete process.env.REALTIME_PROVIDER;
  });
});
