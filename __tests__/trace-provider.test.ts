/**
 * TraceProvider interface contract — reference arm (ADR-027).
 */
import { runTraceProviderContract } from "./contract/trace-provider-contract";
import { DefaultTraceProvider } from "@/platform/observability/tracing";

describe("TraceProvider contract — default provider", () => {
  runTraceProviderContract({
    makeProvider: () => new DefaultTraceProvider(),
  });
});
