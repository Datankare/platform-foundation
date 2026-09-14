/**
 * prompt-registry-integrity.test.ts — ADR-038 D7 enforcement (Sprint 4).
 *
 * The prompt registry (listPrompts) is the single source of truth for what prompts exist, so
 * the eval harness (ADR-038) scopes to it. Every prompt source file — prompts/<domain>/<name>-v<N>.ts
 * — must therefore be registered in PROMPT_REGISTRY, and every registration must have a source
 * file. This is the registry-completeness half of the ADR-038 conformance kit; the eval-coverage
 * half (enum-exhaustive / fail-closed / boundary / adversarial fixtures) lands with the datasets.
 *
 * It is the prompt-layer analogue of agent-registry-integrity.test.ts.
 *
 * Self-tests first (Gotcha 64): the scanner must see the tree and the extractor must work — and
 * the detector must recognize an unregistered name as missing — before any "clean" result is
 * trusted.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { listPrompts } from "@/prompts";

const ROOT = process.cwd();
const PROMPTS_DIR = join(ROOT, "prompts");

// A prompt source file: <name>-v<N>.ts. Excludes index.ts, __tests__, and the evals tree.
const PROMPT_FILE = /-v\d+\.ts$/;

function promptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "evals") continue;
      out.push(...promptFiles(full));
    } else if (PROMPT_FILE.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// The registry key a prompt file declares: the first quoted `name: "..."` (the config's name;
// the interface `name: string;` further down has no quotes and does not match).
function declaredName(file: string): string | null {
  const src = readFileSync(file, "utf-8");
  const m = src.match(/name:\s*"([a-z0-9-]+)"/);
  return m ? m[1] : null;
}

describe("prompt registry integrity (ADR-038 D7)", () => {
  const files = promptFiles(PROMPTS_DIR);
  const registered = new Set(listPrompts());

  it("self-test: finds every prompt source file and extracts its name", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
    const names = files.map(declaredName);
    expect(names).toContain("safety-classify");
    expect(names).toContain("gatekeeper");
    expect(names.every((n) => n !== null)).toBe(true);
  });

  it("self-test: an unregistered name is recognized as missing", () => {
    expect(registered.has("nonexistent-prompt")).toBe(false);
  });

  it("every prompt source file is registered in PROMPT_REGISTRY", () => {
    const missing: string[] = [];
    for (const file of files) {
      const name = declaredName(file);
      if (name && !registered.has(name)) {
        missing.push(`${file.slice(ROOT.length + 1)} (name: "${name}")`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every registered prompt has a source file (no phantom registrations)", () => {
    const fileNames = new Set(
      files.map(declaredName).filter((n): n is string => n !== null)
    );
    const phantom = [...registered].filter((n) => !fileNames.has(n));
    expect(phantom).toEqual([]);
  });
});
