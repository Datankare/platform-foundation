#!/usr/bin/env node
/**
 * scripts/make-audio-fixtures.mjs — the committed test audio, made with ffmpeg, byte for byte
 * repeatable (TASK-234; DESIGN-56f1 §6)
 *
 * Only files that need an encoder (Opus, Vorbis, AAC, MP3, FLAC) are committed, and the two
 * recordings real Safari made (RECORDED below); every WAV, the duration-less WebM files and the
 * damaged input are made in code by __tests__/fixtures/audio/generate.ts. Run:
 *
 *   node scripts/make-audio-fixtures.mjs <directory>
 *
 * The same ffmpeg build gives the same bytes: every encode is bit-exact (`-fflags +bitexact
 * -flags:a +bitexact`), carries no metadata (`-map_metadata -1`), runs the encoder on one thread (`-threads 1` after the inputs, so it applies to the output), uses fixed
 * `lavfi` sources and a fixed Ogg serial, and writes no ID3 tag. The directory's SHA256SUMS starts
 * with the ffmpeg version line. Another ffmpeg build may give other bytes: then every file is made
 * again, __tests__/fixtures/audio/SHA256SUMS changes in the same commit and the README's version
 * line with it — a visible, reviewed change, never a silent one.
 *
 * Safari's recordings cannot be made again here (they are what one real Safari wrote on one day),
 * so this script does not write them: it carries each one's name, size and SHA-256 (RECORDED) and
 * puts those rows into the SHA256SUMS it writes. Making the fixtures again in an empty directory
 * and comparing its SHA256SUMS with the committed one therefore checks every row, the recordings'
 * too; the committed bytes are checked against the same rows by
 * __tests__/audio-fixtures-integrity.test.ts.
 *
 * It refuses an output directory inside /mnt/user-data/outputs, checked after resolving symbolic
 * links (that storage rewrites media files — it added C2PA manifests to the first design's
 * fixtures).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * The storage media must never pass through. AUDIO_FIXTURES_REFUSED_DIR ADDS a stand-in directory
 * (so the refusal can be tested); it never replaces the real storage, which stays refused.
 */
const STORAGE = "/mnt/user-data/outputs";
const REFUSED = [
  STORAGE,
  ...(process.env.AUDIO_FIXTURES_REFUSED_DIR
    ? [process.env.AUDIO_FIXTURES_REFUSED_DIR]
    : []),
];

/** The real path of `dir`, or of its nearest existing parent joined with the rest. */
export function realTarget(dir) {
  let head = resolve(dir);
  const rest = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    rest.unshift(basename(head));
    head = parent;
  }
  return join(existsSync(head) ? realpathSync(head) : head, ...rest);
}

/**
 * True when `dir` is inside the refused storage, comparing real paths on both sides: the storage
 * itself may be a symbolic link (on this machine /mnt/user-data/outputs is one), and so may `dir`.
 */
export function refused(dir) {
  const target = realTarget(dir);
  const roots = new Set(REFUSED.flatMap((r) => [resolve(r), realTarget(r)]));
  for (const root of roots) {
    if (target === root || target.startsWith(root.endsWith("/") ? root : root + "/"))
      return true;
  }
  return false;
}

