/**
 * __tests__/retention-stores.test.ts — every store outside the tables keeps what it holds for a
 * bounded time (TASK-215, the S4 retention sweep by store: B-13, B-14)
 *
 * @guard a cache backend that keeps an entry for good, or a store with no retention statement
 * @guard a provider, a store or a browser storage the code can select or write, with no retention
 *
 * The tables' retention is RETENTION_REGISTER's (retention-coverage.db.test.ts). The sweep by
 * store found the cache took a missing, zero or negative TTL — or CACHE_DEFAULT_TTL=0 — as "keep
 * for good"; every backend now bounds each entry (platform/cache/ttl.ts). Here: the bound's rules,
 * the in-memory backend expiring an entry asked to live for ever, each backend's source taking its
 * TTL through the bound, and RETENTION_STORES stating each store's retention. Every store the code
 * can reach is found in the code — each setting that selects a provider or a store, and each file
 * that writes the browser's storage — and must name its RETENTION_STORES entry
 * (RETENTION_STORE_SOURCES) or, an app's own, its manifest's `retentionStores`: a new store has no
 * retention until it is stated (hostile: a planted provider setting and a planted browser write).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  CACHE_DEFAULT_TTL_SECONDS,
  CACHE_MAX_TTL_SECONDS,
  boundedDefaultTtl,
  boundedTtl,
} from "@/platform/cache/ttl";
import { InMemoryCacheProvider } from "@/platform/cache/memory-cache";
import { RETENTION_STORE_SOURCES, RETENTION_STORES } from "@/platform/jobs/retention";

const mm = require("../scripts/module-manifest.cjs") as {
  loadManifest: () => { retentionStores?: Record<string, string> };
};

const ROOT = join(__dirname, "..");

/** Where the code that runs against a deployment lives. */
const SOURCE_DIRS = ["app", "components", "lib", "platform", "modules"];

/** Names that look like a selector setting and are not one, with why. */
const NOT_A_STORE: Readonly<Record<string, string>> = {
  EXTERNAL_PROVIDER:
    "an identity pool's user status (platform/auth/identity-relink.ts), not a setting",
};

/** Files that name a store without using it, with why. */
const NOT_A_STORE_FILE: Readonly<Record<string, string>> = {
  "platform/jobs/retention.ts":
    "the register itself: its statements name the browser's storage",
};

const SELECTOR =
  /envVar:\s*"([A-Z][A-Z0-9_]*)"|(?:["'`]|process\.env\.)([A-Z][A-Z0-9_]*_(?:PROVIDER|STORE|LEDGER|REPORTER|CONVERTER))\b/g;
const BROWSER_STORAGE =
  /\b(?:localStorage|sessionStorage|indexedDB)\b|\bdocument\.cookie\b|\bcookies\.set\(/;

/** The source without its comments (a `//` after a `:` — a URL in a string — is kept). */
export function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every selector setting and every browser-storage writer in the given sources. */
export function storeSources(
  sources: readonly { file: string; text: string }[]
): string[] {
  const found = new Set<string>();
  for (const { file, text } of sources) {
    for (const m of withoutComments(text).matchAll(SELECTOR)) {
      const name = m[1] ?? m[2];
      if (name && !(name in NOT_A_STORE)) found.add(name);
    }
    if (!(file in NOT_A_STORE_FILE) && BROWSER_STORAGE.test(withoutComments(text)))
      found.add(file);
  }
  return [...found].sort();
}

/** The sources found with no statement of their retention. */
export function unstatedStores(
  found: readonly string[],
  sources: Readonly<Record<string, string>>,
  app: Readonly<Record<string, string>>,
  stores: Readonly<Record<string, string>>
): string[] {
  return found.filter(
    (f) => !(f in app) && !(sources[f] !== undefined && sources[f] in stores)
  );
}

function sourceFiles(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "node_modules" || name === "__tests__" || name.startsWith("."))
        continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(?:ts|tsx)$/.test(name) && !/\.(?:test|spec)\.tsx?$/.test(name))
        out.push({
          file: relative(ROOT, full).split(sep).join("/"),
          text: readFileSync(full, "utf8"),
        });
    }
  };
  for (const d of SOURCE_DIRS) walk(join(ROOT, d));
  return out;
}

/** The backends' sources that take an entry's TTL without the bound. */
export function unboundedBackends(
  sources: readonly { file: string; text: string }[]
): string[] {
  return sources
    .filter(
      ({ text }) =>
        /ttlSeconds\s*\?\?|defaultTTLSeconds\s*\?\?\s*\d|ttl\s*<=\s*0\)\s*return null/.test(
          text
        ) || !/boundedTtl\(/.test(text)
    )
    .map(({ file }) => file)
    .sort();
}

