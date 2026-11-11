/**
 * @jest-environment node
 */
/**
 * __tests__/recorded-text.test.ts — the platform's notes on a record are a catalog key and
 * values, rendered where they are shown (TASK-208, N-110; TASK-209, N-112)
 *
 * A withdrawn approval's record, an abandoned run's reason, the note left where an erased one was,
 * a carried-over ban, who acted in an audit export: stored as the catalog's key and values
 * (platform/errors/recorded-text.ts), never English; the subject's export renders them
 * (platform/auth/data-export.ts renderRecords), and leaves what a person wrote as it is.
 *
 * @not-guard: behaviour tests of the records; reads four named stores to pin their SQL's keys
 * to the catalog, an instance check, not a scan (rule C of screen-text-indirect is the guard)
 */
import { messageKey } from "@/platform/errors/registry";
import {
  CLAIM_TAKEN_BACK,
  COMPLETION_NOT_WRITTEN,
  RUN_RAISED,
} from "@/platform/action-pipeline";
import {
  APPROVED_AGAIN,
  BAN_CARRIED_OVER,
  BAN_STRIKE_THRESHOLD,
  CHANGED_ON_PAGE,
  EXPORT_ACTOR_KEYS,
  NOTE_ERASED,
  POWER_REDUCED,
  RECORDED_UNKNOWN,
  REFUSED_STALE,
  RESET_TO_DEFAULT,
  REVISED,
  SET_BY_OPERATOR,
  VERIFIED_APPLIED,
  VERIFIED_NOT_APPLIED,
  WITHDRAWN_RUN_FAILED,
  abandonedReason,
  agentsSuspended,
  approvedNote,
  changeApproved,
  configWithdrawn,
  duplicateOf,
  emergencySuspended,
  escalationAutoBlocked,
  expiredUndecided,
  expiredUnused,
  isRecordedText,
  markedExecuted,
  noteColumns,
  refused,
  requiredJob,
  staleState,
  strikeReasonText,
  superseded,
  withdrawalRecord,
} from "@/platform/errors/recorded-text";
import {
  decisionWords,
  renderRecorded,
  runNoteShown,
} from "@/platform/errors/recorded-words";
import { renderShown } from "@/platform/errors/shown-text";
import {
  EFFECT_FAILED,
  EFFECT_UNKNOWN,
  EFFECT_UNRESOLVED,
} from "@/platform/agents/external-effect";
import { renderRecords } from "@/platform/auth/data-export";
import { renderMessage } from "@/platform/errors/messages";
import en from "@/messages/en.json";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AT = "2026-01-02T03:04:05.000Z";

