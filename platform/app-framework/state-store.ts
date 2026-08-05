/**
 * platform/app-framework/state-store.ts — re-export shim
 *
 * The ActivityStateStore contract moved to platform/kernel: the action pipeline owns CAS
 * commits and must reference the contract without importing app-framework (ADR-029 D2).
 * Registry slot #14 is unaffected — the implementations and the singleton stay here.
 *
 * @module platform/app-framework
 */

export * from "@/platform/kernel/state-store";
