/**
 * __tests__/valkey-connector.test.ts — every error on the Valkey provider's socket is handled
 * (platform/cache/valkey-connector.ts).
 *
 * ioredis listens for a socket's "error" with once(); a TLS alert arriving after the first
 * error was thrown as an uncaught exception and stopped the process (the flaky "unknown CA"
 * case of the Valkey suite, reproduced under CPU load). Proved two ways: the connector's socket
 * survives repeated errors, and real clients that cannot verify the server, reconnecting and
 * then closed, leave nothing uncaught.
 */

import { createServer, type Server } from "node:net";
import {
  GuardedValkeyConnector,
  valkeyLateSocketErrors,
} from "@/platform/cache/valkey-connector";
import {
  ValkeyCacheProvider,
  valkeyConnectionOptions,
} from "@/platform/cache/valkey-cache";
import { startValkey, valkeyDescribe, type RunningValkey } from "./helpers/valkey-server";

describe("GuardedValkeyConnector", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("keeps a listener for the socket's whole life: a second error is absorbed, not thrown", async () => {
    const connector = new GuardedValkeyConnector({ host: "127.0.0.1", port });
    const stream = await connector.connect();
    const before = valkeyLateSocketErrors();
    expect(() => {
      stream.emit("error", new Error("first"));
      stream.emit("error", new Error("an alert after the first"));
      stream.emit("error", new Error("and another"));
    }).not.toThrow();
    expect(connector.firstError?.message).toBe("first");
    expect(valkeyLateSocketErrors()).toBe(before + 2);
    connector.disconnect();
  });

  it("opens nothing once disconnected before the next tick (as ioredis's own connector)", async () => {
    const connector = new GuardedValkeyConnector({ host: "127.0.0.1", port });
    const pending = connector.connect();
    connector.disconnect();
    await expect(pending).rejects.toThrow("Connection is closed.");
  });

  it("is the connector the provider gives ioredis", () => {
    const { options } = valkeyConnectionOptions({ url: "rediss://cache.internal:6380" });
    expect(options.Connector).toBe(GuardedValkeyConnector);
  });
});

valkeyDescribe("clients that cannot verify the server, reconnecting, then closed", () => {
  let server: RunningValkey;
  beforeAll(async () => {
    server = await startValkey();
  }, 30_000);
  afterAll(async () => {
    await server?.stop();
  });

  it("leave no uncaught exception (an unknown CA, a wrong name)", async () => {
    const providers: ValkeyCacheProvider[] = [];
    for (let i = 0; i < 20; i++) {
      providers.push(
        new ValkeyCacheProvider({
          url:
            i % 2 === 0
              ? server.url
              : `rediss://:${server.password}@127.0.0.1:${server.port}`,
          // Even ones trust no CA; odd ones trust it but connect by a name it does not carry.
          caCert: i % 2 === 0 ? undefined : server.caPem,
          timeoutMs: 500,
        })
      );
    }
    const health = await Promise.all(providers.map((p) => p.health()));
    expect(health.every((h) => !h.connected)).toBe(true);
    // Let them reconnect a few times, then close them mid-handshake.
    await new Promise((r) => setTimeout(r, 1_500));
    await Promise.all(providers.map((p) => p.close()));
    // Late alerts arrive after close; an unhandled one would fail this test as uncaught.
    await new Promise((r) => setTimeout(r, 1_500));
  }, 30_000);
});
