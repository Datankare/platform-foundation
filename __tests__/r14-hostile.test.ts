/**
 * __tests__/r14-hostile.test.ts — Review 14 M-2: event-loop lag is not a cache failure
 *
 * Ported from the reviewer's proof (review 14): a healthy, instant cache read on an instance whose
 * event loop is stalled (CPU-saturated) was "timed out" — the bound's timer runs before the
 * socket is read — and five such requests opened the stamp breaker and alerted
 * `cache.stamp_breaker_open` against a cache that was fine. A flapping cache raised one alert per
 * opening. Now:
 *
 *   - at the bound the reader yields once and takes a read that has settled (a cache in another
 *     process answers during the stall: every read is served);
 *   - a timeout during lag above STAMP_LAG_BOUND_MS is counted as lag (metric and alert
 *     `cache.stamp_read_lag`), never as a failure: the breaker stays closed;
 *   - a hanging cache on a responsive loop still opens the breaker, and its alert says so;
 *   - alerts are rate-limited per instance (one per STAMP_ALERT_INTERVAL_MS, with a count).
 *
 * Real sockets and a real CPU stall (a busy loop), as the reviewer ran it.
 */
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));
const raiseAlert = jest.fn();
jest.mock("@/platform/observability/alert", () => ({
  raiseAlert: (...a: unknown[]) => raiseAlert(...a),
}));
const recordMetricEvent = jest.fn();
jest.mock("@/platform/observability/metric-event", () => ({
  recordMetricEvent: (...a: unknown[]) => recordMetricEvent(...a),
}));

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, connect, type Server, type Socket } from "node:net";
import {
  readStamp,
  resetStampBreaker,
  stampBreakerState,
  stampReadsLostToLag,
  STAMP_ALERT_INTERVAL_MS,
  STAMP_BREAKER_COOLDOWN_MS,
  STAMP_BREAKER_FAILURES,
  STAMP_LAG_BOUND_MS,
  STAMP_READ_TIMEOUT_MS,
} from "@/platform/cache/stamp-reader";

// Real stalls and a child process: generous, so a loaded CI machine never fails these by the clock.
jest.setTimeout(30_000);

/** Event-loop lag, as on a CPU-saturated instance. */
function busy(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* other requests' CPU work */
  }
}

const hang = () => new Promise<never>(() => {});
const alertsNamed = (name: string) =>
  raiseAlert.mock.calls.filter(([a]) => (a as { name: string }).name === name);

beforeEach(() => {
  resetStampBreaker();
  raiseAlert.mockReset();
  recordMetricEvent.mockReset();
});

