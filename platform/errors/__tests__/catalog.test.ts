/**
 * ADR-051 D5 (a): the registry and the catalog agree; every message is valid ICU whose
 * arguments are declared params.
 */
import { IntlMessageFormat } from "intl-messageformat";
import {
  ERROR_CODES,
  PLATFORM_ERROR_CODES,
  isAppErrorCode,
  messageKey,
  type ErrorCode,
  type ErrorCodeSpec,
} from "@/platform/errors/registry";
import {
  CATALOGS,
  DEFAULT_LOCALE,
  catalogKeys,
  lookup,
  mergeCatalogs,
  renderMessage,
} from "@/platform/errors/messages";
import appEn from "@/messages/app/en.json";

const en = CATALOGS[DEFAULT_LOCALE];
const codes = Object.keys(ERROR_CODES) as ErrorCode[];

/** ICU argument names used by a message (argument, number, date, time, select, plural). */
function argumentsOf(message: string): Set<string> {
  const names = new Set<string>();
  const walk = (nodes: unknown[]): void => {
    for (const n of nodes as Array<Record<string, unknown>>) {
      if (typeof n.value === "string" && [1, 2, 3, 4, 5, 6].includes(n.type as number)) {
        names.add(n.value);
      }
      for (const opt of Object.values(
        (n.options as Record<string, { value: unknown[] }>) ?? {}
      )) {
        walk(opt.value);
      }
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(new IntlMessageFormat(message, "en").getAst() as unknown[]);
  return names;
}

function sample(spec: ErrorCodeSpec): Record<string, string | number | string[]> {
  const v: Record<string, string | number | string[]> = {};
  for (const p of spec.params)
    v[p.name] = p.kind === "number" ? 3 : p.kind === "list" ? ["a", "b"] : "x";
  return v;
}

describe("error registry ↔ catalog (ADR-051)", () => {
  it("has codes", () => {
    expect(codes.length).toBeGreaterThanOrEqual(39);
  });

  it.each(codes)("%s has an English message", (code) => {
    expect(lookup(en, messageKey(code))).toEqual(expect.any(String));
  });

  it("every errors.* catalog key is a registered code", () => {
    const orphans = catalogKeys(en)
      .filter((k) => k.startsWith("errors."))
      .map((k) => k.slice("errors.".length))
      .filter((c) => !(c in ERROR_CODES));
    expect(orphans).toEqual([]);
  });

  it.each(codes)(
    "%s — message arguments are declared params; non-id params appear",
    (code) => {
      const spec: ErrorCodeSpec = ERROR_CODES[code];
      const used = argumentsOf(lookup(en, messageKey(code)) as string);
      const declared = new Set(spec.params.map((p) => p.name));
      expect([...used].filter((a) => !declared.has(a))).toEqual([]);
      const missing = spec.params.filter(
        (p) => p.kind !== "id" && !p.optional && !used.has(p.name)
      );
      expect(missing.map((p) => p.name)).toEqual([]);
    }
  );

  it.each(codes)("%s renders with sample params", (code) => {
    const out = renderMessage(messageKey(code), sample(ERROR_CODES[code]));
    expect(out).not.toBe(messageKey(code));
    expect(out).not.toMatch(/[{}]/);
  });

  it.each(codes)("%s has a plausible status and a caller action", (code) => {
    const spec: ErrorCodeSpec = ERROR_CODES[code];
    expect(spec.status).toBeGreaterThanOrEqual(400);
    expect(spec.status).toBeLessThan(600);
    expect(spec.action.length).toBeGreaterThan(0);
    expect(code).toMatch(
      isAppErrorCode(code) ? /^app\.[a-z_]+\.[a-z_]+$/ : /^[a-z]+\.[a-z_]+$/
    );
  });

  it("every locale has exactly English's keys", () => {
    const want = catalogKeys(en);
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      expect({ locale, keys: catalogKeys(catalog) }).toEqual({ locale, keys: want });
    }
  });
});

describe("app codes and messages (ADR-051 D1 — consumer-owned)", () => {
  it("no platform code is in the app namespace", () => {
    expect(Object.keys(PLATFORM_ERROR_CODES).filter(isAppErrorCode)).toEqual([]);
  });

  it("the app catalog uses only errors.app and screens.app", () => {
    const outside = catalogKeys(appEn).filter(
      (k) => !k.startsWith("errors.app.") && !k.startsWith("screens.app.")
    );
    expect(outside).toEqual([]);
  });

  it("merges an app catalog under the platform's", () => {
    const merged = mergeCatalogs(
      { errors: { auth: { required: "Sign in." } } },
      { errors: { app: { files: { too_large: "Too large." } } } }
    );
    expect(lookup(merged, "errors.auth.required")).toBe("Sign in.");
    expect(lookup(merged, "errors.app.files.too_large")).toBe("Too large.");
  });

  it("refuses an app key outside its namespaces", () => {
    expect(() => mergeCatalogs({}, { errors: { auth: { required: "x" } } })).toThrow(
      /outside errors\.app/
    );
  });

  it("refuses an app key the platform already defines", () => {
    expect(() =>
      mergeCatalogs(
        { errors: { app: { a: { b: "platform" } } } },
        { errors: { app: { a: { b: "app" } } } }
      )
    ).toThrow(/already defined by the platform: errors\.app\.a\.b/);
  });
});
