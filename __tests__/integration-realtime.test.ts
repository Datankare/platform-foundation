/**
 * Sprint 6 — Integration: Realtime Pipeline
 *
 * Tests the full realtime pipeline end-to-end:
 * provider → channels → messaging → streaming → presence → health → connection guard.
 * Verifies Sprint 5 components work together as a cohesive module.
 */

import { MockRealtimeProvider } from "@/platform/realtime/mock-realtime";
import {
  validateConnection,
  validateMessageIntent,
  trackConnection,
  releaseConnection,
  resetConnectionTracking,
  getConnectionStats,
} from "@/platform/realtime/connection-guard";
import {
  checkRealtimeHealth,
  createRealtimeHealthProbe,
} from "@/platform/realtime/health-probe";
import {
  createMessage,
  isStreamMessage,
  isTrajectoryMessage,
  isApprovalMessage,
} from "@/platform/realtime/types";
import type { RealtimeMessage, StreamChunk } from "@/platform/realtime/types";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe("Realtime Pipeline Integration", () => {
  let provider: MockRealtimeProvider;

  beforeEach(() => {
    provider = new MockRealtimeProvider();
    resetConnectionTracking();
  });

  afterEach(async () => {
    await provider.disconnect();
  });

  describe("Full lifecycle: connect → channel → message → disconnect", () => {
    it("completes the full channel lifecycle", async () => {
      // Connect
      await provider.connect();
      expect(provider.getConnectionState()).toBe("connected");

      // Create channel
      const ch = provider.channel("room:lobby");
      expect(provider.getChannelCount()).toBe(1);

      // Subscribe and receive messages
      const received: RealtimeMessage[] = [];
      ch.subscribe((msg) => received.push(msg));

      // Broadcast a message with agentic metadata
      await ch.broadcast({
        type: "notification",
        channel: "room:lobby",
        actorType: "user",
        actorId: "user-1",
        intent: "inform",
        payload: { text: "Hello lobby" },
      });

      expect(received).toHaveLength(1);
      expect(received[0].actorType).toBe("user");
      expect(received[0].intent).toBe("inform");
      expect(received[0].id).toMatch(/^msg_/);
      expect(received[0].timestamp).toBeGreaterThan(0);

      // Clean up
      ch.unsubscribe();
      await provider.removeChannel("room:lobby");
      expect(provider.getChannelCount()).toBe(0);

      // Disconnect
      await provider.disconnect();
      expect(provider.getConnectionState()).toBe("disconnected");
    });
  });

  describe("Streaming lifecycle: create → write → subscribe → close", () => {
    it("streams chunks end-to-end", async () => {
      await provider.connect();

      const chunks: StreamChunk[] = [];
      provider.subscribeStream("session-1", (chunk) => chunks.push(chunk));

      const writer = provider.createStream("session-1");
      await writer.write({ text: "Once ", done: false });
      await writer.write({ text: "upon ", done: false });
      await writer.write({ text: "a time", done: false });
      await writer.write({
        text: "",
        done: true,
        usage: { inputTokens: 10, outputTokens: 30, cost: 0.002 },
      });
      await writer.close();

      expect(chunks).toHaveLength(4);
      expect(chunks.map((c) => c.text).join("")).toBe("Once upon a time");
      expect(chunks[3].done).toBe(true);
      expect(chunks[3].usage?.outputTokens).toBe(30);
    });

    it("handles stream abort", async () => {
      await provider.connect();

      const chunks: StreamChunk[] = [];
      provider.subscribeStream("session-2", (chunk) => chunks.push(chunk));

      const writer = provider.createStream("session-2");
      await writer.write({ text: "Start...", done: false });
      await writer.abort("Connection lost");

      expect(chunks).toHaveLength(2);
    });
  });

  describe("Presence tracking", () => {
    it("tracks and retrieves presence", async () => {
      await provider.connect();
      const ch = provider.channel("room:game");

      await ch.trackPresence({ name: "Alice", role: "player" });
      const presence = await ch.getPresence();

      expect(presence).toHaveLength(1);
      expect(presence[0].state).toEqual({ name: "Alice", role: "player" });

      await ch.untrackPresence();
      expect(await ch.getPresence()).toHaveLength(0);
    });
  });

  describe("Connection guard integration", () => {
    it("validates then tracks connections", () => {
      const result = validateConnection({
        actorType: "user",
        actorId: "user-1",
        channel: "room:lobby",
      });
      expect(result.allowed).toBe(true);

      trackConnection("user-1", "room:lobby");
      const stats = getConnectionStats();
      expect(stats.totalConnections).toBe(1);
      expect(stats.totalChannels).toBe(1);
    });

    it("enforces per-user connection limits", () => {
      for (let i = 0; i < 5; i++) {
        trackConnection("user-1", `ch-${i}`);
      }

      const result = validateConnection({
        actorType: "user",
        actorId: "user-1",
        channel: "ch-5",
      });
      expect(result.allowed).toBe(false);

      // Release one
      releaseConnection("user-1", "ch-0");
      const result2 = validateConnection({
        actorType: "user",
        actorId: "user-1",
        channel: "ch-5",
      });
      expect(result2.allowed).toBe(true);
    });

    it("enforces P17 intent boundary for agents", () => {
      // Agent can inform
      expect(
        validateMessageIntent({ actorType: "agent", intent: "inform" }).allowed
      ).toBe(true);

      // Agent can checkpoint
      expect(
        validateMessageIntent({ actorType: "agent", intent: "checkpoint" }).allowed
      ).toBe(true);

      // Agent cannot commit without approval
      expect(
        validateMessageIntent({ actorType: "agent", intent: "commit" }).allowed
      ).toBe(false);

      // Agent cannot propose without approval
      expect(
        validateMessageIntent({ actorType: "agent", intent: "propose" }).allowed
      ).toBe(false);

      // User can do anything
      expect(validateMessageIntent({ actorType: "user", intent: "commit" }).allowed).toBe(
        true
      );

      // System can do anything
      expect(
        validateMessageIntent({ actorType: "system", intent: "rollback" }).allowed
      ).toBe(true);
    });
  });

  describe("Health probe integration", () => {
    it("reports unhealthy when disconnected", async () => {
      const health = await checkRealtimeHealth(provider);
      expect(health.connected).toBe(false);
      expect(health.latencyMs).toBe(-1);
      expect(health.provider).toBe("mock");
    });

    it("reports healthy when connected", async () => {
      await provider.connect();
      const health = await checkRealtimeHealth(provider);
      expect(health.connected).toBe(true);
      expect(health.latencyWithinSla).toBe(true);
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("health probe function works with HealthRegistry pattern", async () => {
      await provider.connect();
      const probe = createRealtimeHealthProbe(provider);
      const result = await probe();
      expect(result.healthy).toBe(true);
      expect(result.details.connectionState).toBe("connected");
    });
  });

  describe("Agentic message schema (P15-P18)", () => {
    it("P15: messages carry agent identity and delegation", async () => {
      await provider.connect();
      const ch = provider.channel("agent:work");
      const received: RealtimeMessage[] = [];
      ch.subscribe((msg) => received.push(msg));

      await ch.broadcast({
        type: "trajectory-step",
        channel: "agent:work",
        actorType: "agent",
        actorId: "planner-v1",
        onBehalfOf: "user-123",
        intent: "inform",
        trajectoryId: "traj-1",
        stepIndex: 0,
        payload: { action: "searching" },
      });

      expect(received[0].actorType).toBe("agent");
      expect(received[0].onBehalfOf).toBe("user-123");
    });

    it("P16: messages carry memory hints", () => {
      const msg = createMessage({
        type: "notification",
        channel: "test",
        actorType: "system",
        actorId: "sys",
        intent: "inform",
        memoryHint: "episodic",
        payload: {},
      });
      expect(msg.memoryHint).toBe("episodic");
    });

    it("P17: message intent types are enforced", () => {
      const inform = createMessage({
        type: "stream-chunk",
        channel: "s",
        actorType: "system",
        actorId: "ai",
        intent: "inform",
        payload: {},
      });
      expect(inform.intent).toBe("inform");

      const propose = createMessage({
        type: "approval-request",
        channel: "a",
        actorType: "agent",
        actorId: "a1",
        intent: "propose",
        payload: { action: "send email" },
      });
      expect(propose.intent).toBe("propose");
    });

    it("P18: trajectory messages carry step tracking", () => {
      const step = createMessage({
        type: "trajectory-step",
        channel: "t",
        actorType: "agent",
        actorId: "researcher",
        intent: "checkpoint",
        trajectoryId: "traj-abc",
        stepIndex: 3,
        parentStepId: "step-2",
        payload: { finding: "relevant document found" },
      });

      expect(isTrajectoryMessage(step)).toBe(true);
      expect(step.trajectoryId).toBe("traj-abc");
      expect(step.stepIndex).toBe(3);
      expect(step.parentStepId).toBe("step-2");
    });

    it("type guards correctly classify messages", () => {
      const stream = createMessage({
        type: "stream-chunk",
        channel: "s",
        actorType: "system",
        actorId: "ai",
        intent: "inform",
        payload: {},
      });
      expect(isStreamMessage(stream)).toBe(true);
      expect(isTrajectoryMessage(stream)).toBe(false);
      expect(isApprovalMessage(stream)).toBe(false);

      const approval = createMessage({
        type: "approval-request",
        channel: "a",
        actorType: "agent",
        actorId: "a1",
        intent: "propose",
        payload: {},
      });
      expect(isApprovalMessage(approval)).toBe(true);
      expect(isStreamMessage(approval)).toBe(false);
    });
  });

  describe("Connection state change notifications", () => {
    it("fires handlers on state transitions", async () => {
      const states: string[] = [];
      provider.onConnectionStateChange((s) => states.push(s));

      await provider.connect();
      await provider.disconnect();

      expect(states).toContain("connecting");
      expect(states).toContain("connected");
      expect(states).toContain("disconnected");
    });
  });
});
