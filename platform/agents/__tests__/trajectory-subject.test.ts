/**
 * platform/agents/__tests__/trajectory-subject.test.ts
 *
 * ADR-029 D4 — a trajectory carries an explicit subject.
 *
 * Before D4, session trajectories were created by passing a sessionId into the `agentId`
 * parameter. It type-checked, so no test could have caught it by construction; these arms
 * assert the discriminator that makes the two kinds distinguishable.
 */

import { InMemoryTrajectoryStore } from "../trajectory-store";

describe("TrajectorySubject (ADR-029 D4)", () => {
  let store: InMemoryTrajectoryStore;

  beforeEach(() => {
    store = new InMemoryTrajectoryStore();
  });

  it("records an agent subject", async () => {
    const record = await store.create(
      { kind: "agent", id: "guardian" },
      "content-screen",
      "platform"
    );

    expect(record.subject.kind).toBe("agent");
    expect(record.subject.id).toBe("guardian");
    expect(record.trajectory.agentId).toBe("guardian");
  });

  it("records a session subject", async () => {
    const record = await store.create(
      { kind: "session", id: "sess_abc" },
      "session-created",
      "user"
    );

    expect(record.subject.kind).toBe("session");
    expect(record.subject.id).toBe("sess_abc");
  });

  it("filters by subjectKind", async () => {
    await store.create({ kind: "agent", id: "guardian" }, "a", "platform");
    await store.create({ kind: "session", id: "sess_1" }, "b", "user");

    const sessions = await store.query({ subjectKind: "session" });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].subject.id).toBe("sess_1");
  });

  it("filters by subjectId", async () => {
    await store.create({ kind: "session", id: "sess_1" }, "a", "user");
    await store.create({ kind: "session", id: "sess_2" }, "b", "user");

    const one = await store.query({ subjectId: "sess_2" });

    expect(one).toHaveLength(1);
    expect(one[0].trigger).toBe("b");
  });

  it("separates an agent and a session that share an id", async () => {
    await store.create({ kind: "agent", id: "shared" }, "agent-run", "platform");
    await store.create({ kind: "session", id: "shared" }, "session-created", "user");

    const agents = await store.query({ subjectKind: "agent", subjectId: "shared" });

    expect(agents).toHaveLength(1);
    expect(agents[0].trigger).toBe("agent-run");
  });
});
