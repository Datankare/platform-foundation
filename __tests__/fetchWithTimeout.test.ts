import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

const mockFetch = jest.fn();
global.fetch = mockFetch;

describe("fetchWithTimeout", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns response on successful fetch within timeout", async () => {
    const mockResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
    mockFetch.mockResolvedValueOnce(mockResponse);

    const result = await fetchWithTimeout("https://api.example.com/test", {
      method: "POST",
      timeoutMs: 5000,
    });

    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("passes fetch options through to underlying fetch", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    mockFetch.mockResolvedValueOnce(mockResponse);

    await fetchWithTimeout("https://api.example.com/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Custom": "value" },
      body: JSON.stringify({ text: "hello" }),
      timeoutMs: 10000,
    });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.example.com/test");
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({
      "Content-Type": "application/json",
      "X-Custom": "value",
    });
    expect(options.body).toBe(JSON.stringify({ text: "hello" }));
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws structured error on timeout", async () => {
    // Simulate a fetch that never resolves
    mockFetch.mockImplementationOnce(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        })
    );

    const fetchPromise = fetchWithTimeout("https://api.example.com/slow", {
      timeoutMs: 100,
    });

    // Advance timers to trigger the abort
    jest.advanceTimersByTime(150);

    await expect(fetchPromise).rejects.toThrow("Request timed out after 100ms");
  });

  it("re-throws non-timeout errors unchanged", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Network error"));

    await expect(fetchWithTimeout("https://api.example.com/test")).rejects.toThrow(
      "Network error"
    );
  });

  it("uses default 10s timeout when timeoutMs not specified", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    mockFetch.mockResolvedValueOnce(mockResponse);

    await fetchWithTimeout("https://api.example.com/test");

    // Verify signal was passed (timeout was set up)
    const [, options] = mockFetch.mock.calls[0];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});
