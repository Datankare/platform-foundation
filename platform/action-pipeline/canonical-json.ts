/**
 * platform/action-pipeline/canonical-json.ts — canonical JSON text for comparing values (PF v5.1.0)
 *
 * @module platform/action-pipeline
 */

/**
 * JSON with object keys sorted at every depth, so equal values compare equal as text. The value
 * is first taken through JSON itself (toJSON, dropped undefined, NaN to null), so the comparison
 * is of what a durable store keeps — two Dates differ by their time, not both become `{}`.
 */
export function canonicalJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return "undefined";
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])])
      );
    }
    return v;
  };
  return JSON.stringify(sort(JSON.parse(text)));
}
