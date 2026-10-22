/**
 * __tests__/screened-stream.test.ts — streamed output is released only after screening (audit X-11)
 *
 * Adversarial: a banned term split across chunks or windows is still caught; nothing the screen
 * has not passed is ever yielded; a screening error or a non-boolean answer withholds the text;
 * the source stops being read once the stream is refused. Property-tested with fast-check.
 */

import fc from "fast-check";
import { screenStream, type ScreenedEvent } from "@/platform/ai/screened-stream";
import type { AIStreamChunk } from "@/platform/ai/types";
import { fuzzParams } from "@/__tests__/helpers/fuzz";

fc.configureGlobal(fuzzParams());

async function* chunks(parts: string[], done = true): AsyncGenerator<AIStreamChunk> {
  for (let i = 0; i < parts.length; i++) {
    yield { text: parts[i], done: done && i === parts.length - 1 };
  }
}

async function collect(it: AsyncIterable<ScreenedEvent>): Promise<ScreenedEvent[]> {
  const out: ScreenedEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const released = (events: ScreenedEvent[]) =>
  events.map((e) => (e.kind === "text" ? e.text : "")).join("");
const terminal = (events: ScreenedEvent[]) => events[events.length - 1].kind;
const allow = async () => true;
const noBad = async (t: string) => !t.includes("BAD");

describe("screenStream", () => {
  it("releases everything, in order, when the screen passes it", async () => {
    const ev = await collect(
      screenStream(chunks(["Hel", "lo ", "world"]), allow, { window: 4 })
    );
    expect(released(ev)).toBe("Hello world");
    expect(terminal(ev)).toBe("done");
  });

  it("passes the final chunk's usage through", async () => {
    async function* src(): AsyncGenerator<AIStreamChunk> {
      yield { text: "hi", done: true, usage: { inputTokens: 1, outputTokens: 2 } };
    }
    const ev = await collect(screenStream(src(), allow));
    expect(ev).toContainEqual({
      kind: "done",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
  });

  it("holds text back until a window is screened", async () => {
    const seen: string[] = [];
    const ev = await collect(
      screenStream(chunks(["ab", "cd", "ef"]), async (t) => (seen.push(t), true), {
        window: 4,
        overlap: 0,
      })
    );
    expect(seen).toEqual(["abcd", "ef"]);
    expect(
      ev.filter((e) => e.kind === "text").map((e) => (e as { text: string }).text)
    ).toEqual(["abcd", "ef"]);
  });

  it("catches a term split across two windows (overlap)", async () => {
    const ev = await collect(
      screenStream(chunks(["xxxB", "ADyy"]), noBad, { window: 4, overlap: 3 })
    );
    expect(released(ev)).toBe("xxxB");
    expect(terminal(ev)).toBe("rejected");
  });

  it("withholds a window on rejection and stops reading the source", async () => {
    let read = 0;
    async function* src(): AsyncGenerator<AIStreamChunk> {
      for (const t of ["ok ", "BAD", "more", "more"]) {
        read++;
        yield { text: t, done: false };
      }
      yield { text: "", done: true };
    }
    const ev = await collect(screenStream(src(), noBad, { window: 3, overlap: 2 }));
    expect(released(ev)).toBe("ok ");
    expect(terminal(ev)).toBe("rejected");
    expect(read).toBe(2);
  });

  it.each([
    [
      "throws",
      async () => {
        throw new Error("classifier down");
      },
    ],
    ["answers a non-boolean", async () => "yes" as unknown as boolean],
  ])("withholds the text when the screen %s", async (_label, screen) => {
    const ev = await collect(screenStream(chunks(["secret"]), screen));
    expect(released(ev)).toBe("");
    expect(["failed", "rejected"]).toContain(terminal(ev));
  });

  it("reports a source failure as failed, after only screened text", async () => {
    async function* src(): AsyncGenerator<AIStreamChunk> {
      yield { text: "abcd", done: false };
      throw new Error("upstream");
    }
    const ev = await collect(screenStream(src(), allow, { window: 4 }));
    expect(released(ev)).toBe("abcd");
    expect(terminal(ev)).toBe("failed");
  });

  it("screens and releases what is left when the source ends without a final chunk", async () => {
    const ev = await collect(screenStream(chunks(["ab"], false), allow, { window: 10 }));
    expect(released(ev)).toBe("ab");
    expect(terminal(ev)).toBe("done");
  });

  it("property: released text never contains a banned term, however it is chunked", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("a", "B", "A", "D", "BAD", " ", "xyz"), {
          maxLength: 30,
        }),
        fc.integer({ min: 1, max: 8 }),
        async (parts, window) => {
          const ev = await collect(
            screenStream(chunks(parts), noBad, { window, overlap: 2 })
          );
          expect(released(ev)).not.toContain("BAD");
          expect(ev.filter((e) => e.kind !== "text")).toHaveLength(1);
        }
      )
    );
  });

  it("property: with nothing banned, the output is exactly the input", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { maxLength: 20 }),
        fc.integer({ min: 1, max: 50 }),
        async (parts, window) => {
          const ev = await collect(screenStream(chunks(parts), allow, { window }));
          expect(released(ev)).toBe(parts.join(""));
          expect(terminal(ev)).toBe("done");
        }
      )
    );
  });
});
