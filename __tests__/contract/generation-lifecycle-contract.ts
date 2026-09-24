/**
 * __tests__/contract/generation-lifecycle-contract.ts — ADR-045 L21 generation-lifecycle kit.
 *
 * The contract for governed generation: a draft is never surfaced until committed, a blocked
 * or escalated draft is withheld fail-closed, high-risk is held for Confirm, and commit is
 * idempotent (a retry never double-spends). Run it with a harness that generates under
 * controllable trust, screen verdict, and retry.
 */
export interface GenerationLifecycleHarness {
  readonly name: string;
  readonly run: (scenario: {
    trust?: "system" | "trusted" | "user" | "guest";
    screen?: "allow" | "warn" | "block" | "escalate";
    retry?: boolean;
  }) => Promise<{ status: "committed" | "held" | "withheld"; generatorCalls: number }>;
}

export function runGenerationLifecycleContract(h: GenerationLifecycleHarness): void {
  describe(`generation lifecycle contract — ${h.name} (ADR-045 L21)`, () => {
    it("commits a clean, trusted, low-risk generation", async () => {
      const r = await h.run({ trust: "trusted", screen: "allow" });
      expect(r.status).toBe("committed");
    });
    it("withholds a blocked draft (fail-closed, never surfaced)", async () => {
      expect((await h.run({ trust: "trusted", screen: "block" })).status).toBe(
        "withheld"
      );
    });
    it("withholds an escalated draft", async () => {
      expect((await h.run({ trust: "trusted", screen: "escalate" })).status).toBe(
        "withheld"
      );
    });
    it("holds a high-risk (untrusted) generation for Confirm", async () => {
      expect((await h.run({ trust: "guest", screen: "allow" })).status).toBe("held");
    });
    it("commit is idempotent — a retry never double-spends", async () => {
      const r = await h.run({ trust: "trusted", screen: "allow", retry: true });
      expect(r.generatorCalls).toBe(1);
    });
  });
}
