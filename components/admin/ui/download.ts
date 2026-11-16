/**
 * components/admin/ui/download.ts — a file an admin screen fetches and saves, with what became of
 * it (TASK-221, SF-admin-116)
 *
 * A tenant's export was a plain download link: no sign that anything was happening, and a refusal
 * arrived as a JSON file or a raw page saved under the export's name. Here the file is fetched
 * through the one call path (apiFetch: the cookie session, ADR-057), so the screen can say it is
 * working and what came of it:
 *
 *   { ok: true,  filename, bytes, tail }   the file, saved by the browser under the name the
 *                                         route gave it; `tail` is its last characters, for a
 *                                         caller that checks the file ended as it should;
 *   { ok: false, refusal }                 the refusal the shared handler decides, or
 *                                         networkRefusal() when no answer came — nothing saved;
 *                                         or, when the caller's `whole` says the file did not end
 *                                         as a whole one does (a stream that failed part-way),
 *                                         the caller's `incomplete` refusal — nothing saved, so
 *                                         a part is never kept as if it were the whole.
 *
 * It never throws.
 *
 * @module components/admin/ui
 */

import { apiFetch } from "@/platform/auth/api-fetch";
import { networkRefusal, type Refusal } from "@/platform/errors/refusal";
import { refusalFrom, type CallBody } from "./admin-call";

export type DownloadResult =
  | {
      readonly ok: true;
      readonly filename: string;
      readonly bytes: number;
      /** The file's last characters (up to 512 bytes): how it ended. */
      readonly tail: string;
    }
  | { readonly ok: false; readonly refusal: Refusal };

/** The file name a Content-Disposition header gives, else `fallback`. */
export function fileNameOf(disposition: string | null, fallback: string): string {
  const m = /filename="([^"]+)"/.exec(disposition ?? "");
  return m?.[1] ?? fallback;
}

/** Hand `blob` to the browser to save as `filename` (nothing, where there is no browser). */
function save(blob: Blob, filename: string): void {
  if (typeof URL.createObjectURL !== "function") return;
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}

/** A blob's text (a browser without Blob.text reads it through a FileReader). */
function textOf(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => resolve("");
    reader.readAsText(blob);
  });
}

export async function adminDownload(
  url: string,
  fallbackName: string,
  check: {
    /** Whether the file's last characters are those of a whole file. */
    readonly whole?: (tail: string) => boolean;
    /** What to say when it is not. */
    readonly incomplete?: Refusal;
  } = {}
): Promise<DownloadResult> {
  let res: Response;
  try {
    res = await apiFetch(url, { method: "GET" });
  } catch {
    return { ok: false, refusal: networkRefusal() };
  }
  if (!res.ok) {
    let body: CallBody = {};
    try {
      const parsed = (await res.json()) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        body = parsed as CallBody;
    } catch {
      // No body, or not JSON: the status alone decides.
    }
    return { ok: false, refusal: refusalFrom(res.status, body) };
  }
  let blob: Blob;
  try {
    blob = await res.blob();
  } catch {
    // The answer stopped before it was whole.
    return { ok: false, refusal: networkRefusal() };
  }
  const filename = fileNameOf(res.headers.get("content-disposition"), fallbackName);
  const tail = await textOf(blob.slice(Math.max(0, blob.size - 512)));
  if (check.whole && !check.whole(tail))
    return { ok: false, refusal: check.incomplete ?? networkRefusal() };
  save(blob, filename);
  return { ok: true, filename, bytes: blob.size, tail };
}
