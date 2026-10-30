/**
 * __tests__/soak/stamp-reader-real-stall.soak.ts — the stamp reader on a real clock, real sockets
 * and a real CPU stall (review 13 M2, review 14 M-2), kept out of the per-commit passes (TASK-198,
 * D-13)
 *
 * These are the reviewers' proofs as they ran them. Their verdicts depend on how the machine
 * schedules the CPU: a child process must be given CPU inside a 250 ms busy loop, and a loop is
 * judged responsive only while no heartbeat is more than STAMP_LAG_BOUND_MS late — a GC pause or
 * another worker on a 2-vCPU runner breaks either. So they do not gate a commit (the same cases
 * run there on jest's fake clock: __tests__/r13-hostile.test.ts, __tests__/r14-hostile.test.ts);
 * they run in the scheduled fuzz-and-soak job (.github/workflows/fuzz.yml, the step "Soak", whose
 * command runs every *.soak.ts under __tests__/soak), alone on the runner.
 */
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));
const raiseAlert = jest.fn();
jest.mock("@/platform/observability/alert", () => ({
  raiseAlert: (...a: unknown[]) => raiseAlert(...a),
}));
jest.mock("@/platform/observability/metric-event", () => ({
  recordMetricEvent: jest.fn(),
}));

import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import {
  readStamp,
  resetStampBreaker,
  stampBreakerState,
  stampReadsLostToLag,
  STAMP_BREAKER_FAILURES,
  STAMP_READ_TIMEOUT_MS,
} from "@/platform/cache/stamp-reader";

jest.setTimeout(60_000);

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
});

describe("soak: a healthy cache in another process, read while this instance stalls (R14-M2)", () => {
  let child: ChildProcess;
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
    const port = await new Promise<number>((resolve) =>
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
    expect(results).toHaveLength(STAMP_BREAKER_FAILURES + 2);
    expect(results).toEqual(results.map(() => true));
    expect(stampBreakerState()).toBe("closed");
    expect(alertsNamed("cache.stamp_breaker_open")).toEqual([]);
  });
});

describe("soak: a hanging cache on a responsive real loop (R13-M2, R14-M2)", () => {
  it("each read returns within the bound and the breaker opens after the failures", async () => {
    for (let i = 0; i < STAMP_BREAKER_FAILURES; i++) {
      const started = Date.now();
      expect((await readStamp(hang)).ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(STAMP_READ_TIMEOUT_MS + 250);
    }
    expect(stampReadsLostToLag()).toBe(0);
    expect(stampBreakerState()).toBe("open");
    expect(alertsNamed("cache.stamp_breaker_open")).toHaveLength(1);
  });
});
