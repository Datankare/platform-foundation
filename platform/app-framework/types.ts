/**
 * platform/app-framework/types.ts — re-export shim
 *
 * The activity vocabulary moved to platform/kernel, which is dependency-free and sits
 * beneath both the session and tool adapters (ADR-029 D2). This shim keeps every existing
 * importer working; new code should import from "@/platform/kernel".
 *
 * @module platform/app-framework
 */

export * from "@/platform/kernel/types";
