/**
 * @jest-environment node
 */
/**
 * __tests__/test-pool-connect-timeout.test.ts — the DB tests' pool gives up on a connection well
 * inside the test's own bound, and says so by name (56e-3b R2; hang report §1.5)
 *
 * What it refuses: a connect or a queued checkout that hangs and is reported only as the test's
 * "Exceeded timeout of 30000 ms" (the Mac pass-3 signature could not tell a hung connect from a
 * blocked statement). The pool's bound, DB_TEST_CONNECT_TIMEOUT_MS, is at most a third of the
 * test's, DB_TEST_TIMEOUT_MS, and a timed-out checkout fails with an error naming it — in both of
 * pg's call forms. The server here accepts the connection and never answers, as a stuck one does.
 */
import { createServer, type Server, type Socket } from "node:net";
import type { Pool, PoolClient, PoolConfig } from "pg";
import { closedPort } from "./helpers/closed-port";

const factories: ((role: string) => Pool)[] = [];
jest.mock("@/platform/data", () => ({
  closeDataPools: jest.fn(async () => undefined),
  setDataPoolFactory: jest.fn(async (f: (role: string) => Pool) => {
    factories.push(f);
  }),
  withOwnerTx: jest.fn(),
}));
let silentUrl = "";
jest.mock("@/platform/data/pool", () => ({
  poolConfig: (): PoolConfig => ({ connectionString: silentUrl, max: 1 }),
}));

import {
  connectTestDatabase,
  connectTimeoutMessage,
  DB_TEST_CONNECT_TIMEOUT_MS,
  DB_TEST_TIMEOUT_MS,
  disconnectTestDatabase,
  testPool,
} from "./helpers/db";

let server: Server;
const sockets: Socket[] = [];
const pools: Pool[] = [];

beforeAll(async () => {
  // Accepts, reads nothing back, answers nothing: a connect that hangs.
  server = createServer((s) => {
    sockets.push(s);
    s.on("error", () => undefined);
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  silentUrl = `postgresql://u:p@127.0.0.1:${addr.port}/none`;
});

afterAll(async () => {
  for (const p of pools) await p.end().catch(() => undefined);
  for (const s of sockets) s.destroy();
  await new Promise<void>((res) => server.close(() => res()));
});

const NAMED =
  /^test database: no connection within 200 ms \(DB_TEST_CONNECT_TIMEOUT_MS, __tests__\/helpers\/db\.ts; the test's own bound is DB_TEST_TIMEOUT_MS, 30000 ms\)/;

describe("the test pool's connect bound (56e-3b R2)", () => {
  it("is at most a third of the test's own bound, and over the deployment's 5 s (TASK-204's bursts)", () => {
    expect(DB_TEST_TIMEOUT_MS).toBe(30_000);
    expect(DB_TEST_CONNECT_TIMEOUT_MS * 3).toBeLessThanOrEqual(DB_TEST_TIMEOUT_MS);
    expect(DB_TEST_CONNECT_TIMEOUT_MS).toBeGreaterThan(5_000);
  });

  it("is the bound of every pool the DB suites get (connectTestDatabase's factory)", async () => {
    await connectTestDatabase();
    try {
      expect(factories).toHaveLength(1);
      const pool = factories[0]("request");
      pools.push(pool);
      expect(
        (pool as unknown as { options: PoolConfig }).options.connectionTimeoutMillis
      ).toBe(DB_TEST_CONNECT_TIMEOUT_MS);
    } finally {
      await disconnectTestDatabase();
    }
  });

  it("a connect the server never answers fails by name; so does the checkout queued behind it", async () => {
    const pool = testPool({ connectionString: silentUrl, max: 1 }, 200);
    pools.push(pool);
    const [first, queued] = await Promise.allSettled([pool.connect(), pool.connect()]);
    expect(first.status).toBe("rejected");
    expect(queued.status).toBe("rejected");
    const a = (first as PromiseRejectedResult).reason as Error;
    const b = (queued as PromiseRejectedResult).reason as Error;
    // A new client's connect, then pg-pool's queue: each named, with pg's own words kept.
    expect(a.message).toMatch(NAMED);
    expect(a.message).toMatch(/Connection terminated due to connection timeout$/);
    expect(b.message).toMatch(NAMED);
    expect(b.message).toMatch(/timeout exceeded when trying to connect$/);
    expect((a as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  it("the callback form is named the same way; another error is passed on as it is", async () => {
    const pool = testPool({ connectionString: silentUrl, max: 1 }, 200);
    pools.push(pool);
    const err = await new Promise<unknown>((res) =>
      pool.connect((e: Error | undefined, _c: PoolClient | undefined, done) => {
        done?.();
        res(e);
      })
    );
    expect((err as Error).message).toMatch(NAMED);
    // Refused at once (a port just released: nothing listens): not a timeout, so not renamed.
    const refused = testPool(
      { connectionString: `postgresql://u:p@127.0.0.1:${await closedPort()}/none` },
      200
    );
    pools.push(refused);
    const e = (await refused.connect().catch((x: unknown) => x)) as Error;
    expect(e.message).not.toMatch(/DB_TEST_CONNECT_TIMEOUT_MS/);
    expect(connectTimeoutMessage(10_000, "x")).toContain("no connection within 10000 ms");
  });
});
