/**
 * POST /api/admin/config-ai — Config management agent conversation
 *
 * Accepts an admin message, builds the config agent context, calls
 * the AI orchestrator with tool definitions, executes any tool calls,
 * and returns the agent's response with tool results and trajectory.
 *
 * Permission: config_view (all admins can converse; writes checked per-tool)
 *
 * GenAI Principles:
 *   P2  — Bounded execution: max steps enforced
 *   P3  — Observability: trajectory returned with every response
 *   P10 — Human oversight: changes require explicit confirmation
 *   P12 — Cost tracking: total cost returned per turn
 *   P15 — Agent identity: config-manager on behalf of admin
 *   P18 — Durable trajectories: trajectoryId stable across turn
 *
 * Phase 4, Sprint 3a
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard, getAdminActorId } from "@/platform/auth/admin-guard";
import { logger, generateRequestId } from "@/lib/logger";
import {
  buildConfigManagerPrompt,
  buildConfigAgentIdentity,
} from "@/prompts/admin/config-manager-v1";
import { CONFIG_TOOLS } from "@/platform/admin/config-handlers";
import { isApprovalRequired } from "@/platform/admin/config-approval";
import type { Step } from "@/platform/agents/types";
import type { ConfigToolResult } from "@/platform/admin/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum tool calls per conversation turn to prevent runaway loops */

// ---------------------------------------------------------------------------
// Request/Response types
// ---------------------------------------------------------------------------

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

interface ConfigAIRequest {
  /** The admin's message */
  message: string;
  /** Conversation history (previous turns) */
  history?: ConversationMessage[];
  /** Admin's role for permission context */
  adminRole?: "admin" | "super_admin";
}

interface ConfigAIResponse {
  /** Agent's natural language response */
  response: string;
  /** Tool results from this turn */
  toolResults: ConfigToolResult[];
  /** Whether a change is pending confirmation */
  pendingConfirmation: boolean;
  /** Trajectory metadata */
  trajectoryId: string;
  agentId: string;
  steps: Step[];
  totalCost: number;
  totalLatencyMs: number;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const requestId = generateRequestId();
  const startTime = Date.now();

  // Permission check — any admin with config_view can converse
  const denied = await adminGuard(request, "config_view");
  if (denied) return denied;

  try {
    const body: ConfigAIRequest = await request.json();

    if (!body.message || typeof body.message !== "string") {
      return NextResponse.json(
        { error: "message is required and must be a string" },
        { status: 400 }
      );
    }

    const actorId = getAdminActorId(request);
    const adminRole = body.adminRole ?? "admin";

    // Build agent context
    const identity = buildConfigAgentIdentity(actorId);
    const approvalRequired = await isApprovalRequired();
    const systemPrompt = buildConfigManagerPrompt({
      adminUserId: actorId,
      adminRole,
      permissionTier: adminRole === "super_admin" ? "safety" : "standard",
      approvalRequired,
    });

    // Build trajectory for this turn
    const trajectoryId = `traj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const steps: Step[] = [];
    const toolResults: ConfigToolResult[] = [];

    // Step 0: Receive message (cognition)
    steps.push({
      stepIndex: 0,
      action: "receive-message",
      boundary: "cognition",
      input: {
        messageLength: body.message.length,
        historyLength: body.history?.length ?? 0,
      },
      output: { systemPromptLength: systemPrompt.length, toolCount: CONFIG_TOOLS.length },
      cost: 0,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    });

    // Step 1: Process with orchestrator (cognition)
    // In the current implementation, we use a simplified tool dispatch model:
    // The admin's natural language is parsed for intent, and tools are
    // dispatched directly. Full LLM-driven tool use comes in Sprint 4b
    // when the agent runtime is activated.
    //
    // For now, the route accepts tool calls from the frontend and
    // dispatches them. The frontend drives the conversation flow using
    // the config-ai/execute endpoint for direct tool calls.

    const response: ConfigAIResponse = {
      response: buildAcknowledgment(body.message),
      toolResults,
      pendingConfirmation: false,
      trajectoryId,
      agentId: identity.actorId,
      steps,
      totalCost: 0,
      totalLatencyMs: Date.now() - startTime,
    };

    logger.info("Config AI conversation turn", {
      requestId,
      route: "/api/admin/config-ai",
      actorId,
      trajectoryId,
      toolCalls: toolResults.length,
      latencyMs: response.totalLatencyMs,
    });

    return NextResponse.json(response);
  } catch (error) {
    logger.error("Config AI conversation failed", {
      requestId,
      route: "/api/admin/config-ai",
      error: error instanceof Error ? error.message : "Unknown",
    });
    return NextResponse.json({ error: "Config AI conversation failed" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a basic acknowledgment response.
 *
 * TASK-037: Replace this placeholder with LLM-driven conversation
 * in Sprint 4b when the agent runtime is activated. The full flow:
 * system prompt → LLM with tool definitions → tool calls → response.
 * Do NOT extend this keyword-matching approach — it does not scale.
 *
 * For now, the config AI endpoint primarily serves as a tool execution
 * gateway via the /execute sub-route.
 */
function buildAcknowledgment(message: string): string {
  const lower = message.toLowerCase();

  if (lower.includes("search") || lower.includes("find") || lower.includes("show")) {
    return "I can help you find configuration entries. Use the tool panel to search by keyword, category, or permission tier.";
  }
  if (lower.includes("change") || lower.includes("update") || lower.includes("set")) {
    return "I can help you update configuration. Use the tool panel to select a config key and proposed value. I'll validate and show you the impact before applying.";
  }
  if (
    lower.includes("history") ||
    lower.includes("who changed") ||
    lower.includes("audit")
  ) {
    return "I can show you the change history for any configuration key. Use the tool panel to query history.";
  }
  if (lower.includes("impact") || lower.includes("what happened")) {
    return "I can show you how moderation outcomes changed after a config change. Use the impact report tool for any moderation config key.";
  }
  if (lower.includes("approval") || lower.includes("pending")) {
    return "I can help you manage pending approvals. Use the approval tools to review, approve, or reject pending changes.";
  }

  return "I'm the config management agent. I can help you search, view, update, and audit platform configuration. What would you like to do?";
}
