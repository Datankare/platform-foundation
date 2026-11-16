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
 * TASK-216 — the console's core on its shared parts (tests 6 to 11): the Users screen and the
 * command bar, each through a success, a refusal, a change held for a second administrator and
 * the confirmation of an action that cannot be undone, at 1280 px and 390 px, with the
 * accessibility scan on /admin. The command bar's planner is a paid model whose plan is not the
 * same twice, so these journeys answer POST /api/admin/ai themselves with a fixed plan (the
 * route's own shape) — and only that: the confirm step, the executor, the hold, the decision
 * route and every refusal are the server's own.
 *
 * TASK-220 — the governance screens on the shared parts: journeys 1 to 3 and 5 now go through
 * each screen's confirm step (a setting from → to, an agent read back, a decision's confirm with
 * focus in and back), and the requester sees their own change in Approvals without Approve
 * (E-56). Journey 12 (1280 px) adds a setting to dual control from its picker (held, marked
 * waiting, a link to Approvals), blocks a feature for an account found by its address and lifts
 * it, creates an entitlement group, and reads back a password policy, an approval policy and a
 * capability's features before cancelling them; journey 13 (390 px) decides the dual-control
 * change, filters the audit log by kind, and scans each governance screen at that width. Each
 * screen is scanned with axe where it is first shown.
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
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { checkA11y } from "./helpers/a11y";
import { signInPage } from "./helpers/session";

const OWNER_URL = process.env.E2E_DATABASE_OWNER_URL;
const SHOTS = process.env.ADMIN_SCREENSHOTS_DIR;
const TENANT = "00000000-0000-4000-8000-000000000001";

/** The test double's two administrators (platform/auth/mock-provider.ts MOCK_EXTRA_IDENTITIES). */
const ADMIN_A = {
  id: "e2e00000-0000-4000-8000-00000000000a",
  email: "admin-a@e2e.test",
};
const ADMIN_B = {
  id: "e2e00000-0000-4000-8000-00000000000b",
  email: "admin-b@e2e.test",
};
/** A member the Users journeys act on (TASK-216): an ordinary account with the default role. */
const MEMBER = {
  id: "e2e00000-0000-4000-8000-0000000056d1",
  email: "mia-member@e2e.test",
  name: "Mia Member",
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
      `insert into users (id, cognito_sub, email, display_name, role_id, tenant_id, email_verified)
       select $1::uuid, $1, $2, $3, r.id, $4::uuid, true from roles r where r.is_default
       on conflict (id) do update set role_id = excluded.role_id, deleted_at = null`,
      [MEMBER.id, MEMBER.email, MEMBER.name, TENANT]
    );
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

/**
 * The console's routes share one rate limit per network address (DEFAULT_RULES.ADMIN_OPS, 30 a
 * minute — ADR-052), and every journey here comes from one address. A journey is a person's, at
 * a person's pace: each console request this file's pages make is counted, and before a step
 * that needs `need` more, the journey waits until the last minute has room for them. The limit
 * is never raised or bypassed for the harness (as e2e/admin-routes.spec.ts waits its own out).
 */
const ADMIN_OPS = { max: 30, windowMs: 60_000, margin: 3 };
/** A paced journey may wait for the minute to have room. */
const PACED = 240_000;
/**
 * When each was sent — kept in the run's own temporary directory too, so a worker restarted by a
 * failed test (which starts this file again from its first journey) still knows what the minute
 * holds.
 */
const REQUEST_LOG = process.env.E2E_SESSIONS_DIR
  ? join(process.env.E2E_SESSIONS_DIR, "admin-console-requests.json")
  : null;
