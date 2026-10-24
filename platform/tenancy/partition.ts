/**
 * platform/tenancy/partition.ts — tenant partitions for in-memory stores (ADR-053 D6, D8)
 *
 * In-memory stores (tests, local runs; production refuses them) keep each tenant's records
 * apart the way row-level security does for the Postgres ones, so code exercised in memory
 * behaves as it will in production — the isolation kit runs against both.
 *
 * Outside any tenant, records go to a separate "no tenant" partition rather than throwing:
 * unit tests of a single store call it directly, and no deployment reaches it (the route check
 * puts every request in a tenant scope, and production stores are the Postgres ones, which
 * refuse work with no tenant).
 *
 * @module platform/tenancy
 */

import { peekTenant } from "./context";

/** Partition name used when there is no tenant. Never a tenant id (not a UUID). */
export const NO_TENANT_PARTITION = "-";

/** The current tenant's partition name. */
export function memoryPartition(): string {
  return peekTenant()?.tenantId ?? NO_TENANT_PARTITION;
}

/** A map of maps: one inner map per tenant, created on first use. */
export class TenantPartitionedMap<K, V> {
  private readonly parts = new Map<string, Map<K, V>>();

  /** The current tenant's map. */
  current(): Map<K, V> {
    const name = memoryPartition();
    let part = this.parts.get(name);
    if (!part) {
      part = new Map<K, V>();
      this.parts.set(name, part);
    }
    return part;
  }

  /** Forget every tenant's records (tests). */
  clearAll(): void {
    this.parts.clear();
  }
}
