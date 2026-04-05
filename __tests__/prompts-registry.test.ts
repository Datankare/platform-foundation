/**
 * __tests__/prompts-registry.test.ts — Prompt registry + admin prompt tests
 *
 * Tests: registry lookup, unknown prompt error, listing, admin prompt builder.
 */

import { getPromptConfig, listPrompts, buildAdminSystemPrompt } from "@/prompts";

// ---------------------------------------------------------------------------
// Prompt registry
// ---------------------------------------------------------------------------

describe("getPromptConfig", () => {
  it("returns config for safety-classify", () => {
    const config = getPromptConfig("safety-classify");
    expect(config.name).toBe("safety-classify");
    expect(config.version).toBe(1);
    expect(config.tier).toBe("fast");
    expect(config.maxTokens).toBe(128);
  });

  it("returns config for admin-command-bar", () => {
    const config = getPromptConfig("admin-command-bar");
    expect(config.name).toBe("admin-command-bar");
    expect(config.version).toBe(1);
    expect(config.tier).toBe("standard");
    expect(config.maxTokens).toBe(1024);
  });

  it("throws for unknown prompt name", () => {
    expect(() => getPromptConfig("nonexistent-prompt")).toThrow(
      'Unknown prompt: "nonexistent-prompt"'
    );
  });

  it("error message lists registered prompts", () => {
    try {
      getPromptConfig("bad");
    } catch (err) {
      expect((err as Error).message).toContain("safety-classify");
      expect((err as Error).message).toContain("admin-command-bar");
    }
  });
});

describe("listPrompts", () => {
  it("lists all registered prompt names", () => {
    const names = listPrompts();
    expect(names).toContain("safety-classify");
    expect(names).toContain("admin-command-bar");
    expect(names.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Admin command bar prompt
// ---------------------------------------------------------------------------

describe("buildAdminSystemPrompt", () => {
  it("includes the panel name", () => {
    const prompt = buildAdminSystemPrompt("roles", "");
    expect(prompt).toContain("Current panel: roles");
  });

  it("includes the context data", () => {
    const context = 'Current roles: [{"name":"admin"}]';
    const prompt = buildAdminSystemPrompt("roles", context);
    expect(prompt).toContain(context);
  });

  it("includes all admin rules", () => {
    const prompt = buildAdminSystemPrompt("players", "");
    expect(prompt).toContain("Always use the provided tools");
    expect(prompt).toContain("destructive actions");
    expect(prompt).toContain("ambiguous");
  });
});