function loggedRequests(): number[] {
  try {
    const stored = REQUEST_LOG
      ? (JSON.parse(readFileSync(REQUEST_LOG, "utf8")) as unknown)
      : [];
    return Array.isArray(stored)
      ? stored.filter((at): at is number => typeof at === "number")
      : [];
  } catch {
    // No log yet (the first journey of the run), or one cut short: nothing is known.
    return [];
  }
}
const consoleRequests: number[] = loggedRequests();
const watched = new WeakSet<Page>();
function watch(page: Page): void {
  if (watched.has(page)) return;
  watched.add(page);
  page.on("request", (request) => {
    if (!/\/api\/(?:admin|operator)\//.test(request.url())) return;
    const now = Date.now();
    consoleRequests.push(now);
    // Only the last minute matters.
    while (consoleRequests.length && now - consoleRequests[0]! > 2 * ADMIN_OPS.windowMs)
      consoleRequests.shift();
    if (REQUEST_LOG) writeFileSync(REQUEST_LOG, JSON.stringify(consoleRequests));
  });
}
async function room(page: Page, need: number): Promise<void> {
  for (;;) {
    const now = Date.now();
    const recent = consoleRequests.filter((at) => now - at < ADMIN_OPS.windowMs + 1000);
    if (recent.length + need <= ADMIN_OPS.max - ADMIN_OPS.margin) return;
    // Until the oldest request of the minute has left it.
    await page.waitForTimeout(recent[0]! + ADMIN_OPS.windowMs + 1000 - now + 50);
  }
}

/** Open the console as `admin` (the test double's session in this browser). */
async function openConsole(page: Page, admin: typeof ADMIN_A): Promise<void> {
  watch(page);
  await signInPage(page, admin);
  const session = page.waitForResponse(
    (r) => r.url().endsWith("/api/admin/session") && r.request().method() === "GET"
  );
  await page.goto("/admin");
  expect((await session).status()).toBe(200);
}

/** Open a section from the sidebar; `read` is its data's response, awaited after the click. */
async function section(
  page: Page,
  name: string,
  read: Promise<{ status(): number }>
): Promise<void> {
  await page
    .getByRole("navigation", { name: "Admin sections" })
    .getByRole("button", { name })
    .click();
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

// Every journey starts with room in the minute for what it opens (see `room`).
test.beforeEach(async ({ page }) => {
  test.setTimeout(PACED);
  await room(page, 10);
});

/** A setting's name on the console (its stored name made readable — never the stored name). */
const KEY_NAME = "Moderation: strike ban threshold";

test("1. a setting is changed from its edit panel: confirmed from → to, and held for approval; its requester may not decide it (N-60, SF-admin-070, 071, E-56)", async ({
  page,
}) => {
  await openConsole(page, ADMIN_A);
  await section(
    page,
    "Platform config",
    page.waitForResponse(
      (r) => r.url().includes("/api/admin/config") && r.request().method() === "GET"
    )
  );
  // Grouped by category, each setting by its name (SF-admin-072).
  await expect(page.getByRole("table", { name: "Settings: Moderation" })).toBeVisible();
  await page.getByLabel("Find a setting by its name or what it does").fill("strike ban");
  await checkA11y(page);
  await shot(page, "01-config-list");
  const opener = page.getByRole("button", { name: `Open the setting ${KEY_NAME}` });
  await opener.click();
  const panel = page.getByRole("region", { name: KEY_NAME });
  // The panel takes focus where it opens (SF-admin-070).
  await expect(panel.getByRole("heading", { level: 3 })).toBeFocused();
  await expect(panel.getByText("Platform default")).toBeVisible();
  await expect(
    panel.getByText(/A safety approver or super admin may change it/)
  ).toBeVisible();
  await expect(panel).not.toContainText(KEY);
  await panel.getByRole("button", { name: "Change this setting" }).click();
  await panel.getByLabel("New value").fill("7");
  await panel.getByRole("button", { name: "Review the change" }).click();
  // Now → after, and why, before anything is sent (SF-admin-071).
  const confirm = panel.getByRole("alertdialog", { name: `Change ${KEY_NAME}?` });
  await expect(confirm).toBeFocused();
  await expect(confirm.locator("[data-diff='true']")).toContainText("7");
  await confirm
    .getByLabel("Reason", { exact: true })
    .fill("Fewer bans for first offences");
  await checkA11y(page);
  await shot(page, "02-config-edit");
  const sent = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/admin/config-ai/execute") && r.request().method() === "POST"
  );
  await confirm.getByRole("button", { name: "Change the setting" }).click();
  expect((await sent).status()).toBe(202);
  const held = outcome(page, `Set ${KEY_NAME} to 7`);
  await expect(held).toHaveAttribute("data-outcome", "held");
  await expect(held).toContainText("Approvals");
  await fitsWidth(page);
  await shot(page, "03-config-held");

  // In Approvals, the requester sees the change and may not decide it (E-56).
  await section(
    page,
    "Approvals",
    page.waitForResponse(
      (r) => r.url().includes("/api/admin/approvals") && r.request().method() === "GET"
    )
  );
  const card = page
    .locator("li[data-approval]")
    .filter({ hasText: `Setting ${KEY_NAME}` });
  await expect(card).toHaveCount(1);
  await expect(
    card.getByRole("button", { name: `Approve: Setting ${KEY_NAME}` })
  ).toBeDisabled();
  await expect(card).toContainText("You asked for it: another administrator decides it.");
  await checkA11y(page);
  await shot(page, "03b-approvals-own-request");
});

test("2. a second admin sees the change, who asked and why; approves it after the confirm step; the result stays (N-61, N-62, SF-admin-034)", async ({
  page,
}) => {
  await openConsole(page, ADMIN_B);
  await section(
    page,
    "Approvals",
    page.waitForResponse(
      (r) => r.url().includes("/api/admin/approvals") && r.request().method() === "GET"
    )
  );
  const card = page
    .locator("li[data-approval]")
    .filter({ hasText: `Setting ${KEY_NAME}` });
  await expect(card).toHaveCount(1);
  await expect(card.locator("[data-diff='true']")).toContainText("7");
  await expect(card.locator("[data-requester='true']")).toContainText(ADMIN_A.email);
  await expect(card).toContainText("Fewer bans for first offences");
  // Never the requester's id, nor the setting's stored name.
  await expect(card).not.toContainText(ADMIN_A.id);
  await expect(card).not.toContainText(KEY);
  await fitsWidth(page);
  await checkA11y(page);
  await shot(page, "04-approvals");
  const approve = card.getByRole("button", { name: `Approve: Setting ${KEY_NAME}` });
  await approve.click();
  const confirm = card.getByRole("alertdialog", { name: "Approve this change?" });
  await expect(confirm).toBeFocused();
  // Escape cancels, and focus goes back to the button (SF-admin-034).
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(approve).toBeFocused();
  await approve.click();
  await expect(confirm).toContainText(`Setting ${KEY_NAME}`);
  await shot(page, "05-approvals-confirm");
  const decided = page.waitForResponse(
    (r) => r.url().includes("/api/admin/approvals/") && r.request().method() === "POST"
  );
  await confirm.getByRole("button", { name: "Approve and apply" }).click();
  expect((await decided).status()).toBe(200);
  const result = outcome(
    page,
    `Approved: Setting ${KEY_NAME}. Applied: the setting is now 7.`
  );
  await expect(result).toBeVisible();
  // It stays until dismissed.
  await page.waitForTimeout(8000);
  await expect(result).toBeVisible();
  await shot(page, "06-approvals-result");
  await result.getByRole("button", { name: "Dismiss" }).click();
  await expect(result).toHaveCount(0);
});

test("3. a trusted agent is registered through the form: capabilities by name, read back before it is sent (N-66, SF-admin-130, 133)", async ({
  page,
}) => {
  await openConsole(page, ADMIN_A);
  await section(
    page,
    "Trusted agents",
    page.waitForResponse(
      (r) =>
        r.url().includes("/api/admin/agent-registry") && r.request().method() === "GET"
    )
  );
  await page.getByRole("button", { name: "Register an agent" }).click();
  const form = page.getByRole("form", { name: "Register a trusted agent" });
  await form.getByLabel("Agent's name").fill("agent:e2e-helper");
  await form.getByRole("checkbox", { name: "Translate", exact: true }).check();
  await form.getByLabel("Longest token, in seconds").fill("120");
  await checkA11y(page);
  await shot(page, "07-agents-form");
  await form.getByRole("button", { name: "Register it" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Register agent:e2e-helper?" });
  await expect(confirm).toContainText("Capabilities: Translate");
  await expect(confirm).toContainText("Longest token: 120 seconds");
  const sent = page.waitForResponse(
    (r) => r.url().endsWith("/api/admin/ai/execute") && r.request().method() === "POST"
  );
  await confirm.getByRole("button", { name: "Register it" }).click();
  expect([200, 202]).toContain((await sent).status());
  const said = outcome(page, "Register agent:e2e-helper");
  await expect(said).toHaveAttribute("data-outcome", /^(applied|held)$/);
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
    page.waitForResponse(
      (r) => r.url().includes("/api/operator/erasures") && r.request().method() === "GET"
    )
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
  const asked = page.waitForResponse(
    (r) =>
      r
        .url()
        .includes(`/api/operator/tenants/${TENANT}/erasures/${ERASED}/attestation`) &&
      r.request().method() === "POST"
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
  // The audit log at 1280 px names who acted by address, each action by name (SF-admin-051).
  const wide = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await openConsole(wide, ADMIN_B);
  await section(
    wide,
    "Audit log",
    wide.waitForResponse(
      (r) => r.url().includes("/api/admin/audit") && r.request().method() === "GET"
    )
  );
  const log = wide.getByRole("table", { name: "Audit log, newest first" });
  await expect(log.getByText(ADMIN_A.email).first()).toBeVisible();
  await expect(log).not.toContainText("config.updated");
  await fitsWidth(wide);
  await shot(wide, "11-audit");
  await wide.close();

  // At 390 px: the sections in a picker; a setting changed (held) by admin-a…
  const phoneA = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await openConsole(phoneA, ADMIN_A);
  const picker = phoneA.getByRole("combobox", { name: "Admin sections" });
  await expect(picker).toBeVisible();
  const settings = phoneA.waitForResponse(
    (r) => r.url().includes("/api/admin/config") && r.request().method() === "GET"
  );
  await picker.selectOption("platform-config");
  expect((await settings).status()).toBe(200);
  await phoneA.getByLabel("Find a setting by its name or what it does").fill("signups");
  await phoneA.getByRole("button", { name: "Open the setting Signups enabled" }).click();
  const panel = phoneA.getByRole("region", { name: "Signups enabled" });
  await expect(panel).toBeInViewport();
  await panel.getByRole("button", { name: "Change this setting" }).click();
  await panel.getByRole("checkbox", { name: "Signups enabled: on" }).uncheck();
  await panel.getByRole("button", { name: "Review the change" }).click();
  const confirm = panel.getByRole("alertdialog", { name: "Change Signups enabled?" });
  await confirm
    .getByLabel("Reason", { exact: true })
    .fill("Close sign-ups for maintenance");
  await fitsWidth(phoneA);
  await shot(phoneA, "12-config-edit-390");
  const sent = phoneA.waitForResponse(
    (r) =>
      r.url().endsWith("/api/admin/config-ai/execute") && r.request().method() === "POST"
  );
  await confirm.getByRole("button", { name: "Change the setting" }).click();
  expect((await sent).status()).toBe(202);
  await expect(outcome(phoneA, "Set Signups enabled to Off")).toHaveAttribute(
    "data-outcome",
    "held"
  );
  await fitsWidth(phoneA);
  await shot(phoneA, "13-config-held-390");
  await phoneA.close();

  // …and admin-b sees it at 390 px, by address, and rejects it after the confirm.
  const phoneB = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await openConsole(phoneB, ADMIN_B);
  const listed = phoneB.waitForResponse(
    (r) => r.url().includes("/api/admin/approvals") && r.request().method() === "GET"
  );
  await phoneB
    .getByRole("combobox", { name: "Admin sections" })
    .selectOption("approvals");
  expect((await listed).status()).toBe(200);
  const card = phoneB
    .locator("li[data-approval]")
    .filter({ hasText: "Setting Signups enabled" });
  await expect(card.locator("[data-requester='true']")).toContainText(ADMIN_A.email);
  await fitsWidth(phoneB);
  await shot(phoneB, "14-approvals-390");
  await card.getByRole("button", { name: "Reject: Setting Signups enabled" }).click();
  const reject = card.getByRole("alertdialog", { name: "Reject this change?" });
  await expect(reject).toHaveAttribute("data-risk", "irreversible");
  const decided = phoneB.waitForResponse(
    (r) => r.url().includes("/api/admin/approvals/") && r.request().method() === "POST"
  );
  await reject.getByRole("button", { name: "Reject it" }).click();
  expect((await decided).status()).toBe(200);
  await expect(
    outcome(phoneB, "Rejected: Setting Signups enabled. Nothing was changed.")
  ).toBeVisible();
  await fitsWidth(phoneB);
  await shot(phoneB, "15-approvals-rejected-390");
  await phoneB.close();
});

// ── TASK-216: the console's core — Users and the command bar ────────────────────────────

/** An outcome in the console's one outcome display, by what it says. */
const outcome = (page: Page, text: string | RegExp) =>
  page.locator("[data-outcome]").filter({ hasText: text });

/** Open the member's detail from the Users list. */
async function openMember(page: Page) {
  await page.getByRole("button", { name: `Open ${MEMBER.name}` }).click();
  const panel = page.getByRole("region", { name: `Account: ${MEMBER.name}` });
  await expect(panel.getByRole("heading", { level: 3 })).toBeFocused();
  return panel;
}

/**
 * The planner's answer for this page: a fixed plan in the route's own shape (see the header).
 * Every other request goes to the server.
 */
async function plans(page: Page, plan: unknown): Promise<void> {
  await page.unroute("**/api/admin/ai");
  await page.route("**/api/admin/ai", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 200, contentType: "application/json", json: { plan } })
      : route.fallback()
  );
}

/** Type a request in the command bar and run it; the plan's panel takes focus. */
async function ask(page: Page, request: string) {
  await page.getByRole("textbox", { name: "Command" }).fill(request);
  await page.getByRole("button", { name: "Run" }).click();
  const plan = page.getByRole("region", { name: "Proposed actions" });
  await expect(plan.getByRole("heading", { name: "Proposed actions" })).toBeFocused();
  return plan;
}

test("6. Users: who is signed in, the list and its count; a role change is confirmed and held; a refusal says why", async ({
  page,
}) => {
  await room(page, 8);
  await openConsole(page, ADMIN_A);
  // The header names who is signed in, then the role (SF-admin-005).
  await expect(page.locator("[data-signed-in-as]")).toHaveText("admin-a");
  await expect(page.locator("[data-signed-in-role]")).toHaveText("Super admin");
  // The section is in the address (SF-admin-006), and the list says how many there are.
  const list = page.getByRole("table", { name: "Users" });
  await expect(list).toBeVisible();
  await expect(page.locator("[data-page-range]")).toHaveText(/^1–\d+ of \d+$/);
  await fitsWidth(page);
  await checkA11y(page);
  await shot(page, "16-users-list");

  const panel = await openMember(page);
  // No id, and no stored role code, unless details are asked for (SF-admin-042).
  await expect(panel).not.toContainText(MEMBER.id);
  await fitsWidth(page);
  await shot(page, "17-users-detail");

  // A role change: confirmed first, naming the account and from → to (SF-admin-040).
  await panel.getByLabel("New role").selectOption({ label: "Moderator" });
  await panel.getByRole("button", { name: "Change role…" }).click();
  const confirm = panel.getByRole("alertdialog", {
    name: `Change the role of ${MEMBER.name}`,
  });
  await expect(confirm).toBeFocused();
  await expect(confirm.locator("[data-role-change]")).toContainText("to “Moderator”");
  await checkA11y(page);
  await shot(page, "18-users-role-confirm");
  const sent = page.waitForResponse(
    (r) => r.url().endsWith("/api/admin/users") && r.request().method() === "PATCH"
  );
  await confirm.getByRole("button", { name: "Change the role" }).click();
  // Under dual control (admin.dual_control_actions): held for a second administrator.
  expect((await sent).status()).toBe(202);
  const held = outcome(page, /The change of role from “.+” to “Moderator” waits/);
  await expect(held).toHaveAttribute("data-outcome", "held");
  await expect(held).toBeFocused();
  await expect(held).toContainText(`For: ${MEMBER.name}`);
  await expect(held).toContainText(
    "A second administrator approves or rejects it in Approvals"
  );
  await fitsWidth(page);
  await checkA11y(page);
  await shot(page, "19-users-role-held");

  // A refusal: the super admin role is given in the database only — said by its own sentence,
  // and the earlier outcome is still there (nothing vanishes).
  await panel.getByLabel("New role").selectOption({ label: "Super admin" });
  await panel.getByRole("button", { name: "Change role…" }).click();
  const refusedBy = page.waitForResponse(
    (r) => r.url().endsWith("/api/admin/users") && r.request().method() === "PATCH"
  );
  await panel.getByRole("button", { name: "Change the role" }).click();
  expect((await refusedBy).status()).toBeGreaterThanOrEqual(400);
  const refused = page.locator("[data-outcome='refused']");
  await expect(refused).toHaveCount(1);
  await expect(refused).toContainText("Not done");
  await expect(refused).toContainText(`For: ${MEMBER.name}`);
  await expect(held).toBeVisible();
  await shot(page, "20-users-role-refused");
  await refused.getByRole("button", { name: "Dismiss" }).click();
  await expect(refused).toHaveCount(0);
});

test("7. Users: the second administrator approves; the first sees the new role (a change that took effect)", async ({
  page,
}) => {
  await room(page, 12);
  await openConsole(page, ADMIN_B);
  await section(
    page,
    "Approvals",
    page.waitForResponse(
      (r) => r.url().includes("/api/admin/approvals") && r.request().method() === "GET"
    )
  );
  await expect(page).toHaveURL(/[?&]section=approvals/);
  const card = page.locator("li[data-approval]").filter({ hasText: MEMBER.email });
  await expect(card).toHaveCount(1);
  await card.getByRole("button", { name: /^Approve: / }).click();
  const decided = page.waitForResponse(
    (r) => r.url().includes("/api/admin/approvals/") && r.request().method() === "POST"
  );
  await card.getByRole("button", { name: "Approve and apply" }).click();
  expect((await decided).status()).toBe(200);
  // A reload stays on the section the address names; Back returns to the one before.
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "Approvals" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { level: 2, name: "Users" })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: MEMBER.email });
  await expect(row).toContainText("Moderator");
});

