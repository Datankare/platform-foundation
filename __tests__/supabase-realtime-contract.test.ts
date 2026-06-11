/**
 * RealtimeProvider contract — Supabase reference arm (ADR-027).
 *
 * Runs the synced RealtimeProvider conformance kit against the real
 * SupabaseRealtimeProvider. The provider takes an injected SupabaseClient, so a
 * fake client (channels that no-op on/subscribe/send/track, removeChannel -> ok)
 * is supplied — no HTTP needed. Single synced arm.
 */

jest.mock("@/lib/logger", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { runRealtimeProviderContract } from "./contract/realtime-provider-contract";
import {
  createSupabaseRealtimeProvider,
  type SupabaseChannel,
  type SupabaseClient,
} from "@/platform/realtime/supabase-realtime";

function makeFakeChannel(): SupabaseChannel {
  const ch: SupabaseChannel = {
    on: () => ch,
    subscribe: () => ch,
    send: async () => "ok",
    track: async () => "ok",
    untrack: async () => "ok",
    unsubscribe: async () => "ok",
    presenceState: () => ({}),
  };
  return ch;
}

const fakeClient: SupabaseClient = {
  channel: () => makeFakeChannel(),
  removeChannel: async () => "ok",
};

describe("RealtimeProvider contract — Supabase (PF reference impl)", () => {
  runRealtimeProviderContract({
    makeProvider: () => createSupabaseRealtimeProvider({ client: fakeClient }),
  });
});
