/**
 * TASK-204 (N-4): the Supabase realtime provider, now inside coverage — what it does with a
 * channel's events beyond the conformance kit's no-op client: a message delivered to every
 * handler (and a payload without one to none), a failed send or presence write logged and not
 * thrown, presence read with its defaults, a stream's chunks, end and abort, and its channels
 * removed from Supabase when it disconnects.
 */
const warn = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: (...a: unknown[]) => warn(...a),
    error: jest.fn(),
  },
}));

import { runWithTenant } from "@/platform/tenancy/context";
import {
  createSupabaseRealtimeProvider,
  type SupabaseChannel,
  type SupabaseClient,
} from "@/platform/realtime/supabase-realtime";
import type { RealtimeMessage, StreamChunk } from "@/platform/realtime/types";

const T = "11111111-1111-4111-8111-111111111111";
const inT = <R>(fn: () => R): R => runWithTenant({ tenantId: T, mode: "shared" }, fn);

/** A channel that records what it was sent and lets the test raise its events. */
function recordingChannel(answers: { send?: string; track?: string } = {}) {
  const sent: Record<string, unknown>[] = [];
  let onMessage: ((p: Record<string, unknown>) => void) | null = null;
  let onStatus: ((s: string) => void) | undefined;
  const calls: string[] = [];
  let presence: Record<string, Record<string, unknown>[]> = {};
  const ch: SupabaseChannel = {
    on: (_e, _f, cb) => {
      onMessage = cb;
      return ch;
    },
    subscribe: (cb) => {
      onStatus = cb;
      calls.push("subscribe");
      return ch;
    },
    send: async (m) => {
      sent.push(m);
      return (answers.send ?? "ok") as "ok";
    },
    track: async () => (answers.track ?? "ok") as "ok",
    untrack: async () => {
      calls.push("untrack");
      return "ok";
    },
    unsubscribe: async () => {
      calls.push("unsubscribe");
      return "ok";
    },
    presenceState: <P extends Record<string, unknown>>() =>
      presence as unknown as Record<string, P[]>,
  };
  return {
    ch,
    sent,
    calls,
    raise: (p: Record<string, unknown>) => onMessage?.(p),
    status: (s: string) => onStatus?.(s),
    setPresence: (p: Record<string, Record<string, unknown>[]>) => {
      presence = p;
    },
  };
}

function clientWith(...channels: ReturnType<typeof recordingChannel>[]) {
  const removed: SupabaseChannel[] = [];
  let i = 0;
  const client: SupabaseClient = {
    channel: () => channels[i++]?.ch ?? recordingChannel().ch,
    removeChannel: async (c) => {
      removed.push(c);
      return "ok";
    },
  };
  return { client, removed };
}

const message = (over: Partial<RealtimeMessage> = {}) =>
  ({
    id: "m1",
    timestamp: 1,
    type: "notification",
    channel: "room",
    actorType: "user",
    actorId: "u1",
    intent: "inform",
    payload: { text: "hi" },
    ...over,
  }) as RealtimeMessage;

beforeEach(() => warn.mockClear());

describe("a channel's messages and writes", () => {
  it("delivers a message to every handler until each unsubscribes; one without a payload to none", () => {
    const rc = recordingChannel();
    const provider = createSupabaseRealtimeProvider({ client: clientWith(rc).client });
    const room = inT(() => provider.channel("room"));
    const a = jest.fn();
    const b = jest.fn();
    const subA = room.subscribe(a);
    room.subscribe(b);
    // One Supabase subscription, however many handlers.
    expect(rc.calls.filter((c) => c === "subscribe")).toHaveLength(1);
    rc.status("SUBSCRIBED");
    rc.status("CHANNEL_ERROR");
    rc.raise({ payload: message() });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    rc.raise({});
    expect(a).toHaveBeenCalledTimes(1);
    subA.unsubscribe();
    rc.raise({ payload: message({ id: "m2" }) });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    // Unsubscribed whole: Supabase is told, and a new handler subscribes again.
    room.unsubscribe();
    expect(rc.calls).toContain("unsubscribe");
    room.subscribe(jest.fn());
    expect(rc.calls.filter((c) => c === "subscribe")).toHaveLength(2);
  });

  it("[hostile:store-down] a send or a presence write Supabase refuses is logged, never thrown", async () => {
    const rc = recordingChannel({ send: "timed out", track: "error" });
    const provider = createSupabaseRealtimeProvider({ client: clientWith(rc).client });
    const room = inT(() => provider.channel("room"));
    await inT(() =>
      room.broadcast({
        type: "notification",
        channel: "room",
        actorType: "user",
        actorId: "u1",
        intent: "inform",
        payload: {},
      })
    );
    await room.trackPresence({ actorId: "u1" });
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      "Supabase broadcast failed",
      "Supabase presence track failed",
    ]);
    // Each send carries a fresh id and a time.
    expect(rc.sent[0]).toMatchObject({
      type: "broadcast",
      event: "message",
      payload: { id: expect.any(String), timestamp: expect.any(Number) },
    });
    await room.untrackPresence();
    expect(rc.calls).toContain("untrack");
  });

  it("reads presence with its defaults: a user, the key as its id, now as its time", async () => {
    const rc = recordingChannel();
    rc.setPresence({
      k1: [{ actorType: "agent", actorId: "a1", joinedAt: 5 }, {}],
    });
    const provider = createSupabaseRealtimeProvider({ client: clientWith(rc).client });
    const room = inT(() => provider.channel("room"));
    const entries = await room.getPresence();
    expect(entries[0]).toMatchObject({ actorType: "agent", actorId: "a1", joinedAt: 5 });
    expect(entries[1]).toMatchObject({ actorType: "user", actorId: "k1" });
    expect(typeof entries[1].joinedAt).toBe("number");
  });
});

