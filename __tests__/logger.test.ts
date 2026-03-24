import { logger, generateRequestId } from "@/lib/logger";

describe("logger", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it("emits error logs when level is error (default)", () => {
    process.env.LOG_LEVEL = "error";
    logger.error("test error");
    expect(console.error).toHaveBeenCalledTimes(1);
    const entry = JSON.parse((console.error as jest.Mock).mock.calls[0][0]);
    expect(entry.level).toBe("error");
    expect(entry.message).toBe("test error");
    expect(entry.timestamp).toBeDefined();
    expect(entry.environment).toBeDefined();
  });

  it("suppresses info logs when level is error", () => {
    process.env.LOG_LEVEL = "error";
    logger.info("test info");
    expect(console.log).not.toHaveBeenCalled();
  });

  it("suppresses debug logs when level is warn", () => {
    process.env.LOG_LEVEL = "warn";
    logger.debug("test debug");
    expect(console.log).not.toHaveBeenCalled();
  });

  it("emits all levels when LOG_LEVEL is debug", () => {
    process.env.LOG_LEVEL = "debug";
    logger.error("e");
    logger.warn("w");
    logger.info("i");
    logger.debug("d");
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledTimes(2);
  });

  it("defaults to error level when LOG_LEVEL is unset", () => {
    delete process.env.LOG_LEVEL;
    logger.info("should not appear");
    expect(console.log).not.toHaveBeenCalled();
    logger.error("should appear");
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("includes optional fields in log entry", () => {
    process.env.LOG_LEVEL = "error";
    logger.error("api failed", { route: "/api/process", status: 500 });
    const entry = JSON.parse((console.error as jest.Mock).mock.calls[0][0]);
    expect(entry.route).toBe("/api/process");
    expect(entry.status).toBe(500);
  });

  it("response logs 5xx as error level", () => {
    process.env.LOG_LEVEL = "debug";
    logger.response("/api/process", "POST", 500, "req-1", 100);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("response logs 4xx as warn level", () => {
    process.env.LOG_LEVEL = "debug";
    logger.response("/api/process", "POST", 400, "req-1", 50);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("response logs 2xx as info level", () => {
    process.env.LOG_LEVEL = "debug";
    logger.response("/api/process", "POST", 200, "req-1", 50);
    expect(console.log).toHaveBeenCalledTimes(1);
  });

  it("generateRequestId returns non-empty string", () => {
    const id = generateRequestId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("generateRequestId returns unique values", () => {
    const ids = new Set(Array.from({ length: 100 }, generateRequestId));
    expect(ids.size).toBe(100);
  });

  it("log entry is valid JSON", () => {
    process.env.LOG_LEVEL = "error";
    logger.error("json test");
    const raw = (console.error as jest.Mock).mock.calls[0][0];
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
