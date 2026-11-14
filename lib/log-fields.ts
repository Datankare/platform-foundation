/**
 * lib/log-fields.ts — every field name a log line may carry, classified (TASK-215, audit A-10)
 *
 * The logger redacted credentials and a handful of personal fields by name (lib/logger.ts
 * REDACTED_KEYS), and nothing said whether any other field could carry personal data: a network
 * address, a browser, a model's words about what a person wrote, an identity subject went out as
 * written. Now every field name a log call passes is here, kept or redacted, with why —
 * `__tests__/log-fields.test.ts` fails on a field name no register classifies, so a new field
 * cannot carry personal data into the logs unnoticed. An app's own fields are in its consumer seam,
 * platform/observability/app-log-fields.ts, in the same form.
 *
 * The practice is the OWASP Logging Cheat Sheet's "Data to exclude" (OWASP Cheat Sheet Series
 * Team): personal data and session or access identifiers are not recorded directly, but removed,
 * masked or hashed.
 *
 *   "redacted: <why>"   the logger writes `[redacted]` for the value, at any depth
 *   "kept: <why>"       written as given — its strings still scanned: an e-mail or IP address
 *                       inside any text is replaced (lib/logger.ts redactText)
 *
 * @module lib
 */

import { APP_LOG_FIELDS } from "@/platform/observability/app-log-fields";

export { APP_LOG_FIELDS };

const each = (names: readonly string[], decision: string): Record<string, string> =>
  Object.fromEntries(names.map((n) => [n, decision]));

const ID = "kept: an id the platform assigned (pseudonymous; never an address or a name)";
const CODE = "kept: a code, a name or a key the platform or its configuration defines";
const NUMBER = "kept: a number, a flag, a time or a size";
const TEXT =
  "kept: text the platform or a dependency wrote (an error, a probe's detail) — its strings scanned for e-mail and IP addresses";

