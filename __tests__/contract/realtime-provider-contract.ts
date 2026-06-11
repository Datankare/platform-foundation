/**
 * __tests__/contract/realtime-provider-contract.ts
 * RealtimeProvider conformance kit (TCK) — ADR-027. Not a *.test.ts.
 */

import type { RealtimeProvider } from "@/platform/realtime/types";

export interface RealtimeContractFixtures {
  makeProvider: () => RealtimeProvider | Promise<RealtimeProvider>;
}

export function runRealtimeProviderContract(fx: RealtimeContractFixtures): void {
  let provider: RealtimeProvider;

  beforeEach(async () => {
    provider = await fx.makeProvider();
  });

  afterEach(async () => {
    try {
      await provider.disconnect();
    } catch {
      /* noop */
    }
  });

  describe("name", () => {
    it("exposes a non-empty provider name", () => {
      expect(typeof provider.name).toBe("string");
      expect(provider.name.length).toBeGreaterThan(0);
    });
  });

  describe("connection lifecycle", () => {
    it("connects and reports a connected state", async () => {
      await provider.connect();
      expect(provider.getConnectionState()).toBe("connected");
    });

    it("disconnects and reports a disconnected state", async () => {
      await provider.connect();
      await provider.disconnect();
      expect(provider.getConnectionState()).toBe("disconnected");
    });

    it("notifies state handlers and supports unsubscribe", async () => {
      const seen: string[] = [];
      const unsub = provider.onConnectionStateChange((s) => {
        seen.push(s);
      });
      await provider.connect();
      expect(seen.length).toBeGreaterThan(0);
      const countAfterConnect = seen.length;
      unsub();
      await provider.disconnect();
      expect(seen.length).toBe(countAfterConnect);
    });
  });

  describe("channels", () => {
    it("creates and removes a channel", async () => {
      await provider.connect();
      const ch = provider.channel("contract-channel");
      expect(ch).toBeTruthy();
      await expect(provider.removeChannel("contract-channel")).resolves.toBeUndefined();
    });
  });

  describe("streaming", () => {
    it("provides a stream writer and a subscription", async () => {
      await provider.connect();
      const writer = provider.createStream("contract-session");
      expect(writer).toBeTruthy();
      const sub = provider.subscribeStream("contract-session", () => {});
      expect(sub).toBeTruthy();
    });
  });

  describe("health", () => {
    it("measures latency as a non-negative number", async () => {
      await provider.connect();
      const latency = await provider.getLatency();
      expect(typeof latency).toBe("number");
      expect(latency).toBeGreaterThanOrEqual(0);
    });
  });
}
