# AUX Design: Agent User Experience

> "Being agentic is not just about agents running on your platform — it's about agents running your platform."
> — Dharmesh Shah, simple.ai@dharmesh

**Status:** Design Phase
**Target:** Phase 5 (Application Framework)
**Dependencies:** Phase 3 (Voice Pipeline), Phase 4 (Content Safety)
**Last Updated:** 2026-04-14

---

## The Problem

Today Playform exposes human-facing endpoints:

| Endpoint            | What it does                           | Agent burden                                                             |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `POST /api/process` | Safety + detect + classify + translate | Returns flat JSON blob designed for React; agent must parse 10+ fields   |
| `POST /api/stream`  | AI streaming response                  | Agent must accumulate SSE chunks, handle reconnection                    |
| `POST /api/tts`     | Text to speech                         | Agent must know to call this AFTER process, with the right language code |
| `POST /api/extract` | Audio/PDF/text extraction              | Agent must route file types, handle encoding, retry on failure           |

An agent handling a voice interaction must:

1. Call `/api/extract` with audio → get transcript
2. Call `/api/process` with transcript → get translations + classification
3. Call `/api/tts` with translated text → get audio
4. Handle errors at each step, retry, decide what to do on partial failure

That's 3+ API calls, token-burning orchestration reasoning, and error handling — **per interaction**. Our VoicePipeline already solves this internally, but the API surface still forces agents through the human path.

---

## Design Principles

### 1. Workflow-Level Tools, Not Granular Endpoints

**Bad AUX:** Expose every internal function as a tool.
**Good AUX:** Expose one tool per complete workflow.

An agent should say "process this audio into Spanish" — not "transcribe this, then check safety, then translate, then synthesize."

### 2. Structured Results with `nextActions`

Every response tells the agent what it CAN do next. The agent doesn't reason about possibilities — the platform enumerates them.

```typescript
interface AgentResponse<T> {
  result: T;
  trajectory: TrajectoryResult;
  nextActions: NextAction[];
  cost: CostSummary;
}

interface NextAction {
  action: string; // "translate-more" | "escalate" | "retry" | "done"
  description: string; // Human-readable for debugging
  endpoint: string; // Where to call
  requiredParams: string[]; // What the agent needs to provide
  estimatedCost: string; // "$0.002" — so agents can budget
}
```

### 3. Intent-Driven, Not Verb-Driven

Human APIs: `POST /api/tts` (verb: "synthesize this text")
Agent APIs: `POST /api/agent/process-content` with `intent: "translate-and-speak"` (goal: "I want the user to hear this in Spanish")

The platform maps intents to workflows internally. Adding a new workflow doesn't change the agent's interface — just adds a new intent.

### 4. Cost Transparency

Agents operate on budgets. Every response includes cost information so agents can make economic decisions:

```typescript
interface CostSummary {
  apiCalls: number;
  tokensUsed: number;
  estimatedCostUSD: number;
  cachedResults: number; // How many results came from cache
  costSavedFromCache: number; // What we saved by caching
}
```

### 5. Trajectory as First-Class Return

Every workflow execution returns its trajectory (P18). Agents can:

- Audit what happened
- Resume from failure points
- Learn from past trajectories (which workflows succeed, which fail)

---

## Proposed AUX Surface

### Core Agent Endpoints

#### `POST /api/agent/process-content`

The primary workflow tool. Replaces the need to chain `/api/extract` → `/api/process` → `/api/tts`.

```typescript
// Request
interface ProcessContentRequest {
  // Input — exactly one required
  input: {
    audio?: string; // Base64 audio
    text?: string; // Plain text
    file?: string; // Base64 file (PDF, etc.)
    url?: string; // URL to fetch content from
  };

  // Intent — what the agent wants to accomplish
  intent:
    | "translate" // Translate to target languages
    | "identify" // Identify content type / song / language
    | "analyze" // Full classification + safety analysis
    | "full-pipeline" // Everything: transcribe + classify + translate + synthesize
    | "transcribe"; // Just STT, no translation

  // Configuration
  targetLanguages?: string[]; // Default: baseline (en, es, fr)
  synthesize?: boolean; // Generate TTS audio? Default: true for translate
  sourceLanguage?: string; // Hint; auto-detect if omitted

  // Agent context (P15)
  actorType: "agent" | "user" | "system";
  actorId: string;
  onBehalfOf?: string;
  traceId?: string;
  budgetMaxUSD?: number; // Agent's cost ceiling for this request
}

// Response
interface ProcessContentResponse {
  result: {
    transcript?: string;
    detectedLanguage?: string;
    contentType?: string;
    translations?: FanOutTranslation[];
    audio?: { [languageCode: string]: string }; // Base64 per language
    safety?: { passed: boolean; reason?: string };
  };

  trajectory: {
    id: string;
    steps: PipelineStepResult[];
    totalLatencyMs: number;
  };

  nextActions: NextAction[];
  cost: CostSummary;
}
```

**Examples:**

