/**
 * @jest-environment node
 */
/**
 * __tests__/lifecycle-closure-scan.test.ts — every trajectory opened is ended, and every decision
 * that ends a hold ends its trajectory (TASK-193, audit B-1, B-2, A-1)
 *
 * TASK-193 was filed because the command bar created a trajectory and never ended it; the audit
 * found the same at every caller of invokeTool (it records steps, never a status) and on every
 * decision path but a plain rejection. Nothing failed: the checks tested that retention existed,
 * not that anything reached the states it deletes.
 *
 * The code is read (the TypeScript compiler API), so a new site fails here until it is handled:
 *
 *   1. Creators. Every call that opens a trajectory — `<trajectory store>.create({ kind, … })`,
 *      `createSession(`, `proposeOnce(` / `proposeAction(` (a hold, which pauses one) — must be
 *      inside `withTrajectory(` (platform/agents/trajectory-closure.ts: ended when the request
 *      ends), or in a function that ends it itself (`finishTrajectory(`, or a `finally` calling
 *      it), or be in CLOSERS naming what ends it and why.
 *   2. Decisions. Every call that ends a hold outside the proposal stores — `.withdraw(`,
 *      `.resolveIndeterminate(`, `.supersede(`, `.decide(` — must be in a function that also moves
 *      the hold's trajectory (`endHeldTrajectory(`, `settleHeldTrajectory(`, or `.updateStatus(`
 *      of a hold's `.trajectoryId`), or in CLOSERS.
 *
 * Round 1 (L6): a trajectory store's `.create(` inside withTrajectory's callback is a second
 * trajectory, which withTrajectory does not end — only a hold there (which pauses the request's
 * own) counts as ended by it.
 *
 * Every CLOSERS entry must match a site that exists (an entry for a file this repository does not
 * have — an app's own — is skipped), so the list cannot keep claiming what has gone.
 *
 * Shown failing on the code before TASK-193: 10 creator sites (the command bar, the Users and
 * Entitlements pages, every config write, the Guardian's empty-text run …) and 6 decision sites.
 */

import * as ts from "typescript";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { productionSources, read } from "./helpers/route-policy";

const ROOT = process.cwd();

/** "<file>#<function>" → what ends the trajectory there, and why it is not ended in place. */
const CLOSERS: Readonly<Record<string, string>> = {
  "platform/agents/runtime.ts#executeAgent":
    "every return sets completed, failed, paused or indeterminate; a crashed run, or a pause nothing resumes, is ended by the reaper (agents.trajectory-retention, closeAbandoned)",
  "platform/agents/workflow-loop.ts#createTrajectory":
    "runGoal / advanceGoal set every outcome's status (completed, failed, or waiting on its hold); a crashed run is ended by the reaper",
  "platform/agents/workflow-loop.ts#holdStep":
    "the workflow's hold: its owner's decision (withdrawHeldAction, rejectHeldAction, resolveUndecidedHeldAction), or its expiry (hold-expiry.ts)",
  "app/api/admin/ai/command-bar.ts#runCommandBarAction":
    "the hold: its decision (approval-decision.ts settleHeldTrajectory), withdrawal (hold-withdrawal.ts) or expiry (hold-expiry.ts expireUndecidedHolds); the request's own trajectory is ended by withTrajectory unless held",
  "platform/admin/config-handlers.ts#dispatchInTrajectory":
    "the hold: its decision, withdrawal or expiry, as the command bar's",
  "platform/effects/route.ts#routeGovernedEffect":
    "the caller's trajectory (an adaptive or content run); its hold's decision or expiry ends the hold's",
  "platform/app-framework/session.ts#createSession":
    "the app session: a session has no end state yet (audit B-5, batch S4 of the TASK-193 sweep); the reaper skips session trajectories",
  "platform/action-pipeline/index.ts#proposeOnce":
    "the library itself: its caller names the closer (each caller is a site here)",
  "platform/action-pipeline/index.ts#reviseProposal":
    "supersedes the live proposal and re-proposes under the same trajectory: proposeAction pauses it again",
  "platform/admin/approval-decision.ts#decideRuntimeHoldNow":
    "decideRuntimeHold, its only caller, settles the hold's trajectory in a finally (settleHeldTrajectory)",
  "platform/admin/hold-withdrawal.ts#oneByOne":
    "withdrawBatch, its only caller, settles every withdrawn hold's trajectory",
  "lib/translate-session.ts#openTranslateSession":
    "Playform's app session (createSession): its trajectory is the session's (audit B-5, batch S4)",
};

/** Files that implement the stores: their own calls are the transitions, not decisions on them. */
const STORE_FILES = new Set([
  "platform/agents/proposal-store.ts",
  "platform/agents/postgres-proposal-store.ts",
  "platform/agents/trajectory-store.ts",
  "platform/agents/postgres-trajectory-store.ts",
]);

