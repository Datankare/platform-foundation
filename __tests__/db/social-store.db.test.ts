/**
 * @jest-environment node
 */
/**
 * PostgresSocialStore against the replayed database: the conformance kit inside one tenant
 * (each test a fresh tenant with its own users — groups, members and invitees are users of the
 * same tenant), the SQL paths the kit does not reach (duplicates, not found, refusals, the
 * group and its owner written together), and the store isolated between tenants.
 */

jest.mock("@/platform/data", () => require("../helpers/data-faults").withFaults());
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { randomUUID } from "node:crypto";
import { runSocialStoreContract } from "../contract/social-store-contract";
import { runTenantIsolationContract } from "../contract/tenant-isolation-contract";
import { socialIsolation } from "../helpers/moderation-isolation-fixtures";
import { clearFaults, faults } from "../helpers/data-faults";
import { PostgresSocialStore, type CreateGroupInput } from "@/platform/social";
import { DataUnavailableError, withTenantTx } from "@/platform/data";
import { peekTenant, runWithoutTenant } from "@/platform/tenancy/context";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  inTenant,
  type TestTenant,
} from "../helpers/db";

const tenants = new Map<string, TestTenant>();
async function tenant(): Promise<TestTenant> {
  const t = await createTestTenant();
  tenants.set(t.id, t);
  return t;
}
async function userFor(): Promise<string> {
  const t = tenants.get(peekTenant()?.tenantId ?? "");
  return t ? t.user("iso") : randomUUID();
}

const unavailable = () => new DataUnavailableError("injected");

