/**
 * __tests__/browser-recorder.test.ts — the recorder core with a fake MediaRecorder and a fake
 * clock (TASK-234; DESIGN-56f1 §4.3, tests T13–T17). No wall clock: the clock is injected.
 */

import {
  RECORDER_TYPES,
  RecorderError,
  acquireMicrophone,
  classifyMicrophoneError,
  pickRecorderType,
  startRecording,
  type Clock,
} from "@/platform/voice/browser-recorder";

class FakeClock implements Clock {
  now = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number);
  }
  /** Runs every timer due up to now + ms, in time order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers)
        if (e[1].at <= end && (!due || e[1].at < due[1].at)) due = e;
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = end;
  }
  get pending(): number {
    return this.timers.size;
  }
}

class FakeTrack {
  stopped = 0;
  listeners = new Set<() => void>();
  addEventListener(_t: "ended", fn: () => void) {
    this.listeners.add(fn);
  }
  removeEventListener(_t: "ended", fn: () => void) {
    this.listeners.delete(fn);
  }
  stop() {
    this.stopped++;
  }
  end() {
    for (const fn of [...this.listeners]) fn();
  }
}

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static supported: Record<string, boolean> = {};
  static isTypeSupported(t: string) {
    return FakeRecorder.supported[t] === true;
  }
  state: "inactive" | "recording" = "inactive";
  startArgs: unknown[][] = [];
  stops = 0;
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  payload: Blob[] = [new Blob(["abc"]), new Blob([""]), new Blob(["def"])];
  constructor(
    public stream: unknown,
    o: { mimeType: string }
  ) {
    if (FakeRecorder.failConstruct) throw FakeRecorder.failConstruct;
    this.mimeType = o.mimeType;
    FakeRecorder.instances.push(this);
  }
  static failConstruct: unknown = null;
  static failStart: unknown = null;
  start(...args: unknown[]) {
    if (FakeRecorder.failStart) throw FakeRecorder.failStart;
    this.startArgs.push(args);
    this.state = "recording";
  }
  stop() {
    this.stops++;
    this.state = "inactive";
    for (const data of this.payload) this.ondataavailable?.({ data });
    this.onstop?.();
  }
}

class FakeDocument {
  visibilityState: "visible" | "hidden" = "visible";
  listeners = new Set<() => void>();
  addEventListener(_t: string, fn: () => void) {
    this.listeners.add(fn);
  }
  removeEventListener(_t: string, fn: () => void) {
    this.listeners.delete(fn);
  }
  hide() {
    this.visibilityState = "hidden";
    for (const fn of [...this.listeners]) fn();
  }
}

const g = globalThis as Record<string, unknown>;
const saved = {
  MediaRecorder: g.MediaRecorder,
  document: g.document,
  navigator: g.navigator,
};
let doc: FakeDocument;
let track: FakeTrack;
let stream: MediaStream;

beforeEach(() => {
  FakeRecorder.instances = [];
  FakeRecorder.supported = { "audio/webm;codecs=opus": true };
  FakeRecorder.failConstruct = null;
  FakeRecorder.failStart = null;
  g.MediaRecorder = FakeRecorder;
  doc = new FakeDocument();
  g.document = doc;
  track = new FakeTrack();
  stream = { getTracks: () => [track] } as unknown as MediaStream;
});
afterEach(() => {
  g.MediaRecorder = saved.MediaRecorder;
  g.document = saved.document;
  Object.defineProperty(globalThis, "navigator", {
    value: saved.navigator,
    configurable: true,
    writable: true,
  });
});

function setNavigator(value: unknown) {
  Object.defineProperty(globalThis, "navigator", {
    value,
    configurable: true,
    writable: true,
  });
}

describe("start() with no timeslice (T13, WB-8)", () => {
  it("calls recorder.start with no argument and keeps the recorder's MIME type", async () => {
    const clock = new FakeClock();
    const rec = startRecording(stream, {
      mimeType: "audio/webm;codecs=opus",
      maxSeconds: 5,
      clock,
    });
    const r = FakeRecorder.instances[0];
    expect(r.startArgs).toEqual([[]]);
    r.mimeType = "audio/webm;codecs=opus";
    rec.stop();
    const blob = await rec.result;
    expect(blob.type).toBe("audio/webm;codecs=opus");
    expect(await blob.text()).toBe("abcdef");
  });
});

describe("the fix round (CODE-REVIEW-A/B)", () => {
  const named = (name: string) => Object.assign(new Error(name), { name });

  it("RB-2: the Blob carries the type the recorder reports, not the one asked for", async () => {
    const clock = new FakeClock();
    const rec = startRecording(stream, { mimeType: "audio/webm", maxSeconds: 5, clock });
    FakeRecorder.instances[0].mimeType = "audio/webm;codecs=opus";
    rec.stop();
    expect((await rec.result).type).toBe("audio/webm;codecs=opus");
    const rec2 = startRecording(stream, { mimeType: "audio/webm", maxSeconds: 5, clock });
    FakeRecorder.instances[1].mimeType = "";
    rec2.stop();
    expect((await rec2.result).type).toBe("audio/webm");
  });

  it.each([
    ["NotSupportedError", "browser_unsupported"],
    ["SecurityError", "recording_interrupted"],
  ])(
    "RA-2: a recorder that cannot be made (%s) → %s, microphone stopped, nothing attached",
    (name, code) => {
      FakeRecorder.failConstruct = named(name);
      let e: unknown;
      try {
        startRecording(stream, {
          mimeType: "audio/webm",
          maxSeconds: 5,
          clock: new FakeClock(),
        });
      } catch (x) {
        e = x;
      }
      expect(e).toBeInstanceOf(RecorderError);
      expect((e as RecorderError).code).toBe(code);
      expect(track.stopped).toBe(1);
      expect(track.listeners.size).toBe(0);
      expect(doc.listeners.size).toBe(0);
    }
  );

  it.each([
    ["NotSupportedError", "browser_unsupported"],
    ["InvalidStateError", "recording_interrupted"],
  ])(
    "RA-2/RB-10: start() throwing (%s) → %s, microphone stopped, listeners and timers gone",
    async (name, code) => {
      FakeRecorder.failStart = named(name);
      const clock = new FakeClock();
      let e: unknown;
      try {
        startRecording(stream, { mimeType: "audio/webm", maxSeconds: 5, clock });
      } catch (x) {
        e = x;
      }
      expect((e as RecorderError).code).toBe(code);
      expect(track.stopped).toBe(1);
      expect(track.listeners.size).toBe(0);
      expect(doc.listeners.size).toBe(0);
      expect(clock.pending).toBe(0);
    }
  );

  it("RA-7: hidden or a track ending after Stop keeps the complete recording", async () => {
    class LateStop extends FakeRecorder {
      stop() {
        this.stops++;
        this.state = "inactive";
      }
      deliver() {
        for (const data of this.payload) this.ondataavailable?.({ data });
        this.onstop?.();
      }
    }
    g.MediaRecorder = LateStop;
    const rec = startRecording(stream, {
      mimeType: "audio/webm",
      maxSeconds: 5,
      clock: new FakeClock(),
    });
    rec.stop();
    doc.hide();
    track.end();
    (FakeRecorder.instances[0] as LateStop).deliver();
    expect(await (await rec.result).text()).toBe("abcdef");
  });
});

describe("the timer (T14)", () => {
  it("stops at maxSeconds exactly once; onTick counts down", async () => {
    const clock = new FakeClock();
    const ticks: number[] = [];
    const rec = startRecording(stream, {
      mimeType: "audio/webm;codecs=opus",
      maxSeconds: 3,
      clock,
      onTick: (s) => ticks.push(s),
    });
    clock.advance(2999);
    expect(FakeRecorder.instances[0].stops).toBe(0);
    clock.advance(1);
    expect(FakeRecorder.instances[0].stops).toBe(1);
    expect(ticks).toEqual([3, 2, 1]);
    rec.stop();
    clock.advance(10000);
    expect(FakeRecorder.instances[0].stops).toBe(1);
    expect((await rec.result).size).toBe(6);
    expect(track.stopped).toBe(1);
    expect(clock.pending).toBe(0);
  });

  it("a manual stop and then the timer stop it once; the timer is cleared", async () => {
    const clock = new FakeClock();
    const rec = startRecording(stream, {
      mimeType: "audio/webm;codecs=opus",
      maxSeconds: 3,
      clock,
    });
    clock.advance(1500);
    rec.stop();
    rec.stop();
    clock.advance(5000);
    expect(FakeRecorder.instances[0].stops).toBe(1);
    expect(clock.pending).toBe(0);
    await expect(rec.result).resolves.toBeInstanceOf(Blob);
  });

  it("a recorder already inactive at stop still settles the result", async () => {
    const clock = new FakeClock();
    const rec = startRecording(stream, {
      mimeType: "audio/webm;codecs=opus",
      maxSeconds: 3,
      clock,
    });
    FakeRecorder.instances[0].state = "inactive";
    rec.stop();
    await expect(rec.result).rejects.toMatchObject({ code: "recording_interrupted" });
  });

  it("uses the real timers when no clock is given", async () => {
    jest.useFakeTimers();
    try {
      const rec = startRecording(stream, {
        mimeType: "audio/webm;codecs=opus",
        maxSeconds: 2,
      });
      jest.advanceTimersByTime(2000);
      expect(FakeRecorder.instances[0].stops).toBe(1);
      await expect(rec.result).resolves.toBeInstanceOf(Blob);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([0, -1, NaN, Infinity])("maxSeconds %p throws TypeError", (maxSeconds) => {
    expect(() => startRecording(stream, { mimeType: "audio/webm", maxSeconds })).toThrow(
      TypeError
    );
  });

  it("an empty MIME type throws TypeError", () => {
    expect(() => startRecording(stream, { mimeType: "", maxSeconds: 3 })).toThrow(
      TypeError
    );
  });
});

describe("interruptions are failures, never partial sends (T15)", () => {
  async function interrupted(cause: (r: FakeRecorder) => void) {
    const clock = new FakeClock();
    const rec = startRecording(stream, {
      mimeType: "audio/webm;codecs=opus",
      maxSeconds: 10,
      clock,
    });
    clock.advance(2000);
    cause(FakeRecorder.instances[0]);
    await expect(rec.result).rejects.toBeInstanceOf(RecorderError);
    await expect(rec.result).rejects.toMatchObject({ code: "recording_interrupted" });
    expect(track.stopped).toBe(1);
    expect(track.listeners.size).toBe(0);
    expect(doc.listeners.size).toBe(0);
    expect(clock.pending).toBe(0);
  }

  it("the track ends (device unplugged, iOS interruption)", () =>
    interrupted(() => track.end()));
  it("the recorder reports an error", () => interrupted((r) => r.onerror?.()));
  it("the page becomes hidden", () => interrupted(() => doc.hide()));

  it("a page already hidden at start", async () => {
    doc.visibilityState = "hidden";
    const rec = startRecording(stream, {
      mimeType: "audio/webm;codecs=opus",
      maxSeconds: 10,
      clock: new FakeClock(),
    });
    await expect(rec.result).rejects.toMatchObject({ code: "recording_interrupted" });
  });

  it("an empty recording is a failure, not a Blob", async () => {
    const clock = new FakeClock();
    const rec = startRecording(stream, {
      mimeType: "audio/webm;codecs=opus",
      maxSeconds: 1,
      clock,
    });
    FakeRecorder.instances[0].payload = [new Blob([""])];
    clock.advance(1000);
    await expect(rec.result).rejects.toMatchObject({ code: "recording_interrupted" });
  });

  it("a visibility change to visible is not an interruption", async () => {
    const clock = new FakeClock();
    const rec = startRecording(stream, {
      mimeType: "audio/webm;codecs=opus",
      maxSeconds: 1,
      clock,
    });
    for (const fn of doc.listeners) fn();
    clock.advance(1000);
    await expect(rec.result).resolves.toBeInstanceOf(Blob);
  });

  it("works without a document (no visibility to watch)", async () => {
    g.document = undefined;
    const clock = new FakeClock();
    const rec = startRecording(stream, {
      mimeType: "audio/webm;codecs=opus",
      maxSeconds: 1,
      clock,
    });
    clock.advance(1000);
    await expect(rec.result).resolves.toBeInstanceOf(Blob);
  });
});

describe("the recorder type (T16)", () => {
  it("the default order is WebM/Opus then Ogg/Opus; mp4 is never chosen", () => {
    expect(RECORDER_TYPES).toEqual(["audio/webm;codecs=opus", "audio/ogg;codecs=opus"]);
    FakeRecorder.supported = {
      "audio/webm;codecs=opus": true,
      "audio/ogg;codecs=opus": true,
    };
    expect(pickRecorderType()).toBe("audio/webm;codecs=opus");
    FakeRecorder.supported = { "audio/ogg;codecs=opus": true, "audio/mp4": true };
    expect(pickRecorderType()).toBe("audio/ogg;codecs=opus");
    FakeRecorder.supported = { "audio/mp4": true };
    expect(pickRecorderType()).toBeNull();
  });

  it("no MediaRecorder, or one without isTypeSupported, or a throwing one → null", () => {
    g.MediaRecorder = undefined;
    expect(pickRecorderType()).toBeNull();
    g.MediaRecorder = function NoCheck() {};
    expect(pickRecorderType()).toBeNull();
    g.MediaRecorder = Object.assign(function Throws() {}, {
      isTypeSupported: () => {
        throw new Error("x");
      },
    });
    expect(pickRecorderType()).toBeNull();
  });

  it("none supported → browser_unsupported and the microphone is never opened", async () => {
    FakeRecorder.supported = { "audio/mp4": true };
    const getUserMedia = jest.fn();
    setNavigator({ mediaDevices: { getUserMedia } });
    await expect(acquireMicrophone()).rejects.toMatchObject({
      code: "browser_unsupported",
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("no microphone API → browser_unsupported", async () => {
    setNavigator({});
    await expect(acquireMicrophone()).rejects.toMatchObject({
      code: "browser_unsupported",
    });
  });
});

describe("microphone failures told apart (T17)", () => {
  it.each([
    ["NotAllowedError", "microphone_blocked"],
    ["SecurityError", "microphone_blocked"],
    ["NotFoundError", "microphone_missing"],
    ["OverconstrainedError", "microphone_missing"],
    ["NotReadableError", "microphone_unavailable"],
    ["AbortError", "microphone_unavailable"],
  ])("%s → %s", async (name, code) => {
    const err = Object.assign(new Error("x"), { name });
    setNavigator({ mediaDevices: { getUserMedia: () => Promise.reject(err) } });
    const e = await acquireMicrophone().catch((x) => x);
    expect(e).toBeInstanceOf(RecorderError);
    expect(e.code).toBe(code);
    expect(e.cause).toBe(err);
    expect(classifyMicrophoneError(err)).toBe(code);
  });

  it("a value with no name → microphone_unavailable", () => {
    expect(classifyMicrophoneError("x")).toBe("microphone_unavailable");
    expect(classifyMicrophoneError(null)).toBe("microphone_unavailable");
  });

  it("a granted microphone is returned", async () => {
    const s = { id: "mic" };
    const getUserMedia = jest.fn().mockResolvedValue(s);
    setNavigator({ mediaDevices: { getUserMedia } });
    await expect(acquireMicrophone()).resolves.toBe(s);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
  });
});
