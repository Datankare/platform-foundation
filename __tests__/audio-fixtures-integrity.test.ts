/**
 * __tests__/audio-fixtures-integrity.test.ts — the committed test audio is exactly what was made
 * (TASK-234; DESIGN-56f1 §6.1, test T19)
 *
 * @guard an altered, unlisted or missing audio fixture, a C2PA/JUMBF manifest added to one, or an
 * audio file tracked outside __tests__/fixtures/audio/
 *
 * Decoders skip unknown boxes and chunks, so an altered fixture passes every other test: a storage
 * that added a signed C2PA manifest to 9 of the first design's 15 files was noticed only by
 * reading the bytes. This test reads them: every media file in the folder is listed in SHA256SUMS
 * with its digest, every listed file exists, and none holds the bytes `c2pa` or `jumb` (any
 * case). The listed files are exactly the twelve the generator script makes and the two Safari
 * recordings it carries by name, size and digest (they cannot be made again). `generate.ts`, `README.md` and `SHA256SUMS` are the folder's three non-media files.
 * "Audio elsewhere" reads `git ls-files` (tracked files only), so untracked browser output,
 * node_modules or a scratch clone never fail it.
 */

import { execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DERIVED_FIXTURES,
  GENERATED_FIXTURES,
  lyingFlacLength,
  repeatedLiveWebm,
  webmOpusSilenceNoDuration,
} from "./fixtures/audio/generate";

const FOLDER = "__tests__/fixtures/audio";
const NON_MEDIA = new Set(["generate.ts", "README.md", "SHA256SUMS"]);
const AUDIO_EXT =
  /\.(?:wav|wave|mp3|m4a|m4b|m4r|mp4|mov|aac|webm|weba|mka|mkv|ogg|oga|opus|spx|flac|caf|aif|aiff|amr|3gp|3g2|wma)$/i;
const MARKERS = [/c2pa/i, /jumb/i];

const sha256 = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * The folder's files as git sees them: tracked, plus untracked files that are not ignored — so a
 * new unlisted file still fails, but a file git ignores (Finder's .DS_Store on the owner's Mac)
 * does not. Fails loudly outside a git work tree.
 */
export function folderFiles(dir: string): string[] {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
    {
      cwd: dir,
      maxBuffer: 16 << 20,
    }
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

/** Every way a fixture folder differs from its SHA256SUMS; [] when it matches. */
export function folderProblems(dir: string): string[] {
  const out: string[] = [];
  const sumsText = readFileSync(join(dir, "SHA256SUMS"), "utf8");
  const lines = sumsText.split("\n").filter((l) => l !== "");
  if (!/^# ffmpeg version /.test(lines[0] ?? ""))
    out.push("SHA256SUMS: first line is not the ffmpeg version");
  const listed = new Map<string, string>();
  for (const line of lines) {
    if (line.startsWith("# ")) continue;
    const m = /^([0-9a-f]{64}) {2}([^/\s]+)$/.exec(line);
    if (!m) {
      out.push(`SHA256SUMS: unreadable line "${line}"`);
      continue;
    }
    listed.set(m[2], m[1]);
  }
  const media = folderFiles(dir).filter((f) => !NON_MEDIA.has(f));
  for (const f of media) {
    const bytes = readFileSync(join(dir, f));
    const want = listed.get(f);
    if (want === undefined) out.push(`${f}: not listed in SHA256SUMS`);
    else if (sha256(bytes) !== want) out.push(`${f}: checksum differs from SHA256SUMS`);
    const text = bytes.toString("latin1");
    for (const m of MARKERS)
      if (m.test(text)) out.push(`${f}: holds the bytes ${m.source}`);
  }
  for (const f of listed.keys())
    if (!media.includes(f)) out.push(`${f}: listed but missing`);
  return out.sort();
}

/** Tracked audio files outside the one fixture folder. */
export function audioElsewhere(tracked: readonly string[]): string[] {
  return tracked.filter((f) => AUDIO_EXT.test(f) && !f.startsWith(`${FOLDER}/`));
}

/** The generator script's two lists: the files it makes and the recordings it carries. */
function generatorLists(): {
  made: string[];
  recorded: Array<{ name: string; bytes: number; sha256: string; madeBy: string }>;
} {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import("./scripts/make-audio-fixtures.mjs").then((m) => console.log(JSON.stringify({ made: m.FIXTURES.map(([n]) => n), recorded: m.RECORDED })))',
      ],
      { encoding: "utf8" }
    )
  );
}

