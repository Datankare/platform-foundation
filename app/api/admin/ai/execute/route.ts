/**
 * app/api/admin/ai/execute/route.ts — Execute confirmed admin actions
 *
 * Dispatches to individual handlers in handlers.ts.
 * Sprint 6
 */

import { shown as shownText } from "@/platform/errors/shown-text";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { holds } from "@/platform/auth/role-governance";
import {
  ADMIN_TOOL_PERMISSIONS,
  type AdminToolId,
} from "@/app/api/admin/ai/tool-permissions";
import { logger } from "@/lib/logger";
import {
  COMMAND_BAR_ACTOR_ID,
  COMMAND_BAR_HANDLERS,
  codedResult,
  isErasureHoldConflict,
  actionInputSchema,
  SERVER_SET_INPUTS,
  runCommandBarAction,
  withAccountIdsNormalised,
  type ActionResult as BarResult,
} from "@/app/api/admin/ai/command-bar";
import { heldTargetAccount } from "@/app/api/admin/ai/held-summary";
import { withAccountNames } from "@/app/api/admin/ai/handlers/search";
import { withTrajectory } from "@/platform/agents/trajectory-closure";
import { apiError, readJsonBody, type InputSchemaNode } from "@/platform/errors";
import { mergeInputSchemas } from "@/platform/admin/input-keys";
import { tenantRoute } from "@/platform/tenancy/route";

/** Held for a second admin's approval: `held`, with the hold's id (ActionResult, review 9 H1). */
type ActionResult = BarResult;

/**
 * The account an account-targeting action names (ACCOUNT_TARGET_FIELD), as the screen shows it:
 * its address (null once erased) and id — undefined when the action names none, the account is
 * not found, or it cannot be read (the result line then stands alone).
 */
async function namedTarget(
  tool: AdminToolId,
  input: Record<string, unknown>
): Promise<{ id: string; email: string | null } | undefined> {
  try {
    const found = await heldTargetAccount(tool, withAccountIdsNormalised(tool, input));
    return found ? { id: found.id, email: found.email } : undefined;
  } catch {
    return undefined;
  }
}

/** search's parser also takes `query`, the old name of its `text` filter (an older plan's). */
const SEARCH_INPUT: InputSchemaNode = mergeInputSchemas([
  actionInputSchema("search"),
  { type: "object", properties: { query: { type: "string" } } },
]);

/** The keys an action's input may hold: its own schema's (search: with `query`). */
function inputSchemaOf(tool: AdminToolId): InputSchemaNode {
  return tool === "search" ? SEARCH_INPUT : actionInputSchema(tool);
}

/** The plan's actions as sent: each `{ tool, input }` read as far as it is one. */
function sentActions(body: Readonly<Record<string, unknown>>): { tool?: unknown }[] {
  return Array.isArray(body.actions)
    ? body.actions.map((a) =>
        a && typeof a === "object" ? (a as { tool?: unknown }) : {}
      )
    : [];
}

const isTool = (t: unknown): t is AdminToolId =>
  typeof t === "string" &&
  Object.prototype.hasOwnProperty.call(ADMIN_TOOL_PERMISSIONS, t);

/**
 * The body this route reads (TASK-203, N-31): a plan of actions, each a tool and its input, read
 * before any step runs — an input naming only keys some tool's schema names (search's with
 * `query`); a key no tool names is refused here. Each action's own schema then checks its input
 * exactly (inputKeyProblem), after the action's permission (a caller who may not act is told so,
 * not shown the tool's keys), and the keys the server sets for it are refused here (below).
 */
const PLAN_BODY_SCHEMA: InputSchemaNode = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tool: { type: "string" },
          input: mergeInputSchemas(
            (Object.keys(ADMIN_TOOL_PERMISSIONS) as AdminToolId[]).map(inputSchemaOf)
          ),
        },
      },
    },
  },
};

/**
 * The keys of each action's input the server sets (SERVER_SET_INPUTS: a held change's snapshot of
 * the role it was asked against), never a caller: refused `request.field_not_accepted`.
 */
function serverSetPaths(body: Readonly<Record<string, unknown>>): string[] {
  return sentActions(body).flatMap((a, i) =>
    isTool(a.tool)
      ? Object.keys(SERVER_SET_INPUTS[a.tool] ?? {}).map(
          (k) => `actions[${i}].input.${k}`
        )
      : []
  );
}

/** The most actions one confirmed plan may carry (audit B-19). */
const MAX_ACTIONS = 20;

