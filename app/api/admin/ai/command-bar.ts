/**
 * app/api/admin/ai/command-bar.ts — The command bar's actions, as governed runtime tools, and the
 * authority for the ones held for a second admin (audit X-10, C-14, RR-19)
 *
 * Each confirmed action runs through the governed runtime (invokeTool: trajectory, budget,
 * gating). An action named in the governed list `admin.dual_control_actions` — by default the
 * changes to who holds power: roles, their permissions, a user's role, agents' registration and
 * scope, the approval policy — is raised to `restricted`, so the pipeline holds it: a proposal is
 * minted and the action does not run. Another admin who independently holds the action's own
 * permission approves it (POST /api/admin/approvals/[id], COMMAND_BAR_HOLDS) and it then runs,
 * once, with the requester's authority as it stands at that moment (re-verified: still an admin
 * in good standing, still holding the permission) — or not at all.
 *
 * Before: command-bar actions were declared `consequential`, below the gating line, so none was
 * ever held (C-14); and an approved command-bar hold never ran (RR-19).
 *
 * The role-change page (PATCH /api/admin/users) holds a role change under the same list entry
 * (change_user_role), and the entitlements page (PATCH /api/admin/entitlements) a group turned on
 * or off (set_entitlement_group_active), so neither page is a weaker second path.
 *
 * @module app/api/admin/ai
 */

import { holds, type VerifiedAdmin } from "@/platform/auth/role-governance";
import { verifiedAdminById } from "@/platform/auth/admin-guard";
import { getConfigOrThrow } from "@/platform/auth/platform-config";
import { logger } from "@/lib/logger";
import type { AgentIdentity, Tool } from "@/platform/agents/types";
import type { ProposalRecord } from "@/platform/kernel/types";
import { invokeTool } from "@/platform/agents/tool-invoker";
import { getTrajectoryStore } from "@/platform/agents/trajectory-store";
import { getProposalStore } from "@/platform/agents/proposal-store";
import { PipelineRejectedError, proposeOnce } from "@/platform/action-pipeline";
import {
  resumeFailure,
  type HoldAuthority,
  type HoldResumeResult,
} from "@/platform/admin/hold-authority";
import { ADMIN_TOOL_PERMISSIONS, type AdminToolId } from "./tool-permissions";
import {
  handleCreateRole,
  handleDeleteRole,
  handleDuplicateRole,
  handleAssignPermissions,
  handleChangeUserRole,
  handleCreateEntitlementGroup,
  handleSetEntitlementGroupActive,
  handleUpdatePasswordPolicy,
  handleSearch,
  handleRegisterAgent,
  handleSuspendAgent,
  handleSetAgentScope,
  handleSetAgentTtl,
  handleBlockUserFeature,
  handleUnblockUserFeature,
  handleSetApprovalPolicy,
  handleSetCapabilityMapping,
  type ActionResult,
} from "./handlers";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type { ActionResult };

type Handler = (
  input: Record<string, any>,
  admin: VerifiedAdmin
) => Promise<ActionResult>;

/** Handlers that act only on their input record the verified admin as the actor (TASK-138). */
const asActor =
  (fn: (input: Record<string, any>, actorId: string) => Promise<ActionResult>): Handler =>
  (input, admin) =>
    fn(input, admin.userId);

export const COMMAND_BAR_HANDLERS: Record<AdminToolId, Handler> = {
  create_role: handleCreateRole,
  delete_role: handleDeleteRole,
  duplicate_role: handleDuplicateRole,
  assign_permissions: handleAssignPermissions,
  change_user_role: handleChangeUserRole,
  create_entitlement_group: handleCreateEntitlementGroup,
  set_entitlement_group_active: handleSetEntitlementGroupActive,
  update_password_policy: asActor(handleUpdatePasswordPolicy),
  search: handleSearch,
  register_agent: handleRegisterAgent,
  suspend_agent: handleSuspendAgent,
  set_agent_scope: handleSetAgentScope,
  set_agent_ttl: handleSetAgentTtl,
  block_user_feature: asActor(handleBlockUserFeature),
  unblock_user_feature: asActor(handleUnblockUserFeature),
  set_approval_policy: asActor(handleSetApprovalPolicy),
  set_capability_mapping: handleSetCapabilityMapping,
};

/** The command bar's agent identity; every action is recorded as done for the admin. */
export const COMMAND_BAR_ACTOR_ID = "command-bar";

export function commandBarActor(admin: VerifiedAdmin): AgentIdentity {
  return {
    actorType: "agent",
    actorId: COMMAND_BAR_ACTOR_ID,
    agentRole: "command-bar",
    onBehalfOf: admin.userId,
  };
}