function gitTracked(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { maxBuffer: 64 << 20 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

describe("the committed audio fixtures (T19, WB-1)", () => {
  it("match SHA256SUMS: listed, present, unchanged, no C2PA/JUMBF bytes", () => {
    expect(folderProblems(FOLDER)).toEqual([]);
  });

  it("are the twelve encoder-made files and Safari's two recordings (WB-21) — and no other", () => {
    const listed = readFileSync(join(FOLDER, "SHA256SUMS"), "utf8")
      .split("\n")
      .filter((l) => /^[0-9a-f]{64}/.test(l))
      .map((l) => l.slice(66));
    const known = generatorLists();
    expect(known.made).toHaveLength(12);
    expect(known.recorded.map((r) => r.name)).toEqual([
      "safari-26.6.2-mp4.m4a",
      "safari-26.6.2-webm.webm",
    ]);
    expect(listed).toEqual([...known.made, ...known.recorded.map((r) => r.name)].sort());
  });

  it("WB-21: each Safari recording is the bytes the generator script carries (name, size, SHA-256)", () => {
    for (const r of generatorLists().recorded) {
      const bytes = readFileSync(join(FOLDER, r.name));
      expect([r.name, bytes.length, sha256(bytes)]).toEqual([r.name, r.bytes, r.sha256]);
    }
  });

  it("E-12: the generator script writes this SHA256SUMS, the recordings' rows included", () => {
    const committed = readFileSync(join(FOLDER, "SHA256SUMS"), "utf8");
    const version = committed.split("\n")[0].slice(2);
    const recorded = new Set(generatorLists().recorded.map((r) => r.name));
    const made = [...committed.matchAll(/^([0-9a-f]{64}) {2}(\S+)$/gm)]
      .filter((m) => !recorded.has(m[2]))
      .map((m) => [m[2], m[1]]);
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import("./scripts/make-audio-fixtures.mjs").then((m) => process.stdout.write(m.sumsFile(process.env.V, JSON.parse(process.env.MADE))))',
      ],
      {
        encoding: "utf8",
        env: { ...process.env, V: version, MADE: JSON.stringify(made.reverse()) },
      }
    );
    expect(out).toBe(committed);
  });

  it("E-12: a name listed twice is refused, not written", () => {
    const r = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import("./scripts/make-audio-fixtures.mjs").then((m) => m.sumsFile("v", [["safari-26.6.2-mp4.m4a", "00"]]))',
      ],
      { encoding: "utf8" }
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/a file name is listed twice/);
  });

  it("no audio file is tracked outside the fixture folder (git ls-files)", () => {
    expect(audioElsewhere(gitTracked())).toEqual([]);
  });

  it("the README's digests and ffmpeg line are SHA256SUMS's", () => {
    const sums = readFileSync(join(FOLDER, "SHA256SUMS"), "utf8");
    const readme = readFileSync(join(FOLDER, "README.md"), "utf8").replace(/\s+/g, " ");
    const version = sums.split("\n")[0].slice(2).trim();
    expect(readme).toContain(version.replace(/\s+/g, " "));
    for (const m of sums.matchAll(/^([0-9a-f]{64}) {2}(\S+)$/gm)) {
      expect([m[2], readme.includes(m[1])]).toEqual([m[2], true]);
    }
  });
});

