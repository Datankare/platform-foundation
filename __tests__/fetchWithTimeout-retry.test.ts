/**
 * fetchWithTimeout — retry integrity tests.
 *
 * Covers branches missing from fetchWithTimeout.test.ts:
 * - Retry on 429/503/529 status codes
 * - Exponential backoff between retries
 * - Retry exhaustion (returns last retryable response)
 * - Timeout during retry attempts
 */

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
  generateRequestId: () => "test-req-id",
}));

import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe("fetchWithTimeout — retry on transient errors", () => {
  it("retries on 429 and succeeds on second attempt", async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce({ status: 429, ok: false })
      .mockResolvedValueOnce({ status: 200, ok: true });
    global.fetch = mockFetch;

    const response = await fetchWithTimeout("https://api.test.com/data", {
      maxRetries: 2,
    });

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 503", async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce({ status: 503, ok: false })
      .mockResolvedValueOnce({ status: 200, ok: true });
    global.fetch = mockFetch;

    const response = await fetchWithTimeout("https://api.test.com/data", {
      maxRetries: 2,
    });

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 529", async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce({ status: 529, ok: false })
      .mockResolvedValueOnce({ status: 200, ok: true });
    global.fetch = mockFetch;

    const response = await fetchWithTimeout("https://api.test.com/data", {
      maxRetries: 2,
    });

    expect(response.status).toBe(200);
  });

  it("does NOT retry on non-retryable status codes (400, 500)", async () => {
    const mockFetch = jest.fn().mockResolvedValueOnce({ status: 400, ok: false });
    global.fetch = mockFetch;

    const response = await fetchWithTimeout("https://api.test.com/data", {
      maxRetries: 2,
    });

    expect(response.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 500", async () => {
    const mockFetch = jest.fn().mockResolvedValueOnce({ status: 500, ok: false });
    global.fetch = mockFetch;

    const response = await fetchWithTimeout("https://api.test.com/data", {
      maxRetries: 2,
    });

    expect(response.status).toBe(500);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("fetchWithTimeout — retry exhaustion", () => {
  it("returns the retryable response after all retries exhausted", async () => {
    const mockFetch = jest.fn().mockResolvedValue({ status: 429, ok: false });
    global.fetch = mockFetch;

    const response = await fetchWithTimeout("https://api.test.com/data", {
      maxRetries: 2,
    });

    // After 3 attempts (0, 1, 2), returns the 429
    expect(response.status).toBe(429);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe("fetchWithTimeout — timeout during retry", () => {
  it("retries after timeout and succeeds", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    const mockFetch = jest
      .fn()
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce({ status: 200, ok: true });
    global.fetch = mockFetch;

    const response = await fetchWithTimeout("https://api.test.com/data", {
      timeoutMs: 100,
      maxRetries: 2,
    });

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws after timeout on all retry attempts", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    const mockFetch = jest.fn().mockRejectedValue(abortError);
    global.fetch = mockFetch;

    await expect(
      fetchWithTimeout("https://api.test.com/data", {
        timeoutMs: 100,
        maxRetries: 1,
      })
    ).rejects.toThrow("timed out");

    expect(mockFetch).toHaveBeenCalledTimes(2); // initial + 1 retry
  });
});

describe("fetchWithTimeout — zero retries", () => {
  it("does not retry when maxRetries is 0", async () => {
    const mockFetch = jest.fn().mockResolvedValueOnce({ status: 429, ok: false });
    global.fetch = mockFetch;

    const response = await fetchWithTimeout("https://api.test.com/data", {
      maxRetries: 0,
    });

    expect(response.status).toBe(429);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("fetchWithTimeout — audit G-9", () => {
  const abortError = () => new DOMException("The operation was aborted.", "AbortError");

  it("does not send a timed-out POST again (it may have been processed and billed)", async () => {
    const mockFetch = jest.fn().mockRejectedValue(abortError());
    global.fetch = mockFetch;
    await expect(
      fetchWithTimeout("https://api.test.com/paid", {
        method: "POST",
        timeoutMs: 50,
        maxRetries: 2,
      })
    ).rejects.toThrow("timed out");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries a timed-out POST only when the caller says it is safe", async () => {
    const mockFetch = jest
      .fn()
      .mockRejectedValueOnce(abortError())
      .mockResolvedValueOnce({ status: 200, ok: true });
    global.fetch = mockFetch;
    const res = await fetchWithTimeout("https://api.test.com/idempotent", {
      method: "POST",
      timeoutMs: 50,
      maxRetries: 1,
      retryOnTimeout: true,
    });
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("still retries a POST refused with 429 (not processed)", async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce({ status: 429, ok: false })
      .mockResolvedValueOnce({ status: 200, ok: true });
    global.fetch = mockFetch;
    const res = await fetchWithTimeout("https://api.test.com/paid", {
      method: "POST",
      maxRetries: 1,
    });
    expect(res.status).toBe(200);
  });

  it("keeps the caller's signal: aborting it aborts the call, and it is never retried", async () => {
    const caller = new AbortController();
    const mockFetch = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(abortError()));
        })
    );
    global.fetch = mockFetch as unknown as typeof fetch;
    const pending = fetchWithTimeout("https://api.test.com/data", {
      signal: caller.signal,
      timeoutMs: 10_000,
      maxRetries: 2,
    });
    caller.abort(new Error("caller gave up"));
    await expect(pending).rejects.toThrow("caller gave up");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("an already-aborted caller signal sends nothing", async () => {
    const mockFetch = jest.fn();
    global.fetch = mockFetch;
    const caller = new AbortController();
    caller.abort();
    await expect(
      fetchWithTimeout("https://api.test.com/data", { signal: caller.signal })
    ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("times the body too: a body that stalls past the deadline is aborted", async () => {
    let bodySignal: AbortSignal | undefined;
    global.fetch = jest.fn(async (_url: string, init: RequestInit) => {
      bodySignal = init.signal ?? undefined;
      return {
        status: 200,
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(abortError()));
          }),
      };
    }) as unknown as typeof fetch;
    const res = await fetchWithTimeout("https://api.test.com/slow-body", {
      timeoutMs: 30,
    });
    await expect(res.json()).rejects.toThrow("aborted");
    expect(bodySignal?.aborted).toBe(true);
  });

  it("a stream is timed to its headers only", async () => {
    let streamSignal: AbortSignal | undefined;
    global.fetch = jest.fn(async (_url: string, init: RequestInit) => {
      streamSignal = init.signal ?? undefined;
      return { status: 200, ok: true };
    }) as unknown as typeof fetch;
    await fetchWithTimeout("https://api.test.com/stream", {
      method: "POST",
      timeoutMs: 20,
      stream: true,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(streamSignal?.aborted).toBe(false);
  });
});