const BITEXACT = ["-fflags", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1"];
const FMP4 = ["-movflags", "+frag_keyframe+empty_moov+default_base_moof"];
const sine = (hz, s, rate) => [
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=${hz}:duration=${s}:sample_rate=${rate}`,
];

/** Every committed file: its name and its ffmpeg arguments (the README lists the same). */
export const FIXTURES = [
  [
    "tone.webm",
    [
      ...sine(1234, 3, 48000),
      "-ac",
      "2",
      "-c:a",
      "libopus",
      "-b:a",
      "64k",
      ...BITEXACT,
      "-f",
      "webm",
    ],
  ],
  [
    "tone-opus.ogg",
    [
      ...sine(1234, 3, 48000),
      "-ac",
      "2",
      "-c:a",
      "libopus",
      "-b:a",
      "64k",
      ...BITEXACT,
      "-serial_offset",
      "1",
      "-f",
      "ogg",
    ],
  ],
  [
    "tone-vorbis.ogg",
    [
      ...sine(1234, 3, 48000),
      "-ac",
      "2",
      "-c:a",
      "libvorbis",
      "-q:a",
      "3",
      ...BITEXACT,
      "-serial_offset",
      "1",
      "-f",
      "ogg",
    ],
  ],
  [
    "tagged.webm",
    [
      ...sine(1234, 3, 48000),
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      "-fflags",
      "+bitexact",
      "-flags:a",
      "+bitexact",
      "-metadata",
      "title=SECRETTITLE",
      "-metadata",
      "artist=SECRETARTIST",
      "-f",
      "webm",
    ],
  ],
  [
    "tone.m4a",
    [
      ...sine(1234, 3, 44100),
      "-ac",
      "2",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      ...BITEXACT,
      "-f",
      "mp4",
    ],
  ],
  [
    "tone-fmp4.m4a",
    [
      ...sine(1234, 3, 44100),
      "-ac",
      "2",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      ...BITEXACT,
      ...FMP4,
      "-f",
      "mp4",
    ],
  ],
  [
    "tone-fmp4-20s.m4a",
    [
      ...sine(1234, 20, 44100),
      "-ac",
      "1",
      "-c:a",
      "aac",
      "-b:a",
      "32k",
      ...BITEXACT,
      ...FMP4,
      "-f",
      "mp4",
    ],
  ],
  [
    "tone-fmp4-60s.m4a",
    [
      ...sine(1234, 60, 44100),
      "-ac",
      "1",
      "-c:a",
      "aac",
      "-b:a",
      "24k",
      ...BITEXACT,
      ...FMP4,
      "-f",
      "mp4",
    ],
  ],
  [
    "tone.mp3",
    [
      ...sine(1234, 3, 44100),
      "-ac",
      "2",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "96k",
      ...BITEXACT,
      "-write_xing",
      "1",
      "-id3v2_version",
      "0",
      "-f",
      "mp3",
    ],
  ],
  [
    "tone.flac",
    [...sine(1234, 3, 48000), "-ac", "2", "-c:a", "flac", ...BITEXACT, "-f", "flac"],
  ],
  [
    "bomb-1h.flac",
    [
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=16000:cl=mono",
      "-t",
      "3600",
      "-c:a",
      "flac",
      ...BITEXACT,
      "-f",
      "flac",
    ],
  ],
  [
    "wide-8ch-192k.flac",
    [...sine(1234, 5, 192000), "-ac", "8", "-c:a", "flac", ...BITEXACT, "-f", "flac"],
  ],
];

/**
 * The committed files no encoder here can make again: real Safari's own recordings of the gate's
 * 1234 Hz oscillator (e2e/audio/safari-check.mjs, the owner's Mac, job b56f1-mac-1, 2026-11-18).
 * Each was checked against the SHA-256 that run printed before it was committed.
 */
export const RECORDED = Object.freeze([
  Object.freeze({
    name: "safari-26.6.2-mp4.m4a",
    bytes: 17983,
    sha256: "2f438ef5dbca54d272756641339244eafd72aa7e72532aea76a6d205f1e2665d",
    madeBy: "Safari 26.6.2, MediaRecorder audio/mp4; codecs=mp4a.40.2",
  }),
  Object.freeze({
    name: "safari-26.6.2-webm.webm",
    bytes: 106154,
    sha256: "7337c0ceb260091c5cf2140fc1f9c3e0e98ed62ad2120f29be98b53d1be237e7",
    madeBy: "Safari 26.6.2, MediaRecorder audio/webm; codecs=opus",
  }),
]);

/**
 * The text of SHA256SUMS: the ffmpeg version line, then one row per committed file in name
 * order — the encoder-made files' digests as given (`made`: [name, sha256] pairs) and the
 * recordings' as carried in RECORDED.
 */
export function sumsFile(version, made) {
  const rows = [...made, ...RECORDED.map((r) => [r.name, r.sha256])];
  const names = rows.map(([n]) => n);
  if (new Set(names).size !== names.length) {
    throw new Error("a file name is listed twice");
  }
  rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `# ${version}\n${rows.map(([n, d]) => `${d}  ${n}`).join("\n")}\n`;
}

/** One encode's ffmpeg arguments: `-threads 1` after the inputs, so it governs the encoder. */
export function ffmpegArgv(args, out) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    ...args,
    "-threads",
    "1",
    out,
  ];
}

function main(argv) {
  if (!argv[2]) {
    console.error(
      "usage: node scripts/make-audio-fixtures.mjs <directory outside /mnt/user-data/outputs>"
    );
    return 2;
  }
  if (refused(argv[2])) {
    console.error(
      `refused: ${argv[2]} is inside ${REFUSED.join(" or ")} (that storage rewrites media files)`
    );
    return 2;
  }
  const dir = resolve(argv[2]);
  mkdirSync(dir, { recursive: true });
  const version = execFileSync("ffmpeg", ["-hide_banner", "-version"])
    .toString()
    .split("\n")[0];
  for (const [name, args] of FIXTURES) {
    execFileSync("ffmpeg", ffmpegArgv(args, join(dir, name)));
  }
  const names = new Set(FIXTURES.map(([n]) => n));
  const made = readdirSync(dir)
    .filter((f) => names.has(f))
    .map((f) => [
      f,
      createHash("sha256")
        .update(readFileSync(join(dir, f)))
        .digest("hex"),
    ]);
  writeFileSync(join(dir, "SHA256SUMS"), sumsFile(version, made));
  process.stdout.write(readFileSync(join(dir, "SHA256SUMS"), "utf8"));
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
) {
  process.exitCode = main(process.argv);
}
