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
import { randomUUID } from "node:crypto";
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
import { approvalExpiryDays, holdLapsed } from "@/platform/admin/hold-expiry";
import { isErrorCode, type ErrorCode, type ErrorParams } from "@/platform/errors";
import { inputKeyRefusal, type InputSchemaNode } from "@/platform/admin/input-keys";
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
  handlePurgeUserData,
  createRoleRule,
  deleteRoleRule,
  duplicateRoleRule,
  assignPermissionsRule,
  changeUserRoleRule,
  createEntitlementGroupRule,
  setEntitlementGroupActiveRule,
  purgeUserDataRule,
  restrictionTargetRule,
  type ActionResult,
} from "./handlers";
import { coded, type ApproverRule } from "./handlers/shared";
import { searchResultFor, searchStepRecord } from "./handlers/search";
import { HELD_CURRENT_ROLE, heldRoleSnapshot } from "./handlers/roles";
import { purgeInputProblem } from "./handlers/purge";
import { approvalPolicyInputProblem } from "./handlers/approval";
import { PANEL_TOOL_SCHEMAS, SHARED_TOOLS } from "./tool-schemas";
import {
  ACCOUNT_TARGET_FIELD,
  heldActionSummary,
  heldTargetAccount,
} from "./held-summary";
import { canonicalUuid, sameId } from "@/platform/auth/same-id";

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
  purge_user_data: handlePurgeUserData,
};

/**
 * The rules each action applies to the admin who makes it, beyond its page permission — the
 * role-governance rules (checkRoleAssignment, checkPermissionGrant, mayChangePlatformCatalog,
 * the protected-role and default-role rules) and the erasure's own. Each is the function the
 * handler itself calls, so the two cannot drift. An approver of a held action must pass it too,
 * evaluated for the approver against the held payload (TASK-194, audit C-2: an approver needed
 * only the page permission, so an admin could approve a role change — to safety_approver, say —
 * that they could not make). `__tests__/command-bar-governance.test.ts` fails when a handler
 * applies such a rule without an entry here.
 */
export const APPROVER_RULES: Readonly<Partial<Record<AdminToolId, ApproverRule<any>>>> = {
  create_role: createRoleRule,
  delete_role: deleteRoleRule,
  duplicate_role: duplicateRoleRule,
  assign_permissions: assignPermissionsRule,
  change_user_role: changeUserRoleRule,
  create_entitlement_group: createEntitlementGroupRule,
  set_entitlement_group_active: setEntitlementGroupActiveRule,
  purge_user_data: purgeUserDataRule,
  // Never on one's own account (TASK-194 round 1, A3).
  block_user_feature: restrictionTargetRule,
  unblock_user_feature: restrictionTargetRule,
};

/**
 * A rule's refusal of an approver, as the hold authority answers it: every rule refuses with a
 * catalog code (coded, rebase round 2); anything else still refuses (fail closed).
 */
function approverRefusalOf(
  tool: AdminToolId,
  refused: ActionResult | null
): { code: ErrorCode; params: ErrorParams } | undefined {
  if (!refused) return undefined;
  return refused.code && isErrorCode(refused.code)
    ? { code: refused.code, params: refused.params ?? {} }
    : {
        code: "approvals.permission_required",
        params: { permission: ADMIN_TOOL_PERMISSIONS[tool] },
      };
}

/**
 * Actions held for a second admin whatever admin.dual_control_actions says: the irreversible
 * ones (TASK-194, audit C-6 — an account's erasure was one admin's alone, while a reversible role
 * change was dual-controlled). The list cannot free them.
 */
export const ALWAYS_HELD_ACTIONS: ReadonlySet<AdminToolId> = new Set<AdminToolId>([
  "purge_user_data",
]);

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
  if (ALWAYS_HELD_ACTIONS.has(tool)) return true;
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

/**
 * The command-bar action as a governed runtime tool; `held` raises it over the gating line.
 *
 * What the tool returns is what its step records. A search records searchStepRecord — the rows'
 * ids and counts, its text filters reduced to their length — because the step outlives an
 * account's erasure (TASK-189 round 1); the admin's screen gets the whole result through
 * `onResult` — a search's `id` column only for a caller whose verified role may see it
 * (searchResultFor, TASK-190 round 1).
 */
