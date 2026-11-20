# Audio conversion — the adopter's guide

How audio becomes the one format the platform's speech and song-identification providers take,
in the person's browser, and how the server checks it. The decisions and their reasons:
[ADR-061](adr/ADR-061-audio-in-the-browser.md).

## 0. How to read this; what this version covers

This guide is written so it is never wrong about what exists: each batch adds only the chapters
for what it ships, and this list says exactly which are here.

| Chapter                                                                                                         | Status in this version                                     |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 0. How to read this                                                                                             | Here                                                       |
| 1. What it is for: one path for audio                                                                           | Not yet — arrives with the server path                     |
| 2. Canonical audio                                                                                              | **Here**                                                   |
| 3. Converting in the browser                                                                                    | **Here** (sending the result arrives with the server path) |
| 4–9. The interface, the capability flag, the default, settings, an in-process implementation, conformance kit 1 | Not yet — arrive with the server path                      |
| 10–13. A remote service: contract, running it, kit 2, worked example                                            | Not yet — arrive with the optional remote service          |
| 14. Operating it                                                                                                | Not yet                                                    |
| 15. Sources and credits                                                                                         | **Here**                                                   |

What exists today: the browser modules (`platform/voice/canonical-wav.ts`,
`browser-audio.ts`, `browser-recorder.ts`), their tests, the test audio and the cross-browser
gate. **Nothing in the app calls them yet**; no route, screen or setting changes.

## 2. Canonical audio

### 2.1 The byte layout

Canonical audio is a WAV file of 16-bit little-endian PCM samples, one channel, 16 000 samples a
second, with exactly this 44-byte header and nothing else — no `LIST`, `id3 `, `bext`, `JUNK` or
any other chunk, no RF64, no extensible format:

| Offset | Bytes | Value                                     |
| ------ | ----- | ----------------------------------------- |
| 0      | 4     | `RIFF`                                    |
| 4      | 4     | file length − 8 (little-endian)           |
| 8      | 4     | `WAVE`                                    |
| 12     | 4     | `fmt `                                    |
| 16     | 4     | 16                                        |
| 20     | 2     | 1 (PCM)                                   |
| 22     | 2     | 1 (channel)                               |
| 24     | 4     | 16 000 (samples a second)                 |
| 28     | 4     | 32 000 (bytes a second)                   |
| 32     | 2     | 2 (bytes a sample)                        |
| 34     | 2     | 16 (bits a sample)                        |
| 36     | 4     | `data`                                    |
| 40     | 4     | file length − 44, an even number of bytes |

The header of one second of audio (32 044 bytes), in hex:

```
52 49 46 46 24 7d 00 00 57 41 56 45 66 6d 74 20
10 00 00 00 01 00 01 00 80 3e 00 00 00 7d 00 00
02 00 10 00 64 61 74 61 00 7d 00 00
```

### 2.2 The check

`checkCanonicalWav(bytes, limits)` compares the 44 header bytes with the header computed for the
input's length, byte for byte — one comparison that covers every field, both sizes and "no other
chunk". Then the data must be an even number of bytes, and the length within the limits. It
answers `{ ok: true, wav }` or `{ ok: false, code }` with one of `invalid_audio`, `too_large`,
`too_short`, `too_long`; it never throws on the input bytes and never puts them into a code.

**Limits fail closed.** `limits` is `{ maxBytes, minSeconds, maxSeconds }`: `maxBytes` an integer
in (44, 4 194 304], `0 < minSeconds ≤ maxSeconds`, all finite. Anything else — `NaN`, `undefined`,
zero, a string, a minimum over the maximum — throws `AudioLimitsError` with code `misconfigured`:
a configuration fault is loud, never a pass.

### 2.3 `CanonicalWav`, and why it is a class

What the check (or the browser encoder) returns is a `CanonicalWav` object, and only this module
can make one:

- its constructor needs a symbol private to the module, so `new CanonicalWav(…)`, a subclass, a
  guessed `Symbol.for(…)` and `Reflect.construct` all throw `TypeError`;
- its bytes are in an ES-private field and leave only as fresh copies (`copyBytes()`,
  `toBase64()`, `toBlob()`), so changing the input after the check, or a copy, changes nothing;
- the object, the class and its prototype are frozen;
- `requireCanonicalWav(x)` returns `x` only when this module made it — a JSON body, raw bytes cast
  to the type, `Object.create(CanonicalWav.prototype)`, `Object.setPrototypeOf`, a `Proxy` or a
  `structuredClone` of a real one all throw `TypeError`.

A provider calls `requireCanonicalWav` at its boundary and reads the audio only through the
copies. TypeScript's types document the path; the class enforces it at run time.
`wav.slice(maxSeconds)` gives the first `maxSeconds` (a finite number above 0; anything else
throws `RangeError`).

