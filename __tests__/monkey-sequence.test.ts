/**
 * @jest-environment node
 */
/**
 * scripts/monkey/monkey.mjs sequence mode (TASK-147) — run against a small fake server, in a
 * scratch tree with its own app/api routes.
 *
 * The monkey's random steps were mostly refused with 429 from one address. Sequence mode paces
 * itself, waits out a 429's Retry-After (never bypassing the limiter), reuses the ids the server
 * returned in later paths and bodies, and checks I6: no response to one caller carries another
 * caller's identity.
 */

import { execFile } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { createServer, type Server } from "http";
import { tmpdir } from "os";
import { join } from "path";
import type { AddressInfo } from "net";

const SCRIPT = join(process.cwd(), "scripts/monkey/monkey.mjs");
const USER_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const GUEST_ID = "9f0e8d7c-6b5a-4c3d-8e1f-0a1b2c3d4e5f";
const ITEM_ID = "11111111-2222-4333-8444-555555555555";
const ROUTES = [
  "items",
  "items/[id]",
  "limited",
  ...Array.from({ length: 9 }, (_, i) => `r${i}`),
];

let dir: string;
let server: Server;
let base: string;
let leak = false;
let limitedOnce = false;
const seenPaths: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "monkey-seq-"));
  for (const r of ROUTES) {
    mkdirSync(join(dir, "app/api", r), { recursive: true });
    writeFileSync(
      join(dir, "app/api", r, "route.ts"),
      "export async function GET() {}\nexport async function POST() {}\n"
    );
  }
  server = createServer((req, res) => {
    const url = req.url ?? "";
    seenPaths.push(url);
    const auth = req.headers.authorization ?? "";
    const json = (
      status: number,
      body: unknown,
      headers: Record<string, string> = {}
    ) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    req.resume();
    req.on("end", () => {
      if (url.startsWith("/api/auth/guest")) {
        const payload = Buffer.from(JSON.stringify({ sub: GUEST_ID })).toString(
          "base64url"
        );
        return json(200, { token: `guest.${payload}.sig` });
      }
      if (url.startsWith("/api/limited") && !limitedOnce) {
        limitedOnce = true;
        return json(429, { code: "rate_limit.exceeded" }, { "retry-after": "1" });
      }
      if (url.startsWith("/api/items")) {
        if (auth.startsWith("Bearer guest.")) {
          return json(200, { items: leak ? [{ owner: USER_ID }] : [] });
        }
        return json(200, { items: [{ id: ITEM_ID }] });
      }
      return json(400, { code: "request.invalid_body" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function monkey(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      "node",
      [SCRIPT],
      {
        cwd: dir,
        env: {
          ...process.env,
          MONKEY_BASE_URL: base,
          MONKEY_MODE: "sequence",
          MONKEY_STEPS: "60",
          MONKEY_RATE_PER_MIN: "60000",
          MONKEY_MOCK_USER: "1",
          MONKEY_SEED: "7",
          ...env,
        },
        timeout: 60_000,
      },
      (err, stdout, stderr) =>
        resolve({
          code: err ? ((err as { code?: number }).code ?? 1) : 0,
          out: stdout + stderr,
        })
    );
  });
}

describe("monkey sequence mode (TASK-147)", () => {
  it("waits out a 429 and takes the step again; passes a clean server", async () => {
    leak = false;
    limitedOnce = false;
    const r = await monkey({});
    expect(r.out).toMatch(/mode: sequence/);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/waited out [1-9]\d* limit/);
    expect(r.out).toMatch(/no invariant broken/);
  }, 60_000);

  it("reuses the ids the server returned in later requests", async () => {
    seenPaths.length = 0;
    await monkey({ MONKEY_SEED: "11", MONKEY_STEPS: "120" });
    expect(seenPaths.some((p) => p.includes(ITEM_ID))).toBe(true);
  }, 60_000);

  it("fails I6 when one caller's response carries another caller's identity", async () => {
    leak = true;
    const r = await monkey({ MONKEY_SEED: "3", MONKEY_STEPS: "120" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/I6 .*the user caller's id in a response to guest/);
    leak = false;
  }, 60_000);
});