/** The platform's log fields. */
export const LOG_FIELDS: Readonly<Record<string, string>> = {
  // ADR-057 (TASK-214), classified by TASK-215: a refused forgery check says whether the header
  // came and how the origin was judged; a provider's failure to end every session, its code.
  csrfHeader:
    "kept: whether the forgery-check header came (wrong or absent), never its value",
  origin:
    "kept: the origin check's verdict (same, cross or absent), never the origin itself",
  errorCode: CODE,
  ...each(
    [
      "accountId",
      "actorId",
      "agentId",
      "appealingUserId",
      "approvalId",
      "documentId",
      "effectKey",
      "guardianTrajectoryId",
      "guestId",
      "holdId",
      "id",
      "jobId",
      "knowledgeBaseId",
      "operationId",
      "patternId",
      "proposalId",
      "proposalIds",
      "purgeId",
      "requestId",
      "requestedBy",
      "reviewItemId",
      "reviewerId",
      "roleId",
      "strikeId",
      "targetId",
      "tenantId",
      "toolId",
      "traceId",
      "spanId",
      "trajectoryId",
      "userId",
      "workerId",
    ],
    ID
  ),
  ...each(
    [
      "accountStatus",
      "action",
      "actionTaken",
      "actorType",
      "alert",
      "authority",
      "blockedFields",
      "categories",
      "categoriesFlagged",
      "category",
      "channel",
      "code",
      "cognitoType",
      "configKey",
      "consentStatus",
      "contentType",
      "decision",
      "decisionOwner",
      "direction",
      "encoding",
      "environment",
      "feature",
      "field",
      "finalStatus",
      "guardianAction",
      "handler",
      "health",
      "key",
      "keys",
      "kind",
      "label",
      "languageCode",
      "method",
      "metric",
      "module",
      "moduleName",
      "name",
      "newStatus",
      "outcome",
      "permission",
      "permissionCode",
      "previousStatus",
      "probe",
      "provider",
      "reason",
      "reasons",
      "reasoning",
      "role",
      "roleName",
      "route",
      "rule",
      "scope",
      "service",
      "severity",
      "source",
      "sourceFormat",
      "status",
      "step",
      "store",
      "table",
      "targetLanguage",
      "tier",
      "tool",
      "traceProvider",
      "triggeredBy",
      "useCase",
      "version",
      "was",
      "what",
    ],
    CODE
  ),
  ...each(
    [
      "actionCount",
      "attempt",
      "autoDetect",
      "bannedAt",
      "boot",
      "bootStep",
      "chunk",
      "chunks",
      "clipBytes",
      "clipDurationSeconds",
      "confidence",
      "confirmed",
      "contentRatingLevel",
      "conversionMs",
      "count",
      "current",
      "dropped",
      "droppedCount",
      "droppedWithoutTenant",
      "dryRun",
      "durationMs",
      "errorCount",
      "expired",
      "failureCount",
      "goalCount",
      "hasAttempt",
      "hasAudio",
      "hasClientId",
      "hasSentry",
      "hasText",
      "hasUserPoolId",
      "healthProbes",
      "inputBytes",
      "isEnforced",
      "lagMs",
      "latencyMs",
      "limit",
      "max",
      "maxRetries",
      "maxSteps",
      "maxTokens",
      "metricsSink",
      "outputBytes",
      "pipelineLatencyMs",
      "probeCount",
      "proven",
      "queryDimensions",
      "queryLength",
      "receivedText",
      "required",
      "recordedPrevious",
      "restoredTo",
      "restrictedUntil",
      "retryInMs",
      "runningMs",
      "sampleRate",
      "scheduled",
      "servingSnapshotFrom",
      "severityAdjustment",
      "slaMs",
      "stepIndex",
      "steps",
      "storedDefault",
      "storedDimensions",
      "success",
      "suspendedUntil",
      "synthesize",
      "syntheticBlocks",
      "textBytes",
      "textLength",
      "threshold",
      "timestamp",
      "toolCalls",
      "totalActiveStrikes",
      "totalLatencyMs",
      "ttftMs",
      "unhealthy",
      "withdrawn",
    ],
    NUMBER
  ),
  ...each(
    [
      "detail",
      "error",
      "errors",
      "failures",
      "host",
      "identifier",
      "message",
      "result",
      "results",
    ],
    TEXT
  ),
  ...each(
    ["fields"],
    "kept: field paths a route answered without declaring them (names, never values — TASK-215)"
  ),

  inputHash:
    "kept: a keyed hash of screened text (RECORD_HASH_KEY, TASK-215) — confirms nothing without the key",
  raw: "redacted: a model's raw answer, which can repeat what the person wrote",
  rawReason:
    "redacted: a model's words on why, which can quote what the person wrote (A-5)",
  rawReasoning: "redacted: a provider's words on what it saw (A-5)",
  title: "redacted: what a person's recording was identified as",
  artist: "redacted: what a person's recording was identified as",
  subject: "redacted: an identity provider's subject",
  cognitoSub: "redacted: an identity provider's subject",
  ip: "redacted: a network address (A-10)",
  ipAddress: "redacted: a network address (A-10)",
  ip_address: "redacted: a network address (A-10)",
  clientIp: "redacted: a network address (A-10)",
  forwardedFor: "redacted: a network address (A-10)",
  userAgent: "redacted: a browser's identifying string (A-10)",
  user_agent: "redacted: a browser's identifying string (A-10)",
  text: "redacted: what a person wrote",
  input: "redacted: what a person wrote",
  transcript: "redacted: what a person said",
  prompt: "redacted: a prompt, which carries what a person wrote",
  content: "redacted: what a person wrote or sent",
};

/** Every field name whose value the logger redacts, the platform's and the app's. */
export const REDACTED_LOG_FIELDS: ReadonlySet<string> = new Set(
  Object.entries({ ...LOG_FIELDS, ...APP_LOG_FIELDS })
    .filter(([, d]) => d.startsWith("redacted:"))
    .map(([k]) => k)
);