describe("the integrity check refuses each planted fault (self-tests)", () => {
  let dir: string;
  const good = Buffer.from("fLaC-not-really-audio-but-bytes");
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audio-fixtures-"));
    execFileSync("git", ["init", "-q", dir]);
    writeFileSync(join(dir, ".git", "info", "exclude"), ".DS_Store\n");
    writeFileSync(join(dir, "tone.flac"), good);
    writeFileSync(join(dir, "generate.ts"), "// c2pa in a non-media file is fine");
    writeFileSync(join(dir, "README.md"), "C2PA is named here");
    writeFileSync(
      join(dir, "SHA256SUMS"),
      `# ffmpeg version 6.1.1\n${sha256(good)}  tone.flac\n`
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("[self-test] a clean folder passes (the three non-media files exempt)", () => {
    expect(folderProblems(dir)).toEqual([]);
  });

  it("[self-test] RB-11: a file git ignores (.DS_Store) is not counted; an unignored new file is", () => {
    writeFileSync(join(dir, ".DS_Store"), "finder");
    expect(folderProblems(dir)).toEqual([]);
    writeFileSync(join(dir, "new.m4a"), "x");
    expect(folderProblems(dir)).toEqual(["new.m4a: not listed in SHA256SUMS"]);
  });

  it("[self-test] one byte changed", () => {
    const b = Buffer.from(good);
    b[3] ^= 1;
    writeFileSync(join(dir, "tone.flac"), b);
    expect(folderProblems(dir)).toEqual(["tone.flac: checksum differs from SHA256SUMS"]);
  });

  it.each(["c2pa", "C2PA", "jumb", "JUMB"])("[self-test] %s inserted", (marker) => {
    const b = Buffer.concat([good, Buffer.from(marker, "latin1")]);
    writeFileSync(join(dir, "tone.flac"), b);
    writeFileSync(
      join(dir, "SHA256SUMS"),
      `# ffmpeg version 6.1.1\n${sha256(b)}  tone.flac\n`
    );
    expect(folderProblems(dir)).toEqual([
      `tone.flac: holds the bytes ${marker.toLowerCase()}`,
    ]);
  });

  it("[self-test] an unlisted file", () => {
    writeFileSync(join(dir, "extra.m4a"), "x");
    expect(folderProblems(dir)).toEqual(["extra.m4a: not listed in SHA256SUMS"]);
  });

  it("[self-test] a listed file missing", () => {
    rmSync(join(dir, "tone.flac"));
    expect(folderProblems(dir)).toEqual(["tone.flac: listed but missing"]);
  });

  it("[self-test] no version line, an unreadable line", () => {
    writeFileSync(join(dir, "SHA256SUMS"), `${sha256(good)}  tone.flac\nnonsense\n`);
    expect(folderProblems(dir)).toEqual(
      [
        'SHA256SUMS: unreadable line "nonsense"',
        "SHA256SUMS: first line is not the ffmpeg version",
      ].sort()
    );
  });

  it("[self-test] a .wav tracked outside the folder; untracked files are never seen", () => {
    expect(
      audioElsewhere([
        "test-fixtures/audio/tone-12s.wav",
        "__tests__/fixtures/audio/tone.m4a",
        "docs/README.md",
        "public/sound.MP3",
        "docs/memo.m4b",
        "e2e/clip.mkv",
        "assets/voice.wma",
      ])
    ).toEqual([
      "test-fixtures/audio/tone-12s.wav",
      "public/sound.MP3",
      "docs/memo.m4b",
      "e2e/clip.mkv",
      "assets/voice.wma",
    ]);
  });
});

describe("generate.ts is deterministic (T23)", () => {
  it.each(Object.keys(GENERATED_FIXTURES))("%s: two calls, the same SHA-256", (name) => {
    expect(sha256(GENERATED_FIXTURES[name]())).toBe(sha256(GENERATED_FIXTURES[name]()));
  });

  it("the sizes the design states", () => {
    expect(GENERATED_FIXTURES["tone-59s-48k-stereo.wav"]().length).toBe(
      44 + 59 * 48000 * 4
    );
    expect(GENERATED_FIXTURES["nodur-30min.webm"]().length).toBe(1444596);
    expect(GENERATED_FIXTURES["garbage.bin"]().length).toBe(30000);
    expect(GENERATED_FIXTURES["empty.bin"]().length).toBe(0);
  });
});

describe("scripts/make-audio-fixtures.mjs refuses the storage that rewrites media (E-12)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "make-fixtures-"));
    mkdirSync(join(dir, "store"));
    symlinkSync(join(dir, "store"), join(dir, "storelink"));
    mkdirSync(join(dir, "elsewhere"));
    symlinkSync(join(dir, "storelink"), join(dir, "elsewhere", "via"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (target: string | undefined, refusedDir: string) =>
    spawnSync(
      process.execPath,
      ["scripts/make-audio-fixtures.mjs", ...(target === undefined ? [] : [target])],
      {
        encoding: "utf8",
        env: { ...process.env, AUDIO_FIXTURES_REFUSED_DIR: refusedDir },
      }
    );

  it.each([
    ["the storage itself", "store/new"],
    ["the storage through a symbolic link to it", "storelink/new"],
    ["a link chain into the storage", "elsewhere/via/new"],
  ])("%s: exits 2 and writes nothing", (_n, target) => {
    // The stand-in storage is itself named through a link, as /mnt/user-data/outputs is one.
    const r = run(join(dir, target), join(dir, "storelink"));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/refused: .* \(that storage rewrites media files\)/);
    expect(readdirSync(join(dir, "store"))).toEqual([]);
  });

  it("RB-12: the test stand-in ADDS to the refusal; the real storage stays refused", () => {
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import("./scripts/make-audio-fixtures.mjs").then((m) => console.log(JSON.stringify([m.refused("/mnt/user-data/outputs/x"), m.refused(process.env.AUDIO_FIXTURES_REFUSED_DIR + "/y")])))',
      ],
      {
        encoding: "utf8",
        env: { ...process.env, AUDIO_FIXTURES_REFUSED_DIR: join(dir, "store") },
      }
    );
    expect(JSON.parse(out)).toEqual([true, true]);
  });

  it("RB-13: every encode puts -threads 1 after its inputs (it then governs the encoder)", () => {
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import("./scripts/make-audio-fixtures.mjs").then((m) => console.log(JSON.stringify(m.FIXTURES.map(([n, a]) => { const v = m.ffmpegArgv(a, n); return v.indexOf("-threads") > v.lastIndexOf("-i"); }))))',
      ],
      { encoding: "utf8" }
    );
    const all = JSON.parse(out) as boolean[];
    expect(all).toHaveLength(12);
    expect(all.every(Boolean)).toBe(true);
  });

  it("no directory: exits 2 with its usage", () => {
    const r = run(undefined, join(dir, "store"));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/);
    expect(existsSync(join(dir, "store", "SHA256SUMS"))).toBe(false);
  });
});

