/**
 * __tests__/valkey-server-helper.test.ts — the throwaway Valkey server is the suite's own
 * (TASK-198, D-17)
 *
 * __tests__/helpers/valkey-server.ts finds a free port, closes it and hands it to the child: in
 * between, another worker's server (or anything) can take it. Its readiness check only tested that
 * something listened on the port, so a suite could connect to the wrong server — wrong password,
 * wrong CA — and fail for nothing in the code. Now a start whose port is taken is retried on
 * another, and the server is ready only when it answers AUTH with its own password over TLS
 * verified against its own CA.
 */
import { createServer, type Server } from "node:net";
import {
  answersAsOwn,
  startValkey,
  valkeyDescribe,
  type RunningValkey,
} from "./helpers/valkey-server";

jest.setTimeout(60_000);

valkeyDescribe("the test Valkey server (helpers/valkey-server.ts)", () => {
  const running: RunningValkey[] = [];
  afterAll(async () => {
    for (const v of running) await v.stop();
  });

  it("a port taken by something else between the check and the bind: started on another, its own", async () => {
    const squatter: Server = createServer((s) => s.destroy());
    await new Promise<void>((r) => squatter.listen(0, "127.0.0.1", () => r()));
    const taken = (squatter.address() as { port: number }).port;
    try {
      const v = await startValkey({ port: taken });
      running.push(v);
      expect(v.port).not.toBe(taken);
      expect(await answersAsOwn(v.port, v.password, v.caPem)).toBe(true);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });

  it("a port taken by another worker's server: never handed that server", async () => {
    const other = await startValkey();
    running.push(other);
    const mine = await startValkey({ port: other.port });
    running.push(mine);
    expect(mine.port).not.toBe(other.port);
    expect(mine.password).not.toBe(other.password);
    expect(await answersAsOwn(mine.port, mine.password, mine.caPem)).toBe(true);
    // The other server refuses this one's password and certificate authority.
    expect(await answersAsOwn(other.port, mine.password, other.caPem)).toBe(false);
    expect(await answersAsOwn(other.port, other.password, mine.caPem)).toBe(false);
  });
});
