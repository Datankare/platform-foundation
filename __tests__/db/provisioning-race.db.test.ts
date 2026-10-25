/**
 * @jest-environment node
 */
/**
 * First requests at once each get their account (TASK-117; PF v6.0.x, found adopting PF in
 * Playform). The account insert said `on conflict (id) do nothing`, which arbitrates only the id:
 * a request that passed the id check before the winner's row reached the index then waited on
 * the winner at the cognito_sub key (players_cognito_sub_key) and failed with a unique violation
 * there — "failed", refused as account.not_provisioned (about 2 in 900 concurrent attempts). It
 * now says `on conflict do nothing` with no target (every unique key of the row arbitrates) and
 * then reads, in the same tenant transaction, which row holds the identity.
 *
 * The interleaving is injected, not raced: a second connection (the owner's) holds the
 * conflicting row in an open transaction, the test waits until Postgres reports the provisioning
 * insert blocked on that connection (pg_blocking_pids), and only then lets the holder finish.
 * The stress case runs many rounds of three concurrent first requests on top.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: jest.fn(async (_key: string, fallback: unknown) => fallback),
}));

import { randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";
import { auditRowsForUser } from "@/platform/auth/audit";
import {
  DEFAULT_USER_ROLE,
  ensureUserProvisioned,
  type ProvisioningOutcome,
} from "@/platform/auth/user-provisioning";
import { withOwnerTx, withTenantTx, type Tx } from "@/platform/data";
import {
  DB_ENABLED,
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";

let t: TestTenant;
if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
    t = await createTestTenant();
  });
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });
}
afterEach(() => jest.clearAllMocks());

type Row = Record<string, unknown>;

const rowsOf = (sub: string): Promise<Row[]> =>
  t.run(() =>
    withTenantTx(
      async (tx) =>
        (
          await tx.query(
            "select id, cognito_sub from users where id = $1::uuid or cognito_sub = $2",
            [sub, sub]
          )
        ).rows
    )
  );

/** Wait until some backend is blocked on `pid` (Postgres' own lock graph), or fail. */
async function blockedOn(pid: number): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where $1::int = any(pg_blocking_pids(pid))",
        [pid]
      )
    );
    if (rows[0]!.n > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`nothing blocked on backend ${pid}`);
}

/**
 * Provision `sub` while the owner's connection holds `hold`'s writes uncommitted: the
 * provisioning insert is started, seen blocked on the holder, and the holder then runs
 * `finish` and commits (or rolls back when `finish` throws).
 */
async function provisionAgainstHeldRow(
  sub: string,
  hold: (tx: Tx) => Promise<unknown>,
  finish: (tx: Tx) => Promise<unknown>
): Promise<ProvisioningOutcome> {
  let pid!: number;
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let held!: () => void;
  const isHeld = new Promise<void>((r) => (held = r));
  const holder = withOwnerTx("tenant-lifecycle", async (tx) => {
    pid = (await tx.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!
      .pid;
    await hold(tx);
    held();
    await released;
    await finish(tx);
  }).catch((err: unknown) => err);
  await isHeld;
  const outcome = t.run(() => ensureUserProvisioned(sub));
  await blockedOn(pid);
  release();
  const [result, holderError] = await Promise.all([outcome, holder]);
  if (holderError instanceof Error && holderError.message !== "roll back")
    throw holderError;
  return result;
}

const insertHeld = (tx: Tx, id: string, sub: string) =>
  tx.query(
    `insert into users (id, cognito_sub, role_id, tenant_id)
     select $1::uuid, $2, r.id, $3::uuid from roles r where r.name = $4`,
    [id, sub, t.id, DEFAULT_USER_ROLE]
  );

const rollBack = async () => {
  throw new Error("roll back");
};

dbDescribe("account provisioning against a concurrent first request (Postgres)", () => {
  it("the winner's row reaches the subject key before the id key: the loser answers existing, never failed", async () => {
    // The interleaving behind the defect: the winner's subject is in the index, its id is not
    // yet. The id-only arbiter passed the id check and then failed on players_cognito_sub_key
    // (here, it deadlocks against the winner's id). Every key arbitrating, the insert waits on
    // the winner, inserts nothing, and the read that follows finds the winner's row.
    const sub = randomUUID();
    const interim = randomUUID();
    const outcome = await provisionAgainstHeldRow(
      sub,
      (tx) => insertHeld(tx, interim, sub),
      (tx) =>
        tx.query("update users set id = $2::uuid where id = $1::uuid", [interim, sub])
    );
    expect(outcome).toBe("existing");
    expect(await rowsOf(sub)).toEqual([{ id: sub, cognito_sub: sub }]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("the winner's row holds both keys: existing, one row", async () => {
    const sub = randomUUID();
    const outcome = await provisionAgainstHeldRow(
      sub,
      (tx) => insertHeld(tx, sub, sub),
      async () => undefined
    );
    expect(outcome).toBe("existing");
    expect(await rowsOf(sub)).toHaveLength(1);
  });

  it("the concurrent writer rolls back: this request creates the account", async () => {
    for (const other of ["same id", "same subject only"]) {
      const sub = randomUUID();
      const outcome = await provisionAgainstHeldRow(
        sub,
        (tx) => insertHeld(tx, other === "same id" ? sub : randomUUID(), sub),
        rollBack
      );
      expect(outcome).toBe("created");
      expect(await rowsOf(sub)).toEqual([{ id: sub, cognito_sub: sub }]);
    }
  });

  it("hostile: another account commits the subject — failed, decided by the read, not a unique violation", async () => {
    const sub = randomUUID();
    const other = randomUUID();
    const outcome = await provisionAgainstHeldRow(
      sub,
      (tx) => insertHeld(tx, other, sub),
      async () => undefined
    );
    expect(outcome).toBe("failed");
    expect(await rowsOf(sub)).toEqual([{ id: other, cognito_sub: sub }]);
    expect(logger.error).toHaveBeenCalledWith(
      "User provisioning failed",
      expect.objectContaining({
        step: "insert",
        error: "the subject is held by another account of this tenant",
      })
    );
    const audit = await t.run(() => withTenantTx((tx) => auditRowsForUser(tx, sub, 10)));
    expect(audit.map((r) => (r.details as Row).outcome).sort()).toEqual([
      "attempted",
      "failed",
    ]);
  });

  it("hostile: the identity is held in another tenant — failed, never this tenant's account", async () => {
    const elsewhere = await createTestTenant();
    const sub = randomUUID();
    await elsewhere.run(() => ensureUserProvisioned(sub));
    await expect(t.run(() => ensureUserProvisioned(sub))).resolves.toBe("failed");
    expect(logger.error).toHaveBeenCalledWith(
      "User provisioning failed",
      expect.objectContaining({ error: "the identity is held outside this tenant" })
    );
    expect(await rowsOf(sub)).toEqual([]);
  });

  it("stress: three first requests at once, many rounds — one created, the rest existing, never failed", async () => {
    for (let round = 0; round < 150; round++) {
      const sub = randomUUID();
      const outs = await Promise.all(
        [0, 1, 2].map(() => t.run(() => ensureUserProvisioned(sub)))
      );
      expect(outs.sort()).toEqual(["created", "existing", "existing"]);
      expect(await rowsOf(sub)).toHaveLength(1);
    }
    expect(logger.error).not.toHaveBeenCalled();
  }, 120_000);
});