interface Site {
  readonly key: string;
  readonly line: number;
  readonly what: string;
  readonly closed: boolean;
}

function functionName(node: ts.Node, sf: ts.SourceFile): string {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (
      (ts.isFunctionDeclaration(n) ||
        ts.isMethodDeclaration(n) ||
        ts.isFunctionExpression(n)) &&
      n.name
    ) {
      return n.name.getText(sf);
    }
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      ts.isVariableDeclaration(n.parent) &&
      ts.isIdentifier(n.parent.name)
    ) {
      return n.parent.name.text;
    }
  }
  return "(top level)";
}

/** The nearest named function around `node` (its body is where a closer counts). */
function enclosingNamed(node: ts.Node): ts.Node | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n;
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      ts.isVariableDeclaration(n.parent)
    )
      return n;
  }
  return undefined;
}

/** The nearest function of any kind around `node`. */
function enclosingAny(node: ts.Node): ts.Node | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n)) return n;
  }
  return undefined;
}

function callsIn(
  node: ts.Node | undefined,
  names: readonly string[],
  accept: (call: ts.CallExpression, name: string) => boolean = () => true
): boolean {
  if (!node) return false;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      if (names.includes(name) && accept(n, name)) found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * A mover moves the HOLD's trajectory (review round 1, L6): `endHeldTrajectory(` and
 * `settleHeldTrajectory(` take the hold; an `.updateStatus(` counts only when its first argument
 * is a trajectory id read from a hold (`<hold>.trajectoryId`) — an update of some other
 * trajectory in the same function does not end this hold's.
 */
function movesHeldTrajectory(sf: ts.SourceFile) {
  return (call: ts.CallExpression, name: string): boolean => {
    if (name !== "updateStatus") return true;
    const first = call.arguments[0];
    return (
      first !== undefined &&
      ts.isPropertyAccessExpression(first) &&
      first.name.text === "trajectoryId" &&
      first.expression.getText(sf) !== "this"
    );
  };
}

function insideCallOf(node: ts.Node, name: string): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === name
    )
      return true;
  }
  return false;
}

/** Whether `call` opens a trajectory. */
function opensTrajectory(call: ts.CallExpression, sf: ts.SourceFile): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    if (["createSession", "proposeOnce", "proposeAction"].includes(callee.text))
      return callee.text;
    return undefined;
  }
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "create")
    return undefined;
  const receiver = callee.expression.getText(sf);
  const first = call.arguments[0];
  const subjectLiteral =
    first !== undefined &&
    ts.isObjectLiteralExpression(first) &&
    first.properties.some(
      (p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === "kind"
    );
  // A TrajectoryStore.create(subject, trigger, scopeType, scopeId?): the scope is a literal.
  const scope = call.arguments[2];
  const scoped =
    scope !== undefined &&
    ts.isStringLiteralLike(scope) &&
    ["user", "platform", "group"].includes(scope.text);
  if (/trajector/i.test(receiver) || subjectLiteral || scoped)
    return `${receiver}.create`;
  // A receiver declared as a trajectory store (`store: TrajectoryStore`, `= getTrajectoryStore()`).
  if (
    ts.isIdentifier(callee.expression) &&
    declaredAsTrajectoryStore(callee.expression, sf)
  )
    return `${receiver}.create`;
  return undefined;
}

