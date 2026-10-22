/**
 * app/api/admin/ai/handlers/agents.ts — trusted-agent registry action handlers (Sprint 3c U4).
 *
 * GenAI-native governance admin (ADR-035): vocabulary-free operations on the
 * agent.trusted_agents config store. No specific agent ids or capability names are baked in —
 * a handler mutates whatever the store contains. The store is a json_array of
 * [agentId, {owner, scopes[], status, maxTokenTtl}] pairs; handlers read it, apply one change,
 * and write it back through writeGovernedConfig — the key's tier permission, validation,
 * history, two-person approval and dual control, the same as the config page (audit X-7).
 */

import { getConfig } from "@/platform/auth/platform-config";
import { writeGovernedConfig } from "@/platform/admin/governed-config";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";
import { fromGovernedConfig, type ActionResult } from "./shared";

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
  admin: VerifiedAdmin,
  summary: string
): Promise<ActionResult> {
  const outcome = await writeGovernedConfig(admin, {
    key: TRUSTED_AGENTS_KEY,
    value: pairs,
    changeComment: `Command bar: ${summary}`,
  });
  return fromGovernedConfig(outcome, TRUSTED_AGENTS_KEY, summary);
}

/** Register a new trusted agent, or fail if it already exists. */
export async function handleRegisterAgent(
  input: Record<string, any>,
  admin: VerifiedAdmin
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
  return writeRegistry(pairs, admin, `Registered agent ${agentId}`);
}

/** Suspend or reactivate an agent. */
export async function handleSuspendAgent(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult> {
  const agentId: string = input.agent_id;
  const reactivate: boolean = input.reactivate === true;
  const pairs = await readRegistry();
  const entry = pairs.find(([id]) => id === agentId);
  if (!entry) return { success: false, error: `Agent "${agentId}" is not registered` };
  entry[1].status = reactivate ? "active" : "suspended";
  return writeRegistry(
    pairs,
    admin,
    `${reactivate ? "Reactivated" : "Suspended"} agent ${agentId}`
  );
}

/** Replace an agent's scope set. */
export async function handleSetAgentScope(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult> {
  const agentId: string = input.agent_id;
  const scopes: string[] = Array.isArray(input.scopes) ? input.scopes : [];
  const pairs = await readRegistry();
  const entry = pairs.find(([id]) => id === agentId);
  if (!entry) return { success: false, error: `Agent "${agentId}" is not registered` };
  entry[1].scopes = scopes;
  return writeRegistry(pairs, admin, `Set scope of ${agentId} to [${scopes.join(", ")}]`);
}

/** Set an agent's per-agent token-TTL ceiling (seconds). */
export async function handleSetAgentTtl(
  input: Record<string, any>,
  admin: VerifiedAdmin
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
  return writeRegistry(pairs, admin, `Set token ceiling of ${agentId} to ${ttl}s`);
}
