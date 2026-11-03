/**
 * @jest-environment node
 */
/**
 * platform/admin/__tests__/stale-change.test.ts — a stale change's own text claims no withdrawal
 * (TASK-194 round 22)
 *
 * staleChangeMessage is a config tool's result text (staleResult) and a held change's run result
 * (runApprovedConfigChange, no recorded value) — logged, and carried in tool results and the
 * trajectory. Whether the hold is withdrawn is the decision's to say (`withdrawn: true`), and it
 * may not land: the text says only what is true wherever it is read.
 */

import { staleChangeMessage } from "@/platform/admin/stale-change";

it("says nothing was changed and to ask again, never that the request is withdrawn", () => {
  const text = staleChangeMessage("k");
  expect(text).toMatch(/nothing was changed/);
  expect(text).toMatch(/ask again/i);
  expect(text).not.toMatch(/withdrawn/i);
});
