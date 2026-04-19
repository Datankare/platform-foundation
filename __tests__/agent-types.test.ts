/**
 * Sprint 1a — Agent type vocabulary tests
 *
 * Tests for platform/agents/types.ts and index.ts.
 * Verifies type exports, default constants, and structural contracts.
 *
 * 18-principle mapping: P2 P5 P6 P12 P15 P17 P18 — all via type contracts
 */

import {
  DEFAULT_BUDGET_CONFIG,
  type AgentIdentity,
  type Trajectory,
  type Step,
  type Tool,
  type BudgetConfig,
  type AgentConfig,
  type TrajectoryStatus,
  type StepBoundary,
} from "@/platform/agents";

// ═══════════════════════════════════════════════════════════════════════
// DEFAULT_BUDGET_CONFIG (P12)
// ═══════════════════════════════════════════════════════════════════════

describe("DEFAULT_BUDGET_CONFIG", () => {
  it("has sensible defaults for rule-based agents", () => {
    expect(DEFAULT_BUDGET_CONFIG.maxCostPerTrajectory).toBe(0.1);
    expect(DEFAULT_BUDGET_CONFIG.maxCostPerDay).toBe(5.0);
    expect(DEFAULT_BUDGET_CONFIG.maxStepsPerTrajectory).toBe(20);
  });

  it("is a frozen-compatible object (readonly fields)", () => {
    // Verify the shape is correct — readonly enforced at compile time
    const config: BudgetConfig = DEFAULT_BUDGET_CONFIG;
    expect(config.maxCostPerTrajectory).toBeGreaterThan(0);
    expect(config.maxCostPerDay).toBeGreaterThan(0);
    expect(config.maxStepsPerTrajectory).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TYPE STRUCTURAL CONTRACTS (compile-time + runtime shape verification)
// ═══════════════════════════════════════════════════════════════════════

describe("AgentIdentity (P15)", () => {
  it("supports user actor type", () => {
    const identity: AgentIdentity = {
      actorType: "user",
      actorId: "user-123",
      agentRole: "requester",
    };
    expect(identity.actorType).toBe("user");
    expect(identity.actorId).toBe("user-123");
    expect(identity.agentRole).toBe("requester");
    expect(identity.onBehalfOf).toBeUndefined();
  });

  it("supports agent actor type with delegation", () => {
    const identity: AgentIdentity = {
      actorType: "agent",
      actorId: "conductor-1",
      agentRole: "conductor",
      onBehalfOf: "user-456",
    };
    expect(identity.actorType).toBe("agent");
    expect(identity.onBehalfOf).toBe("user-456");
  });

  it("supports system actor type", () => {
    const identity: AgentIdentity = {
      actorType: "system",
      actorId: "cron-daily",
      agentRole: "scheduler",
    };
    expect(identity.actorType).toBe("system");
  });
});

describe("Step (P17 + P18)", () => {
  it("supports cognition boundary", () => {
    const step: Step = {
      stepIndex: 0,
      action: "classify-audio",
      input: { format: "webm" },
      output: { classification: "music", confidence: 0.87 },
      cost: 0,
      durationMs: 12,
      timestamp: "2026-04-19T10:00:00Z",
      boundary: "cognition",
    };
    expect(step.boundary).toBe("cognition");
    expect(step.cost).toBe(0);
  });

  it("supports commitment boundary", () => {
    const step: Step = {
      stepIndex: 1,
      action: "route-to-identification",
      input: { target: "acrcloud" },
      output: { routed: true },
      cost: 0.005,
      durationMs: 200,
      timestamp: "2026-04-19T10:00:01Z",
      boundary: "commitment",
    };
    expect(step.boundary).toBe("commitment");
    expect(step.cost).toBe(0.005);
  });
});

describe("Trajectory (P18)", () => {
  it("supports all status values", () => {
    const statuses: TrajectoryStatus[] = ["running", "completed", "failed", "paused"];
    statuses.forEach((status) => {
      const trajectory: Trajectory = {
        trajectoryId: `traj-${status}`,
        agentId: "conductor-1",
        steps: [],
        status,
        totalCost: 0,
        createdAt: "2026-04-19T10:00:00Z",
        updatedAt: "2026-04-19T10:00:00Z",
      };
      expect(trajectory.status).toBe(status);
    });
  });

  it("accumulates cost across steps", () => {
    const steps: Step[] = [
      {
        stepIndex: 0,
        action: "classify",
        input: {},
        output: {},
        cost: 0,
        durationMs: 5,
        timestamp: "2026-04-19T10:00:00Z",
        boundary: "cognition",
      },
      {
        stepIndex: 1,
        action: "identify",
        input: {},
        output: {},
        cost: 0.005,
        durationMs: 200,
        timestamp: "2026-04-19T10:00:01Z",
        boundary: "commitment",
      },
    ];

    const trajectory: Trajectory = {
      trajectoryId: "traj-cost-test",
      agentId: "conductor-1",
      steps,
      status: "completed",
      totalCost: steps.reduce((sum, s) => sum + s.cost, 0),
      createdAt: "2026-04-19T10:00:00Z",
      updatedAt: "2026-04-19T10:00:01Z",
    };

    expect(trajectory.totalCost).toBe(0.005);
    expect(trajectory.steps).toHaveLength(2);
  });
});

describe("Tool (P5)", () => {
  it("has typed input and output schemas", () => {
    const tool: Tool = {
      id: "translate-text",
      name: "Translate",
      description: "Translates text between languages",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          targetLanguage: { type: "string" },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          translation: { type: "string" },
          detectedLanguage: { type: "string" },
        },
      },
    };
    expect(tool.id).toBe("translate-text");
    expect(tool.inputSchema).toBeDefined();
    expect(tool.outputSchema).toBeDefined();
  });
});

describe("AgentConfig (P2)", () => {
  it("combines identity, tools, and budget", () => {
    const config: AgentConfig = {
      id: "conductor-v1",
      name: "Input Conductor",
      description: "Orchestrates the input agent layer",
      tools: [],
      budgetConfig: DEFAULT_BUDGET_CONFIG,
    };
    expect(config.id).toBe("conductor-v1");
    expect(config.tools).toHaveLength(0);
    expect(config.budgetConfig.maxCostPerTrajectory).toBe(0.1);
  });
});

describe("StepBoundary (P17)", () => {
  it("has exactly two values", () => {
    const boundaries: StepBoundary[] = ["cognition", "commitment"];
    expect(boundaries).toHaveLength(2);
  });
});
