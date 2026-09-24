/**
 * multimodal-input-conformance.test.ts — ADR-044 L21: the orchestrator + provider path
 * routes multimodal input by declared capability and degrades fail-closed.
 */
import { runMultimodalInputContract } from "./contract/multimodal-input-contract";
import { createOrchestrator } from "@/platform/ai";
import type {
  AIProvider,
  AIRequest,
  AIResponse,
  ProviderCapabilities,
} from "@/platform/ai";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

runMultimodalInputContract({
  name: "orchestrator + provider",
  received: async (caps: ProviderCapabilities, request: AIRequest) => {
    let captured: AIRequest | null = null;
    const provider: AIProvider = {
      name: "capture",
      capabilities: caps,
      async complete(r: AIRequest): Promise<AIResponse> {
        captured = r;
        return {
          content: [{ type: "text", text: "ok" }],
          model: "capture-model",
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    await createOrchestrator({ provider }).complete(request, {
      useCase: "test",
      requestId: "req",
    });
    if (!captured) throw new Error("provider was not called");
    return captured;
  },
});
