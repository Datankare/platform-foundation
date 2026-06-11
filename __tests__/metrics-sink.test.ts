/**
 * MetricsSink interface contract — reference arm (ADR-027).
 */
import { runMetricsSinkContract } from "./contract/metrics-sink-contract";
import { InMemoryMetricsSink } from "@/platform/observability/metrics-sink";

describe("MetricsSink contract — in-memory sink", () => {
  runMetricsSinkContract({
    makeSink: () => new InMemoryMetricsSink(),
  });
});
