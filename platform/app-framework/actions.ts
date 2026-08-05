/**
 * platform/app-framework/actions.ts — re-export shim
 *
 * Risk, tier and ActionContext assembly moved to platform/action-pipeline/risk.ts:
 * the shared pipeline needs them and cannot import app-framework (ADR-029 D2).
 *
 * @module platform/app-framework
 */

export * from "@/platform/action-pipeline/risk";