describe("recorded text (TASK-208, N-110)", () => {
  it("every key the records use is one English has", () => {
    const keys = [
      BAN_CARRIED_OVER.key,
      NOTE_ERASED.key,
      RECORDED_UNKNOWN.key,
      withdrawalRecord({}).key,
      withdrawalRecord({}, "undecided").key,
      abandonedReason(AT).key,
      ...Object.values(EXPORT_ACTOR_KEYS).map((k) => k.key),
      "screens.records.note",
      "screens.records.superseded_identity_unrecorded",
      "screens.records.superseded_newer_proposal",
      // TASK-209 (N-112): the platform's notes TypeScript wrote, each a key and values.
      ...[
        expiredUnused(7),
        expiredUndecided(7),
        WITHDRAWN_RUN_FAILED,
        VERIFIED_NOT_APPLIED,
        VERIFIED_APPLIED,
        APPROVED_AGAIN,
        REVISED,
        staleState(1, 2),
        duplicateOf("h"),
        REFUSED_STALE,
        refused(REFUSED_STALE),
        requiredJob("k"),
        superseded(POWER_REDUCED),
        POWER_REDUCED,
        agentsSuspended("r"),
        configWithdrawn(REFUSED_STALE, {}),
        CHANGED_ON_PAGE,
        SET_BY_OPERATOR,
        RESET_TO_DEFAULT,
        changeApproved("c"),
        emergencySuspended("r"),
        BAN_STRIKE_THRESHOLD,
        escalationAutoBlocked(24),
        markedExecuted("by", "n"),
        strikeReasonText("guardian_block:classifier", {})!,
      ].map((t) => t.key),
      EFFECT_FAILED,
      EFFECT_UNKNOWN,
      EFFECT_UNRESOLVED,
      // An audited act's outcome reasons (TASK-209: audit details).
      "screens.records.audit_act_raised",
      "screens.records.audit_reported_failure",
      "screens.records.audit_rolled_back",
      "screens.records.audit_indeterminate",
      "screens.records.audit_run_failed_kept",
      "screens.records.audit_run_failed_not_released",
      // A run's failure reason, audited (TASK-209: audit details).
      RUN_RAISED,
      COMPLETION_NOT_WRITTEN,
      CLAIM_TAKEN_BACK,
      // 067 moves the rows written before to these (supabase/migrations/067_…).
      "screens.records.config_stale",
      "screens.records.config_refused",
      "screens.records.config_required_job_062",
      "screens.records.dual_control_added",
      "screens.records.dual_control_removed",
    ];
    for (const key of keys) expect([key, renderMessage(key)]).not.toEqual([key, key]);
    // And the catalog's records are exactly these (no stray key).
    expect(
      Object.keys(en.screens.records)
        .map((k) => `screens.records.${k}`)
        .sort()
    ).toEqual([...new Set(keys)].sort());
  });

  it("a withdrawal's record keeps who had approved it and when; its note is the row's own", () => {
    const record = withdrawalRecord({ decidedBy: "alice", decidedAt: AT });
    expect(record).toEqual({
      key: "screens.records.withdrawn_after_approval",
      params: { approvedBy: "alice", approvedAt: AT },
    });
    expect(decisionWords({ decisionShown: record, decisionNote: "its run failed" })).toBe(
      `Approved by alice at ${AT}, never run; withdrawn: its run failed`
    );
    expect(
      decisionWords({
        decisionShown: withdrawalRecord({}, "undecided"),
        decisionNote: "checked",
      })
    ).toBe(
      "Approved by unknown at unknown, its run undecided; withdrawn, verified not applied: checked"
    );
  });

  it("a decision with no record is its note alone; an erased note is the catalog's", () => {
    expect(decisionWords({ decisionNote: "a person's words" })).toBe("a person's words");
    expect(decisionWords({})).toBeUndefined();
    expect(
      decisionWords({
        decisionShown: { key: "screens.records.note", params: { note: NOTE_ERASED } },
      })
    ).toBe("erased with the account it was about");
    // A record that is not a screen message is not rendered as one.
    expect(
      decisionWords({ decisionShown: { key: "errors.x" }, decisionNote: "as written" })
    ).toBe("as written");
    expect(renderRecorded({ key: "not.a.screen" })).toBe("");
  });

  it("the SQL stores build the records from keys English has, and every key the code knows", () => {
    // The statements build each record inline (a query's text is never built from values), so
    // their keys are read from the source: each is one the catalog has.
    const files = [
      "platform/admin/hold-expiry.ts",
      "platform/agents/postgres-proposal-store.ts",
      "platform/agents/postgres-trajectory-store.ts",
      "platform/auth/user-provisioning.ts",
    ];
    const keys = files
      .flatMap((f) => [
        ...readFileSync(join(__dirname, "..", f), "utf8").matchAll(
          /'(screens\.records\.\w+)'/g
        ),
      ])
      .map((m) => m[1]);
    expect([...new Set(keys)].sort()).toEqual([
      "screens.records.ban_carried_over",
      "screens.records.marked_executed",
      "screens.records.trajectory_abandoned",
      "screens.records.unknown",
      "screens.records.withdrawn_after_approval",
      "screens.records.withdrawn_undecided",
    ]);
    for (const key of keys) expect([key, renderMessage(key)]).not.toEqual([key, key]);
  });

  it("isRecordedText takes a screen message's key and values only", () => {
    expect(isRecordedText(BAN_CARRIED_OVER)).toBe(true);
    expect(isRecordedText({ key: "errors.internal" })).toBe(false);
    expect(isRecordedText("A ban on this address carried over to a new account.")).toBe(
      false
    );
    expect(isRecordedText({ key: "screens.x", params: "y" })).toBe(false);
  });
});

