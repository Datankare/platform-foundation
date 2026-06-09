/**
 * __tests__/roadmap-consistency.test.ts
 *
 * Sprint 7 (item B) — ROADMAP integrity gate.
 *
 * Enforces that docs/ROADMAP.md cannot silently drift: each phase's status
 * marker in the Phase Summary table must match that phase's section-header
 * marker. This runs inside the standard `npx jest` gate in BOTH repos (the
 * file syncs platform-foundation -> playform), so a mismatch fails CI and
 * blocks the merge. It is the machine-enforced replacement for the manual
 * D1 / E4 checklist steps that drift kept slipping through.
 *
 * Consumer overlay guard: when the roadmap belongs to a consumer that layers
 * its own phases on top (detected by a "Playform" title), the game-phase
 * overlay (Phase 5 = Game Engine, Phase 8 = Game 1) must be intact — guarding
 * against a platform-foundation -> playform whole-file clobber.
 *
 * Parsing is deliberately split-based (not padded regexes) to stay clear of
 * the eslint-plugin-regexp super-linear-backtracking rule.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROADMAP_PATH = join(process.cwd(), "docs", "ROADMAP.md");

interface PhaseRow {
  id: string;
  name: string;
  marker: string;
}

function markerOf(text: string): string {
  const m = text.match(/[✅🔄⏳]/u);
  return m ? m[0] : "";
}

function stripMarker(text: string): string {
  return text.replace(/[✅🔄⏳]/gu, "").trim();
}

function parseSummary(md: string): Map<string, PhaseRow> {
  const start = md.indexOf("## Phase Summary");
  if (start === -1) return new Map();
  const next = md.indexOf("\n## ", start + 1);
  const section = md.slice(start, next === -1 ? undefined : next);

  const rows = new Map<string, PhaseRow>();
  for (const line of section.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const id = cells[1] ?? "";
    if (!/^\d+(?:\.\d+)?$/.test(id)) continue;
    rows.set(id, {
      id,
      name: stripMarker(cells[2] ?? ""),
      marker: markerOf(cells[3] ?? ""),
    });
  }
  return rows;
}

function parseHeaders(md: string): Map<string, PhaseRow> {
  const rows = new Map<string, PhaseRow>();
  const headerRe = /^## Phase (\d+(?:\.\d+)?) — (.+)$/gm;
  for (const m of md.matchAll(headerRe)) {
    rows.set(m[1], {
      id: m[1],
      name: stripMarker(m[2]),
      marker: markerOf(m[2]),
    });
  }
  return rows;
}

function titleOf(md: string): string {
  const m = md.match(/^# (.+)$/m);
  return m ? m[1].trim() : "";
}

describe("ROADMAP.md consistency", () => {
  const md = readFileSync(ROADMAP_PATH, "utf8");
  const summary = parseSummary(md);
  const headers = parseHeaders(md);

  it("parses a plausible roadmap (sanity guard)", () => {
    expect(summary.size).toBeGreaterThan(5);
    expect(headers.size).toBeGreaterThan(5);
    expect(summary.has("4")).toBe(true);
    expect(headers.has("4")).toBe(true);
  });

  it("Phase Summary status markers match the section headers", () => {
    const mismatches: string[] = [];
    for (const [id, row] of summary) {
      const header = headers.get(id);
      if (!header || !header.marker || !row.marker) continue;
      if (header.marker !== row.marker) {
        mismatches.push(
          `Phase ${id}: summary "${row.marker}" vs header "${header.marker}"`
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  const isConsumerOverlay = /playform/i.test(titleOf(md));
  (isConsumerOverlay ? it : it.skip)(
    "consumer game overlay is intact (Phase 5 Game Engine, Phase 8 Game 1)",
    () => {
      expect(headers.get("5")?.name ?? "").toMatch(/game engine/i);
      expect(headers.get("8")?.name ?? "").toMatch(/game 1/i);
    }
  );
});
