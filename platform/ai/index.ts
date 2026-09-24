/**
 * platform/ai/index.ts — Public API for the LLM orchestration layer
 *
 * ADR-015: All AI interactions go through this module.
 *
 * Usage:
 *   import { getOrchestrator } from "@/platform/ai";
 *   const response = await getOrchestrator().complete(request, options);
 */

// Types
export type {
  ModelTier,
  ModelConfig,
  AIMessage,
  AIContentBlock,
  AITextBlock,
  AIToolUseBlock,
  AIToolResultBlock,
  AITool,
  AIRequest,
  AIResponse,
  AIProvider,
  OrchestratorOptions,
  AICallMetrics,
  CircuitState,
  CircuitBreakerConfig,
} from "./types";

export { MODEL_REGISTRY, DEFAULT_CIRCUIT_BREAKER_CONFIG } from "./types";

// Provider
export { AnthropicProvider, AIProviderError } from "./provider";
export type { AIErrorKind } from "./provider";

// Orchestrator
export {
  createOrchestrator,
  getOrchestrator,
  setOrchestrator,
  CircuitBreaker,
} from "./orchestrator";
export type { Orchestrator, CreateOrchestratorOptions } from "./orchestrator";

// Instrumentation
export {
  estimateCost,
  recordMetrics,
  getRecentMetrics,
  clearMetrics,
  summarizeMetrics,
} from "./instrumentation";
export type { MetricsSummary } from "./instrumentation";
export {
  degradeToSupported,
  requestModalities,
  blockModality,
  supportsInput,
} from "./multimodal";
export type { Modality, AIImageBlock, AIAudioBlock, ProviderCapabilities } from "./types";
export { screenMultimodalInput, detectMultimodalInput } from "./screen-input";
export {
  generateGoverned,
  defaultRiskPolicy,
  setGenerationRiskPolicy,
  resetGenerationRiskPolicy,
} from "./image-generation";
export type {
  GeneratedImage,
  GenerationRequest,
  GenerationOutcome,
  GenerationTier,
  GenerationStatus,
  ImageGenerator,
  GenerationRiskPolicy,
  RequesterTrust,
  GenerateOptions,
  ApprovalContext,
  RiskSignals,
} from "./image-generation";
export {
  emitProvenance,
  verifyProvenance,
  detectSyntheticOrigin,
  setSyntheticDetector,
  resetSyntheticDetector,
} from "./provenance";
export type {
  ImageBytes,
  ProvenanceCredential,
  DetectionSignal,
  SyntheticDetector,
} from "./provenance";
