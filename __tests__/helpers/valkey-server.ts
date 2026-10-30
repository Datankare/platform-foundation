/**
 * __tests__/helpers/valkey-server.ts — a throwaway Valkey/Redis server for the Valkey cache tests
 * (review 9 M5)
 *
 * Spawns `valkey-server` (or `redis-server`) on a free port, with TLS — a test CA and a server
 * certificate for "localhost" made with openssl — so the provider is tested over verify-full TLS
 * as a deployment runs it. Absent binaries skip the suites, unless REQUIRE_VALKEY_TESTS=1 (CI),
 * which makes their absence a failure.
 *
 * Ready means THIS server answers (TASK-198, D-17): a free port is found, closed and handed to
 * the child, so another worker's server can take it in between, and a check that only "something
 * listens" then connected the suite to the wrong server (wrong password, wrong CA). Now the child's
 * exit is watched (a port taken from under it: it exits, and the start is retried on another), and
 * the server is ready only when it answers AUTH with its own password and PING over TLS verified
 * against its own CA.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { connect as netConnect, createServer } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";

function which(bin: string): string | undefined {
  try {
    return (
      execFileSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).trim() ||
      undefined
    );
  } catch {
    return undefined;
  }
}

const SERVER = which("valkey-server") ?? which("redis-server");
const OPENSSL = which("openssl");

export const VALKEY_ENABLED = Boolean(SERVER && OPENSSL);
if (!VALKEY_ENABLED && process.env.REQUIRE_VALKEY_TESTS === "1") {
  throw new Error(
    "REQUIRE_VALKEY_TESTS=1 but valkey-server/redis-server or openssl is not on PATH"
  );
}
export const valkeyDescribe: jest.Describe = VALKEY_ENABLED ? describe : describe.skip;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface RunningValkey {
  /** rediss://:<password>@localhost:<port> */
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly password: string;
  /** The test CA that signed the server's certificate (PEM). */
  readonly caPem: string;
  stop(): Promise<void>;
}

/** How many ports a start tries before it gives up. */
const START_ATTEMPTS = 5;

function spawnServer(
  server: string,
  dir: string,
  port: number,
  password: string
): ChildProcess {
  return spawn(
    server,
    [
      "--port",
      "0",
      "--tls-port",
      String(port),
      "--bind",
      "127.0.0.1",
      "--tls-cert-file",
      join(dir, "server.crt"),
      "--tls-key-file",
      join(dir, "server.key"),
      "--tls-ca-cert-file",
      join(dir, "ca.crt"),
      "--tls-auth-clients",
      "no",
      "--requirepass",
      password,
      "--save",
      "",
      "--appendonly",
      "no",
      "--dir",
      dir,
    ],
    { stdio: "ignore" }
  );
}

/**
 * Whether the server on `port` is this child: it answers AUTH with `password` and PING, over TLS
 * verified against `caPem` for "localhost". One attempt, bounded.
 */
export function answersAsOwn(
  port: number,
  password: string,
  caPem: string
): Promise<boolean> {
  return new Promise((resolve) => {
    let got = "";
    // The TCP socket is ours, so it is closed whatever TLS does (a TLS socket destroyed before
    // its handshake can leave the connection under it open).
    const raw = netConnect(port, "127.0.0.1");
    const s = tlsConnect({ socket: raw, servername: "localhost", ca: caPem }, () =>
      s.write(`AUTH ${password}\r\nPING\r\n`)
    );
    const done = (ok: boolean) => {
      clearTimeout(timer);
      s.destroy();
      raw.destroy();
      resolve(ok);
    };
    raw.on("error", () => done(false));
    const timer = setTimeout(() => done(false), 1_000);
    s.on("data", (d) => {
      got += String(d);
      if (got.includes("+PONG")) done(got.startsWith("+OK"));
      else if (got.includes("-")) done(false);
    });
    s.on("error", () => done(false));
    s.on("close", () => done(false));
  });
}

/** Waits until the child answers as itself; false when it exits first (its port was taken). */
async function ready(
  child: ChildProcess,
  port: number,
  password: string,
  caPem: string
): Promise<boolean> {
  let exited = child.exitCode !== null;
  child.once("exit", () => (exited = true));
  for (let i = 0; i <= 100 && !exited; i++) {
    if (await answersAsOwn(port, password, caPem)) return !exited;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/**
 * Start a TLS-only server whose certificate names "localhost" (not 127.0.0.1). `port` (tests of
 * this helper) is the port the first attempt uses.
 */
export async function startValkey(
  options: { port?: number } = {}
): Promise<RunningValkey> {
  if (!SERVER || !OPENSSL) throw new Error("no valkey-server/redis-server or openssl");
  const dir = mkdtempSync(join(tmpdir(), "pf-valkey-"));
  const ssl = (...args: string[]) =>
    execFileSync(OPENSSL, args, { cwd: dir, stdio: "ignore" });
  ssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=pf-test-ca",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt"
  );
  ssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=localhost",
    "-keyout",
    "server.key",
    "-out",
    "server.csr"
  );
  // The certificate names localhost only: the hostname check is exercised against 127.0.0.1.
  writeFileSync(join(dir, "san.cnf"), "subjectAltName=DNS:localhost\n");
  ssl(
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-days",
    "2",
    "-out",
    "server.crt",
    "-extfile",
    "san.cnf"
  );
  const caPem = readFileSync(join(dir, "ca.crt"), "utf8");
  const password = `pw-${randomBytes(12).toString("hex")}`;
  let started: { child: ChildProcess; port: number } | undefined;
  for (let attempt = 0; attempt < START_ATTEMPTS && !started; attempt++) {
    const port = attempt === 0 && options.port ? options.port : await freePort();
    const child = spawnServer(SERVER, dir, port, password);
    if (await ready(child, port, password, caPem)) started = { child, port };
    else child.kill("SIGKILL");
  }
  if (!started) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error("the test Valkey server did not start");
  }
  const { child, port } = started;
  return {
    url: `rediss://:${password}@localhost:${port}`,
    host: "localhost",
    port,
    password,
    caPem,
    async stop() {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2000).unref();
      });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
