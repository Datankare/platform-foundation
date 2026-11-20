# Test audio (TASK-234, ADR-061)

The audio the browser converter and the strict WAV check are tested with. Every file here is
synthetic — a generated sine tone or silence — with no third-party content, so there is no licence
to track beyond this repository's own.

- **Committed only where an encoder is needed** (Opus, Vorbis, AAC, MP3, FLAC): the twelve encoder-made files
  in the table below, made by `node scripts/make-audio-fixtures.mjs <directory>` with ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers.
  Every encode is bit-exact, so the same ffmpeg build gives the same bytes (the script's header
  lists its arguments).
- **Committed because nothing here can make them again**: the two recordings real Safari 26.6.2
  made of the gate's 1234 Hz oscillator on the owner's Mac (job `b56f1-mac-1`, 2026-11-18, the
  shipped recorder run by `e2e/audio/safari-check.mjs`). Each was checked against the SHA-256 that
  run printed before it was committed; `scripts/make-audio-fixtures.mjs` carries their names,
  sizes and digests (`RECORDED`) and writes their rows into `SHA256SUMS`, so making the fixtures
  again and comparing `SHA256SUMS` checks them too. They hold a generated tone and nothing else
  (no microphone was used).
- **Made in code, never committed**: every WAV, the duration-less WebM files, the damaged and the
  empty input, the validator's malformed inputs, `lying-length.flac` (made from
  `bomb-1h.flac`: its first 110 000 bytes, about 575 s, declaring 10 s) and
  `nodur-80s-safari-form.webm` (made from `safari-26.6.2-webm.webm`: its one Cluster 20 times
  over, 80.2 s, still stating no length) — `generate.ts` in this folder.
- **`SHA256SUMS`** lists every committed media file. `__tests__/audio-fixtures-integrity.test.ts`
  fails on a checksum mismatch, a media file not listed, a listed file missing, the bytes `c2pa` or
  `jumb` (any case) anywhere in a media file, or an audio file tracked anywhere else in the
  repository. `generate.ts`, this README and `SHA256SUMS` are the three non-media files here.

**Never copy these files through a storage that rewrites media.** A storage used while this was
designed added signed C2PA/JUMBF manifests to audio files saved in it; decoders skip such boxes, so
only the checksums and the marker scan notice.

**When ffmpeg changes.** Another ffmpeg build may give other bytes. Then all twelve encoder-made files are made
again, `SHA256SUMS` changes in the same commit, and the version line above with it — a visible,
reviewed change, never a silent one.

| File                      | Content                                                                                            | Length                    | Used for                                                        | sha256                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `tone.webm`               | Opus 64k, 2 ch, 48 kHz, 1234 Hz                                                                    | 3 s                       | decode, all engines                                             | `caaa34d399e63e53d8e1ded549bbc875241e4a1b82021e784d56fa9e58f8d71e` |
| `tagged.webm`             | Opus 32k, title/artist tags `SECRETTITLE`/`SECRETARTIST`                                           | 3 s                       | the tags never reach the WAV                                    | `13ba4b06076761a0f8dafc2f5dd9b30012a0705b06cb2f9e919e6cf8c17d4678` |
| `tone-opus.ogg`           | Ogg Opus 64k, 2 ch                                                                                 | 3 s                       | decode                                                          | `8a5ec81f501270d36fa06e60770f7c5dad68f9d089c7966df5bae541cd79f7bd` |
| `tone-vorbis.ogg`         | Ogg Vorbis q3, 2 ch                                                                                | 3 s                       | decode                                                          | `c176971b9a3521317c5d6fa8263669f11a094a0fbec661fe5a4c3e2017603e75` |
| `tone.m4a`                | AAC 96k, 2 ch, 44.1 kHz, moov at the end (iOS Voice Memos layout)                                  | 3 s                       | decode                                                          | `9c643029729701da6c219b7cffaf029f5a298be685c67abbb38664c1165bf007` |
| `tone-fmp4.m4a`           | AAC 96k, fragmented MP4 (Safari's recorder layout)                                                 | 3 s (decodes 3.023 s)     | decode                                                          | `1f81f6278664c61a76dc92debe00d93b4d4a572cda5e3b1f660965fb47720878` |
| `tone-fmp4-20s.m4a`       | AAC 32k, mono, fragmented MP4                                                                      | 20 s (decodes 20.023 s)   | trimmed as a recording (WB-2)                                   | `8cb77ba51bc1f74b0776ac533082e203aade2d22a1160978bdd53d359b78ce53` |
| `tone-fmp4-60s.m4a`       | AAC 24k, mono, fragmented MP4                                                                      | 60 s (decodes 60.023 s)   | upload at the limit: trimmed; limit 59: refused before decoding | `1ef805063311a08e3c3c3c427b4c357175e482be3902e08cbe94ba56111a463e` |
| `tone.mp3`                | MP3 96k, 2 ch, no ID3 tag                                                                          | 3 s                       | decode                                                          | `1325f57ff1022d5de0ea88f2227242d76e9ec639e5e2bdcf3b0fe01c67338c08` |
| `tone.flac`               | FLAC, 2 ch, 48 kHz                                                                                 | 3 s                       | decode                                                          | `bedeb7839049c7974eb9c74ce72c631a97ea1e1c7aee12249d356a895f8bf677` |
| `bomb-1h.flac`            | FLAC silence, 16 kHz mono (0.66 MB)                                                                | 3600 s                    | refused from its metadata, never decoded                        | `41dd754f46fc4f24696441fec62d257ddba76a8bbb061a20ca4b08231fcd9ef4` |
| `safari-26.6.2-webm.webm` | Safari's own recording, `audio/webm; codecs=opus`: live WebM (no Duration, sizes unknown), 1234 Hz | about 4 s (106 154 bytes) | every engine converts what real Safari records                  | `7337c0ceb260091c5cf2140fc1f9c3e0e98ed62ad2120f29be98b53d1be237e7` |
| `safari-26.6.2-mp4.m4a`   | Safari's own recording, `audio/mp4; codecs=mp4a.40.2`: fragmented MP4, 1234 Hz                     | about 4 s (17 983 bytes)  | every engine converts what real Safari records                  | `2f438ef5dbca54d272756641339244eafd72aa7e72532aea76a6d205f1e2665d` |
| `wide-8ch-192k.flac`      | FLAC, 8 ch, 192 kHz                                                                                | 5 s                       | a wide file decodes and is mixed down                           | `99b307a24e45b1499cc646a309a2474f1c970b59cd6b90bd4be45015718a0c3a` |

The tone is 1234 Hz in every file that has one; e2e/audio checks the converted WAV's peak at
1234 ± 4 Hz.