describe("R14-M2 a healthy cache in another process, read while this instance stalls", () => {
  let child: ChildProcess;
  let port = 0;
  let sock: Socket;
  beforeAll(async () => {
    // The cache is another process (as in production): it answers while this one is busy.
    child = spawn(
      process.execPath,
      [
        "-e",
        `const s=require("net").createServer(c=>{c.setNoDelay(true);c.on("data",()=>c.write("pong"))});
         s.listen(0,"127.0.0.1",()=>process.stdout.write(String(s.address().port)+"\\n"));`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    port = await new Promise<number>((resolve) =>
      child.stdout!.once("data", (d) => resolve(Number(String(d).trim())))
    );
    sock = connect(port, "127.0.0.1");
    sock.setNoDelay(true);
    await new Promise<void>((r) => sock.once("connect", () => r()));
  });
  afterAll(() => {
    sock.destroy();
    child.kill();
  });

  /** One cache "get" on the open connection: answered in well under a millisecond. */
  const get = () =>
    new Promise<string>((resolve) => {
      sock.once("data", () => resolve("-"));
      sock.write("ping");
    });

  it("every read is served: the answer received during the stall is taken at the bound", async () => {
    expect((await readStamp(get)).ok).toBe(true);
    const results: boolean[] = [];
    for (let i = 0; i < STAMP_BREAKER_FAILURES + 2; i++) {
      const p = readStamp(get);
      busy(STAMP_READ_TIMEOUT_MS + 50);
      results.push((await p).ok);
    }
    expect(results).toEqual(results.map(() => true));
    expect(stampBreakerState()).toBe("closed");
    expect(alertsNamed("cache.stamp_breaker_open")).toEqual([]);
  });
});

describe("R14-M2 the reviewer's case: a cache in this process, unanswerable while it stalls", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((s) => s.on("data", () => s.write("pong")));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  /** A cache "get" over a real socket that answers in well under a millisecond. */
  const socketGet = () =>
    new Promise<string>((resolve, reject) => {
      const c = connect(port, "127.0.0.1", () => c.write("ping"));
      c.on("data", () => {
        c.destroy();
        resolve("-");
      });
      c.on("error", reject);
    });

  it("a stall of 250 ms on every read never opens the breaker: each timeout is lag, alerted once as lag", async () => {
    expect((await readStamp(socketGet)).ok).toBe(true);
    let ok = 0;
    for (let i = 0; i < STAMP_BREAKER_FAILURES * 2; i++) {
      const p = readStamp(socketGet);
      busy(250);
      if ((await p).ok) ok++;
    }
    expect(stampBreakerState()).toBe("closed");
    expect(alertsNamed("cache.stamp_breaker_open")).toEqual([]);
    // Each read either was served or timed out during lag — none counted as a cache failure.
    expect(ok + stampReadsLostToLag()).toBe(STAMP_BREAKER_FAILURES * 2);
    if (stampReadsLostToLag() > 0) {
      const lagAlerts = alertsNamed("cache.stamp_read_lag");
      expect(lagAlerts).toHaveLength(1); // rate-limited
      expect(lagAlerts[0][0].message).toMatch(
        /INSTANCE was busy, not because the cache failed/
      );
      expect(recordMetricEvent).toHaveBeenCalledWith(
        "cache.stamp_read_lag",
        expect.objectContaining({ count: 1 }),
        expect.any(Object)
      );
    }
    // Once the instance is idle again, the same cache is read at once.
    expect((await readStamp(socketGet)).ok).toBe(true);
  });
});

describe("R14-M2 lag and failure told apart", () => {
  it("a hanging cache during a stall: lag, not failure — the breaker stays closed", async () => {
    for (let i = 0; i < STAMP_BREAKER_FAILURES + 1; i++) {
      const p = readStamp(hang);
      busy(STAMP_READ_TIMEOUT_MS + STAMP_LAG_BOUND_MS + 50);
      expect((await p).ok).toBe(false); // fail closed: unreadable, read from the database
    }
    expect(stampReadsLostToLag()).toBe(STAMP_BREAKER_FAILURES + 1);
    expect(stampBreakerState()).toBe("closed");
    expect(alertsNamed("cache.stamp_breaker_open")).toEqual([]);
    expect(alertsNamed("cache.stamp_read_lag")).toHaveLength(1);
    expect(alertsNamed("cache.stamp_read_lag")[0][0]).toMatchObject({
      count: 1,
      tags: expect.objectContaining({ count: "1" }),
    });
  });

  it("a hanging cache on a responsive loop opens the breaker; the alert says it is the cache", async () => {
    for (let i = 0; i < STAMP_BREAKER_FAILURES; i++) await readStamp(hang);
    expect(stampBreakerState()).toBe("open");
    expect(stampReadsLostToLag()).toBe(0);
    const [alert] = alertsNamed("cache.stamp_breaker_open");
    expect(alert[0].message).toMatch(/event loop was responsive/);
    expect(alert[0].message).toMatch(/this is the cache, not instance lag/);
  });

  it("a probe lost to lag is no verdict: the breaker stays half-open and the next read probes", async () => {
    const fail = async () => {
      throw new Error("ECONNRESET");
    };
    for (let i = 0; i < STAMP_BREAKER_FAILURES; i++) await readStamp(fail);
    expect(stampBreakerState()).toBe("open");
    // The cool-down has passed (the clock moved on, still running).
    const real = Date.now.bind(Date);
    const clock = jest
      .spyOn(Date, "now")
      .mockImplementation(() => real() + STAMP_BREAKER_COOLDOWN_MS + 1);
    try {
      expect(stampBreakerState()).toBe("half-open");
      const p = readStamp(hang);
      busy(STAMP_READ_TIMEOUT_MS + STAMP_LAG_BOUND_MS + 50);
      expect((await p).ok).toBe(false);
      expect(stampReadsLostToLag()).toBe(1);
      expect(stampBreakerState()).toBe("half-open");
      expect((await readStamp(async () => "-")).ok).toBe(true);
      expect(stampBreakerState()).toBe("closed");
    } finally {
      clock.mockRestore();
    }
  });
});

describe("R14-M2 a flapping cache raises one alert per interval, with a count", () => {
  it("four openings within five minutes: one alert; the next one past the interval counts them", async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    try {
      const down = async () => {
        throw new Error("down");
      };
      for (let cycle = 0; cycle < 4; cycle++) {
        for (let i = 0; i < STAMP_BREAKER_FAILURES; i++) await readStamp(down);
        expect(stampBreakerState()).toBe("open");
        jest.setSystemTime(Date.now() + STAMP_BREAKER_COOLDOWN_MS + 1_000);
        expect((await readStamp(async () => "-")).ok).toBe(true); // probe answers: closed
      }
      expect(alertsNamed("cache.stamp_breaker_open")).toHaveLength(1);
      expect(alertsNamed("cache.stamp_breaker_open")[0][0]).toMatchObject({ count: 1 });
      jest.setSystemTime(1_000_000 + STAMP_ALERT_INTERVAL_MS + 1);
      for (let i = 0; i < STAMP_BREAKER_FAILURES; i++) await readStamp(down);
      const alerts = alertsNamed("cache.stamp_breaker_open");
      expect(alerts).toHaveLength(2);
      // This opening and the three held back since the first alert.
      expect(alerts[1][0]).toMatchObject({ count: 4, tags: { openings: "4" } });
      expect(alerts[1][0].message).toMatch(/opened 4 time\(s\) since the last alert/);
    } finally {
      jest.useRealTimers();
    }
  });
});
