/**
 * e2e/admin-console.spec.ts — the admin console walked as the people who use it (TASK-202:
 * N-60 to N-66, S3-E19)
 *
 * Two administrators of the deployment's one tenant (the test double's admin-a and admin-b,
 * platform/auth/mock-provider.ts) on the production build and the replayed database (CI:
 * playwright.config.ts):
 *
 *   1. admin-a changes a dual-controlled setting from its edit panel, and sees it held for approval;
 *   2. admin-b opens Approvals, sees what the change is (the setting, now → after), who asked by
 *      address and role, and the reason; approves it after the confirm step; the result names the
 *      change, says it applied, and stays until dismissed;
 *   3. admin-a registers a trusted agent through the form, and sees it held;
 *   4. admin-b opens Erasures and sees an erasure whose identity could not be verified, and asks a
 *      second operator to attest it.
 *
 * Seeded once, through the owner connection, before the walk (beforeAll): the two administrators —
 * the documented first-super-admin bootstrap (ADR-013: super_admin is assigned in the database
 * only; dual control needs a second one) — and one erasure stuck on an identity the system could
 * not find in a pool it can prove (the test double cannot produce that state). Nothing else is
 * written by hand: every change is made through the screens.
 *
 * Runs where the harness gives it a database (E2E_DATABASE_OWNER_URL — Playform's CI, or a local
 * production build on a seeded database); skipped, saying so, without one. With
 * ADMIN_SCREENSHOTS_DIR set, each screen is also saved there at 1280 px (and the console at
 * 390 px) for the change's walkthrough record (CLAUDE.md, "Admin changes are walked").
 */
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

const OWNER_URL = process.env.E2E_DATABASE_OWNER_URL;
const SHOTS = process.env.ADMIN_SCREENSHOTS_DIR;
const TENANT = "00000000-0000-4000-8000-000000000001";

/** The test double's two administrators (platform/auth/mock-provider.ts MOCK_EXTRA_IDENTITIES). */
const ADMIN_A = {
  token: "mock-access-token:admin-a",
  id: "e2e00000-0000-4000-8000-00000000000a",
  email: "admin-a@e2e.test",
};
const ADMIN_B = {
  token: "mock-access-token:admin-b",
  id: "e2e00000-0000-4000-8000-00000000000b",
  email: "admin-b@e2e.test",
};
/** The erased account whose sign-in identity could not be proven gone. */
const ERASED = "e2e00000-0000-4000-8000-0000000000e1";

const KEY = "moderation.strike_ban_threshold";

test.describe.configure({ mode: "serial" });

test.skip(!OWNER_URL, "needs the harness's database (E2E_DATABASE_OWNER_URL)");

test.beforeAll(async () => {
  const db = new Client({ connectionString: OWNER_URL });
  await db.connect();
  try {
    for (const admin of [ADMIN_A, ADMIN_B]) {
      await db.query(
        `insert into users (id, cognito_sub, email, display_name, role_id, tenant_id, email_verified)
         select $1::uuid, $1, $2, $3, r.id, $4::uuid, true from roles r where r.name = 'super_admin'
         on conflict (id) do update set role_id = excluded.role_id, deleted_at = null`,
        [admin.id, admin.email, admin.email.split("@")[0], TENANT]
      );
    }
    await db.query(
      `insert into users (id, cognito_sub, email, display_name, role_id, tenant_id, deleted_at)
       select $1::uuid, $1, null, '[deleted]', r.id, $2::uuid, now() from roles r where r.is_default
       on conflict (id) do nothing`,
      [ERASED, TENANT]
    );
    await db.query(
      `insert into user_deletions (user_id, requested_by, tenant_id, external_erasures)
       values ($1::uuid, $2, $3::uuid, $4::jsonb)
       on conflict (tenant_id, user_id) do update set external_erasures = excluded.external_erasures`,
      [
        ERASED,
        ADMIN_A.id,
        TENANT,
        JSON.stringify({
          "identity-provider": { attempts: 3, poolUnverified: true, error: "not found" },
        }),
      ]
    );
  } finally {
    await db.end();
  }
});