export function runtimeToolFor(
  tool: AdminToolId,
  input: Record<string, unknown>,
  admin: VerifiedAdmin,
  held: boolean,
  onResult?: (result: ActionResult) => void
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
    execute: async () => {
      const result = await COMMAND_BAR_HANDLERS[tool](input, admin);
      // The admin's screen: a search's `id` column only for the roles that may see it (TASK-190
      // round 1, S-L1); the step records the whole search's form either way.
      onResult?.(tool === "search" ? searchResultFor(result, admin) : result);
      return (tool === "search"
        ? searchStepRecord(result, input)
        : stepRecordOf(result)) as unknown as Record<string, unknown>;
    },
    ...(ATOMIC_ACTIONS.has(tool) ? { atomic: true } : {}),
    // An approved run that reports failure did not take effect: its approval is kept for a retry
    // (review 10 H2).
    // Its registry code and params when it has one (TASK-194 round 15, I-1): the decision on
    // its hold answers why, not only that it failed.
    reportsFailure: (output) => {
      const r = output as unknown as ActionResult;
      if (r?.success === true) return undefined;
      if (
        typeof r?.code === "string" &&
        isErrorCode(r.code) &&
        r.code !== "admin.action_failed" &&
        r.code !== "internal.error"
      )
        return { reason: r.code, code: r.code, params: r.params };
      return r?.error ?? "The action reported failure";
    },
  };
}

/**
 * What an action's step records: its result without the pipeline detail an erasure returns (the
 * route shows that to its admin; the step, which outlives the account, keeps only the outcome).
 */
function stepRecordOf(result: ActionResult): ActionResult {
  if (!result || typeof result !== "object" || !("purge" in result)) return result;
  const { purge: _purge, ...rest } = result as ActionResult & { purge?: unknown };
  void _purge;
  return rest;
}

/**
 * The result as the admin's screen may see it (TASK-199; rebase round 2, finding 2): a failure
 * that is not held carries a code of the error-code contract — one without (a result passed
 * through from a module the handlers' scan cannot read) becomes internal.error with a reference,
 * its text logged, never returned. __tests__/command-bar-coded-results.test.ts holds the
 * handlers to codes; this is the boundary's own check.
 */
export function codedResult(tool: string, result: ActionResult): ActionResult {
  if (result.success || result.held) return result;
  if (typeof result.code === "string" && isErrorCode(result.code)) {
    return { ...result, error: result.code };
  }
  const requestId = randomUUID();
  logger.error("Command-bar action failed without a code", {
    requestId,
    tool,
    error: typeof result.error === "string" ? result.error : String(result.error),
    route: "app/api/admin/ai/command-bar",
  });
  return {
    success: false,
    error: "internal.error",
    code: "internal.error",
    params: { requestId },
  };
}

/**
 * `input` with the action's account field (ACCOUNT_TARGET_FIELD) in one spelling (TASK-199;
 * round 3, finding 4): an account id in any spelling Postgres reads as a UUID becomes its
 * canonical form (canonicalUuid); an erasure's account is lower-cased whatever it is (round 3,
 * L1). Any other value as asked — the handler refuses what is not an account.
 */
export function withAccountIdsNormalised(
  tool: AdminToolId,
  input: Record<string, unknown>
): Record<string, unknown> {
  const field = ACCOUNT_TARGET_FIELD[tool];
  if (!field) return input;
  const value = input[field];
  if (typeof value !== "string") return input;
  const canonical = canonicalUuid(value);
  if (canonical) return { ...input, [field]: canonical };
  if (tool !== "purge_user_data") return input;
  return { ...input, [field]: value.toLowerCase() };
}

export type CommandBarOutcome =
  | { readonly kind: "ran"; readonly result: ActionResult }
  | { readonly kind: "held"; readonly proposalId: string };

/**
 * The inputs of the actions only a route runs (no planner offers them): their routes build them
 * server-side, and these are what those routes pass (round 10, I-A).
 */
