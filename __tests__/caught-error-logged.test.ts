/**
 * @jest-environment node
 */
/**
 * __tests__/caught-error-logged.test.ts — a caught error's text reaches the log, and only the log
 * (TASK-205, R-77 / R-78)
 *
 * __tests__/error-text-not-returned.test.ts proves no caught error's text leaves a catch other
 * than through a log. This proves the other half: the text is not lost (R-78 was a diagnostic
 * dropped on the floor) — it is in the log line, with the caller's context, while what the
 * caller returns is fixed. Each test loads the modules in a fresh registry with the logger
 * mocked first: jest.setup loads the agents' bootstrap (and with it these modules) before a
 * suite's own mock would apply.
 */

type Log = { error: jest.Mock; warn: jest.Mock; info: jest.Mock; debug: jest.Mock };

function fresh(): Log {
  jest.resetModules();
  const log: Log = {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  };
  jest.doMock("@/lib/logger", () => ({ logger: log, generateRequestId: () => "req" }));
  return log;
}

describe("caught-error: the text is logged where it is caught, never returned", () => {
  it("logCaught writes the error's own text with the context, at the level asked", () => {
    const log = fresh();
    const { logCaught } = jest.requireActual<
      typeof import("@/platform/observability/caught-error")
    >("@/platform/observability/caught-error");
    logCaught(log, "Thing failed", new Error('relation "secret_table" does not exist'), {
      userId: "u1",
    });
    logCaught(log, "Probe failed", "plain text thrown", { probe: "p" }, "warn");
    expect(log.error).toHaveBeenCalledWith("Thing failed", {
      userId: "u1",
      error: 'relation "secret_table" does not exist',
    });
    expect(log.warn).toHaveBeenCalledWith("Probe failed", {
      probe: "p",
      error: "plain text thrown",
    });
  });

  it("failedWrite: undefined when the write succeeds; WRITE_FAILED and a log line when not", async () => {
    const log = fresh();
    const { failedWrite, WRITE_FAILED } = jest.requireActual<
      typeof import("@/platform/observability/caught-error")
    >("@/platform/observability/caught-error");
    await expect(
      failedWrite(log, async () => 1, "Write failed")
    ).resolves.toBeUndefined();
    expect(log.error).not.toHaveBeenCalled();
    const out = await failedWrite(
      log,
      async () => {
        throw new Error('insert violates foreign key constraint "users_fk"');
      },
      "Write failed",
      { userId: "u2" }
    );
    expect(out).toBe(WRITE_FAILED);
    expect(out).not.toContain("users_fk");
    expect(log.error).toHaveBeenCalledWith("Write failed", {
      userId: "u2",
      error: 'insert violates foreign key constraint "users_fk"',
    });
  });

  it("a provider probe: unreachable says so in fixed words; the network's text is logged", async () => {
    const log = fresh();
    const { probeResponsive, PROVIDER_UNREACHABLE } = jest.requireActual<
      typeof import("@/platform/observability/provider-health")
    >("@/platform/observability/provider-health");
    const status = await probeResponsive("acr", async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.7:443");
    });
    expect(status).toMatchObject({ healthy: false, error: PROVIDER_UNREACHABLE });
    expect(log.warn).toHaveBeenCalledWith("Provider unreachable", {
      provider: "acr",
      error: "connect ECONNREFUSED 10.0.0.7:443",
    });
    // A provider that answered with an error is healthy, and nothing is logged as unreachable.
    log.warn.mockClear();
    await expect(
      probeResponsive("acr", async () => {
        throw new Error("unsupported format");
      })
    ).resolves.toMatchObject({ healthy: true, error: undefined });
    expect(log.warn).not.toHaveBeenCalled();
  });
});
