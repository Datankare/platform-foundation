/**
 * app/api/admin/ai/handlers/agents.ts — trusted-agent registry action handlers (Sprint 3c U4).
 *
 * GenAI-native governance admin (ADR-035): vocabulary-free operations on the
 * agent.trusted_agents config store. No specific agent ids or capability names are baked in —
 * a handler mutates whatever the store contains. The store is a json_array of
 * [agentId, {owner, scopes[], status, maxTokenTtl}] pairs; handlers read it, apply one change,
 * and write it back through the governed config path (history + two-person approval at the
 * config layer for the safety tier).
 */

import { getConfig, setConfig } from "@/platform/auth/platform-config";
import { writeAuditLog } from "@/platform/auth/audit";
import type { ActionResult } from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

const TRUSTED_AGENTS_KEY = "agent.trusted_agents";

interface TrustedAgentRecord {
  owner: string;
  scopes: string[];
  status: "active" | "suspended";
  maxTokenTtl?: number;
}

/** Read the registry as an ordered list of [id, record] pairs (json_array shape). */
async function readRegistry(): Promise<[string, TrustedAgentRecord][]> {
  const pairs = await getConfig<[string, TrustedAgentRecord][]>(TRUSTED_AGENTS_KEY, []);
  return Array.isArray(pairs) ? pairs : [];
}

async function writeRegistry(
  pairs: [string, TrustedAgentRecord][],
  actorId: string,
  summary: string
): Promise<ActionResult> {
  try {
    await setConfig(
      TRUSTED_AGENTS_KEY,
      pairs,
      actorId,
      "Trusted-agent registry (governed via admin)",
      "agent"
    );
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  await writeAuditLog({
    action: "admin_action",
    actorId,
    details: { type: "agent_registry", prompt_action: true, summary },
  });
  return { success: true, result: summary };
}

/** Register a new trusted agent, or fail if it already exists. */
export async function handleRegisterAgent(
  input: Record<string, any>,
  actorId: string
): Promise<ActionResult> {
  const agentId: string = input.agent_id;
  if (!agentId) return { success: false, error: "agent_id is required" };
  const pairs = await readRegistry();
  if (pairs.some(([id]) => id === agentId)) {
    return { success: false, error: `Agent "${agentId}" is already registered` };
  }
  const record: TrustedAgentRecord = {
    owner: input.owner || "first-party",
    scopes: Array.isArray(input.scopes) ? input.scopes : [],
    status: "active",
    maxTokenTtl: typeof input.max_token_ttl === "number" ? input.max_token_ttl : 300,
  };
  pairs.push([agentId, record]);
  return writeRegistry(pairs, actorId, `Registered agent ${agentId}`);
}

/** Suspend or reactivate an agent. */
export async function handleSuspendAgent(
  input: Record<string, any>,
  actorId: string
): Promise<ActionResult> {
  const agentId: string = input.agent_id;
  const reactivate: boolean = input.reactivate === true;
  const pairs = await readRegistry();
  const entry = pairs.find(([id]) => id === agentId);
  if (!entry) return { success: false, error: `Agent "${agentId}" is not registered` };
  entry[1].status = reactivate ? "active" : "suspended";
  return writeRegistry(
    pairs,
    actorId,
    `${reactivate ? "Reactivated" : "Suspended"} agent ${agentId}`
  );
}

/** Replace an agent's scope set. */
export async function handleSetAgentScope(
  input: Record<string, any>,
  actorId: string
): Promise<ActionResult> {
  const agentId: string = input.agent_id;
  const scopes: string[] = Array.isArray(input.scopes) ? input.scopes : [];
  const pairs = await readRegistry();
  const entry = pairs.find(([id]) => id === agentId);
  if (!entry) return { success: false, error: `Agent "${agentId}" is not registered` };
  entry[1].scopes = scopes;
  return writeRegistry(
    pairs,
    actorId,
    `Set scope of ${agentId} to [${scopes.join(", ")}]`
  );
}

/** Set an agent's per-agent token-TTL ceiling (seconds). */
export async function handleSetAgentTtl(
  input: Record<string, any>,
  actorId: string
): Promise<ActionResult> {
  const agentId: string = input.agent_id;
  const ttl: number = input.max_token_ttl;
  if (typeof ttl !== "number" || ttl <= 0) {
    return {
      success: false,
      error: "max_token_ttl must be a positive number of seconds",
    };
  }
  const pairs = await readRegistry();
  const entry = pairs.find(([id]) => id === agentId);
  if (!entry) return { success: false, error: `Agent "${agentId}" is not registered` };
  entry[1].maxTokenTtl = ttl;
  return writeRegistry(pairs, actorId, `Set token ceiling of ${agentId} to ${ttl}s`);
}