test("8. Users: an erasure's confirmation says it cannot be undone and what is lost; asked, it is held", async ({
  page,
}) => {
  await room(page, 6);
  await openConsole(page, ADMIN_A);
  const panel = await openMember(page);
  const erase = panel.getByRole("button", { name: "Erase account data…" });
  await erase.click();
  const confirm = panel.getByRole("alertdialog", {
    name: `Erase the account of ${MEMBER.name}`,
  });
  await expect(confirm).toBeFocused();
  await expect(confirm).toHaveAttribute("data-risk", "irreversible");
  await expect(confirm).toContainText("This cannot be undone.");
  await expect(confirm).toContainText(
    "Lost for good, once a second administrator approves"
  );
  await checkA11y(page);
  await shot(page, "21-users-erase-confirm");
  // Escape is Cancel, and focus goes back to the button: nothing was asked.
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(erase).toBeFocused();
  // Asked, with the kind of reason chosen (SF-admin-036): held, nothing erased.
  await erase.click();
  await confirm.getByLabel("Why is it being erased?").selectOption("user-request");
  const asked = page.waitForResponse(
    (r) => r.url().endsWith("/api/admin/gdpr") && r.request().method() === "POST"
  );
  await confirm.getByRole("button", { name: "Ask for erasure" }).click();
  const answer = await asked;
  expect(answer.status()).toBe(202);
  expect(answer.request().postDataJSON()).toEqual({
    userId: MEMBER.id,
    reason: "user-request",
  });
  const held = outcome(page, "The erasure waits for a second administrator.");
  await expect(held).toHaveAttribute("data-outcome", "held");
  await expect(held).toContainText("Nothing has been erased");
  await expect(panel.locator("[data-erase-pending]")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Erase account data…" })).toHaveCount(0);
  await fitsWidth(page);
  await shot(page, "22-users-erase-held");
});

test("9. the command bar: a search that runs, a change that is held, and one the server refuses", async ({
  page,
}) => {
  await room(page, 16);
  await openConsole(page, ADMIN_A);
  const bar = page.getByRole("textbox", { name: "Command" });
  // A label, its examples and what it can do here as help — and no focus taken (SF-admin-007, 017).
  await expect(bar).not.toBeFocused();
  await expect(page.locator("[data-command-scope]")).toContainText("Here you can:");

  // A success: a search of this screen, handed to the list.
  await plans(page, {
    message: "Searching for moderators.",
    actions: [{ tool: "search", input: { table: "users", role: "moderator" } }],
  });
  let plan = await ask(page, "show moderators");
  await expect(plan).toContainText("Search users where role is moderator");
  await shot(page, "23-command-plan");
  let ran = page.waitForResponse(
    (r) => r.url().endsWith("/api/admin/ai/execute") && r.request().method() === "POST"
  );
  await plan.getByRole("button", { name: "Confirm 1 action" }).click();
  expect((await ran).status()).toBe(200);
  const found = outcome(page, "The matching users are shown in the list below.");
  await expect(found).toHaveAttribute("data-outcome", "applied");
  await expect(found).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Remove filter: Role: Moderator" })
  ).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: MEMBER.email })).toBeVisible();
  await fitsWidth(page);
  await checkA11y(page);
  await shot(page, "24-command-search-done");

  // Held: creating a role is under dual control. The plan names permissions, never codes.
  await plans(page, {
    message: "Creating the role.",
    actions: [
      {
        tool: "create_role",
        input: {
          name: "e2e_56d1_helper",
          display_name: "E2E helper",
          permissions: ["can_play"],
        },
      },
    ],
  });
  await section(
    page,
    "Roles",
    page.waitForResponse(
      (r) => r.url().includes("/api/admin/roles") && r.request().method() === "GET"
    )
  );
  // The plan made on Users did not follow to Roles (SF-admin-001).
  await expect(page.locator("[data-outcome]")).toHaveCount(0);
  plan = await ask(page, "create an E2E helper role that can play");
  await expect(plan).toContainText("Create role “E2E helper”");
  await expect(plan).not.toContainText("can_play");
  ran = page.waitForResponse(
    (r) => r.url().endsWith("/api/admin/ai/execute") && r.request().method() === "POST"
  );
  await plan.getByRole("button", { name: "Confirm 1 action" }).click();
  expect((await ran).status()).toBe(202);
  const held = page.locator("[data-outcome='held']");
  await expect(held).toContainText("Create a role");
  await expect(held).toContainText(
    "Next: A second administrator approves or rejects it in Approvals"
  );
  await fitsWidth(page);
  await shot(page, "25-command-held");

  // An action that cannot be undone is marked so, says what is lost, and has the danger button
  // — whichever action it is (SF-admin-010). Cancelled: nothing runs.
  await plans(page, {
    message: "Deleting it.",
    actions: [{ tool: "delete_role", input: { role_name: "e2e_56d1_no_such_role" } }],
  });
  plan = await ask(page, "delete the role e2e_56d1_no_such_role");
  const item = plan.getByRole("listitem");
  await expect(item).toHaveAttribute("data-risk", "irreversible");
  await expect(item).toContainText("Cannot be undone");
  await expect(item).toContainText("Lost: the role and its list of permissions");
  await checkA11y(page);
  await shot(page, "26-command-irreversible");
  await plan.getByRole("button", { name: "Cancel" }).click();
  await expect(plan).toHaveCount(0);

  // Refused by the server: a search with a filter its table does not take. The plan says it
  // will be refused, by the filter's name; confirmed anyway, the executor refuses it — said in
  // the catalogue's words, and the held outcome above is still there.
  await plans(page, {
    message: "Searching roles.",
    actions: [{ tool: "search", input: { table: "roles", within_days: 3 } }],
  });
  plan = await ask(page, "show roles from the last 3 days");
  await expect(plan).toContainText(
    "the days since it was recorded (an invalid value: the search will be refused)"
  );
  ran = page.waitForResponse(
    (r) => r.url().endsWith("/api/admin/ai/execute") && r.request().method() === "POST"
  );
  await plan.getByRole("button", { name: "Confirm 1 action" }).click();
  await ran;
  const refused = page.locator("[data-outcome='refused']");
  await expect(refused).toHaveCount(1);
  await expect(refused).toContainText("Not done");
  await expect(refused).toBeFocused();
  await expect(held).toBeVisible();
  await fitsWidth(page);
  await shot(page, "27-command-refused");
});

