/**
 * platform/errors/messages.ts — Catalog lookup and ICU rendering (ADR-051 D1–D3)
 *
 * The catalog files live in messages/<locale>.json (nested objects; a key `errors.auth.required`
 * is `{ errors: { auth: { required } } }`). English is the source of truth and the fallback.
 * Rendering uses intl-messageformat — the ICU engine next-intl builds on — so the same catalog
 * serves the screens in Sprint 7B.
 *
 * @module platform/errors
 */

import { IntlMessageFormat } from "intl-messageformat";
import en from "@/messages/en.json";

export type Catalog = Readonly<Record<string, unknown>>;

export const DEFAULT_LOCALE = "en";

/** Locales with a catalog. Adding one is a product decision (ADR-051 D6). */
export const CATALOGS: Readonly<Record<string, Catalog>> = { en };

export function availableLocales(): string[] {
  return Object.keys(CATALOGS);
}

/** A message by dotted key, or undefined. */
export function lookup(catalog: Catalog, key: string): string | undefined {
  let node: unknown = catalog;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** Every dotted key in a catalog, sorted. */
export function catalogKeys(catalog: Catalog, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(catalog)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push(key);
    else if (v && typeof v === "object") out.push(...catalogKeys(v as Catalog, key));
  }
  return out.sort();
}

/**
 * The best available locale for an Accept-Language header: the first listed language (exact tag,
 * then its base language) that has a catalog; otherwise English.
 */
export function negotiateLocale(acceptLanguage: string | null | undefined): string {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const wanted = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, ...rest] = part.trim().split(";");
      const q = rest.find((r) => r.trim().startsWith("q="));
      return { tag: tag.trim().toLowerCase(), q: q ? Number(q.trim().slice(2)) : 1 };
    })
    .filter((w) => w.tag && w.tag !== "*" && Number.isFinite(w.q) && w.q > 0)
    .sort((a, b) => b.q - a.q);
  const available = availableLocales();
  for (const { tag } of wanted) {
    const exact = available.find((l) => l.toLowerCase() === tag);
    if (exact) return exact;
    const base = available.find((l) => l.toLowerCase() === tag.split("-")[0]);
    if (base) return base;
  }
  return DEFAULT_LOCALE;
}

export type MessageValues = Readonly<Record<string, string | number | readonly string[]>>;

/**
 * Render a catalog message. Lists are formatted with the locale's list style before ICU sees
 * them. Falls back to English, then to the key itself — rendering an error must never throw.
 */
export function renderMessage(
  key: string,
  values: MessageValues = {},
  locale = DEFAULT_LOCALE
): string {
  const loc = CATALOGS[locale] ? locale : DEFAULT_LOCALE;
  const source = lookup(CATALOGS[loc], key) ?? lookup(CATALOGS[DEFAULT_LOCALE], key);
  if (source === undefined) return key;
  const prepared: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(values)) {
    prepared[name] = Array.isArray(value)
      ? new Intl.ListFormat(loc, { style: "long", type: "conjunction" }).format(value)
      : (value as string | number);
  }
  try {
    return String(new IntlMessageFormat(source, loc).format(prepared));
  } catch {
    return source;
  }
}
