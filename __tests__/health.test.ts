import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  it("returns status ok", async () => {
    const response = await GET();
    const data = await response.json();
    expect(data.status).toBe("ok");
  });

  it("returns service name", async () => {
    const response = await GET();
    const data = await response.json();
    expect(data.service).toBeDefined();
  });

  it("returns timestamp", async () => {
    const response = await GET();
    const data = await response.json();
    expect(data.timestamp).toBeDefined();
    expect(() => new Date(data.timestamp)).not.toThrow();
  });

  it("does NOT expose API key presence", async () => {
    const response = await GET();
    const data = await response.json();
    expect(data.apis).toBeUndefined();
    expect(data.anthropic).toBeUndefined();
    expect(data.google).toBeUndefined();
  });
});
