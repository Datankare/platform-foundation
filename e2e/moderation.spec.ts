/**
 * e2e/moderation.spec.ts — a decision about a member's content, appealed by the member and decided
 * by a moderator, through the pages people use (TASK-210, N-117; Playform's copy is the same file)
 *
 * Batch 55i found the review dashboard and the appeal form mounted on no page: a moderator could
 * not review the queue and a member could not appeal. This walks both, on the production build and
 * the replayed database, as the people who do them — the test double's member (member-u, a new
 * account with the default role) and moderator (moderator-m, the moderator role:
 * can_access_admin, can_moderate, admin_view_audit — migration 018):
 *
 *   1. the member types something the screening blocks on the home page; the refusal links to the
 *      decision; the account page lists it, and the member appeals it;
 *   2. the moderator opens the console's Moderation section (and no section it may not), asks the
 *      reviewing assistant (advisory: with no model key, as in CI, it has no suggestion), claims
 *      the appeal through the appeals route and overturns it with a note;
 *   3. an escalation filed by staff tooling (POST /api/moderation/review — no screen files one) is
 *      claimed and released through the review route;
 *   4. the member's account page shows the appeal decided; the member may not read the queue
 *      (hostile:role).
 *
 * Seeded once, through the owner connection: the moderator's role (assigned in the database, as
 * the console's first administrators are — ADR-013). The member records their date of birth
 * through the app's own route, as every new account does. Nothing else is written by hand. Runs
 * where the harness gives it a database (E2E_DATABASE_OWNER_URL); skipped, saying so, without one.
 */
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";
import { Client } from "pg";
import { checkA11y } from "./helpers/a11y";
import { sessionFetch, signInPage } from "./helpers/session";

const OWNER_URL = process.env.E2E_DATABASE_OWNER_URL;
const TENANT = "00000000-0000-4000-8000-000000000001";

/** The test double's moderator and member (platform/auth/mock-provider.ts). */
const MODERATOR = {
  id: "e2e00000-0000-4000-8000-00000000000d",
  email: "moderator-m@e2e.test",
};
const MEMBER = {
  id: "e2e00000-0000-4000-8000-00000000000e",
  email: "member-u@e2e.test",
};
type Person = typeof MEMBER;

/** Text the platform's blocklist refuses at once, with no model (platform/moderation/blocklist). */
const BLOCKED_TEXT = "how to make a bomb";
const APPEAL_REASON =
  "I was quoting a news headline about a police investigation, not asking how to do it.";
const APPEAL_LINK = "See this decision and appeal it";

test.describe.configure({ mode: "serial" });
test.skip(!OWNER_URL, "needs the harness's database (E2E_DATABASE_OWNER_URL)");
test.use({ viewport: { width: 1280, height: 900 } });

test.beforeAll(async ({ request }) => {
  const db = new Client({ connectionString: OWNER_URL });
  await db.connect();
  try {
    await db.query(
      `insert into users (id, cognito_sub, email, display_name, role_id, tenant_id, email_verified)
       select $1::uuid, $1, $2, 'moderator-m', r.id, $3::uuid, true from roles r where r.name = 'moderator'
       on conflict (id) do update set role_id = excluded.role_id, deleted_at = null`,
      [MODERATOR.id, MODERATOR.email, TENANT]
    );
  } finally {
    await db.end();
  }
  // The member's date of birth, as an adult, through the app's route (provisions the account).
  const age = await call(request, MEMBER, "POST", "/api/account/age", {
    dateOfBirth: "1990-01-01",
  });
  const code = ((await age.json().catch(() => ({}))) as { code?: string }).code;
  expect(age.ok() || code === "account.age_already_recorded").toBe(true);
});

async function waitOut(retryAfter: string | undefined): Promise<void> {
  const seconds = Math.min(Math.max(Number(retryAfter) || 5, 1), 65);
  await new Promise((r) => setTimeout(r, seconds * 1000));
}

/** A route called as `who` (their own cookie session), waiting out a rate limit. */
async function call(
  _api: APIRequestContext,
  who: Person,
  method: "GET" | "POST",
  path: string,
  data?: unknown
): Promise<APIResponse> {
  for (let attempt = 0; ; attempt++) {
    const res = await sessionFetch(who, method, path, data);
    if (res.status() !== 429 || attempt >= 3) return res;
    await waitOut(res.headers()["retry-after"]);
  }
}

/** The test double's session for `who` in this browser. */
async function signIn(page: Page, who: Person): Promise<void> {
  await signInPage(page, who);
}

