/**
 * __tests__/kernel-singleton.test.ts
 *
 * The primitive that fixes the bundle split. Its own correctness matters more than most,
 * because every registry in the platform will depend on it.
 */

import {
  getSingleton,
  setSingleton,
  hasSingleton,
  resetSingleton,
  resetAllSingletons,
  singletonKeys,
} from "@/platform/kernel/singleton";

const KEY = "test.singleton.alpha";
const OTHER = "test.singleton.beta";

beforeEach(() => {
  resetAllSingletons();
});

describe("getSingleton", () => {
  it("creates on first access and returns the same value after", () => {
    let created = 0;
    const make = () => {
      created += 1;
      return { id: created };
    };
    const first = getSingleton(KEY, make);
    const second = getSingleton(KEY, make);
    expect(second).toBe(first);
    expect(created).toBe(1);
  });

  it("keeps distinct keys distinct", () => {
    const a = getSingleton(KEY, () => ({ n: 1 }));
    const b = getSingleton(OTHER, () => ({ n: 2 }));
    expect(a).not.toBe(b);
  });

  it("preserves a falsy value rather than re-creating it", () => {
    // A store legitimately holding 0, "" or false must not be rebuilt on every read.
    let created = 0;
    const make = () => {
      created += 1;
      return 0;
    };
    expect(getSingleton(KEY, make)).toBe(0);
    expect(getSingleton(KEY, make)).toBe(0);
    expect(created).toBe(1);
  });
});

describe("setSingleton", () => {
  it("replaces the value", () => {
    getSingleton(KEY, () => "first");
    setSingleton(KEY, "second");
    expect(getSingleton(KEY, () => "unused")).toBe("second");
  });

  it("returns the previous value so a caller can restore it", () => {
    getSingleton(KEY, () => "original");
    const previous = setSingleton(KEY, "replacement");
    expect(previous).toBe("original");
    setSingleton(KEY, previous);
    expect(getSingleton(KEY, () => "unused")).toBe("original");
  });

  it("returns undefined when nothing was set", () => {
    expect(setSingleton(KEY, "first")).toBeUndefined();
  });
});

describe("hasSingleton", () => {
  it("distinguishes unset from set", () => {
    expect(hasSingleton(KEY)).toBe(false);
    getSingleton(KEY, () => "value");
    expect(hasSingleton(KEY)).toBe(true);
  });

  it("does not create the value as a side effect of asking", () => {
    let created = 0;
    hasSingleton(KEY);
    expect(created).toBe(0);
    getSingleton(KEY, () => {
      created += 1;
      return 1;
    });
    expect(created).toBe(1);
  });
});

describe("reset", () => {
  it("makes the next read re-create from the factory", () => {
    let created = 0;
    const make = () => {
      created += 1;
      return created;
    };
    expect(getSingleton(KEY, make)).toBe(1);
    resetSingleton(KEY);
    expect(getSingleton(KEY, make)).toBe(2);
  });

  it("resetSingleton leaves other keys alone", () => {
    getSingleton(KEY, () => "a");
    getSingleton(OTHER, () => "b");
    resetSingleton(KEY);
    expect(hasSingleton(KEY)).toBe(false);
    expect(hasSingleton(OTHER)).toBe(true);
  });

  it("resetAllSingletons clears everything", () => {
    getSingleton(KEY, () => "a");
    getSingleton(OTHER, () => "b");
    resetAllSingletons();
    expect(singletonKeys()).toEqual([]);
  });
});

describe("the store survives a second copy of this module", () => {
  it("a re-imported module instance sees the same values", async () => {
    // The actual defect: the bundler loads a module twice and each copy has its own state.
    // jest.isolateModules gives a genuinely separate module instance, which is the closest
    // reproduction available without a real Next build. If the registry were module-local
    // rather than anchored on globalThis via Symbol.for, this would fail.
    setSingleton(KEY, "written by the first copy");

    let seen: unknown;
    await new Promise<void>((resolve) => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fresh = require("@/platform/kernel/singleton");
        seen = fresh.getSingleton(KEY, () => "created by the second copy");
        resolve();
      });
    });

    expect(seen).toBe("written by the first copy");
  });

  it("keys registered by a second copy are visible to the first", async () => {
    await new Promise<void>((resolve) => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fresh = require("@/platform/kernel/singleton");
        fresh.setSingleton(OTHER, "from the second copy");
        resolve();
      });
    });
    expect(hasSingleton(OTHER)).toBe(true);
  });
});

describe("singletonKeys", () => {
  it("lists what is registered, sorted, for the startup self-check", () => {
    getSingleton(OTHER, () => 1);
    getSingleton(KEY, () => 2);
    expect(singletonKeys()).toEqual([KEY, OTHER].sort());
  });
});
