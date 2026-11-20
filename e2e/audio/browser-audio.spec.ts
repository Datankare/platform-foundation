import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// The browser-audio gate in one engine (TASK-234; DESIGN-56f1 §9, test T21): the shipped modules
// convert every case of e2e/audio/expect.json and record two oscillator clips; every cell of this
// engine's column is asserted (compare.mjs). Audio starts only after a click on Start. Times are
// logged, never asserted. The run may take up to ten minutes: were an engine to leave the length
// probe without an answer, each such case waits out its budget (30 s) and the run must still end
// with every fact reported.

type Server = { url: string; close: () => Promise<void> };
type Compare = {
  compare: (table: unknown, engine: string, result: unknown) => string[];
  information: (result: unknown) => unknown;
};

const table = JSON.parse(readFileSync(join(__dirname, "expect.json"), "utf8"));
let server: Server;
let cmp: Compare;

test.beforeAll(async () => {
  const serve = (await import("./serve.mjs")) as { startServer: () => Promise<Server> };
  cmp = (await import("./compare.mjs")) as Compare;
  server = await serve.startServer();
});

test.afterAll(async () => {
  await server?.close();
});

test("every cell of this engine's column in expect.json holds", async ({
  page,
  browserName,
}) => {
  await page.goto(server.url);
  await page.waitForFunction(
    () => (window as { __gateReady?: boolean }).__gateReady === true
  );
  await page.click("#start");
  await page.waitForFunction(
    () => (window as { __gateDone?: boolean }).__gateDone === true,
    null,
    {
      timeout: 600_000,
    }
  );
  const result = await page.evaluate(
    () => (window as { __gateResult?: unknown }).__gateResult
  );
  console.log(`[${browserName}] ${JSON.stringify(cmp.information(result))}`);
  expect(cmp.compare(table, browserName, result)).toEqual([]);
});
