/**
 * @jest-environment node
 */
/**
 * __tests__/recorded-text.test.ts — the platform's notes on a record are a catalog key and
 * values, rendered where they are shown (TASK-208, N-110)
 *
 * A withdrawn approval's record, an abandoned run's reason, the note left where an erased one was,
 * a carried-over ban, who acted in an audit export: stored as the catalog's key and values
 * (platform/errors/recorded-text.ts), never English; the subject's export renders them
 * (platform/auth/data-export.ts renderRecords), and leaves what a person wrote as it is.
 *
 * @not-guard: behaviour tests of the records; reads four named stores to pin their SQL's keys
 * to the catalog, an instance check, not a scan (rule C of screen-text-indirect is the guard)
 */
import {
  BAN_CARRIED_OVER,
  EXPORT_ACTOR_KEYS,
  NOTE_ERASED,
  RECORDED_UNKNOWN,
  abandonedReason,
  isRecordedText,
  withdrawalRecord,
} from "@/platform/errors/recorded-text";
import { decisionWords, renderRecorded } from "@/platform/errors/recorded-words";
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