dbDescribe("PostgresSocialStore", () => {
  beforeAll(connectTestDatabase);
  afterEach(() => {
    clearFaults();
    jest.clearAllMocks();
  });
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  describe("conformance", () => {
    let users = { owner: "", member: "", invitee: "" };
    runSocialStoreContract({
      makeStore: async () => {
        const t = await tenant();
        users = {
          owner: await t.user("owner"),
          member: await t.user("member"),
          invitee: await t.user("invitee"),
        };
        return inTenant(new PostgresSocialStore(), t);
      },
      users: () => users,
    });
  });

  runTenantIsolationContract({
    name: "groups",
    makeStore: () => new PostgresSocialStore(),
    createTenant: tenant,
    ...socialIsolation(userFor),
    // Writes report failure as a result and reads return nothing: see "without a tenant".
    failsClosedWithoutTenant: false,
  });

  describe("SQL paths beyond the kit", () => {
    let t: TestTenant;
    let store: PostgresSocialStore;
    let owner: string;
    let member: string;
    beforeEach(async () => {
      t = await tenant();
      store = inTenant(new PostgresSocialStore(), t);
      owner = await t.user("owner");
      member = await t.user("member");
    });

    const group = async () =>
      (await store.createGroup({ name: "Group one", description: "", ownerId: owner }))
        .group!;

    it("creates the group with its owner as a member, metadata and ISO timestamps", async () => {
      const res = await store.createGroup({
        name: "Group one",
        description: "about",
        metadata: { theme: "blue" },
        ownerId: owner,
      });
      expect(res.group).toMatchObject({
        name: "Group one",
        description: "about",
        metadata: { theme: "blue" },
        ownerId: owner,
        status: "active",
      });
      expect(new Date(res.group!.createdAt).toISOString()).toBe(res.group!.createdAt);
      expect(await store.getGroupById(res.group!.id)).toEqual(res.group);
      const members = await store.getMembers(res.group!.id);
      expect(members).toEqual([
        expect.objectContaining({ userId: owner, role: "owner", leftAt: null }),
      ]);
    });

    it("defaults the description and metadata", async () => {
      // A caller outside TypeScript may leave the description out.
      const g = (
        await store.createGroup({ name: "Group one", ownerId: owner } as CreateGroupInput)
      ).group!;
      expect(g).toMatchObject({ description: "", metadata: {} });
    });

    it("writes neither the group nor the membership when the membership is refused", async () => {
      faults.fail = (sql) =>
        /insert into group_memberships/.test(sql) ? new Error("refused") : undefined;
      const res = await store.createGroup({
        name: "Group one",
        description: "",
        ownerId: owner,
      });
      expect(res).toEqual({ success: false, error: "Database error: unknown" });
      clearFaults();
      const { rows } = await t.run(() =>
        withTenantTx((tx) => tx.query("select id from groups"))
      );
      expect(rows).toEqual([]);
    });

    it("refuses a group whose owner it cannot see, or whose name is too short", async () => {
      expect(
        await store.createGroup({
          name: "Group one",
          description: "",
          ownerId: randomUUID(),
        })
      ).toEqual({
        success: false,
        error: "Database error: 23503",
      });
      expect(
        await store.createGroup({ name: "ab", description: "", ownerId: owner })
      ).toEqual({
        success: false,
        error: "Database error: 23514",
      });
    });

    it("reports an unreachable store as unavailable", async () => {
      const g = await group();
      faults.fail = unavailable;
      const unavailableResult = { success: false, error: "Store unavailable" };
      expect(
        await store.createGroup({ name: "Group two", description: "", ownerId: owner })
      ).toEqual(unavailableResult);
      expect(await store.updateGroupStatus(g.id, "archived")).toEqual(unavailableResult);
      expect(await store.addMember(g.id, member, "member")).toEqual(unavailableResult);
      expect(await store.removeMember(g.id, owner)).toEqual(unavailableResult);
      expect(
        await store.createInvite({ groupId: g.id, inviterId: owner, inviteeId: member })
      ).toEqual(unavailableResult);
      expect(await store.resolveInvite(randomUUID(), "accepted")).toEqual(
        unavailableResult
      );
      expect(await store.getGroupById(g.id)).toBeUndefined();
      expect(await store.listGroupsForUser(owner)).toEqual([]);
      expect(await store.getMembers(g.id)).toEqual([]);
      expect(await store.getMembership(g.id, owner)).toBeUndefined();
      expect(await store.listPendingInvites(member)).toEqual([]);
      expect(await store.getInviteById(randomUUID())).toBeUndefined();
    });

    it("answers not found for unknown and malformed ids", async () => {
      expect(await store.getGroupById(randomUUID())).toBeUndefined();
      expect(await store.getGroupById("not-a-uuid")).toBeUndefined();
      expect(await store.updateGroupStatus(randomUUID(), "archived")).toEqual({
        success: false,
        error: "Group not found",
      });
      expect(await store.updateGroupStatus("not-a-uuid", "archived")).toEqual({
        success: false,
        error: "Database error: 22P02",
      });
      expect(await store.getInviteById(randomUUID())).toBeUndefined();
      expect(await store.getMembership(randomUUID(), owner)).toBeUndefined();
    });

    it("refuses a second active membership, and allows rejoining after leaving", async () => {
      const g = await group();
      expect((await store.addMember(g.id, member, "member")).success).toBe(true);
      expect(await store.addMember(g.id, member, "admin")).toEqual({
        success: false,
        error: "User is already an active member",
      });
      expect(await store.addMember(g.id, randomUUID(), "member")).toEqual({
        success: false,
        error: "Database error: 23503",
      });

      const left = await store.removeMember(g.id, member);
      expect(left.membership?.leftAt).toEqual(expect.any(String));
      expect(await store.removeMember(g.id, member)).toEqual({
        success: false,
        error: "Active membership not found",
      });
      expect(await store.removeMember("not-a-uuid", member)).toEqual({
        success: false,
        error: "Active membership not found",
      });
      expect(await store.listGroupsForUser(member)).toEqual([]);

      const rejoined = await store.addMember(g.id, member, "admin");
      expect(rejoined.success).toBe(true);
      // The latest membership, active or not.
      expect(await store.getMembership(g.id, member)).toEqual(rejoined.membership);
      expect((await store.listGroupsForUser(member)).map((x) => x.id)).toEqual([g.id]);
    });

    it("refuses a second pending invite, resolves once, and lists newest first", async () => {
      const g = await group();
      const g2 = (
        await store.createGroup({ name: "Group two", description: "", ownerId: owner })
      ).group!;
      const first = await store.createInvite({
        groupId: g.id,
        inviterId: owner,
        inviteeId: member,
      });
      expect(first.invite).toMatchObject({ status: "pending", resolvedAt: null });
      expect(
        await store.createInvite({ groupId: g.id, inviterId: owner, inviteeId: member })
      ).toEqual({ success: false, error: "Pending invite already exists for this user" });
      expect(
        await store.createInvite({
          groupId: g.id,
          inviterId: owner,
          inviteeId: randomUUID(),
        })
      ).toEqual({ success: false, error: "Database error: 23503" });
      const second = await store.createInvite({
        groupId: g2.id,
        inviterId: owner,
        inviteeId: member,
      });
      expect((await store.listPendingInvites(member)).map((i) => i.id)).toEqual([
        second.invite!.id,
        first.invite!.id,
      ]);
      expect(await store.getInviteById(first.invite!.id)).toEqual(first.invite);

      const declined = await store.resolveInvite(first.invite!.id, "declined");
      expect(declined.invite).toMatchObject({
        status: "declined",
        resolvedAt: expect.any(String),
      });
      expect(await store.resolveInvite(first.invite!.id, "accepted")).toEqual({
        success: false,
        error: "Invite not found or already resolved",
      });
      expect(await store.resolveInvite("not-a-uuid", "accepted")).toEqual({
        success: false,
        error: "Database error: 22P02",
      });
    });
  });

  describe("without a tenant", () => {
    it("writes nothing and reads nothing", async () => {
      const store = new PostgresSocialStore();
      await runWithoutTenant(async () => {
        expect(
          await store.createGroup({
            name: "Group one",
            description: "",
            ownerId: randomUUID(),
          })
        ).toMatchObject({ success: false });
        expect(await store.getGroupById(randomUUID())).toBeUndefined();
        expect(await store.listGroupsForUser(randomUUID())).toEqual([]);
      });
    });
  });
});
