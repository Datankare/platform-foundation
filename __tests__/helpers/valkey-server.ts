/**
 * __tests__/helpers/valkey-server.ts — a throwaway Valkey/Redis server for the Valkey cache tests
 * (review 9 M5)
 *
 * Spawns `valkey-server` (or `redis-server`) on a free port, with TLS — a test CA and a server
 * certificate for "localhost" made with openssl — so the provider is tested over verify-full TLS
 * as a deployment runs it. Absent binaries skip the suites, unless REQUIRE_VALKEY_TESTS=1 (CI),
 * which makes their absence a failure.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { connect, createServer } from "node:net";
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

/** Start a TLS-only server whose certificate names "localhost" (not 127.0.0.1). */
export async function startValkey(): Promise<RunningValkey> {
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
  const port = await freePort();
  const password = `pw-${randomBytes(12).toString("hex")}`;
  const child: ChildProcess = spawn(
    SERVER,
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
  const caPem = readFileSync(join(dir, "ca.crt"), "utf8");
  // Ready when the TLS port accepts connections.
  for (let i = 0; ; i++) {
    const up = await new Promise<boolean>((resolve) => {
      const s = connect(port, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
    if (up) break;
    if (i > 100) {
      child.kill("SIGKILL");
      throw new Error("the test Valkey server did not start");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
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