export const POST = tenantRoute(async function POST(request: NextRequest) {
  const verified = await requireAdmin(request, "can_access_admin");
  if (verified.error) return verified.error;
  const { admin } = verified;

  const read = await readJsonBody(request, PLAN_BODY_SCHEMA, {
    notAccepted: serverSetPaths,
  });
  if (!read.ok) return read.response;
  const body = read.body;
  const { actions } = (body && typeof body === "object" ? body : {}) as {
    actions?: unknown;
  };

  if (!actions || !Array.isArray(actions) || actions.length === 0) {
    return apiError("request.missing_fields", {
      params: { fields: ["actions"] },
      request,
    });
  }
  if (actions.length > MAX_ACTIONS) {
    return apiError("request.invalid_value", {
      params: { field: "actions", allowed: [`at most ${MAX_ACTIONS}`] },
      request,
    });
  }

  const results: ({ tool: string } & ActionResult)[] = [];

  // ADR-039 F2c: command-bar execution runs through the governed runtime (invokeTool) —
  // trajectory, budget and gating — instead of a bespoke dispatch. An action under dual control
  // (admin.dual_control_actions) is held for a second admin, and the plan stops there: the
  // actions after it may depend on it (audit X-10, C-14).
  // The plan's trajectory is ended with the request (TASK-193: it was left `running` for good):
  // completed when every action ran, failed when one did not — unless the plan stopped at a held
  // action, whose decision or expiry ends it (withTrajectory ends only a `running` one).
  const validTools = new Set(Object.keys(COMMAND_BAR_HANDLERS));
  const runPlan = async (trajectoryId: string): Promise<void> => {
    for (let i = 0; i < actions.length; i += 1) {
      const action = (actions[i] && typeof actions[i] === "object" ? actions[i] : {}) as {
        tool?: unknown;
        input?: unknown;
      };
      if (typeof action.tool !== "string" || !validTools.has(action.tool)) {
        // Never String() an arbitrary value: an object with a non-callable toString throws.
        const named =
          typeof action.tool === "string" ? action.tool.slice(0, 64) : "(invalid)";
        // Coded, per the error-code contract (TASK-199).
        results.push({
          tool: named,
          success: false,
          error: "request.invalid_value",
          code: "request.invalid_value",
          params: { field: "tool", allowed: [...validTools].sort() },
        });
        break;
      }

      // TASK-145: entering the admin area only opens the command bar. Each action requires the
      // permission its own admin page requires, checked before anything runs.
      const tool = action.tool as AdminToolId;
      const required = ADMIN_TOOL_PERMISSIONS[tool];
      if (!holds(admin, required)) {
        results.push({
          tool: action.tool,
          success: false,
          error: "auth.permission_denied",
          code: "auth.permission_denied",
          params: { permission: required },
        });
        break;
      }

      const toolInput = (
        action.input && typeof action.input === "object" && !Array.isArray(action.input)
          ? action.input
          : {}
      ) as Record<string, unknown>;

      let result: ActionResult;
      try {
        const outcome = await runCommandBarAction({
          tool,
          input: toolInput,
          admin,
          trajectoryId,
          stepIndex: i,
        });
        result =
          outcome.kind === "held"
            ? {
                success: false,
                held: true,
                proposalId: outcome.proposalId,
                result: shownText("screens.admin_console.results.held_second_admin"),
              }
            : outcome.result;
      } catch (err) {
        // An erasure already held for the account, kept by the database (round 3, L6): its coded
        // answer. Anything else is internal.error with a reference (TASK-199): the error's own
        // text — a table, a constraint, a stack's message — is logged, never returned.
        if (isErasureHoldConflict(err)) {
          result = {
            success: false,
            error: "admin.erasure_pending",
            code: "admin.erasure_pending",
          };
        } else {
          const requestId = randomUUID();
          logger.error("Admin command-bar action failed", {
            requestId,
            tool,
            error: err instanceof Error ? err.message : String(err),
            route: "api/admin/ai/execute",
          });
          result = {
            success: false,
            error: "internal.error",
            code: "internal.error",
            params: { requestId },
          };
        }
      }
      // Only a code of the contract reaches the screen (rebase round 2, finding 2).
      // An audit search names its actors and targets by address (N-63), for the screen only.
      const shown = await withAccountNames(codedResult(tool, result)).catch(() =>
        codedResult(tool, result)
      );
      // The account it acted on, by address (TASK-202, N-63): for the screen only — the step
      // was recorded above, without it.
      const account =
        shown.success || shown.held ? await namedTarget(tool, toolInput) : undefined;
      results.push({ tool: action.tool, ...shown, ...(account ? { account } : {}) });
      if (!result.success) break;
    }
  };
  await withTrajectory(
    {
      subject: { kind: "agent", id: COMMAND_BAR_ACTOR_ID },
      trigger: "command-bar",
      scopeType: "platform",
    },
    (trajectoryId) => runPlan(trajectoryId),
    () => (results.every((r) => r.success || r.held) ? "completed" : "failed")
  );

  // No prompt in the log: free text an admin types may carry personal data (release review).
  logger.info("Admin AI action executed", {
    actionCount: actions.length,
    results: results.map((r) => ({ tool: r.tool, success: r.success })),
    route: "api/admin/ai/execute",
  });

  // A plan that stopped at a held action (it is always the last: a held result is no success)
  // is accepted and waiting: 202, as every route that can hold answers (round 11, item 1).
  const stoppedHeld = results.length > 0 && results[results.length - 1].held === true;
  return NextResponse.json({ results }, { status: stoppedHeld ? 202 : 200 });
});
