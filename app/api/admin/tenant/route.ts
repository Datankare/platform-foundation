/**
 * app/api/admin/tenant/route.ts — this tenant, for its own administrators (ADR-053 D5)
 *
 * GET → the tenant's name, state and addresses; today's spend against its daily agent budget;
 * and the settings its administrators may set for it (each with the platform default and
 * whether the tenant has its own value). Changing one goes through PUT /api/admin/config, which
 * in a shared deployment sets the tenant's own value.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { internalError } from "@/platform/errors";
import { withTenantTx } from "@/platform/data";
import { currentTenant } from "@/platform/tenancy/context";
import { listEnhancedConfig } from "@/platform/auth/platform-config";
import { getBudgetTracker } from "@/platform/agents/budget-tracker";
import { tenantRoute } from "@/platform/tenancy/route";

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const guard = await requireAdmin(request, "can_access_admin");
  if (guard.error) return guard.error;
  try {
    const ctx = currentTenant();
    // The tenant's own record, read in its own transaction: the directory's cache holds what
    // request resolution needs (its state), not its name — another tenant's name is never
    // readable here, and this tenant's is read fresh.
    const [own, domains, budget, settings] = await Promise.all([
      withTenantTx((tx) =>
        tx.query<{ slug: string | null; name: string | null; status: string }>(
          "select slug, name, status from public.directory_tenant($1::uuid)",
          [ctx.tenantId]
        )
      ),
      withTenantTx((tx) =>
        tx.query<{ host: string; created_at: Date }>(
          "select host, created_at from public.tenant_own_domains()"
        )
      ),
      getBudgetTracker().getTenantStatus(),
      listEnhancedConfig(),
    ]);
    const tenant = own.rows[0];
    return NextResponse.json({
      tenant: {
        id: ctx.tenantId,
        mode: ctx.mode,
        slug: tenant?.slug ?? null,
        name: tenant?.name ?? null,
        status: tenant?.status ?? "active",
      },
      domains: domains.rows.map((d) => ({
        host: d.host,
        createdAt: d.created_at.toISOString(),
      })),
      budget,
      // A single deployment's administrators govern every setting (the config page); here the
      // ones a tenant may set for itself.
      settings: settings
        .filter((e) => e.tenantOverridable)
        .map((e) => ({
          key: e.key,
          description: e.description,
          value: e.value,
          platformValue: e.platformValue,
          overridden: e.overridden,
          valueType: e.valueType,
          minValue: e.minValue,
          maxValue: e.maxValue,
          allowedValues: e.allowedValues,
          permissionTier: e.permissionTier,
        })),
    });
  } catch (error) {
    return internalError(error, { request, context: "Tenant settings read failed" });
  }
});