/**
 * The console's routes share one rate limit per address (admin:ops, 30 a minute — ADR-052), which
 * the admin specs before this one spend: a moderator's journey starts on a fresh window.
 */
async function freshAdminWindow(): Promise<void> {
  await new Promise((r) => setTimeout(r, 61_000));
}

/** The console, opened as the moderator (its session read, a rate limit waited out). */
async function openConsole(page: Page): Promise<void> {
  await signIn(page, MODERATOR);
  for (let attempt = 0; ; attempt++) {
    const session = page.waitForResponse((r) => r.url().endsWith("/api/admin/session"));
    await page.goto("/admin");
    const res = await session;
    if (res.status() !== 429 || attempt >= 3) {
      expect(res.status()).toBe(200);
      return;
    }
    await waitOut(res.headers()["retry-after"]);
  }
}

/**
 * One read of the queue, made by `act` (a click), answered 200 — a rate limit waited out and the
 * queue read again with its Refresh.
 */
async function queueRead(page: Page, act: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const read = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/moderation/review"
    );
    await act();
    const res = await read;
    if (res.status() !== 429 || attempt >= 3) {
      expect(res.status()).toBe(200);
      return;
    }
    await waitOut(res.headers()["retry-after"]);
    act = () => page.getByTestId("rd-refresh").click();
  }
}

/** The Moderation section opened, its queue read (under `filter`, when one is chosen). */
async function openQueue(page: Page, filter?: "Pending" | "Resolved"): Promise<void> {
  await queueRead(page, () =>
    page
      .getByRole("navigation")
      .getByRole("button", { name: /^Moderation/ })
      .click()
  );
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("Moderation");
  if (filter) {
    await queueRead(page, () =>
      page.getByRole("group", { name: "Filter by status" }).getByText(filter).click()
    );
  }
}

/** The queue under another status filter, read from the route. */
async function filterQueue(
  page: Page,
  filter: "Pending" | "Claimed" | "Resolved"
): Promise<void> {
  await queueRead(page, () =>
    page.getByRole("group", { name: "Filter by status" }).getByText(filter).click()
  );
}

/**
 * An item's action (`button` in its card): its PATCH through `path`, answered 200, and the queue
 * the dashboard reads again after it. Named for the request it makes, so the journey register
 * (__tests__/journey-coverage.test.ts) reads the path each call names.
 */
async function patch(
  page: Page,
  id: string,
  button: string,
  path: string
): Promise<void> {
  const done = page.waitForResponse(
    (r) => new URL(r.url()).pathname === path && r.request().method() === "PATCH"
  );
  const reread = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/moderation/review" &&
      r.request().method() === "GET"
  );
  await page.getByTestId(`rd-item-${id}`).getByRole("button", { name: button }).click();
  expect((await done).status()).toBe(200);
  expect((await reread).status()).toBe(200);
}

/** The member's newest decision on the account page. */
const newestDecision = (page: Page) =>
  page
    .getByRole("region", { name: "Decisions about your content" })
    .getByRole("listitem")
    .first();

test("1. a member's blocked text links to its decision, and the member appeals it (N-117)", async ({
  page,
}) => {
  await signIn(page, MEMBER);
  await page.goto("/");
  const box = page.locator("main textarea").first();
  await expect(box).toBeVisible({ timeout: 30000 });
  await box.fill(BLOCKED_TEXT);
  await box.press("Enter");
  // The refusal is the decision's own message, with the way to it.
  const link = page.getByRole("link", { name: APPEAL_LINK });
  await expect(link).toBeVisible({ timeout: 30000 });

  const decisions = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/moderation/appeals"
  );
  await link.click();
  await page.waitForURL("**/account");
  expect((await decisions).status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your account");
  const item = newestDecision(page);
  await expect(item).toContainText("Text you submitted");
  await expect(item).toContainText(/You can appeal until/);
  await checkA11y(page);

  await item.getByRole("button", { name: "Appeal this decision" }).click();
  await item.getByLabel(/Why should this decision be reconsidered/).fill(APPEAL_REASON);
  const sent = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/moderation/appeals" &&
      r.request().method() === "POST"
  );
  await item.getByRole("button", { name: "Submit appeal" }).click();
  expect((await sent).status()).toBe(201);
  await expect(item.getByRole("status")).toContainText("Your appeal was sent");
  await expect(item).toContainText(/Appeal sent .*Waiting for a moderator\./);
  await expect(item.getByRole("button", { name: "Appeal this decision" })).toHaveCount(0);
  await checkA11y(page);
});