```
// "Handle this audio clip — translate it to Spanish"
POST /api/agent/process-content
{
  "input": { "audio": "base64..." },
  "intent": "translate",
  "targetLanguages": ["es"],
  "actorType": "agent",
  "actorId": "support-bot-1",
  "onBehalfOf": "user-456"
}

// Response
{
  "result": {
    "transcript": "Good morning, I need help with my account",
    "detectedLanguage": "en",
    "translations": [{ "code": "es", "translated": "Buenos días, necesito ayuda..." }],
    "audio": { "es": "base64..." }
  },
  "trajectory": { "id": "traj_abc", "steps": [...], "totalLatencyMs": 2340 },
  "nextActions": [
    { "action": "translate-more", "description": "Translate to additional languages", "endpoint": "/api/agent/process-content", "requiredParams": ["targetLanguages"] },
    { "action": "respond", "description": "Generate a response to this content", "endpoint": "/api/agent/respond", "requiredParams": ["prompt"] },
    { "action": "done", "description": "No further action needed", "endpoint": null, "requiredParams": [] }
  ],
  "cost": { "apiCalls": 3, "tokensUsed": 0, "estimatedCostUSD": 0.003, "cachedResults": 0, "costSavedFromCache": 0 }
}
```

#### `POST /api/agent/respond`

Generate an AI response in context of prior content processing.

```typescript
interface RespondRequest {
  prompt: string;
  context?: {
    trajectoryId?: string; // Link to prior process-content result
    conversationId?: string; // Ongoing conversation
  };
  constraints?: {
    maxTokens?: number;
    tier?: "fast" | "standard";
    style?: "formal" | "casual" | "technical";
  };
  actorType: "agent" | "user" | "system";
  actorId: string;
  onBehalfOf?: string;
}
```

#### `POST /api/agent/batch`

Process multiple items in one call (the `processTicketQueue` pattern).

```typescript
interface BatchRequest {
  items: ProcessContentRequest[];
  strategy: "parallel" | "sequential";
  stopOnFailure?: boolean; // Default: false (process all, report failures)
  budgetMaxUSD?: number; // Total budget across all items
  actorType: "agent" | "user" | "system";
  actorId: string;
}

interface BatchResponse {
  results: ProcessContentResponse[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    totalCostUSD: number;
    totalLatencyMs: number;
  };
  nextActions: NextAction[];
}
```

#### `GET /api/agent/capabilities`

The "index of 273 features" — tells the agent what the platform can do.

```typescript
interface CapabilitiesResponse {
  version: string;
  intents: {
    name: string;
    description: string;
    requiredParams: string[];
    optionalParams: string[];
    estimatedCostRange: string; // "$0.001 - $0.01"
    estimatedLatencyRange: string; // "500ms - 3s"
  }[];
  languages: LanguageDefinition[];
  limits: {
    maxInputBytes: number;
    maxBatchSize: number;
    rateLimitPerMinute: number;
  };
  providers: {
    translation: string;
    tts: string;
    stt: string;
    ai: string;
  };
}
```

---

## Migration Path

### Phase 4 (Content Safety)

- Add `safety` field to all response types
- Ensure every endpoint returns `trajectory` and `cost`
- Design `nextActions` vocabulary

### Phase 5 (Application Framework)

- Build `/api/agent/process-content` — wraps VoicePipeline + existing routes
- Build `/api/agent/capabilities`
- Build `/api/agent/batch`
- Build `/api/agent/respond`
- Deprecate direct agent use of `/api/process`, `/api/tts`, `/api/extract` (keep for human UI)

### Phase 8 (Consumer App Integration)

- MCP server that exposes AUX endpoints as MCP tools
- Agent discovery: agents can query capabilities and self-configure
- Multi-agent coordination: agents hand off work to each other via trajectories

---

## What Already Exists (Phase 3)

| Component                 | AUX Ready? | Gap                                                   |
| ------------------------- | ---------- | ----------------------------------------------------- |
| VoicePipeline             | ✅         | IS the workflow-level tool — just needs an API route  |
| TranslationCache (P16)    | ✅         | Cost savings tracked                                  |
| Trajectory tracking (P18) | ✅         | Every pipeline step recorded                          |
| Agent identity (P15)      | ✅         | actorType/actorId/onBehalfOf                          |
| Metric emission (P2)      | ✅         | onMetric callback                                     |
| Health probes             | ✅         | Can feed into capabilities response                   |
| Provider registry         | ✅         | Can feed into capabilities response                   |
| nextActions               | ❌         | Pipeline returns results but not suggested next steps |
| Cost tracking             | ⚠️         | Latency tracked, but not dollar cost per step         |
| Batch processing          | ❌         | Not built yet                                         |
| Capabilities endpoint     | ❌         | Not built yet                                         |

---

## Evaluation Criteria

When we build the AUX layer, every endpoint must pass:

1. **One-call test:** Can an agent accomplish the complete workflow in one call?
2. **NextActions test:** Does the response tell the agent what to do next?
3. **Cost test:** Does the response include cost so agents can budget?
4. **Trajectory test:** Can the agent audit what happened?
5. **Capability test:** Can a new agent discover this endpoint and self-configure?
6. **Batch test:** Can an agent process N items without N separate calls?
7. **Budget test:** Can an agent set a cost ceiling and have the platform respect it?

---

## Reading Queue

| Article                               | Author                             | Status  | Key Insight                                                                   |
| ------------------------------------- | ---------------------------------- | ------- | ----------------------------------------------------------------------------- |
| "Why Agents Need Their Own Interface" | Dharmesh Shah (simple.ai@dharmesh) | ✅ Read | AUX = workflow-level tools, not wrapped APIs. nextActions. Cost transparency. |
| —                                     | —                                  | —       | —                                                                             |

---

_This document is reviewed at every phase boundary per L9._
_See [ENGINEERING_LEARNINGS.md](ENGINEERING_LEARNINGS.md) for L13 (AUX design principle)._
_See [ROADMAP.md](ROADMAP.md) for Phase 5 timeline._