/** The governed list of actions held for a second admin. */
export const DUAL_CONTROL_ACTIONS_KEY = "admin.dual_control_actions";

/**
 * The actions whose effect is a governed config write (writeGovernedConfig), and the keys each
 * writes (review 10 H1, H3). Their one hold is the key's: a write to a dual-controlled key is held
 * by the config writer under the key's own rules — the approver needs the key's tier permission,
 * may not be the requester, must be an operator for a shared deployment's platform default, and
 * the approval lapses — and the command bar reports it held. They are never held as actions, so
 * an action-level approval (cleared under the action's lesser permission) can never stand in for
 * the key's, and no change is held twice. A test fails when a handler writes governed config
 * without an entry here, or an entry is on the action list (__tests__/r10-one-hold.test.ts).
 */
export const COMMAND_BAR_CONFIG_WRITES: Readonly<
  Partial<Record<AdminToolId, readonly string[]>>
> = {
  register_agent: ["agent.trusted_agents"],
  suspend_agent: ["agent.trusted_agents"],
  set_agent_scope: ["agent.trusted_agents"],
  set_agent_ttl: ["agent.trusted_agents"],
  set_capability_mapping: ["agent.capability_features"],
};

/** Whether `tool`'s effect is a governed config write, held (if at all) by its key's rules. */
export function isConfigWriteAction(tool: string): boolean {
  return Object.prototype.hasOwnProperty.call(COMMAND_BAR_CONFIG_WRITES, tool);
}

/**
 * What migration 052 seeds the list with. Every change to who holds power that is not a config
 * write: roles and their permissions, a user's role, entitlement groups (one created, one turned
 * on or off — an active group grants its permissions to all its holders), the approval policy
 * (review 7 M6 added the entitlement actions: they were made by one admin alone). What a
 * capability maps to and agents' registration and scope are config writes, held by their keys
 * (agent.capability_features, agent.trusted_agents — both dual-controlled), not here (review 10).
 */
export const DEFAULT_DUAL_CONTROL_ACTIONS: readonly AdminToolId[] = [
  "create_role",
  "delete_role",
  "duplicate_role",
  "assign_permissions",
  "change_user_role",
  "create_entitlement_group",
  "set_entitlement_group_active",
  "set_approval_policy",
];

/**
 * Whether `tool` is held for a second admin. Fail closed: when the list cannot be read, or is
 * not a list, every action that changes something is held (a read never is) — except a config
 * write, which the config writer holds under its key's rules and never the action list
 * (review 10 H1: an entry for one on the list is ignored, so it cannot be held twice).
 */
export async function isDualControlledAction(tool: AdminToolId): Promise<boolean> {
  if (tool === "search") return false;
  if (isConfigWriteAction(tool)) return false;
  try {
    const list = await getConfigOrThrow<unknown>(DUAL_CONTROL_ACTIONS_KEY);
    if (!Array.isArray(list)) return true;
    return list.includes(tool);
  } catch {
    return true;
  }
}

/**
 * Actions whose every effect is a write in the tenant's own transaction (withTenantTx: the row,
 * and its audit record) — no owner connection, no external call. Approved, each runs as one
 * transaction with its approval's claim and completion: all of it or none (review 10 H2).
 */
export const ATOMIC_ACTIONS: ReadonlySet<AdminToolId> = new Set<AdminToolId>([
  "block_user_feature",
  "unblock_user_feature",
  "set_approval_policy",
]);

/** The command-bar action as a governed runtime tool; `held` raises it over the gating line. */
export function runtimeToolFor(
  tool: AdminToolId,
  input: Record<string, unknown>,
  admin: VerifiedAdmin,
  held: boolean
): Tool {
  const isRead = tool === "search";
  return {
    id: tool,
    name: tool,
    description: `admin command-bar: ${tool}`,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    effects: isRead ? [] : ["stateWrite"],
    declaredRisk: isRead ? "ordinary" : held ? "restricted" : "consequential",
    execute: async () =>
      (await COMMAND_BAR_HANDLERS[tool](input, admin)) as unknown as Record<
        string,
        unknown
      >,
    ...(ATOMIC_ACTIONS.has(tool) ? { atomic: true } : {}),
    // An approved run that reports failure did not take effect: its approval is kept for a retry
    // (review 10 H2).
    reportsFailure: (output) => {
      const r = output as unknown as ActionResult;
      return r?.success === true
        ? undefined
        : (r?.error ?? "The action reported failure");
    },
  };
}

export type CommandBarOutcome =
  | { readonly kind: "ran"; readonly result: ActionResult }
  | { readonly kind: "held"; readonly proposalId: string };