The owner's audio decisions are constants in the same module (`AUDIO_DECISIONS`): the Music clip
length (15 s), the largest file a person may pick (25 MiB, 26 214 400 bytes), and whether Safari
older than 18.4 is claimed (no).

## 3. Converting in the browser

### 3.1 `toCanonicalWav`

```ts
toCanonicalWav(blob, { source: "recording" | "upload", minSeconds, maxSeconds,
  maxInputBytes?, probeTimeoutMs? }): Promise<{ wav, seconds, decodedSeconds, trimmed }>
```

| Step | Recording (made by this tab's recorder, stopped by its timer)                                                           | Upload (a file the person picked)                                                                                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | options checked (`misconfigured` otherwise)                                                                             | same                                                                                                                                                                                                             |
| 2    | empty → `empty`                                                                                                         | same                                                                                                                                                                                                             |
| 3    | —                                                                                                                       | larger than 25 MiB → `too_large`, before a byte is read                                                                                                                                                          |
| 3b   | —                                                                                                                       | its container named from its **first 16 bytes** (WAV, MP3, FLAC, Ogg, WebM/Matroska, MP4/M4A); anything else → `undecodable`; the bytes cannot be read → `read_failed`. The type the file declares is never used |
| 4    | —                                                                                                                       | its **declared** length checked **before decoding** (the container's duration, else a seek far past the end); unknown within 3 s → `unmeasurable`; unreadable → `undecodable`; over the limit + 1 s → `too_long` |
| 5    | no 16 kHz decoder → `browser_unsupported`; the file cannot be read → `read_failed`                                      | same (a file moved, deleted or still in iCloud)                                                                                                                                                                  |
| 6    | decoded at 16 kHz (decoding is the resample); a decoder error → `undecodable`, `browser_unsupported` or `out_of_memory` | same                                                                                                                                                                                                             |
| 7    | **trimmed** to `maxSeconds`, never refused for length                                                                   | over the limit + 0.25 s → `too_long`; otherwise trimmed to `maxSeconds`                                                                                                                                          |
| 8    | shorter than `minSeconds` → `too_short`                                                                                 | same                                                                                                                                                                                                             |
| 9    | channels averaged to mono, one second per slice, the page kept responsive                                               | same                                                                                                                                                                                                             |

**What the check before decoding cannot see.** It trusts the length the file's container declares.
A file that declares a short length but holds a long stream (a crafted FLAC, MP4, WebM or MP3)
reaches the decode. An engine that reads the whole stream (Chromium) decodes it whole and it is
then refused (`too_long`, or `out_of_memory`); the decode cannot be stopped part-way, so such a
file costs the picking person's tab memory in proportion to its real length, bounded only by the
25 MiB pick limit. Firefox's decoder refused the test file itself (`undecodable`). WebKit and
Safari decode only the declared length, so there the file converts — to no more than it declared
(§3.3's table; ADR-061 §6). The same holds for a file with many channels at a high rate.
Nothing reaches the server either way.

**Why the bytes, not the declared type.** A picked file can arrive with no type or a wrong one
(drag and drop, some Android and iOS pickers, a renamed file), and Safari's media element does
not reliably recognise an MP3 or a FLAC from its bytes when it is told nothing or the wrong
thing (WebKit bug 198015). So step 3b names the container itself — strictly: an MP3 must start
with an ID3v2 tag or a Layer III frame header, an MP4 with its `ftyp` box, and so on — and step 4
measures a Blob typed from that. A declared type never widens what is accepted: unknown bytes
declared `audio/mpeg` are refused. A file that starts with padding or with another container is
refused as `undecodable`.

A failure rejects with `BrowserAudioError`, its `code`, and its `stage` — the step that ended it
(`input`, `container`, `probe`, `context`, `read`, `decode`, `length`, `encode`), for logs and
diagnosis; what a person is told depends on the code alone. Any other error during encoding is a
bug and is rethrown unchanged, for the error reporter — never shown as a damaged file.

### 3.2 `startRecording` and `acquireMicrophone`

`acquireMicrophone()` opens the microphone, or rejects with `microphone_blocked` (refused),
`microphone_missing` (none, or none that fits) or `microphone_unavailable` (anything else) — and
with `browser_unsupported`, without asking for the microphone, when the browser records none of
the recorder types. `startRecording(stream, { mimeType, maxSeconds, onTick })` records until
`stop()` or `maxSeconds`; `result` is the recording, or `recording_interrupted` when the device
ended, the recorder failed or the page was hidden — never a partial recording.

### 3.3 `detectAudioSupport` and the supported browsers

`detectAudioSupport()` answers `{ music, upload, missing }` by testing capabilities — it never
reads the browser's name or version: a 16 kHz `OfflineAudioContext`; `MediaRecorder` recording
WebM/Opus or Ogg/Opus; the microphone API; and `canPlayType` for WAV, MP3, AAC in MP4, FLAC, Ogg
Opus, Ogg Vorbis and WebM Opus.

| Browser                                              | Music | Upload                                                                                                                     |
| ---------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------- |
| Current Chrome and Edge                              | yes   | WAV, MP3, M4A, FLAC, Ogg, WebM                                                                                             |
| Current Firefox                                      | yes   | the same where the system has an AAC decoder (macOS, Windows); on a Linux without one, upload says "needs a newer browser" |
| Safari 18.4 or later (macOS 15.4+, iOS/iPadOS 18.4+) | yes   | WAV, MP3, M4A, FLAC, Ogg, WebM                                                                                             |
| Safari 14.1–18.3                                     | no    | no — "This needs a newer browser" for the audio features only                                                              |

**What has been observed, per engine** (`e2e/audio/expect.json` is the full table; ADR-061 §5 and
§6 have the evidence). Every row is observed: Chromium on Linux and macOS; Firefox, WebKit and
Safari in two runs on the owner's Mac (`b56f1-mac-1`, then `b56f1r3-mac-pf-1` on 2026-11-18, which
observed every cell the first run had left as a prediction).

| Case                                              | Chromium 156 (Linux, macOS)              | Firefox 157 (macOS)                      | WebKit 27.2 (Playwright, macOS)                    | Safari 26.6.2                                      |
| ------------------------------------------------- | ---------------------------------------- | ---------------------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| WAV, M4A (AAC), Ogg Opus, Ogg Vorbis, WebM Opus   | converts                                 | converts                                 | converts                                           | converts                                           |
| MP3                                               | converts                                 | converts                                 | converts (second run; the first refused it)        | converts (second run; the first refused it)        |
| FLAC                                              | converts                                 | converts                                 | converts                                           | converts (second run; the first refused it)        |
| AAC in fragmented MP4, exact length               | +23 ms, trimmed                          | +24 to +42 ms, trimmed                   | 6–25 ms short                                      | 6–25 ms short                                      |
| A 60 s file with a limit of 59 s                  | refused before decoding                  | refused before decoding                  | refused after one decode                           | refused after one decode                           |
| A generated WebM without a duration (3 s, 30 min) | converts / refused `too_long`, 0 decodes | converts / refused `too_long`, 0 decodes | both refused `undecodable` at the probe, 0 decodes | both refused `undecodable` at the probe, 0 decodes |
| An hour of FLAC in 0.66 MB                        | refused, 0 decodes                       | refused, 0 decodes                       | refused, 0 decodes                                 | refused, 0 decodes (second run)                    |
| Records WebM/Opus                                 | yes                                      | yes                                      | yes                                                | yes                                                |
| Records MP4                                       | yes (Opus)                               | no                                       | yes (AAC)                                          | yes (AAC)                                          |
| Safari's own two recordings converted             | yes                                      | yes (second run)                         | yes (second run)                                   | yes (both runs)                                    |
| A file that declares 10 s and holds 575 s         | decoded whole, refused `too_long`        | refused `undecodable` at the decode      | converts to exactly the declared 10 s              | converts to exactly the declared 10 s              |

**A file that declares less than it holds** never yields more than the limits allow in any engine:
it is refused, or — in WebKit and Safari, which decode only the declared length — converted up to
the length it declares, which the checks before and after decoding have bounded. The gate asserts
that bound (a decoded length beyond the declared one fails). In Safari the person gets the stated
part of such a file; the rest is not sent.

**A WebM that states no length, picked as a file in Safari.** It may be refused with "This audio
couldn't be read" (`undecodable`). The two such files this repository generates are refused every
time: Safari's media element reports them as an unsupported source, whatever type it is told,
although its decoder can decode them. It is not every such file: the WebM Safari's own recorder
writes also states no length, and Safari measures it. Which other files are refused is not known;
the next run on the owner's Mac reports a long one made from Safari's own recording, and converts
Safari's recording as an upload. Chromium and Firefox measure all of these. **Recording in the
page is not affected in any browser:** a recording is never probed (the gate fails one that was), and Safari's
recordings convert. (Not every recorder leaves the length out: Chromium 153's writes it.)

### 3.4 Every failure and what the person is told

| Code                                                                                          | Message                                                                                    |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `empty`, `undecodable`, `unmeasurable`                                                        | This audio couldn't be read. It may be damaged or in a format your browser can't open.     |
| `too_large`                                                                                   | This file is larger than 25 MB. Choose a smaller file.                                     |
| `too_long`                                                                                    | This audio is longer than {maxSeconds} seconds. Use a shorter clip.                        |
| `too_short`                                                                                   | This recording is too short. Record for at least {minSeconds} seconds.                     |
| `read_failed`                                                                                 | This file couldn't be opened. If it is in iCloud, download it to the device and try again. |
| `out_of_memory`                                                                               | This audio is too large for your device to prepare. Try a shorter clip.                    |
| `browser_unsupported`, or detection fails                                                     | This needs a newer browser: Safari 18.4 or later, or a current Chrome, Edge or Firefox.    |
| `microphone_blocked`, `microphone_missing`, `microphone_unavailable`, `recording_interrupted` | the recorder's own messages (they arrive with the screens)                                 |
| a rethrown bug                                                                                | the generic error message; the error reporter receives it                                  |

### 3.5 Record, convert, send — the browser side

```ts
import { toCanonicalWav, BrowserAudioError } from "@/platform/voice/browser-audio";
import {
  acquireMicrophone,
  pickRecorderType,
  startRecording,
} from "@/platform/voice/browser-recorder";

const mimeType = pickRecorderType(); // null: "needs a newer browser"
if (mimeType) {
  const stream = await acquireMicrophone(); // rejects with a microphone code
  const rec = startRecording(stream, {
    mimeType,
    maxSeconds: 15,
    onTick: (s) => show(s),
  });
  const blob = await rec.result; // rejects "recording_interrupted"
  try {
    const { wav } = await toCanonicalWav(blob, {
      source: "recording",
      minSeconds: 10,
      maxSeconds: 15,
    });
    const form = new FormData();
    form.append("audio", wav.toBlob(), "audio.wav");
    // sending it: arrives with the server path
  } catch (e) {
    if (e instanceof BrowserAudioError) explain(e.code);
    else throw e;
  }
}
```

### 3.6 How it is proved

- Jest, in both repositories: the check's property test over 27 generators of valid and malformed
  files, the forgeries, the limits; the converter's every step with fakes; the recorder with a
  fake clock; an import guard; the test audio's checksums.
- `e2e/audio/` in platform-foundation: the shipped modules in real engines against
  `e2e/audio/expect.json` — Chromium on Linux, and Chromium, Firefox, WebKit and real Safari on
  macOS (`.github/workflows/browser-audio.yml`). Every result names the step that ended it and
  what the length probe answered; every compressed upload runs both with no declared type and
  typed as a picker types it; and for ten files the run reports what a bare media element does
  with them, so a refusal is never ambiguous. Run it locally with
  `npx playwright test -c e2e/audio/playwright.config.ts --project=chromium`; on a Mac,
  `node e2e/audio/safari-check.mjs --out <directory>` after `safaridriver --enable`.

## 15. Sources and credits

- "Web Audio API" (W3C; editors P. Adenot, H. Choi) — decode-time resampling, `OfflineAudioContext`.
- "Multimedia Programming Interface and Data Specifications 1.0" (IBM and Microsoft, 1991) — RIFF/WAVE.
- RFC 9559 "Matroska Media Container Format Specification" (S. Lhomme, M. Bunkus, D. Rice) — the test WebM writer.
- RFC 6716 "Definition of the Opus Audio Codec" (J.-M. Valin, K. Vos, T. Terriberry) and RFC 7845
  "Ogg Encapsulation for the Opus Audio Codec" (T. Terriberry, R. Lee, R. Giles) — the Opus silence
  packet and `OpusHead`.
- "MediaStream Recording" (W3C; M. Casas-Sanchez, J. Barnett, T. Leithead) — `MediaRecorder`.
- "WebDriver" (W3C; S. Stewart, D. Burns) — the Safari check.
- Apple, "Safari 18.4 Release Notes" (31 March 2025) and "Testing with WebDriver in Safari".
- WebKit bugs 301507 (empty Blobs for short timeslices) and 213699; WebKit bug 198015 "Cannot play
  audio created from blob" (reported by jordan.michael.last; analysis by Jer Noble) — why the
  probe's Blob is typed from the file's bytes.
- "MIME Sniffing" (WHATWG; editor Gordon P. Hemsley) — naming a media type from leading bytes; the
  table here is stricter and built from each format's own specification.
- actions/runner-images issue #13668 — the macOS runner's missing audio device.
- BROWSER-AUDIO-REVIEW-A and -B and CONFIRM-56f1 (Datankare, 2026-11-17) — reviewer A's seek
  probe and fuzz generators, reviewer B's gate shape and expectation table, the confirmation
  review's edits.