const ROUTE_TOOL_INPUTS: Readonly<Partial<Record<AdminToolId, InputSchemaNode>>> = {
  purge_user_data: {
    type: "object",
    properties: {
      userId: { type: "string" },
      reason: { type: "string" },
      dryRun: { type: "boolean" },
    },
  },
  set_entitlement_group_active: {
    type: "object",
    properties: { group_id: { type: "string" }, is_active: { type: "boolean" } },
  },
};

/** Every action's input schema: its tool schema's, or its route's (above). */
const TOOL_INPUT_SCHEMAS: ReadonlyMap<string, InputSchemaNode> = new Map([
  ...[...SHARED_TOOLS, ...Object.values(PANEL_TOOL_SCHEMAS).flat()].map(
    (t) => [t.name, t.input_schema as InputSchemaNode] as const
  ),
  ...Object.entries(ROUTE_TOOL_INPUTS).map(([k, v]) => [k, v!] as const),
]);

/** The schema an action's input is checked against (round 11: the input-keys guard reads it). */
export function actionInputSchema(tool: AdminToolId): InputSchemaNode {
  return TOOL_INPUT_SCHEMAS.get(tool) ?? { type: "object", properties: {} };
}

/**
 * The input keys the server sets for an action, never a caller — each with why (round 12, nit 6).
 * A caller's is refused as `request.field_not_accepted`; __tests__/input-keys-guard.test.ts reads
 * every key a handler reads, and allows one outside its schema only when it is listed here.
 */
export const SERVER_SET_INPUTS: Readonly<
  Partial<Record<AdminToolId, Readonly<Record<string, string>>>>
> = {
  change_user_role: {
    [HELD_CURRENT_ROLE]:
      "the role a held change was requested against, recorded by runCommandBarAction when it holds the change (heldRoleSnapshot); its approval applies the change only while the account still has it",
  },
};

/**
 * A key of `input` its action's schema does not name, at any depth, refused (round 10, I-A;
 * round 11, item 3: nested too — `rules[0].note`): a held action's input is its hold's payload
 * and its proposal step's input, and free text under a key no schema names would pass the
 * erasure's register of free-text keys (AUDIT_TEXT_KEYS) — and a caller learns of the mistake
 * rather than having it dropped. A key the server sets (SERVER_SET_INPUTS) is the server's:
 * `request.field_not_accepted`. The values themselves are the handler's to check, as before.
 * search is its own parser's (it refuses any key that is not a filter of its table as
 * `request.unknown_input` too, and is never held).
 */
