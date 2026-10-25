/**
 * platform/cache/valkey-connector.ts — the connection ioredis opens for the Valkey provider,
 * with every error on the socket handled.
 *
 * ioredis's own connector (StandaloneConnector) and its client listen for a socket's "error"
 * with once(). A TLS socket can emit a second error after the first — a handshake the server
 * refuses (an unknown CA, a name the certificate does not carry) answers with an alert that
 * arrives after the connection was already failed or closed — and an "error" with no listener
 * is thrown by Node as an uncaught exception: the whole process stops. Reproduced against a
 * TLS server with a client that does not trust its CA, under CPU load, closing the client
 * while it reconnects (CI and a loaded host; the fix of the Valkey provider's flaky test).
 *
 * This connector opens the socket exactly as ioredis's does (TLS options from the provider's
 * verify-full settings, never weakened) and keeps a listener on it for its whole life. The
 * error still reaches the client through its first-error path and the command that was
 * waiting; later ones are counted and dropped. Passed to ioredis through its public
 * `Connector` option.
 */

import { createConnection, type NetConnectOpts, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import { AbstractConnector, type RedisOptions } from "ioredis";

/** Errors a socket emitted after its first: handled here, never thrown (observability). */
let lateSocketErrors = 0;

/** How many socket errors the guard has absorbed in this process. */
export function valkeyLateSocketErrors(): number {
  return lateSocketErrors;
}

type ConnectorOptions = RedisOptions & { disconnectTimeout?: number };

export class GuardedValkeyConnector extends AbstractConnector {
  private readonly options: ConnectorOptions;

  // ioredis hands a connector the client's options untyped (ConnectorConstructor).
  constructor(options: unknown) {
    const typed = options as ConnectorOptions;
    super(typed.disconnectTimeout ?? 2000);
    this.options = typed;
  }

  connect(): Promise<Socket | TLSSocket> {
    const { options } = this;
    this.connecting = true;
    const connection: Record<string, unknown> = {};
    if (options.port != null) connection.port = options.port;
    if (options.host != null) connection.host = options.host;
    if (options.family != null) connection.family = options.family;
    if (options.tls) Object.assign(connection, options.tls);
    // As ioredis's connector: the socket is created on the next tick, and not at all if the
    // client was disconnected meanwhile.
    return new Promise((resolve, reject) => {
      process.nextTick(() => {
        if (!this.connecting) {
          reject(new Error("Connection is closed."));
          return;
        }
        let stream: Socket | TLSSocket;
        try {
          stream = options.tls
            ? tlsConnect(connection as ConnectionOptions)
            : createConnection(connection as unknown as NetConnectOpts);
        } catch (error) {
          reject(error);
          return;
        }
        this.stream = stream;
        let seen = 0;
        stream.on("error", (error: Error) => {
          seen += 1;
          if (seen === 1) this.firstError = error;
          else lateSocketErrors += 1;
        });
        resolve(stream);
      });
    });
  }
}