/** Whether `name` is declared in this file as a trajectory store (a parameter or a variable). */
function declaredAsTrajectoryStore(name: ts.Identifier, sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      (ts.isVariableDeclaration(n) || ts.isParameter(n)) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name.text &&
      /TrajectoryStore\b|getTrajectoryStore\(/.test(n.getText(sf))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

const DECISIONS = ["withdraw", "resolveIndeterminate", "supersede", "decide"];

function scan(files: readonly string[]): { creators: Site[]; decisions: Site[] } {
  return scanSources(files.map((f) => [f, read(f)] as const));
}

/** Holds open (pause) the trajectory they are given: inside withTrajectory, the hold ends it. */
const HOLDS = ["proposeOnce", "proposeAction"];

function scanSources(sources: ReadonlyArray<readonly [string, string]>): {
  creators: Site[];
  decisions: Site[];
} {
  const creators: Site[] = [];
  const decisions: Site[] = [];
  for (const [file, text] of sources) {
    if (
      !/\.create\(|createSession\(|propose(?:Once|Action)\(|\.withdraw\(|\.resolveIndeterminate\(|\.supersede\(|\.decide\(/.test(
        text
      )
    )
      continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        const opened = opensTrajectory(n, sf);
        if (opened && !STORE_FILES.has(file)) {
          const fn = enclosingNamed(n);
          const any = enclosingAny(n);
          // Inside withTrajectory, only a hold on its trajectory is ended by it: a second
          // trajectory created in its callback is not the one it ends (review round 1, L6).
          const closed =
            (insideCallOf(n, "withTrajectory") && HOLDS.includes(opened)) ||
            callsIn(any, ["finishTrajectory"]) ||
            callsIn(fn, ["finishTrajectory"]);
          creators.push({
            key: `${file}#${functionName(n, sf)}`,
            line,
            what: opened,
            closed,
          });
        }
        const callee = n.expression;
        if (
          ts.isPropertyAccessExpression(callee) &&
          DECISIONS.includes(callee.name.text) &&
          !STORE_FILES.has(file) &&
          /proposal|store/i.test(callee.expression.getText(sf))
        ) {
          const any = enclosingAny(n);
          const fn = enclosingNamed(n);
          const movers = ["endHeldTrajectory", "settleHeldTrajectory", "updateStatus"];
          decisions.push({
            key: `${file}#${functionName(n, sf)}`,
            line,
            what: callee.name.text,
            closed:
              callsIn(any, movers, movesHeldTrajectory(sf)) ||
              callsIn(fn, movers, movesHeldTrajectory(sf)),
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { creators, decisions };
}

const FILES = productionSources().filter((f) => /\.tsx?$/.test(f));
const found = scan(FILES);

describe("every trajectory opened is ended, every hold ended ends its trajectory (TASK-193)", () => {
  it("finds the sites it means to (self-test)", () => {
    const creators = new Set(found.creators.map((s) => s.key));
    const want = [
      "platform/agents/runtime.ts#executeAgent",
      "platform/admin/config-handlers.ts#dispatchConfigTool",
      "app/api/admin/ai/command-bar.ts#runCommandBarAction",
      "platform/agents/workflow-loop.ts#createTrajectory",
      "platform/agents/trajectory-closure.ts#withTrajectory",
    ];
    expect(want.filter((k) => !creators.has(k))).toEqual([]);
    const decisions = new Set(found.decisions.map((s) => s.key));
    expect([...decisions]).toEqual(
      expect.arrayContaining([
        "platform/agents/gating.ts#withdrawHeldAction",
        "platform/admin/approval-decision.ts#decideRuntimeHoldNow",
      ])
    );
  });

  it("tells a hold's trajectory from another, and a second trajectory inside withTrajectory (round 1, L6)", () => {
    const fixture = scanSources([
      [
        "fixture/second.ts",
        `export async function second(store: TrajectoryStore) {
           return withTrajectory(args, async (id) => {
             const other = await store.create({ kind: "agent", id: "x" }, "t", "platform");
             await proposeAction(req);
             return other;
           });
         }`,
      ],
      [
        "fixture/decide.ts",
        `export async function wrongOne(proposals: ProposalStore, trajectories: TrajectoryStore, run: Run) {
           const hold = await proposals.withdraw(id, by, note);
           await trajectories.updateStatus(run.id, "failed");
         }
         export async function rightOne(proposals: ProposalStore, trajectories: TrajectoryStore) {
           const hold = await proposals.withdraw(id, by, note);
           await trajectories.updateStatus(hold.trajectoryId, "failed");
         }`,
      ],
    ]);
    expect(fixture.creators.map((c) => [c.what, c.closed])).toEqual([
      ["store.create", false],
      ["proposeAction", true],
    ]);
    expect(fixture.decisions.map((d) => [d.key, d.closed])).toEqual([
      ["fixture/decide.ts#wrongOne", false],
      ["fixture/decide.ts#rightOne", true],
    ]);
  });

  it("every site that opens a trajectory ends it, or names what does", () => {
    const open = found.creators
      .filter((s) => !s.closed && !CLOSERS[s.key])
      .map((s) => `${s.key} (line ${s.line}: ${s.what})`);
    expect(open).toEqual([]);
  });

  it("every decision that ends a hold moves its trajectory, or names what does", () => {
    const open = found.decisions
      .filter((s) => !s.closed && !CLOSERS[s.key])
      .map((s) => `${s.key} (line ${s.line}: .${s.what}())`);
    expect(open).toEqual([]);
  });

  it("every CLOSERS entry is a site that exists and needs it, each with its reason", () => {
    const needed = new Set(
      [...found.creators, ...found.decisions].filter((s) => !s.closed).map((s) => s.key)
    );
    const stale = Object.keys(CLOSERS).filter((key) => {
      const file = key.split("#")[0];
      // An app's own file is not in this repository: its entry is checked there.
      if (!existsSync(join(ROOT, file))) return false;
      return !needed.has(key);
    });
    expect(stale).toEqual([]);
    for (const [key, why] of Object.entries(CLOSERS)) {
      expect([key, why.length > 20]).toEqual([key, true]);
    }
  });
});
