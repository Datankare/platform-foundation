/**
 * platform/realtime/tenant-topic.ts — every channel belongs to one tenant (ADR-053 D6, TASK-114)
 *
 * A channel name is the application's ("room:lobby", "stream:<session>"); the topic the provider
 * joins is that name inside the current tenant: `t:<tenantId>:<name>`. Two tenants using the same
 * channel name are on two topics, so a message never reaches another tenant's subscribers.
 *
 * The prefix alone is not access control — anyone holding the public key could name another
 * tenant's topic. On Supabase the channels are private (authorised by row-level security on
 * realtime.messages, migration 049): a browser may join only topics of the tenant its token
 * names. The server broadcasts with its own credentials.
 *
 * @module platform/realtime
 */

import { currentTenantId } from "@/platform/tenancy/context";
import { memoryPartition } from "@/platform/tenancy/partition";

const NAME = /^[\w:.\-]{1,200}$/;

function checked(name: string): string {
  if (!NAME.test(name)) throw new Error(`Invalid channel name: ${JSON.stringify(name)}`);
  return name;
}

/** The current tenant's topic for `name`. Throws outside a tenant (fail closed). */
export function tenantTopic(name: string): string {
  return `t:${currentTenantId()}:${checked(name)}`;
}

/** As tenantTopic, but outside a tenant the in-memory "no tenant" partition (mock provider). */
export function memoryTopic(name: string): string {
  return `t:${memoryPartition()}:${checked(name)}`;
}
