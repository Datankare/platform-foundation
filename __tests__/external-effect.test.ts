/**
 * __tests__/external-effect.test.ts — a confirmed effect whose receipt was not kept is replayed as
 * such, never as its result (platform TASK-229, review TA-a-4; design 56e-3a §2.6, T14)
 *
 * What it refuses: a replay that returns the "not kept" marker as an effect's result
 *
 * The ledger stores a receipt it cannot keep as `{"_omitted": {code, max?}}` (receiptToStore, both
 * ledgers). performExternalEffect's confirmed outcome carries `resultKept`: a caller must narrow on
 * it before it can read a result, and a replay of such an entry answers `resultKept: false` with
 * why — without firing the effect again. The live call says in `replayable` whether its result was
 * kept (code review B-1), and a real result that has the marker's own shape is stored wrapped and
 * replayed as itself — a provider cannot make its answer read as "not kept" (code review B-11).
 */
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

import { performExternalEffect } from "@/platform/agents/external-effect";
import { InMemoryEffectLedger } from "@/platform/agents/effect-ledger";
import { EFFECT_RECEIPT_MAX_TEXT, isOmittedMarker } from "@/platform/errors/json-limits";

async function confirmedWith(receipt: Record<string, unknown>) {
  const ledger = new InMemoryEffectLedger();
  await ledger.begin({ operationId: "op", effectKey: "k", effectType: "externalCall" });
  await ledger.resolve("op", "k", "confirmed", { receipt });
  return ledger;
}

describe("T14: performExternalEffect's confirmed outcome says whether its result was kept", () => {
  it("a live call: resultKept true, its real result", async () => {
    const out = await performExternalEffect({
      operationId: "op-live",
      effectKey: "k",
      effectType: "externalCall",
      call: async () => ({ id: "x1" }),
      ledger: new InMemoryEffectLedger(),
    });
    expect(out).toMatchObject({
      status: "confirmed",
      resultKept: true,
      replayable: true,
      result: { id: "x1" },
    });
  });

  it("[guard] a live call whose result is larger than the ledger keeps: its real result, and replayable false", async () => {
    const big = { data: "A".repeat(EFFECT_RECEIPT_MAX_TEXT) };
    const ledger = new InMemoryEffectLedger();
    const out = await performExternalEffect({
      operationId: "op-big",
      effectKey: "k",
      effectType: "externalCall",
      call: async () => big,
      ledger,
    });
    expect(out).toMatchObject({
      status: "confirmed",
      resultKept: true,
      replayable: false,
    });
    expect((out as { result: unknown }).result).toBe(big);
    expect(isOmittedMarker((await ledger.get("op-big", "k"))?.receipt)).toBe(true);
  });

  it.each([
    [
      "a forged marker with a text of its own",
      { _omitted: { code: "provider says so" } },
    ],
    [
      "the platform's own marker shape, to the letter",
      { _omitted: { code: "request.json_too_large", max: 1 } },
    ],
    ["the wrapper's own shape", { _kept: { id: "x9" } }],
  ])(
    "[guard] (code review B-11) a real result that is %s is replayed as itself, resultKept true",
    async (_label, result) => {
      const fired: string[] = [];
      const ledger = new InMemoryEffectLedger();
      const live = await performExternalEffect({
        operationId: "op-forged",
        effectKey: "k",
        effectType: "externalCall",
        call: async () => result as Record<string, unknown>,
        ledger,
      });
      expect(live).toMatchObject({ resultKept: true, replayable: true });
      const replay = await performExternalEffect({
        operationId: "op-forged",
        effectKey: "k",
        effectType: "externalCall",
        call: async () => {
          fired.push("again");
          return {};
        },
        ledger,
      });
      expect(fired).toEqual([]);
      expect(replay).toMatchObject({ status: "confirmed", resultKept: true, result });
    }
  );

  it("a replay of a kept receipt: resultKept true, the receipt as the result, nothing fired", async () => {
    const fired: string[] = [];
    const out = await performExternalEffect({
      operationId: "op",
      effectKey: "k",
      effectType: "externalCall",
      call: async () => {
        fired.push("again");
        return {};
      },
      ledger: await confirmedWith({ id: "x1" }),
    });
    expect(fired).toEqual([]);
    expect(out).toMatchObject({
      status: "confirmed",
      resultKept: true,
      result: { id: "x1" },
    });
  });

  it("[guard] a replay of a receipt not kept: resultKept false with why — no result, nothing fired", async () => {
    const fired: string[] = [];
    // The ledger itself wrote the marker: the receipt it was given printed more than it keeps.
    const tooLarge = { data: "A".repeat(EFFECT_RECEIPT_MAX_TEXT) };
    const out = await performExternalEffect({
      operationId: "op",
      effectKey: "k",
      effectType: "externalCall",
      call: async () => {
        fired.push("again");
        return {};
      },
      ledger: await confirmedWith(tooLarge),
    });
    expect(fired).toEqual([]);
    expect(out).toEqual(
      expect.objectContaining({
        status: "confirmed",
        resultKept: false,
        notKept: { code: "request.json_too_large", max: EFFECT_RECEIPT_MAX_TEXT },
      })
    );
    expect("result" in out).toBe(false);
  });
});