describe("the lying-length FLAC (RA-1, RB-19)", () => {
  const bomb = readFileSync(join(FOLDER, "bomb-1h.flac"));
  const declared = (b: Uint8Array) => {
    const d = Buffer.from(b.subarray(8, 8 + 34));
    return (d[13] & 0x0f) * 2 ** 32 + d.readUInt32BE(14);
  };

  it("declares 160 000 samples (10 s) while holding the first 110 000 bytes of an hour", () => {
    expect(declared(bomb)).toBe(57600000);
    const lie = DERIVED_FIXTURES["lying-length.flac"]({ "bomb-1h.flac": bomb });
    expect(lie.length).toBe(110000);
    expect(declared(lie)).toBe(160000);
    // Only the 36-bit total changed; the rate/channels/bits nibble before it is kept.
    expect(Buffer.from(lie.subarray(0, 21))).toEqual(Buffer.from(bomb.subarray(0, 21)));
    expect(lie[21] >> 4).toBe(bomb[21] >> 4);
    expect(Buffer.from(lie.subarray(26, 110000))).toEqual(
      Buffer.from(bomb.subarray(26, 110000))
    );
  });

  it("never changes the committed file it is made from (a copy, not a view)", () => {
    const copy = Buffer.from(bomb);
    lyingFlacLength(copy, 110000, 160000);
    expect(sha256(copy)).toBe(sha256(bomb));
  });

  it("is deterministic, and refuses a file that is not a FLAC", () => {
    expect(sha256(lyingFlacLength(bomb, 110000, 160000))).toBe(
      sha256(lyingFlacLength(bomb, 110000, 160000))
    );
    expect(() => lyingFlacLength(new Uint8Array(100), 50, 1)).toThrow(TypeError);
  });
});