test("2. the moderator reviews the appeal in the console and overturns it (N-117)", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await freshAdminWindow();
  await openConsole(page);
  const nav = page.getByRole("navigation");
  await expect(nav.getByRole("button", { name: /^Moderation/ })).toBeVisible();
  // Only what the moderator may open (can_access_admin, can_moderate, admin_view_audit).
  await expect(nav.getByRole("button", { name: /^Users$/ })).toHaveCount(0);
  await openQueue(page, "Pending");

  const card = page
    .locator("li[data-testid^='rd-item-']")
    .filter({ hasText: APPEAL_REASON })
    .first();
  await expect(card).toBeVisible();
  await expect(card).toContainText(/^Appeal/);
  const id = ((await card.getAttribute("data-testid")) ?? "").replace("rd-item-", "");
  expect(id).not.toBe("");
  await checkA11y(page);

  // The reviewing assistant is advisory: with no model key it has no suggestion, and says so.
  const assisted = page.waitForResponse(
    (r) => new URL(r.url()).pathname === `/api/moderation/review/${id}/assist`
  );
  await card.getByRole("button", { name: "Get AI suggestion" }).click();
  expect((await assisted).status()).toBe(200);
  await expect(
    card.getByText(/No suggestion available right now\.|advisory; you decide/)
  ).toBeVisible();

  // An appeal is acted on through its own route.
  await patch(page, id, "Claim", `/api/moderation/appeals/${id}`);
  await filterQueue(page, "Claimed");
  const mine = page.getByTestId(`rd-item-${id}`);
  await mine.getByRole("button", { name: "Resolve" }).click();
  await mine.getByLabel("Decision").selectOption("overturn");
  await mine.getByLabel("Reviewer notes").fill("A quoted headline; the block was wrong.");
  await patch(page, id, "Submit decision", `/api/moderation/appeals/${id}`);
  await filterQueue(page, "Resolved");
  await expect(page.getByTestId(`rd-decision-${id}`)).toHaveText("Decision: Overturn");
  await checkA11y(page);
});

test("3. an escalation filed by staff tooling is claimed and released through the review route", async ({
  page,
  request,
}) => {
  // No screen files an escalation by hand: staff tooling does, through the route (can_moderate).
  const filed = await call(request, MODERATOR, "POST", "/api/moderation/review", {
    source: "escalation",
    targetUserId: MEMBER.id,
    moderationResult: {
      action: "escalate",
      triggeredBy: "classifier",
      direction: "input",
      contentType: "generation",
      contentRatingLevel: 2,
      blocklistMatches: [],
      reasoning: [
        {
          key: "screens.moderation.reasons.escalate_confidence",
          params: {
            confidence: "0.52",
            threshold: "0.6",
            level: { key: "screens.moderation.levels.teen" },
          },
        },
      ],
      severityAdjustment: 0,
      contextFactors: [{ key: "screens.moderation.factors.clean_history" }],
      attributeToUser: true,
      pipelineLatencyMs: 10,
      classifierCostUsd: 0,
      trajectoryId: `e2e-escalation-${Date.now()}`,
      agentId: "guardian",
    },
  });
  expect(filed.status()).toBe(201);
  const item = ((await filed.json()) as { item: { id: string } }).item;

  await openConsole(page);
  await openQueue(page, "Pending");
  const card = page.getByTestId(`rd-item-${item.id}`);
  await expect(card).toContainText(/^Escalation/);
  await patch(page, item.id, "Claim", `/api/moderation/review/${item.id}`);
  await filterQueue(page, "Claimed");
  await patch(page, item.id, "Release", `/api/moderation/review/${item.id}`);
  await filterQueue(page, "Pending");
  await expect(
    page.getByTestId(`rd-item-${item.id}`).getByRole("button", { name: "Claim" })
  ).toBeVisible();
});

test("4. the member sees the appeal decided, and may not read the queue (hostile:role)", async ({
  page,
  request,
}) => {
  await signIn(page, MEMBER);
  const decisions = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/moderation/appeals"
  );
  await page.goto("/account");
  expect((await decisions).status()).toBe(200);
  await expect(
    page
      .getByRole("region", { name: "Decisions about your content" })
      .getByText(/the decision was overturned\./)
  ).toBeVisible();

  const queue = await call(request, MEMBER, "GET", "/api/moderation/review");
  expect(queue.status()).toBe(403);
  // The account page lists only the member's own decisions: the moderator has none of theirs.
  const own = await call(request, MODERATOR, "GET", "/api/moderation/appeals");
  expect(own.status()).toBe(200);
  expect(((await own.json()) as { decisions: unknown[] }).decisions).toEqual([]);
});