describe("every store's entries expire (TASK-215, S4 by store)", () => {
  it("a missing, zero, negative or non-numeric TTL is the default; none is over seven days", () => {
    for (const asked of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY])
      expect([asked, boundedTtl(asked, 600)]).toEqual([asked, 600]);
    expect(boundedTtl(30, 600)).toBe(30);
    expect(boundedTtl(10 * CACHE_MAX_TTL_SECONDS, 600)).toBe(CACHE_MAX_TTL_SECONDS);
    expect(boundedDefaultTtl(0)).toBe(CACHE_DEFAULT_TTL_SECONDS);
    expect(boundedDefaultTtl(undefined)).toBe(CACHE_DEFAULT_TTL_SECONDS);
    expect(boundedDefaultTtl(1e9)).toBe(CACHE_MAX_TTL_SECONDS);
    expect(boundedTtl(undefined, 0)).toBe(CACHE_DEFAULT_TTL_SECONDS);
  });

  it("an entry asked to live for ever expires (in-memory backend, default 0)", async () => {
    jest.useFakeTimers({ now: new Date("2026-11-13T00:00:00Z") });
    try {
      const cache = new InMemoryCacheProvider({
        namespace: "t215",
        defaultTTLSeconds: 0,
      });
      await cache.set("forever", "what a person wrote", { ttlSeconds: 0 });
      await cache.set("unset", "an AI answer");
      expect(await cache.get("forever")).toBe("what a person wrote");
      jest.setSystemTime(new Date(Date.now() + (CACHE_DEFAULT_TTL_SECONDS + 1) * 1000));
      expect(await cache.get("forever")).toBeNull();
      expect(await cache.get("unset")).toBeNull();
      await cache.set("long", "x", { ttlSeconds: 10 * CACHE_MAX_TTL_SECONDS });
      jest.setSystemTime(new Date(Date.now() + (CACHE_MAX_TTL_SECONDS + 1) * 1000));
      expect(await cache.get("long")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("every cache backend takes its TTL through the bound", () => {
    const sources = ["memory-cache.ts", "valkey-cache.ts", "redis-cache.ts"].map((f) => ({
      file: f,
      text: readFileSync(join(ROOT, "platform/cache", f), "utf8"),
    }));
    expect(unboundedBackends(sources)).toEqual([]);
  });

  it("[self-test] a backend that keeps a missing TTL for good is reported", () => {
    expect(
      unboundedBackends([
        {
          file: "a.ts",
          text: "const ttl = options?.ttlSeconds ?? this.defaultTTLSeconds; if (ttl > 0) args.push('EX', ttl);",
        },
        {
          file: "b.ts",
          text: "const ttl = boundedTtl(options?.ttlSeconds, this.defaultTTLSeconds);",
        },
      ])
    ).toEqual(["a.ts"]);
  });

  it("every store outside the tables states its retention", () => {
    for (const [store, rule] of Object.entries(RETENTION_STORES))
      expect([store, rule.length > 30]).toEqual([store, true]);
    for (const [source, store] of Object.entries(RETENTION_STORE_SOURCES))
      expect([source, store in RETENTION_STORES]).toEqual([source, true]);
  });

  it("every provider, store and browser storage the code can select or write names its retention", () => {
    const found = storeSources(sourceFiles());
    // The scan sees the code: the selectors every deployment sets, and the browser's storage.
    expect(found).toEqual(
      expect.arrayContaining(["AUTH_PROVIDER", "CACHE_PROVIDER", "RATE_LIMIT_STORE"])
    );
    expect(
      unstatedStores(
        found,
        RETENTION_STORE_SOURCES,
        mm.loadManifest().retentionStores ?? {},
        RETENTION_STORES
      )
    ).toEqual([]);
    // And no entry names a file or a setting the code no longer has (a register that only grows
    // stops saying what is stored: ADR-057 moved the session out of the page's storage).
    expect(
      Object.keys(RETENTION_STORE_SOURCES).filter((k) => !found.includes(k))
    ).toEqual([]);
  });

  it("[self-test] a new provider setting, a module slot and a browser write are found; a comment and a status are not", () => {
    const found = storeSources([
      { file: "a.ts", text: 'const p = process.env.FAX_PROVIDER ?? "none";' },
      { file: "b.ts", text: '{ slot: "pager", envVar: "PAGER" }' },
      { file: "c.tsx", text: 'window.localStorage.setItem("draft", text);' },
      { file: "d.ts", text: "// kept in localStorage with the scope, never here" },
      { file: "e.ts", text: 'const s = new Set(["CONFIRMED", "EXTERNAL_PROVIDER"]);' },
      { file: "f.ts", text: 'document.cookie = "x=1";' },
      { file: "g.ts", text: "const s = window.sessionStorage;\ns.setItem(k, v);" },
      { file: "h.ts", text: 'response.cookies.set("pf_x", v, { httpOnly: true });' },
      {
        file: "i.ts",
        text: '/* localStorage once held it */ const u = "https://x.test//a";',
      },
    ]);
    expect(found).toEqual(["FAX_PROVIDER", "PAGER", "c.tsx", "f.ts", "g.ts", "h.ts"]);
  });

  it("[hostile] a store added with no retention fails until it is stated", () => {
    const found = ["CACHE_PROVIDER", "FAX_PROVIDER", "lib/draft.tsx"];
    expect(unstatedStores(found, RETENTION_STORE_SOURCES, {}, RETENTION_STORES)).toEqual([
      "FAX_PROVIDER",
      "lib/draft.tsx",
    ]);
    // Named, but to an entry that does not exist: still unstated.
    expect(
      unstatedStores(
        ["FAX_PROVIDER"],
        { FAX_PROVIDER: "a fax line" },
        {},
        RETENTION_STORES
      )
    ).toEqual(["FAX_PROVIDER"]);
    // An app states its own in its manifest.
    expect(
      unstatedStores(
        found,
        RETENTION_STORE_SOURCES,
        {
          FAX_PROVIDER: "faxes are kept by the line for a day",
          "lib/draft.tsx": "a draft until it is sent",
        },
        RETENTION_STORES
      )
    ).toEqual([]);
  });
});
