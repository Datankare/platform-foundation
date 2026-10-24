/**
 * __tests__/helpers/modules.ts — Run a suite with a chosen set of modules (ADR-054 D4)
 *
 * jest.setup registers the app's modules (an isolated copy) before every suite. A suite that
 * needs a different set — no modules, one module and its dependencies, a fixture module —
 * swaps it with `runWithModules` and puts the app's set back with `restoreAppModules` (call it
 * in afterEach/afterAll). Registration is global per test file, like boot.
 */

// The registry and define directly, not the barrel: the barrel's boot helpers import much of the
// core, which a suite's mocks may not want loaded early.
import { definePlatformModule } from "@/platform/modules/define";
import {
  getModules,
  registerModules,
  resetModuleRegistry,
} from "@/platform/modules/registry";
import type { PlatformModule } from "@/platform/modules/types";

/** The set jest.setup registered, as this file first saw it. */
const APP_SET: readonly PlatformModule[] = getModules();

/** Register exactly `modules` (forgetting the current set first). */
export function runWithModules(modules: readonly PlatformModule[]): void {
  resetModuleRegistry();
  registerModules(modules);
}

/** Register the app's modules again (as jest.setup did). */
export function restoreAppModules(): void {
  runWithModules(APP_SET);
}

/**
 * Run this test file with exactly `modules`, put the app's set back afterwards. For a core test
 * whose fixtures use vocabulary a module would declare (goals, content kinds): it declares them in
 * a fixture module, so it passes the same with the app's modules or with none.
 */
export function withModules(modules: readonly PlatformModule[]): void {
  beforeAll(() => runWithModules(modules));
  afterAll(() => restoreAppModules());
}

/**
 * A fixture app module declaring the workflow goals the agent-workflow tests use (the names the
 * product modules declare, so the fixtures read as before).
 */
export const WORKFLOW_GOALS_FIXTURE: PlatformModule = definePlatformModule({
  id: "workflow-goals-fixture",
  goals: [
    "translate",
    "speak",
    "transcribe",
    "identify-song",
    "translate-and-speak",
    "full-pipeline",
  ],
});

/** A fixture app module declaring the content kinds the moderation tests screen. */
export const CONTENT_KINDS_FIXTURE: PlatformModule = definePlatformModule({
  id: "content-kinds-fixture",
  moderationContentTypes: [
    { name: "translation", severityReduction: true },
    { name: "transcription", severityReduction: true },
    { name: "social", severityReduction: false },
  ],
});