/**
 * Run one confirmed action as `admin`, step `stepIndex` of `trajectoryId`: run it, or — when it
 * is under dual control — hold it (a proposal another admin must approve).
 */
export async function runCommandBarAction(args: {
  readonly tool: AdminToolId;
  readonly input: Record<string, unknown>;
  readonly admin: VerifiedAdmin;
  readonly trajectoryId: string;
  readonly stepIndex: number;
}): Promise<CommandBarOutcome> {
  const { tool, input, admin, trajectoryId, stepIndex } = args;
  const held = await isDualControlledAction(tool);
  const runtimeTool = runtimeToolFor(tool, input, admin, held);
  const actor = commandBarActor(admin);
  const trajectoryStore = getTrajectoryStore();
  const proposalStore = getProposalStore();
  const operationId = `op_${trajectoryId}_${stepIndex}`;
  try {
    const invoked = await invokeTool({
      tool: runtimeTool,
      input,
      actor,
      sessionId: trajectoryId,
      trajectoryId,
      stepIndex,
      operationId,
      trajectoryStore,
      proposalStore,
    });
    const result = invoked.output as unknown as ActionResult;
    return {
      kind: "ran",
      result:
        typeof result?.success === "boolean"
          ? result
          : { success: false, error: "The action produced no result" },
    };
  } catch (err) {
    if (!(err instanceof PipelineRejectedError) || err.reason !== "requires-approval") {
      throw err;
    }
    const proposal = await proposeOnce({
      spec: {
        type: runtimeTool.id,
        effects: runtimeTool.effects,
        declaredRisk: runtimeTool.declaredRisk,
        ephemeral: false,
        commutative: false,
      },
      actor,
      sessionId: trajectoryId,
      operationId,
      label: runtimeTool.id,
      payload: input,
      trajectoryId,
      stepIndex,
      proposalStore,
      trajectoryStore,
    });
    return { kind: "held", proposalId: proposal.proposalId };
  }
}

function isCommandBarTool(label: string): label is AdminToolId {
  return Object.prototype.hasOwnProperty.call(ADMIN_TOOL_PERMISSIONS, label);
}

/**
 * The authority for held command-bar actions: an approver must hold the action's own permission
 * (ADMIN_TOOL_PERMISSIONS — what its admin page requires), and the approved action runs as its
 * requester, re-verified now, through the pipeline, which claims the approval so it runs once.
 */
export const COMMAND_BAR_HOLDS: HoldAuthority = {
  name: "command-bar",
  owns: (proposal) =>
    proposal.actor.actorId === COMMAND_BAR_ACTOR_ID &&
    proposal.actor.agentRole === "command-bar" &&
    isCommandBarTool(proposal.label),
  async requiredPermission(proposal) {
    return isCommandBarTool(proposal.label)
      ? ADMIN_TOOL_PERMISSIONS[proposal.label]
      : "config_manage_safety";
  },
  async resume(proposal: ProposalRecord): Promise<HoldResumeResult> {
    const label = proposal.label;
    if (!isCommandBarTool(label))
      return { kind: "failed", error: "not a command-bar action" };
    const requesterId = proposal.actor.onBehalfOf;
    const requester = requesterId ? await verifiedAdminById(requesterId) : null;
    if (!requester || !holds(requester, ADMIN_TOOL_PERMISSIONS[label])) {
      logger.warn("Approved command-bar action not run: its requester no longer may", {
        proposalId: proposal.proposalId,
        tool: label,
        route: "app/api/admin/ai/command-bar",
      });
      return {
        kind: "failed",
        error: "The requester no longer holds the permission this action needs",
      };
    }
    const stepIndex = Number(/_(\d+)$/.exec(proposal.operationId)?.[1] ?? 0);
    try {
      const invoked = await invokeTool({
        // The held form, so only the approval lets it through.
        tool: runtimeToolFor(label, proposal.payload, requester, true),
        input: proposal.payload,
        actor: proposal.actor,
        sessionId: proposal.sessionId,
        trajectoryId: proposal.trajectoryId,
        stepIndex,
        operationId: proposal.operationId,
        trajectoryStore: getTrajectoryStore(),
        proposalStore: getProposalStore(),
        approvedProposalId: proposal.proposalId,
      });
      const result = invoked.output as unknown as ActionResult;
      // A run that reported failure was released by the pipeline (ApprovedRunFailedError), so
      // here it took effect.
      return result?.success
        ? { kind: "applied" }
        : { kind: "failed", error: result?.error ?? "The action reported failure" };
    } catch (err) {
      return resumeFailure(err);
    }
  },
};