describe("the export renders the platform's notes, and leaves a person's (TASK-208)", () => {
  const exported = () => ({
    profile: { id: "u", ban_note: BAN_CARRIED_OVER, ban_reason: null },
    auditLog: [
      { id: "1", action: "a", created_at: AT, by: "platform" },
      { id: "2", action: "b", created_at: AT, by: "another_account" },
      { id: "3", action: "c", created_at: AT, actor_id: "u" },
      { id: "4", action: "d", created_at: AT, by: "someone" },
    ],
    trajectories: [
      {
        id: "t",
        steps: [
          { action: "trajectory-abandoned", output: { reason: abandonedReason(AT) } },
          {
            action: "x",
            output: {
              note: "gone",
              decision: withdrawalRecord({ decidedBy: "bob", decidedAt: AT }),
            },
          },
          {
            action: "y",
            output: {
              note: NOTE_ERASED,
              decision: withdrawalRecord({ decidedBy: "bob", decidedAt: AT }),
            },
          },
          { action: "z", output: { note: "a person's note", reason: "their reason" } },
          "not a step",
          { action: "no output" },
        ],
      },
      "not a row",
    ],
    trajectorySteps: [
      { id: "s", steps: [{ action: "y", output: { note: NOTE_ERASED } }] },
    ],
    _meta: { complete: true },
  });

  it("renders each in the catalog's words", () => {
    const data: Record<string, unknown> = exported();
    renderRecords(data, "en");
    expect(data.profile).toEqual({
      id: "u",
      ban_note: "A ban on this address carried over to a new account.",
      ban_reason: null,
    });
    expect((data.auditLog as { by?: string }[]).map((r) => r.by)).toEqual([
      "the platform",
      "another account",
      undefined,
      // A value that is no code is left as it was.
      "someone",
    ]);
    const steps = (data.trajectories as { steps: unknown[] }[])[0].steps;
    expect(steps).toEqual([
      {
        action: "trajectory-abandoned",
        output: { reason: `no activity and no open hold since ${AT}` },
      },
      {
        action: "x",
        output: {
          note: "gone",
          decision: `Approved by bob at ${AT}, never run; withdrawn: gone`,
        },
      },
      {
        action: "y",
        output: {
          note: "erased with the account it was about",
          decision: `Approved by bob at ${AT}, never run; withdrawn: erased with the account it was about`,
        },
      },
      { action: "z", output: { note: "a person's note", reason: "their reason" } },
      "not a step",
      { action: "no output" },
    ]);
    expect((data.trajectories as unknown[])[1]).toBe("not a row");
    expect((data.trajectorySteps as { steps: unknown[] }[])[0].steps).toEqual([
      { action: "y", output: { note: "erased with the account it was about" } },
    ]);
    expect(data._meta).toEqual({ complete: true });
  });

  it("a profile with no ban note is left as it is", () => {
    const data: Record<string, unknown> = { profile: { id: "u", ban_note: null } };
    renderRecords(data, "en");
    expect(data.profile).toEqual({ id: "u", ban_note: null });
  });
});

