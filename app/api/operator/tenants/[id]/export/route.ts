/**
 * app/api/operator/tenants/[id]/export/route.ts — every row a tenant owns (operators only,
 * ADR-053 D7), as newline-delimited JSON streamed from one consistent snapshot.
 *
 * GET → application/x-ndjson: first { "export": { format, tenant, domains, at } }, then one
 * { "table": …, "row": … } per row, then { "done": true, "rows": n }. Recorded in the audit log
 * before the first line. A failure part-way ends the stream with a final
 * { "error": "export_failed" } line, so a truncated export is never mistaken for a whole one.
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { internalError } from "@/platform/errors";
import { logger } from "@/lib/logger";
import { getTenantDirectory } from "@/platform/tenancy/directory";
import { exportTenantData } from "@/platform/tenancy/admin";
import { operatorError, operatorOf } from "@/platform/tenancy/operator-http";
import { tenantRoute } from "@/platform/tenancy/route";

export const GET = tenantRoute(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id } = await params;
  try {
    const tenant = await getTenantDirectory().getTenant(id);
    if (!tenant) return operatorError("tenant.not_found", "No such tenant.", request);
  } catch (error) {
    return internalError(error, { request, context: "Tenant export failed" });
  }

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const write = async (chunk: string) => {
    await writer.ready;
    await writer.write(encoder.encode(chunk));
  };
  void (async () => {
    try {
      const result = await exportTenantData(operatorOf(guard.admin), id, write);
      if (!result.ok) await write(JSON.stringify({ error: result.code }) + "\n");
      else await write(JSON.stringify({ done: true, rows: result.value }) + "\n");
    } catch (error) {
      logger.error("Tenant export failed part-way", {
        tenantId: id,
        error: error instanceof Error ? error.message : String(error),
        route: "api/operator/tenants/[id]/export",
      });
      await write(JSON.stringify({ error: "export_failed" }) + "\n").catch(
        () => undefined
      );
    } finally {
      await writer.close().catch(() => undefined);
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="tenant-${exportFileId(id)}.ndjson"`,
      "Cache-Control": "no-store",
    },
  });
});

/** The id in a file name: a UUID (the directory found it), reduced to safe characters anyway. */
function exportFileId(id: string): string {
  return id.replace(/[^0-9a-f-]/gi, "");
}
