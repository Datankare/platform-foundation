/**
 * platform/errors/definitions.ts — a setting's description and a permission's name and
 * description, from the catalog (TASK-209, N-113; ADR-051 D4)
 *
 * The migrations that create a setting or a permission write its words in English
 * (platform_config.description; permissions.display_name and description): the definitional
 * record, read by the configuration assistant (the model) and matched by the admin search. A
 * screen or an answer a screen shows never shows that text: it shows the catalog's, by the
 * setting's key or the permission's code — `screens.settings.<key>` and
 * `screens.permissions.<code>.name|description` (the platform's, messages/en.json), or an app's
 * own under `screens.app.settings.<key>` and `screens.app.permissions.<code>` (its
 * messages/app/en.json) — an app's own setting, or a platform setting the app words itself (its
 * migrations describe it as the app runs it), which comes first.
 * scripts/catalog-definitions-check.mjs (run by the migration replay) fails on a setting or a
 * permission the migrations define without its entry in every locale, and on an entry naming none.
 *
 * @module platform/errors
 */

import { CATALOGS, DEFAULT_LOCALE, lookup, type Catalog } from "./messages";
import { renderShown, type ShownKey, type ShownText } from "./shown-text";

/**
 * The catalog's key for a setting's description, if any: the app's own, where it words the setting
 * itself (its migrations describe a platform setting as the app runs it), else the platform's.
 */
export function settingDescriptionKey(key: string): ShownKey | undefined {
  for (const k of [`screens.app.settings.${key}`, `screens.settings.${key}`] as const)
    if (lookup(CATALOGS[DEFAULT_LOCALE], k) !== undefined) return k;
  return undefined;
}

/** A setting's description as a screen shows it: the catalog's key (none when it has none). */
export function settingDescription(key: string): ShownText | null {
  const k = settingDescriptionKey(key);
  return k ? { key: k } : null;
}

/** The catalog's key for a permission's name or description, if any (the app's first, as above). */
export function permissionKey(
  code: string,
  part: "name" | "description"
): ShownKey | undefined {
  for (const k of [
    `screens.app.permissions.${code}.${part}`,
    `screens.permissions.${code}.${part}`,
  ] as const)
    if (lookup(CATALOGS[DEFAULT_LOCALE], k) !== undefined) return k;
  return undefined;
}

/** A permission's name as a screen shows it: the catalog's key, else its code as data. */
export function permissionName(code: string): ShownText | string {
  const k = permissionKey(code, "name");
  return k ? { key: k } : code;
}

/** A permission's name in words, in `locale` (to sort a list by what a reader sees). */
export function permissionNameText(code: string, locale?: string): string {
  const name = permissionName(code);
  return typeof name === "string" ? name : renderShown(name, locale);
}

/**
 * Every permission the catalog names, code to its name in `locale`: what a statement orders the
 * permissions by where a screen shows them (platform/auth/catalog-order.ts permissionOrderSql).
 */
export function permissionNamesByCode(locale?: string): Record<string, string> {
  const out: Record<string, string> = {};
  const screens = CATALOGS[DEFAULT_LOCALE].screens as Catalog | undefined;
  const app = screens?.app as Catalog | undefined;
  for (const entries of [screens?.permissions, app?.permissions])
    if (entries && typeof entries === "object")
      for (const code of Object.keys(entries))
        out[code] = permissionNameText(code, locale);
  return out;
}
