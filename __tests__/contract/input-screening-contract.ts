/**
 * __tests__/contract/input-screening-contract.ts — ADR-043 L21 input-screening kit.
 *
 * The portable contract for the RAG data path's two input-screening enforcement points
 * (ADR-043 D3): ingestion and query. Both must screen before acting and fail-closed —
 * content the screen blocks or escalates (or that the screen errors on) never enters the
 * index and never reaches retrieval; content it allows or merely warns proceeds. Run it
 * with a harness that exercises each point under a screen forced to a given decision.
 */
import type { ScreenDecision } from "@/platform/rag/screen";

export interface InputScreeningHarness {
  readonly name: string;
  /** Ingest a document under a screen forced to `forced`; resolve whether content entered the index. */
  readonly ingestUnder: (
    forced: ScreenDecision | "throw"
  ) => Promise<{ entered: boolean }>;
  /** Run a query under a screen forced to `forced`; resolve whether retrieval ran (returned results). */
  readonly queryUnder: (
    forced: ScreenDecision | "throw"
  ) => Promise<{ retrieved: boolean }>;
}

const ALLOW: ScreenDecision = { action: "allow" };
const WARN: ScreenDecision = { action: "warn" };
const BLOCK: ScreenDecision = { action: "block" };
const ESCALATE: ScreenDecision = { action: "escalate" };

export function runInputScreeningContract(h: InputScreeningHarness): void {
  describe(`input screening contract — ${h.name} (ADR-043 L21)`, () => {
    describe("ingest enforcement point (ADR-043 D3)", () => {
      it("ingests content the screen allows", async () => {
        expect((await h.ingestUnder(ALLOW)).entered).toBe(true);
      });
      it("ingests content the screen only warns", async () => {
        expect((await h.ingestUnder(WARN)).entered).toBe(true);
      });
      it("withholds content the screen blocks (data-poisoning, fail-closed)", async () => {
        expect((await h.ingestUnder(BLOCK)).entered).toBe(false);
      });
      it("withholds content the screen escalates", async () => {
        expect((await h.ingestUnder(ESCALATE)).entered).toBe(false);
      });
      it("withholds when the screen errors (fail-closed to escalate)", async () => {
        expect((await h.ingestUnder("throw")).entered).toBe(false);
      });
    });

    describe("query enforcement point (ADR-043 D3)", () => {
      it("retrieves when the screen allows", async () => {
        expect((await h.queryUnder(ALLOW)).retrieved).toBe(true);
      });
      it("retrieves when the screen only warns", async () => {
        expect((await h.queryUnder(WARN)).retrieved).toBe(true);
      });
      it("withholds retrieval when the screen blocks (prompt-injection, fail-closed)", async () => {
        expect((await h.queryUnder(BLOCK)).retrieved).toBe(false);
      });
      it("withholds retrieval when the screen escalates", async () => {
        expect((await h.queryUnder(ESCALATE)).retrieved).toBe(false);
      });
      it("withholds retrieval when the screen errors (fail-closed)", async () => {
        expect((await h.queryUnder("throw")).retrieved).toBe(false);
      });
    });
  });
}
