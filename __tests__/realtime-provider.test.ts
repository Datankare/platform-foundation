/**
 * RealtimeProvider interface contract — mock arm (ADR-027).
 */
import { runRealtimeProviderContract } from "./contract/realtime-provider-contract";
import { createMockRealtimeProvider } from "@/platform/realtime/mock-realtime";

describe("RealtimeProvider contract — mock provider", () => {
  runRealtimeProviderContract({
    makeProvider: () => createMockRealtimeProvider(),
  });
});