describe("streams", () => {
  it("writes chunks and an end; a write after close throws; an abort says why", async () => {
    const rc = recordingChannel();
    const rc2 = recordingChannel();
    const provider = createSupabaseRealtimeProvider({
      client: clientWith(rc, rc2).client,
    });
    const writer = inT(() => provider.createStream("s1"));
    await inT(() => writer.write({ text: "a", done: false } as StreamChunk));
    await inT(() => writer.write({ text: "", done: true } as StreamChunk));
    expect(rc.sent.map((m) => (m.payload as RealtimeMessage).type)).toEqual([
      "stream-chunk",
      "stream-end",
    ]);
    await writer.close();
    await expect(
      writer.write({ text: "late", done: false } as StreamChunk)
    ).rejects.toThrow("Stream is closed");
    const second = inT(() => provider.createStream("s2"));
    await inT(() => second.abort());
    await inT(() => second.abort("model down"));
    const errors = rc2.sent
      .map((m) => m.payload as RealtimeMessage)
      .filter((m) => m.type === "stream-error")
      .map((m) => (m.payload as { error: string }).error);
    expect(errors).toEqual(["Stream aborted", "model down"]);
  });

  it("a stream's subscriber hears its chunks, end and error — nothing else", () => {
    const rc = recordingChannel();
    const provider = createSupabaseRealtimeProvider({ client: clientWith(rc).client });
    const heard = jest.fn();
    inT(() => provider.subscribeStream("s1", heard));
    for (const type of ["stream-chunk", "stream-end", "stream-error", "notification"])
      rc.raise({
        payload: message({ type: type as RealtimeMessage["type"], payload: { type } }),
      });
    expect(heard.mock.calls.map((c) => (c[0] as { type: string }).type)).toEqual([
      "stream-chunk",
      "stream-end",
      "stream-error",
    ]);
  });
});

describe("the provider's lifetime", () => {
  it("connects and disconnects, telling each state listener until it stops listening", async () => {
    const one = recordingChannel();
    const two = recordingChannel();
    const { client, removed } = clientWith(one, two);
    const provider = createSupabaseRealtimeProvider({ client });
    const states: string[] = [];
    const stop = provider.onConnectionStateChange((s) => states.push(s));
    await provider.connect();
    expect(provider.getConnectionState()).toBe("connected");
    // One Supabase channel per topic, however often it is asked for.
    const room = inT(() => provider.channel("room"));
    expect(inT(() => provider.channel("room"))).toBe(room);
    inT(() => provider.channel("other"));
    await provider.disconnect();
    expect(removed).toEqual([one.ch, two.ch]);
    expect(states).toEqual(["connecting", "connected", "disconnected"]);
    stop();
    await provider.connect();
    expect(states).toHaveLength(3);
  });

  it("removes a channel it has, and passes over one it has not", async () => {
    const rc = recordingChannel();
    const { client, removed } = clientWith(rc);
    const provider = createSupabaseRealtimeProvider({ client });
    inT(() => provider.channel("room"));
    await inT(() => provider.removeChannel("room"));
    await inT(() => provider.removeChannel("never-opened"));
    expect(removed).toEqual([rc.ch]);
    expect(rc.calls).toContain("unsubscribe");
  });

  it("measures latency with a channel of its own, removed after", async () => {
    const rc = recordingChannel();
    const { client, removed } = clientWith(rc);
    const provider = createSupabaseRealtimeProvider({ client });
    expect(await provider.getLatency()).toBeGreaterThanOrEqual(0);
    expect(removed).toEqual([rc.ch]);
  });
});
