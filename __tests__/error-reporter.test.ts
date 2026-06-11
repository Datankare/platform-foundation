/**
 * ErrorReporter interface contract — reference arm (ADR-027).
 */
import { runErrorReporterContract } from "./contract/error-reporter-contract";
import { NoopErrorReporter } from "@/platform/observability/error-reporting";

describe("ErrorReporter contract — noop reporter", () => {
  runErrorReporterContract({
    makeReporter: () => new NoopErrorReporter(),
  });
});