describe("the platform's notes TypeScript wrote, in the catalog's words (TASK-209, N-112)", () => {
  it("each reads as it was written in English before", () => {
    const words: [unknown, string][] = [
      [expiredUnused(1), "expired: not run within 1 day of its approval"],
      [expiredUnused(7), "expired: not run within 7 days of its approval"],
      [expiredUndecided(2), "expired: not decided within 2 days of being requested"],
      [WITHDRAWN_RUN_FAILED, "not approved again after its run failed"],
      [VERIFIED_NOT_APPLIED, "verified that its run did not take effect"],
      [VERIFIED_APPLIED, "verified as applied"],
      [APPROVED_AGAIN, "approved again: verified that its run did not take effect"],
      [staleState(3, 5), "state advanced 3 -> 5; approval is stale"],
      [duplicateOf("h-1"), "duplicate of hold h-1, which stands"],
      [
        refused(REFUSED_STALE),
        "refused: stale: what it would replace changed since it was requested",
      ],
      [
        refused(requiredJob("jobs.x.enabled")),
        'refused: "jobs.x.enabled" turns on a job that is now required — always on, and set only as the platform default',
      ],
      [
        superseded(POWER_REDUCED),
        "withdrawn: superseded — a power reduction was applied to the key",
      ],
      [
        superseded(agentsSuspended("a breach")),
        "withdrawn: superseded — every agent was suspended: a breach",
      ],
      [
        configWithdrawn(
          { key: "screens.records.config_stale", params: { key: "k" } },
          { by: "u-1", at: AT }
        ),
        `withdrawn by the system: stale — "k" changed since it was requested (approved by u-1 at ${AT})`,
      ],
      [
        configWithdrawn(requiredJob("k"), {}),
        'withdrawn by the system: "k" turns on a job that is now required — always on, and set only as the platform default (approved by unknown at unknown)',
      ],
      [changeApproved(CHANGED_ON_PAGE), "Approved: Changed on the config page"],
      [changeApproved("launch"), "Approved: launch"],
      [emergencySuspended("leak"), "Emergency: every agent suspended — leak"],
      [BAN_STRIKE_THRESHOLD, "Automatic ban: strike threshold exceeded"],
      [
        escalationAutoBlocked(24),
        "Auto-blocked: escalation exceeded the 24h SLA without human review (ADR-041).",
      ],
      [
        markedExecuted("bob", VERIFIED_APPLIED),
        "marked executed by bob: verified as applied",
      ],
      [markedExecuted("bob", "checked"), "marked executed by bob: checked"],
      [
        strikeReasonText("guardian_block:classifier", {
          category: "hate",
          severity: "high",
        }),
        "Guardian blocked content: hate (severity: high, triggered by: classifier).",
      ],
    ];
    for (const [text, expected] of words)
      expect([text, renderShown(text as never)]).toEqual([text, expected]);
  });

  it("a note's columns: a person's text, or the platform's key and values", () => {
    expect(noteColumns("as written")).toEqual({ text: "as written", shown: null });
    expect(noteColumns(REVISED)).toEqual({ text: null, shown: REVISED });
    expect(noteColumns(undefined)).toEqual({ text: null, shown: null });
    expect(approvedNote({ changeComment: "c" })).toBe("c");
    expect(approvedNote({ changeComment: "", changeShown: CHANGED_ON_PAGE })).toEqual(
      CHANGED_ON_PAGE
    );
    expect(approvedNote({ changeComment: "c", changeShown: { key: "errors.x" } })).toBe(
      "c"
    );
    expect(strikeReasonText("a moderator's words", {})).toBeUndefined();
    expect(strikeReasonText(42, {})).toBeUndefined();
  });

  it("a run's note: a code's sentence, the platform's key, or a note recorded before", () => {
    expect(runNoteShown("approvals.run_failed")).toEqual({
      key: "errors.approvals.run_failed",
    });
    expect(runNoteShown("screens.held.note_run_failed")).toEqual({
      key: "screens.held.note_run_failed",
    });
    // A key the catalog does not have, and English written before, stay as recorded.
    expect(runNoteShown("screens.held.note_nonesuch")).toBe("screens.held.note_nonesuch");
    expect(runNoteShown("an operator's own words")).toBe("an operator's own words");
  });

  it("the export words a run's code, an effect's reason and a strike's code; a person's stays", () => {
    const data: Record<string, unknown> = {
      trajectories: [
        {
          id: "t",
          steps: [
            {
              action: "x",
              output: {
                decision: markedExecuted("bob", VERIFIED_APPLIED),
                lastRunError: "screens.held.note_indeterminate",
              },
            },
            { action: "y", output: { lastRunError: "approvals.run_failed" } },
            {
              action: "z",
              output: {
                effects: [{ status: "failed", error: EFFECT_FAILED }],
                note: REVISED,
              },
            },
            { action: "w", output: { lastRunError: "written before codes" } },
          ],
        },
      ],
      strikes: [
        {
          id: "s1",
          category: "hate",
          severity: "high",
          reason: "guardian_block:classifier",
        },
        { id: "s2", category: "spam", severity: "low", reason: "a moderator's words" },
      ],
    };
    renderRecords(data, "en");
    const steps = (
      data.trajectories as { steps: { output: Record<string, unknown> }[] }[]
    )[0].steps;
    expect(steps[0].output).toEqual({
      decision: "marked executed by bob: verified as applied",
      lastRunError: renderMessage("screens.held.note_indeterminate"),
    });
    expect(steps[1].output.lastRunError).toBe(
      renderMessage("errors.approvals.run_failed")
    );
    expect(steps[2].output).toEqual({
      effects: [
        { status: "failed", error: "the call failed (the detail is in the log)" },
      ],
      note: "revised",
    });
    expect(steps[3].output.lastRunError).toBe("written before codes");
    expect((data.strikes as { reason: string }[]).map((s) => s.reason)).toEqual([
      "Guardian blocked content: hate (severity: high, triggered by: classifier).",
      "a moderator's words",
    ]);
  });

  it("an audit record's details: the platform's words rendered in the export; codes and a person's text as they are (TASK-209)", () => {
    const data: Record<string, unknown> = {
      auditLog: [
        {
          action: "admin_action",
          by: "platform",
          details: {
            type: "approved_run_failed",
            reason: RUN_RAISED,
            changeShown: CHANGED_ON_PAGE,
            changeComment: "a person's words",
            nested: { reason: CLAIM_TAKEN_BACK },
            outcomeReason: "approvals.decision_conflict",
          },
        },
      ],
    };
    renderRecords(data, "en");
    const [row] = data.auditLog as { details: Record<string, unknown> }[];
    expect(row!.details).toEqual({
      type: "approved_run_failed",
      reason: renderMessage(RUN_RAISED),
      changeShown: renderMessage(CHANGED_ON_PAGE.key),
      changeComment: "a person's words",
      nested: { reason: renderMessage(CLAIM_TAKEN_BACK) },
      // An audited act's failure code, in its message's words.
      outcomeReason: renderMessage(messageKey("approvals.decision_conflict")),
    });
    expect(row!.details.reason).toBe(
      "the run raised an error (the detail is in the log)"
    );
  });
});