/** Open the console as `admin` (the test double's session in this browser). */
async function openConsole(page: Page, admin: typeof ADMIN_A): Promise<void> {
  await page.context().addCookies([
    {
      name: "pf_has_session",
      value: "true",
      domain: "localhost",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  await page.addInitScript((a) => {
    localStorage.setItem("pf_access_token", a.token);
    localStorage.setItem("pf_refresh_token", "mock-refresh-token");
    localStorage.setItem(
      "pf_user",
      JSON.stringify({
        userId: a.id,
        email: a.email,
        emailVerified: true,
        isGuest: false,
      })
    );
  }, admin);
  const session = page.waitForResponse((r) => r.url().endsWith("/api/admin/session"));
  await page.goto("/admin");
  expect((await session).status()).toBe(200);
}

/** Open a section from the sidebar; `read` is its data's response, awaited after the click. */
async function section(
  page: Page,
  name: string,
  read: Promise<{ status(): number }>
): Promise<void> {
  await page.getByRole("navigation").getByRole("button", { name }).click();
  expect((await read).status()).toBeLessThan(400);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

/** No horizontal page scroll: the console fits the window. */
async function fitsWidth(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.use({ viewport: { width: 1280, height: 900 } });

test("1. a setting is changed from its edit panel, and held for approval (N-60)", async ({
  page,
}) => {
  await openConsole(page, ADMIN_A);
  await section(
    page,
    "Platform config",
    page.waitForResponse((r) => r.url().includes("/api/admin/config"))
  );
  await page.getByLabel("Filter settings").fill("strike_ban");
  await shot(page, "01-config-list");
  await page.getByRole("button", { name: `Open ${KEY}` }).click();
  const panel = page.getByRole("region", { name: new RegExp(KEY) });
  await expect(panel.getByText("Platform default")).toBeVisible();
  await expect(panel.getByText(/Safety/).first()).toBeVisible();
  await panel.getByRole("button", { name: "Change this setting" }).click();
  await panel.getByLabel("New value").fill("7");
  await panel
    .getByLabel("Why are you changing it?")
    .fill("Fewer bans for first offences");
  await shot(page, "02-config-edit");
  const sent = page.waitForResponse((r) =>
    r.url().endsWith("/api/admin/config-ai/execute")
  );
  await panel.getByRole("button", { name: "Submit change" }).click();
  expect((await sent).status()).toBe(202);
  const held = page.getByText(
    `Held for approval by a safety approver or super admin other than you: ${KEY} → 7.`,
    { exact: false }
  );
  await expect(held).toBeVisible();
  await fitsWidth(page);
  await shot(page, "03-config-held");
});

test("2. a second admin sees the change, who asked and why; approves it; the result stays (N-61, N-62)", async ({
  page,
}) => {
  await openConsole(page, ADMIN_B);
  await section(
    page,
    "Approvals",
    page.waitForResponse((r) => r.url().includes("/api/admin/approvals"))
  );
  const card = page.locator("li[data-approval]").filter({ hasText: `Setting ${KEY}` });
  await expect(card).toHaveCount(1);
  await expect(card.locator("[data-diff='true']")).toContainText("7");
  await expect(card.locator("[data-requester='true']")).toHaveText(
    `${ADMIN_A.email} (Super admin)`
  );
  await expect(card).toContainText("Fewer bans for first offences");
  // Never the requester's id.
  await expect(card).not.toContainText(ADMIN_A.id);
  await fitsWidth(page);
  await shot(page, "04-approvals");
  await card.getByRole("button", { name: `Approve: Setting ${KEY}` }).click();
  const confirm = card.getByRole("group", { name: "Approve this change?" });
  await expect(confirm).toContainText(`Setting ${KEY}`);
  await expect(confirm).toContainText(ADMIN_A.email);
  await shot(page, "05-approvals-confirm");
  const decided = page.waitForResponse((r) => r.url().includes("/api/admin/approvals/"));
  await confirm.getByRole("button", { name: "Approve and apply" }).click();
  expect((await decided).status()).toBe(200);
  const result = page.getByText(
    `Approved: Setting ${KEY}. Applied: the setting is now 7.`
  );
  await expect(result).toBeVisible();
  // It stays: the old result went after six seconds.
  await page.waitForTimeout(8000);
  await expect(result).toBeVisible();
  await shot(page, "06-approvals-result");
  await page
    .locator("[data-result]")
    .filter({ hasText: `Approved: Setting ${KEY}` })
    .getByRole("button", { name: "Dismiss" })
    .click();
  await expect(result).toHaveCount(0);
});

test("3. a trusted agent is registered through the form (N-66)", async ({ page }) => {
  await openConsole(page, ADMIN_A);
  await section(
    page,
    "Trusted agents",
    page.waitForResponse((r) => r.url().includes("/api/admin/agent-registry"))
  );
  await page.getByRole("button", { name: "Register an agent" }).click();
  await page.getByLabel("Agent id").fill("agent:e2e-helper");
  await page.getByLabel("Scope").fill("translate");
  await page.getByLabel("Token ceiling (seconds)").fill("120");
  await shot(page, "07-agents-form");
  const sent = page.waitForResponse((r) => r.url().endsWith("/api/admin/ai/execute"));
  await page.getByRole("button", { name: "Register", exact: true }).click();
  expect([200, 202]).toContain((await sent).status());
  await expect(
    page.getByText(
      /^(Held for approval by .*: register agent:e2e-helper\.|Applied: register agent:e2e-helper\.)/
    )
  ).toBeVisible();
  await fitsWidth(page);
  await shot(page, "08-agents-result");
});

test("4. an erasure stuck on an unverifiable identity is shown, and an attestation asked (S3-E19)", async ({
  page,
}) => {
  await openConsole(page, ADMIN_B);
  await section(
    page,
    "Erasures",
    page.waitForResponse((r) => r.url().includes("/api/operator/erasures"))
  );
  const item = page.locator(`li[data-erasure='${ERASED}']`);
  await expect(item).toBeVisible();
  await expect(item.locator("[data-pool-unverified='true']")).toBeVisible();
  await expect(item).toContainText(`Requested by ${ADMIN_A.email}`);
  await shot(page, "09-erasures");
  await item.getByRole("button", { name: "Ask for attestation" }).click();
  await item
    .getByLabel("Note (3–500 characters, kept in the audit record)")
    .fill("absent from both pools, checked by the E2E walk");
  const asked = page.waitForResponse((r) =>
    r.url().includes(`/api/operator/tenants/${TENANT}/erasures/${ERASED}/attestation`)
  );
  await item.getByRole("button", { name: "Ask for attestation" }).click();
  expect((await asked).status()).toBe(201);
  await expect(
    page.getByText(
      `Attestation asked for account ${ERASED}. A second operator must approve it.`
    )
  ).toBeVisible();
  await expect(item).toContainText(`Attestation asked by ${ADMIN_B.email}`);
  await expect(item).toContainText("a different operator must approve it");
  await fitsWidth(page);
  await shot(page, "10-erasures-asked");
});

test("5. on a phone: the console fits, a change is made and decided, people by address (N-63, N-64)", async ({
  browser,
}) => {
  // The audit log at 1280 px names who acted by address.
  const wide = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await openConsole(wide, ADMIN_B);
  await section(
    wide,
    "Audit log",
    wide.waitForResponse((r) => r.url().includes("/api/admin/audit"))
  );
  await expect(wide.getByText(ADMIN_A.email).first()).toBeVisible();
  await fitsWidth(wide);
  await shot(wide, "11-audit");
  await wide.close();

  // At 390 px: the sections in a picker; a setting changed (held) by admin-a…
  const phoneA = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await openConsole(phoneA, ADMIN_A);
  const picker = phoneA.getByRole("combobox", { name: "Admin sections" });
  await expect(picker).toBeVisible();
  const settings = phoneA.waitForResponse((r) => r.url().includes("/api/admin/config"));
  await picker.selectOption("platform-config");
  expect((await settings).status()).toBe(200);
  await phoneA.getByLabel("Filter settings").fill("signups_enabled");
  await phoneA.getByRole("button", { name: "Open signups_enabled" }).click();
  const panel = phoneA.getByRole("region", { name: /signups_enabled/ });
  await panel.getByRole("button", { name: "Change this setting" }).click();
  await panel.getByRole("switch").click();
  await panel
    .getByLabel("Why are you changing it?")
    .fill("Close sign-ups for maintenance");
  await fitsWidth(phoneA);
  await shot(phoneA, "12-config-edit-390");
  const sent = phoneA.waitForResponse((r) =>
    r.url().endsWith("/api/admin/config-ai/execute")
  );
  await panel.getByRole("button", { name: "Submit change" }).click();
  expect((await sent).status()).toBe(202);
  await expect(
    phoneA.getByText(/^Held for approval by .*: signups_enabled → Off\./)
  ).toBeVisible();
  await fitsWidth(phoneA);
  await shot(phoneA, "13-config-held-390");
  await phoneA.close();

  // …and admin-b sees it at 390 px, by address, and rejects it after the confirm.
  const phoneB = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await openConsole(phoneB, ADMIN_B);
  const listed = phoneB.waitForResponse((r) => r.url().includes("/api/admin/approvals"));
  await phoneB
    .getByRole("combobox", { name: "Admin sections" })
    .selectOption("approvals");
  expect((await listed).status()).toBe(200);
  const card = phoneB
    .locator("li[data-approval]")
    .filter({ hasText: "Setting signups_enabled" });
  await expect(card.locator("[data-requester='true']")).toHaveText(
    `${ADMIN_A.email} (Super admin)`
  );
  await fitsWidth(phoneB);
  await shot(phoneB, "14-approvals-390");
  await card.getByRole("button", { name: "Reject: Setting signups_enabled" }).click();
  await card.getByRole("button", { name: "Reject it" }).click();
  await expect(
    phoneB.getByText("Rejected: Setting signups_enabled. Nothing was changed.")
  ).toBeVisible();
  await fitsWidth(phoneB);
  await shot(phoneB, "15-approvals-rejected-390");
  await phoneB.close();
});