export function inputKeyProblem(
  tool: AdminToolId,
  input: Readonly<Record<string, unknown>>
): ActionResult | null {
  if (tool === "search") return null;
  const refused = inputKeyRefusal(
    actionInputSchema(tool),
    input,
    new Set(Object.keys(SERVER_SET_INPUTS[tool] ?? {}))
  );
  if (refused === null) return null;
  return refused.code === "request.unknown_input"
    ? coded(refused.code, {
        field: refused.params.field,
        allowed: [...refused.params.allowed],
      })
    : coded(refused.code, { field: refused.params.field });
}

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
  const { tool, admin, trajectoryId, stepIndex } = args;
  // Only the action's own keys, at every depth, before anything is held or run (round 10, I-A;
  // round 11, item 3). What a held change was requested against (HELD_CURRENT_ROLE) is recorded
  // here, never taken from a caller: a caller's is refused with the rest.
  const asked = args.input;
  const keyProblem = inputKeyProblem(tool, asked);
  if (keyProblem) return { kind: "ran", result: keyProblem };
  // An account is named in one spelling, however it was asked (round 3, L1; TASK-199): every
  // action's account field (ACCOUNT_TARGET_FIELD) holding an id is lower-cased — the rules that
  // compare it with an approver or the requester (checkRestrictionTarget, targetAccount), the
  // one-open-erasure index (061) and openErasureHold all compare one spelling.
  const input = withAccountIdsNormalised(tool, asked);
  const held = await isDualControlledAction(tool);
  // The handler's whole result, for the admin; the step records the tool's (runtimeToolFor).
  let full: ActionResult | undefined;
  const runtimeTool = runtimeToolFor(tool, input, admin, held, (r) => {
    full = r;
  });
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
    const result = full ?? (invoked.output as unknown as ActionResult);
    return {
      kind: "ran",
      result:
        typeof result?.success === "boolean" ? result : coded("admin.action_failed"),
    };
  } catch (err) {
    if (!(err instanceof PipelineRejectedError) || err.reason !== "requires-approval") {
      throw err;
    }
    // A held role change records the account and its role now (TASK-193 B-4; rebase P-1): the
    // account by id, never the address typed, and its approval applies the change only while
    // that is still the role. An account not found is refused here, never held.
    let payload: Record<string, unknown> = input;
    // An erasure is held only as its handler would run it (round 9, I-3): a user id and a listed
    // reason — never free text, which the hold and its run's step would keep.
    if (tool === "purge_user_data") {
      const problem = purgeInputProblem(input);
      if (problem) return { kind: "ran", result: problem };
    }
    // A policy change is held only as the store would take it (round 12, I-2): never a default
    // approver other than a person, never a rule the store refuses.
    if (tool === "set_approval_policy") {
      const problem = approvalPolicyInputProblem(input);
      if (problem) return { kind: "ran", result: problem };
    }
    if (tool === "change_user_role") {
      const snapshot = await heldRoleSnapshot(input);
      if (!snapshot) {
        return {
          kind: "ran",
          result: coded("admin.target_not_found", { target: "user" }),
        };
      }
      payload = {
        ...input,
        user_identifier: snapshot.userId,
        [HELD_CURRENT_ROLE]: snapshot.roleId,
      };
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
      payload,
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
    sameId(proposal.actor.actorId, COMMAND_BAR_ACTOR_ID) &&
    proposal.actor.agentRole === "command-bar" &&
    isCommandBarTool(proposal.label),
  async requiredPermission(proposal) {
    return isCommandBarTool(proposal.label)
      ? ADMIN_TOOL_PERMISSIONS[proposal.label]
      : "config_manage_safety";
  },
  // An erasure's undecided hold that another, older open erasure hold of the same account
  // already covers (TASK-199: one held before 061's index, or a draft index's spelling): the
  // older one stands; this one is rejected, never approved into a second erasure.
  async duplicateOf(proposal) {
    // An undecided hold (proposed), or an undecided run (indeterminate: approving it again would
    // run a second erasure — TASK-194 round 5).
    if (
      proposal.label !== "purge_user_data" ||
      (proposal.status !== "proposed" && proposal.status !== "indeterminate")
    ) {
      return undefined;
    }
    const account = proposal.payload["userId"];
    if (typeof account !== "string") return undefined;
    const [holds, days] = await Promise.all([
      getProposalStore().query({
        statuses: [...OPEN_ERASURE_STATUSES],
        labels: ["purge_user_data"],
      }),
      approvalExpiryDays(),
    ]);
    // A lapsed hold (holdLapsed) can never be approved: it is no hold to duplicate (round 2, 1).
    const older = holds.find(
      (p) =>
        !sameId(p.proposalId, proposal.proposalId) &&
        !holdLapsed(p, days) &&
        typeof p.payload["userId"] === "string" &&
        sameId(p.payload["userId"], account) &&
        (p.createdAt < proposal.createdAt ||
          (p.createdAt === proposal.createdAt && p.proposalId < proposal.proposalId))
    );
    return older
      ? { holdId: older.proposalId, code: "admin.erasure_pending" }
      : undefined;
  },
  // The action's own rules against the held payload (audit C-2): its facts read once, then
  // decided for each approver in memory (round 10, I-C) — the decision's own check below, and
  // who could decide at all (pending-approvals noEligibleDecider), run this one implementation.
  async approverRuleCheck(proposal) {
    if (!isCommandBarTool(proposal.label)) {
      return () => ({
        code: "approvals.permission_required" as const,
        params: { permission: "unknown" },
      });
    }
    const label = proposal.label;
    const rule = APPROVER_RULES[label];
    if (!rule) return () => undefined;
    const facts = await rule.facts(proposal.payload);
    return (approver: VerifiedAdmin) => {
      const refused =
        rule.beforeFacts?.(proposal.payload, approver) ??
        rule.decide(proposal.payload, facts, approver);
      return approverRefusalOf(label, refused);
    };
  },
  // One approver: what needs no read decided first, so it stands when the facts cannot be read
  // (round 11, nit 5); then the same check as the listing's.
  async approverRuleRefusal(proposal, approver) {
    const label = proposal.label;
    if (isCommandBarTool(label)) {
      const early = APPROVER_RULES[label]?.beforeFacts?.(proposal.payload, approver);
      if (early) return approverRefusalOf(label, early);
    }
    return (await COMMAND_BAR_HOLDS.approverRuleCheck!(proposal))(approver);
  },
  // The account it acts on (A3: never the approver's) and what it would do (A1), server-built.
  async targetAccount(proposal) {
    const target = await heldTargetAccount(proposal.label, proposal.payload);
    return target === undefined ? undefined : (target?.id ?? null);
  },
  summary: (proposal) => heldActionSummary(proposal.label, proposal.payload),
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
      // Coded (round 16, R-b; round 17, I-3): the requester's standing, named as theirs — not a
      // failed run to retry, and never the approver's own permission. Nothing was claimed: the
      // approval stands, for when they may again.
      return {
        kind: "failed",
        error: "The requester no longer holds the permission this action needs",
        code: "approvals.requester_lacks_permission",
        params: {
          permission: ADMIN_TOOL_PERMISSIONS[label],
          reason: requester ? "lacks" : "removed",
        },
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

/** The statuses migration 061's index counts as an open erasure hold (proposals_purge_one_open). */
export const OPEN_ERASURE_STATUSES = [
  "proposed",
  "approved",
  "executing",
  "indeterminate",
] as const;

/** An account's open erasure hold, and whether its period has run out (holdLapsed). */
export interface OpenErasureHold {
  readonly proposalId: string;
  readonly createdAt: string;
  /** Past config.approval_expiry_days, undecided or approved and never run (holdLapsed). */
  readonly lapsed: boolean;
  readonly proposal: ProposalRecord;
}

/**
 * The open erasure hold on account `userId`, if any (TASK-194 round 1, A6) — exactly the one
 * migration 061's unique index counts (rebase I-3): the tenant's `purge_user_data` hold in one of
 * OPEN_ERASURE_STATUSES whose account is `userId` in any case, whoever owns it, lapsed or not.
 * `lapsed` says whether its period has run out (holdLapsed, as the Approvals list and a decision
 * judge it): the erasure route withdraws such a hold before holding a new one, and the Users
 * screen does not show it as pending. A read error throws.
 */
export async function openErasureHold(userId: string): Promise<OpenErasureHold | null> {
  const [holds, days] = await Promise.all([
    getProposalStore().query({
      statuses: [...OPEN_ERASURE_STATUSES],
      labels: ["purge_user_data"],
    }),
    approvalExpiryDays(),
  ]);
  const open = holds.find(
    (p) =>
      typeof p.payload["userId"] === "string" &&
      // One spelling of the account (round 3, L1), as the index compares it.
      sameId(p.payload["userId"], userId)
  );
  return open
    ? {
        proposalId: open.proposalId,
        createdAt: open.createdAt,
        lapsed: holdLapsed(open, days),
        proposal: open,
      }
    : null;
}

/** The unique index that keeps one open erasure hold per account (migration 061, round 2 A6). */
export const ERASURE_HOLD_INDEX = "proposals_purge_one_open";

/**
 * Whether `err` — or what it wraps — is the database refusing a second open erasure hold for an
 * account (round 2, A6): two requests made at once both passed openErasureHold, and the index
 * kept one. The route answers the other admin.erasure_pending.
 */
export function isErasureHoldConflict(err: unknown): boolean {
  let at: unknown = err;
  for (let depth = 0; at && depth < 6; depth++) {
    const e = at as {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (e.code === "23505" && e.constraint === ERASURE_HOLD_INDEX) return true;
    if (typeof e.message === "string" && e.message.includes(ERASURE_HOLD_INDEX))
      return true;
    at = e.cause;
  }
  return false;
}