test("10. the command bar: rejecting a held change cannot be undone — confirmed, the decision route answers", async ({
  page,
}) => {
  await room(page, 8);
  await openConsole(page, ADMIN_B);
  const listed = page.waitForResponse(
    (r) => r.url().endsWith("/api/admin/approvals") && r.request().method() === "GET"
  );
  await section(page, "Approvals", listed);
  const approvals = (await (await listed).json()) as {
    approvals: { id: string; source: string; label: string }[];
  };
  const hold = approvals.approvals.find((a) => a.label === "create_role");
  expect(hold, "the role creation admin-a asked for in test 9 is held").toBeDefined();
  await plans(page, {
    message: "Rejecting it.",
    actions: [
      { tool: "reject_hold", input: { proposalId: hold!.id, source: hold!.source } },
    ],
  });
  const plan = await ask(page, "reject the E2E helper role");
  const item = plan.getByRole("listitem");
  await expect(item).toHaveAttribute("data-risk", "irreversible");
  await expect(item).toContainText("Lost: this request.");
  // Named by what it is — never by the hold's id (SF-admin-013).
  await expect(item).not.toContainText(hold!.id);
  await shot(page, "28-command-reject-confirm");
  const decided = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/admin/approvals/${hold!.id}`) &&
      r.request().method() === "POST"
  );
  await plan.getByRole("button", { name: "Confirm 1 action" }).click();
  expect((await decided).status()).toBe(200);
  // What the decision route answered, in words (E-2) — not "Decision recorded".
  const said = page.locator("[data-outcome='applied']");
  await expect(said).toContainText("Rejected");
  await expect(said).not.toContainText("Decision recorded");
  await expect(said).toBeFocused();
  await fitsWidth(page);
  await shot(page, "29-command-rejected");
});

test("11. on a phone (390 px): Users and the command bar fit; a failed read is said; the detail takes the list's place", async ({
  browser,
}) => {
  // Its own context (the accessibility scan needs one of its own).
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await context.newPage();
  await room(phone, 12);
  await openConsole(phone, ADMIN_A);
  await expect(phone.getByRole("table", { name: "Users" })).toBeVisible();
  await fitsWidth(phone);
  await checkA11y(phone);
  await shot(phone, "30-users-390");
  // The detail takes the list's place, with focus; Close leads back to the row.
  await phone.getByRole("button", { name: `Open ${MEMBER.name}` }).click();
  const panel = phone.getByRole("region", { name: `Account: ${MEMBER.name}` });
  await expect(panel.getByRole("heading", { level: 3 })).toBeFocused();
  await expect(panel).toBeInViewport();
  await expect(phone.getByRole("table", { name: "Users" })).toBeHidden();
  await fitsWidth(phone);
  await checkA11y(phone);
  await shot(phone, "31-users-detail-390");
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(phone.getByRole("button", { name: `Open ${MEMBER.name}` })).toBeFocused();

  // A plan and its outcome fit too.
  await plans(phone, {
    message: "Searching.",
    actions: [{ tool: "search", input: { table: "users", text: "mia" } }],
  });
  const plan = await ask(phone, "find mia");
  await fitsWidth(phone);
  await shot(phone, "32-command-plan-390");
  const ran = phone.waitForResponse(
    (r) => r.url().endsWith("/api/admin/ai/execute") && r.request().method() === "POST"
  );
  await plan.getByRole("button", { name: "Confirm 1 action" }).click();
  expect((await ran).status()).toBe(200);
  await expect(phone.locator("[data-outcome='applied']")).toBeVisible();
  await fitsWidth(phone);
  await shot(phone, "33-command-done-390");

  // A read that fails is said as that, with a retry — never an empty list (E-4).
  await phone.route("**/api/admin/roles", (route) => route.abort());
  await phone.getByRole("combobox", { name: "Admin sections" }).selectOption("roles");
  const failed = phone.getByRole("alert").filter({ hasText: "Could not read Roles" });
  await expect(failed).toBeVisible();
  await expect(phone.getByText(/No roles found/)).toHaveCount(0);
  await fitsWidth(phone);
  await checkA11y(phone);
  await shot(phone, "34-read-failed-390");
  await phone.unroute("**/api/admin/roles");
  const read = phone.waitForResponse(
    (r) => r.url().includes("/api/admin/roles") && r.request().method() === "GET"
  );
  await failed.getByRole("button", { name: "Try reading Roles again" }).click();
  expect((await read).status()).toBe(200);
  await expect(failed).toHaveCount(0);
  await context.close();
});

// ── TASK-220: the governance screens, each through its own controls ─────────────────────

test("12. governance screens at 1280 px: dual control, a feature blocked and lifted, a group, the policies read back before they are sent (SF-admin-053, 058, 080 to 084)", async ({
  page,
}) => {
  await room(page, 12);
  await openConsole(page, ADMIN_A);

  // Dual control: the settings by name; one added from a picker, held, and marked waiting.
  await section(
    page,
    "Dual control",
    page.waitForResponse(
      (r) => r.url().includes("/api/admin/config") && r.request().method() === "GET"
    )
  );
  const list = page.getByRole("table", { name: "Settings under dual control" });
  await expect(list.getByText(KEY_NAME)).toBeVisible();
  await expect(list).not.toContainText(KEY);
  await page.getByRole("button", { name: "Add a setting to dual control" }).click();
  const add = page.getByRole("form", { name: "Add a setting to dual control" });
  // The picker offers only settings not yet on the list, by name.
  await expect(add.getByLabel("Setting", { exact: true })).not.toContainText(KEY_NAME);
  await add.getByLabel("Setting", { exact: true }).selectOption({ index: 1 });
  const chosen = (
    await add.getByLabel("Setting", { exact: true }).locator("option:checked").innerText()
  ).trim();
  await add.getByRole("button", { name: "Review the change" }).click();
  const confirmAdd = page.getByRole("alertdialog", {
    name: `Add ${chosen} to dual control?`,
  });
  await expect(confirmAdd).toBeFocused();
  await checkA11y(page);
  await shot(page, "35-dual-control-confirm");
  const asked = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/admin/config-ai/execute") && r.request().method() === "POST"
  );
  await confirmAdd.getByRole("button", { name: "Add it" }).click();
  expect((await asked).status()).toBe(202);
  const held = outcome(page, `Add ${chosen} to dual control`);
  await expect(held).toHaveAttribute("data-outcome", "held");
  // Named, with the way to Approvals — never a proposal's id (SF-admin-082).
  await expect(held.getByRole("link", { name: /Approvals/ })).toBeVisible();
  await expect(
    page.getByText(`Waiting in Approvals to be added: ${chosen}.`)
  ).toBeVisible();
  await fitsWidth(page);
  await shot(page, "36-dual-control-held");

  // Per-account: a feature blocked for an account found by its address, then lifted.
  await room(page, 8);
  await section(
    page,
    "Per-account restrictions",
    page.waitForResponse(
      (r) => r.url().includes("/api/admin/per-account") && r.request().method() === "GET"
    )
  );
  await page.getByRole("button", { name: "Block a feature for an account" }).click();
  const block = page.getByRole("form", { name: "Block a feature for one account" });
  await block.getByLabel("The account's email address").fill(MEMBER.email);
  await block.getByLabel("Feature", { exact: true }).selectOption({ label: "Translate" });
  const found = page.waitForResponse(
    (r) => r.url().endsWith("/api/admin/users/search") && r.request().method() === "POST"
  );
  await block.getByRole("button", { name: "Review the block" }).click();
  expect((await found).status()).toBe(200);
  const confirmBlock = page.getByRole("alertdialog", {
    name: `Block Translate for ${MEMBER.email}?`,
  });
  await confirmBlock.getByLabel("Reason (optional)").fill("Checked by the E2E walk");
  await checkA11y(page);
  await shot(page, "37-per-account-confirm");
  const blocked = page.waitForResponse(
    (r) => r.url().endsWith("/api/admin/ai/execute") && r.request().method() === "POST"
  );
  await confirmBlock.getByRole("button", { name: "Block it" }).click();
  expect([200, 202]).toContain((await blocked).status());
  const blockSaid = outcome(page, "Block Translate");
  await expect(blockSaid).toHaveAttribute("data-outcome", /^(applied|held)$/);
  if ((await blockSaid.getAttribute("data-outcome")) === "applied") {
    const row = page
      .getByRole("table", { name: "Blocked features" })
      .getByRole("row")
      .filter({ hasText: MEMBER.email });
    await expect(row).toContainText("Checked by the E2E walk");
    await expect(row.locator("time")).toHaveCount(1);
    await shot(page, "38-per-account-blocked");
    const lifted = page.waitForResponse(
      (r) => r.url().endsWith("/api/admin/ai/execute") && r.request().method() === "POST"
    );
    await row
      .getByRole("button", { name: `Lift the block on Translate for ${MEMBER.email}` })
      .click();
    expect([200, 202]).toContain((await lifted).status());
    await expect(outcome(page, "Lift the block on Translate")).toBeVisible();
  }
  await fitsWidth(page);
  await shot(page, "39-per-account-result");

  // Entitlements: a group created from its form (an ordinary change).
  await room(page, 6);
  await section(
    page,
    "Entitlements",
    page.waitForResponse(
      (r) => r.url().includes("/api/admin/entitlements") && r.request().method() === "GET"
    )
  );
  await page.getByRole("button", { name: "Create a group" }).click();
  const group = page.getByRole("form", { name: "A new entitlement group" });
  await group.getByLabel("Name", { exact: true }).fill("E2E group");
  await group.getByLabel("Code", { exact: true }).fill("e2e-56d2");
  await checkA11y(page);
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/admin/ai/execute") && r.request().method() === "POST"
  );
  await group.getByRole("button", { name: "Create the group" }).click();
  expect([200, 202]).toContain((await created).status());
  await expect(outcome(page, "Create the group E2E group")).toHaveAttribute(
    "data-outcome",
    /^(applied|held)$/
  );
  await fitsWidth(page);
  await shot(page, "40-entitlements-created");

  // Password policy: each rule from → to read back; cancelled, nothing is sent.
  await room(page, 4);
  await section(
    page,
    "Password policy",
    page.waitForResponse(
      (r) =>
        r.url().includes("/api/admin/password-policy") && r.request().method() === "GET"
    )
  );
  await page.getByRole("button", { name: "Change the policy" }).click();
  await page.getByLabel("Shortest password").fill("14");
  await page.getByRole("button", { name: "Review the change" }).click();
  const policy = page.getByRole("alertdialog", { name: "Change the password policy?" });
  await expect(policy).toContainText("Shortest password:");
  await expect(policy).toContainText("→ 14 characters");
  await checkA11y(page);
  await shot(page, "41-password-policy-confirm");
  await policy.getByRole("button", { name: "Cancel" }).click();
  await expect(policy).toHaveCount(0);

  // Approval policy: the rules edited in place, the new policy read back in words; cancelled.
  await room(page, 4);
  await section(
    page,
    "Approval policy",
    page.waitForResponse(
      (r) =>
        r.url().includes("/api/admin/approval-policy") && r.request().method() === "GET"
    )
  );
  await page.getByRole("button", { name: "Change the rules" }).click();
  await page.getByRole("button", { name: "Add a rule" }).click();
  const rule = page.locator("[data-rule-editor]").last();
  await rule.getByLabel("Matches actions up to this risk").selectOption({ index: 1 });
  await rule.getByRole("checkbox").first().check();
  await checkA11y(page);
  await shot(page, "42-approval-policy-edit");
  await page.getByRole("button", { name: "Review the change" }).click();
  const rules = page.getByRole("alertdialog", {
    name: "Store this approval policy as a new version?",
  });
  await expect(rules.locator("[data-policy-rules] li").last()).toContainText(
    /^Up to .+ risk, .+: .+ approves$/
  );
  await shot(page, "43-approval-policy-confirm");
  await rules.getByRole("button", { name: "Cancel" }).click();
  await expect(rules).toHaveCount(0);

  // Capability map: a capability's features, from → to, read back; cancelled.
  await room(page, 4);
  await section(
    page,
    "Capability map",
    page.waitForResponse(
      (r) =>
        r.url().includes("/api/admin/capability-mapping") &&
        r.request().method() === "GET"
    )
  );
  await page
    .getByRole("table", { name: "Capabilities and the features they need" })
    .getByRole("button", { name: "Translate", exact: true })
    .click();
  const map = page.getByRole("region", { name: "Translate" });
  await map.getByRole("button", { name: "Change its features" }).click();
  await map.getByRole("checkbox", { name: "Transcribe" }).check();
  await map.getByRole("button", { name: "Review the change" }).click();
  const mapConfirm = page.getByRole("alertdialog", {
    name: "Change what Translate needs?",
  });
  await expect(mapConfirm).toContainText("From: Translate. To:");
  await checkA11y(page);
  await shot(page, "44-capability-map-confirm");
  await mapConfirm.getByRole("button", { name: "Cancel" }).click();
  await expect(mapConfirm).toHaveCount(0);
  await fitsWidth(page);
});

test("13. governance screens at 390 px: each fits; the audit log filtered by kind; a change asked and decided on a phone", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await context.newPage();
  await room(phone, 10);
  await openConsole(phone, ADMIN_B);
  const picker = phone.getByRole("combobox", { name: "Admin sections" });
  const open = async (id: string, path: string) => {
    const read = phone.waitForResponse(
      (r) => r.url().includes(path) && r.request().method() === "GET"
    );
    await picker.selectOption(id);
    expect((await read).status()).toBe(200);
  };

  // Approvals: the dual-control change admin-a asked for in test 12, decided here.
  await open("approvals", "/api/admin/approvals");
  const card = phone.locator("li[data-approval]").filter({ hasText: /dual control/i });
  await expect(card.first()).toBeVisible();
  await fitsWidth(phone);
  await checkA11y(phone);
  await shot(phone, "45-approvals-390");
  await card
    .first()
    .getByRole("button", { name: /^Reject: / })
    .click();
  const reject = card.first().getByRole("alertdialog", { name: "Reject this change?" });
  await expect(reject).toBeFocused();
  await fitsWidth(phone);
  await shot(phone, "46-approvals-reject-confirm-390");
  const decided = phone.waitForResponse(
    (r) => r.url().includes("/api/admin/approvals/") && r.request().method() === "POST"
  );
  await reject.getByRole("button", { name: "Reject it" }).click();
  expect((await decided).status()).toBe(200);
  await expect(
    phone.locator("[data-outcome]").filter({ hasText: "Rejected" })
  ).toBeVisible();

  // The audit log: one kind of entry, asked of the route again.
  await room(phone, 6);
  await open("audit", "/api/admin/audit");
  const filtered = phone.waitForResponse(
    (r) => r.url().includes("/api/admin/audit") && r.request().method() === "GET"
  );
  await phone.getByLabel("Show one kind of entry").selectOption({ label: "Signed in" });
  expect((await filtered).status()).toBe(200);
  const log = phone.getByRole("table", { name: "Audit log, newest first" });
  await expect(log.getByRole("row").nth(1)).toContainText("Signed in");
  await fitsWidth(phone);
  await checkA11y(phone);
  await shot(phone, "47-audit-filtered-390");

  // Each other governance screen fits and passes the scan.
  for (const [id, path, name] of [
    ["dual-control", "/api/admin/config", "48-dual-control-390"],
    ["roles", "/api/admin/roles", "49-roles-390"],
    ["per-account", "/api/admin/per-account", "50-per-account-390"],
    ["agent-registry", "/api/admin/agent-registry", "51-agents-390"],
    ["capability-mapping", "/api/admin/capability-mapping", "52-capability-map-390"],
  ] as const) {
    await room(phone, 3);
    await open(id, path);
    await fitsWidth(phone);
    await checkA11y(phone);
    await shot(phone, name);
  }
  await context.close();
});
