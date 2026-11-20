/**
 * __tests__/helpers/closed-port.ts — a loopback port nothing listens on, on any machine (TASK-229)
 *
 * Tests of "the service cannot be reached" used fixed ports — 1, 9, 9999 — taken to be closed. On
 * macOS an unprivileged process may listen on any of them (the low-port restriction went in 10.14),
 * so a developer's tool could answer and the test would test that tool. A port the kernel has just
 * given this process and taken back is refused (ECONNREFUSED) on Linux and macOS alike; the
 * chance another process binds it in between is that of any ephemeral port being reused at once.
 * __tests__/closed-port-guard.test.ts refuses the fixed ports.
 */

import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

/** A loopback port just released by this process. */
export function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** The same, synchronously (for a constant a synchronous helper needs): asked of a child node. */
export function closedPortSync(): number {
  const r = spawnSync(
    process.execPath,
    [
      "-e",
      "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>process.stdout.write(String(p)))})",
    ],
    { encoding: "utf8" }
  );
  const port = Number(r.stdout);
  if (!Number.isInteger(port) || port <= 0) throw new Error("closedPortSync: no port");
  return port;
}