describe("the long duration-less WebM in a real recorder's form (R4)", () => {
  const rec = readFileSync(join(FOLDER, "safari-26.6.2-webm.webm"));
  const CLUSTER = Buffer.from([
    0x1f, 0x43, 0xb6, 0x75, 1, 255, 255, 255, 255, 255, 255, 255,
  ]);
  const count = (b: Uint8Array, needle: Buffer) => {
    let n = 0;
    for (let i = Buffer.from(b).indexOf(needle); i >= 0;) {
      n++;
      i = Buffer.from(b).indexOf(needle, i + 1);
    }
    return n;
  };

  it("is Safari's recording 20 times over: its header kept, 20 Clusters of unknown size 4010 ms apart, no Duration, no Cues", () => {
    const first = rec.indexOf(CLUSTER);
    expect(first).toBe(146);
    // The recording: one Cluster (Timecode 0), 1604 SimpleBlocks, then Cues to the end of the file.
    const cues = rec.indexOf(Buffer.from([0x1c, 0x53, 0xbb, 0x6b]));
    const blocks = rec.subarray(first + 12 + 3, cues);
    const long = Buffer.from(
      DERIVED_FIXTURES["nodur-80s-safari-form.webm"]({ "safari-26.6.2-webm.webm": rec })
    );
    expect(long.length).toBe(146 + 20 * (12 + 6 + blocks.length));
    expect(long.subarray(0, 146)).toEqual(rec.subarray(0, 146));
    expect(count(long, CLUSTER)).toBe(20);
    for (const c of [0, 1, 19]) {
      const at = 146 + c * (12 + 6 + blocks.length);
      expect(long.subarray(at, at + 12)).toEqual(CLUSTER);
      expect([...long.subarray(at + 12, at + 14)]).toEqual([0xe7, 0x84]);
      expect(long.readUInt32BE(at + 14)).toBe(c * 4010);
      expect(sha256(long.subarray(at + 18, at + 18 + blocks.length))).toBe(
        sha256(blocks)
      );
    }
    // Still states no length anywhere: Segment (at 36) of unknown size, no Duration (44 89), no Cues.
    expect(long.subarray(40, 48)).toEqual(
      Buffer.from([1, 255, 255, 255, 255, 255, 255, 255])
    );
    expect(long.subarray(0, 146).includes(Buffer.from([0x44, 0x89]))).toBe(false);
    expect(long.includes(Buffer.from([0x1c, 0x53, 0xbb, 0x6b]))).toBe(false);
  });

  it("never changes the committed recording, and is deterministic", () => {
    const copy = Buffer.from(rec);
    const a = repeatedLiveWebm(copy, 3, 4010);
    expect(sha256(copy)).toBe(sha256(rec));
    expect(sha256(a)).toBe(sha256(repeatedLiveWebm(rec, 3, 4010)));
    expect(a.length).toBeLessThan(repeatedLiveWebm(rec, 4, 4010).length);
  });

  it("refuses any other layout: not WebM, a file that states its duration, several Clusters, a cut block, bad counts", () => {
    const refuses = (b: Uint8Array, copies = 2, ms = 4010) => {
      try {
        repeatedLiveWebm(b, copies, ms);
        return "made";
      } catch (e) {
        return e instanceof TypeError ? e.message : `threw ${String(e)}`;
      }
    };
    expect(refuses(readFileSync(join(FOLDER, "tone.flac")))).toMatch(
      /not an EBML|no EBML header/
    );
    // An encoder-made WebM: a Segment of known size, a Duration.
    expect(refuses(readFileSync(join(FOLDER, "tone.webm")))).toBe(
      "not a one-cluster live WebM: no Segment of unknown size"
    );
    // The generated duration-less file of 30 s has two Clusters.
    expect(refuses(webmOpusSilenceNoDuration(30))).toBe(
      "not a one-cluster live WebM: element 1F43B675 after its Cluster"
    );
    // A Duration put into Info's place (the 2 bytes of an element of the same size renamed).
    const stated = Buffer.from(rec);
    const info = stated.indexOf(Buffer.from([0x15, 0x49, 0xa9, 0x66]));
    const muxer = stated.indexOf(Buffer.from([0x4d, 0x80]), info);
    stated[muxer] = 0x44;
    stated[muxer + 1] = 0x89;
    expect(refuses(stated)).toBe("not a one-cluster live WebM: it states a Duration");
    expect(refuses(rec.subarray(0, 146))).toBe("not a one-cluster live WebM: no Cluster");
    expect(refuses(rec.subarray(0, 146 + 12 + 3))).toBe(
      "not a one-cluster live WebM: its Cluster holds no whole SimpleBlock"
    );
    expect(refuses(rec.subarray(0, 4000))).toMatch(
      /not a one-cluster live WebM|not an EBML/
    );
    expect(refuses(rec, 0)).toMatch(/whole numbers/);
    expect(refuses(rec, 1.5)).toMatch(/whole numbers/);
    expect(refuses(rec, 2, 0)).toMatch(/too long/);
    expect(refuses(rec, 2 ** 31, 4010)).toMatch(/too long/);
    expect(refuses(rec, 1)).toBe("made");
  });
});
