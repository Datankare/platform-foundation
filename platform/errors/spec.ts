/**
 * platform/errors/spec.ts — The shape of an error code's declaration (ADR-051 D3)
 *
 * Shared by the platform registry (registry.ts) and the consuming app's codes (app-codes.ts), so
 * neither imports the other's values.
 *
 * @module platform/errors
 */

export type ErrorParamKind = "id" | "number" | "list";

export interface ErrorParamSpec {
  readonly name: string;
  readonly kind: ErrorParamKind;
  /** Sent only when known; never required by the message. */
  readonly optional?: boolean;
}

export interface ErrorCodeSpec {
  readonly status: number;
  readonly params: readonly ErrorParamSpec[];
  /** What a client or agent should do on receiving this code. */
  readonly action: string;
}
