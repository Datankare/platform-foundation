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
  TenantContextError,
  runWithTenant,
  runWithoutTenant,
} from "@/platform/tenancy/context";
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

const T = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";

/** The provider with every call made inside tenant `t`, as a request's would be. */
function inTenant<P extends object>(provider: P, t: string): P {
  return new Proxy(provider, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function"
        ? (...a: unknown[]) =>
            runWithTenant({ tenantId: t, mode: "shared" }, () =>
              (v as (...x: unknown[]) => unknown).apply(target, a)
            )
        : v;
    },
  });
}

describe("RealtimeProvider contract — Supabase (PF reference impl)", () => {
  runRealtimeProviderContract({
    makeProvider: () =>
      inTenant(createSupabaseRealtimeProvider({ client: fakeClient }), T),
  });
});

describe("channels belong to one tenant (ADR-053 D6, TASK-114)", () => {
  it("joins a private topic named for the tenant, so two tenants never share one", () => {
    const joined: { name: string; opts: unknown }[] = [];
    const client: SupabaseClient = {
      channel: (name, opts) => {
        joined.push({ name, opts });
        return makeFakeChannel();
      },
      removeChannel: async () => "ok",
    };
    const provider = createSupabaseRealtimeProvider({ client });
    const a = runWithTenant({ tenantId: T, mode: "shared" }, () =>
      provider.channel("room:lobby")
    );
    const b = runWithTenant({ tenantId: U, mode: "shared" }, () =>
      provider.channel("room:lobby")
    );
    expect(a).not.toBe(b);
    expect(a.name).toBe("room:lobby");
    expect(joined).toEqual([
      {
        name: `t:${T}:room:lobby`,
        opts: { config: { broadcast: { self: true }, private: true } },
      },
      {
        name: `t:${U}:room:lobby`,
        opts: { config: { broadcast: { self: true }, private: true } },
      },
    ]);
  });

  it("refuses to join anything outside a tenant, and refuses odd names", () => {
    const provider = createSupabaseRealtimeProvider({ client: fakeClient });
    expect(() => runWithoutTenant(() => provider.channel("room:lobby"))).toThrow(
      TenantContextError
    );
    expect(() =>
      runWithTenant({ tenantId: T, mode: "shared" }, () =>
        provider.channel("t:other/../x y")
      )
    ).toThrow(/Invalid channel name/);
  });
});
