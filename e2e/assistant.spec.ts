/**
 * e2e/assistant.spec.ts — a signed-in user asks the assistant, on the production build (TASK-211,
 * N-118; Playform's copy is the same file)
 *
 * /api/stream (the platform's streamed assistant, ADR-018) had no screen: its hook had no caller and
 * no journey reached the route (journey-exemptions.json said so). This walks the assistant page as
 * the test double's asker (asker-q: its own account, so the decision its blocked question records
 * never touches an account another journey signs in as; its age recorded through the app's route,
 * as every new account's is):
 *
 *   1. from the home page's bar to the assistant; the form, accessible; Ask only with a question;
 *   2. a question the screening blocks (the platform's blocklist — no model needed): the route's
 *      own refusal, shown by its code, with the link to its decision on the account page;
 *   3. an ordinary question: whatever the route answers is what the screen shows — the answer as it
 *      streams, or the route's refusal by its code (with no model key, as in a local run, the
 *      screening cannot classify it and the route refuses);
 *   4. with the model (CI's key): the answer streams in and completes;
 *   5. on a phone: the page, its question and what the route answered stay inside the screen.
 */
import { expect, test, type Page, type Response } from "@playwright/test";
import { checkA11y } from "./helpers/a11y";
import { sessionFetch, signInPage } from "./helpers/session";

/** Text the platform's blocklist refuses at once, with no model (platform/moderation/blocklist). */
const BLOCKED_TEXT = "how to make a bomb";
const QUESTION = "In one short sentence: why is the sky blue?";
const APPEAL_LINK = "See this decision and appeal it";

/** The test double's asker (platform/auth/mock-provider.ts). */
const ASKER = {
  id: "e2e00000-0000-4000-8000-00000000000f",
  email: "asker-q@e2e.test",
};

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  // The asker's date of birth, as an adult, through the app's route (provisions the account).
  const age = await sessionFetch(ASKER, "POST", "/api/account/age", {
    dateOfBirth: "1990-01-01",
  });
  const code = ((await age.json().catch(() => ({}))) as { code?: string }).code;
  expect(age.ok() || code === "account.age_already_recorded").toBe(true);
});

/** The asker's session in this browser. */
async function signIn(page: Page): Promise<void> {
  await signInPage(page, ASKER);
}

async function openAssistant(page: Page): Promise<void> {
  await signIn(page);
  await page.goto("/assistant");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Assistant", {
    timeout: 30000,
  });
}

/** Ask `question` and return the route's answer to it. */
async function ask(page: Page, question: string): Promise<Response> {
  await page.getByLabel("Your question").fill(question);
  const answered = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/stream" && r.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Ask" }).click();
  return answered;
}

/** What the route said, as the screen must show it: its refusal's message, or its answer. */
async function routeSaid(res: Response): Promise<{ refusal?: string; answer?: string }> {
  if (res.status() !== 200) {
    const body = (await res.json()) as { message: string };
    return { refusal: body.message };
  }
  const events = (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as { text?: string; error?: string });
  const ended = events.find((e) => e.error);
  if (ended) return { refusal: ended.error };
  return { answer: events.map((e) => e.text ?? "").join("") };
}

test("1. from the home page's bar to the assistant, its form accessible (N-118)", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");
  const link = page.getByRole("link", { name: "Assistant" });
  await expect(link).toBeVisible({ timeout: 30000 });
  await link.click();
  await page.waitForURL("**/assistant");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Assistant");
  const askButton = page.getByRole("button", { name: "Ask" });
  await expect(askButton).toBeDisabled();
  await page.getByLabel("Your question").fill(QUESTION);
  await expect(askButton).toBeEnabled();
  await checkA11y(page);
});

test("2. a question the screening blocks: the route's refusal, with the way to its decision", async ({
  page,
}) => {
  await openAssistant(page);
  const res = await ask(page, BLOCKED_TEXT);
  expect(res.status()).toBe(422);
  const { refusal } = await routeSaid(res);
  const alert = page.getByRole("region", { name: "Answer" }).getByRole("alert");
  await expect(alert).toContainText(refusal!);
  await checkA11y(page);
  const decisions = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/moderation/appeals"
  );
  await alert.getByRole("link", { name: APPEAL_LINK }).click();
  await page.waitForURL("**/account");
  expect((await decisions).status()).toBe(200);
  await expect(
    page
      .getByRole("region", { name: "Decisions about your content" })
      .getByRole("listitem")
      .first()
  ).toBeVisible();
});

test("3. an ordinary question: the screen shows what the route answered", async ({
  page,
}) => {
  await openAssistant(page);
  const said = await routeSaid(await ask(page, QUESTION));
  const region = page.getByRole("region", { name: "Answer" });
  await expect(region).toContainText(`You asked: ${QUESTION}`);
  if (said.refusal !== undefined) {
    await expect(region.getByRole("alert")).toContainText(said.refusal);
  } else {
    await expect(region.getByTestId("assistant-answer")).toHaveText(said.answer!);
    await expect(region.getByRole("alert")).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Ask" })).toBeVisible();
});

test("4. with the model: the answer streams in and completes", async ({ page }) => {
  test.skip(
    !process.env.ANTHROPIC_API_KEY,
    "Requires a live model key. Dependabot PRs do not receive repository secrets, so this is expected there — see TASK-060."
  );
  await openAssistant(page);
  const res = await ask(page, QUESTION);
  expect(res.status()).toBe(200);
  const said = await routeSaid(res);
  expect(said.refusal).toBeUndefined();
  expect((said.answer ?? "").trim().length).toBeGreaterThan(0);
  await expect(page.getByTestId("assistant-answer")).toHaveText(said.answer!);
  await expect(page.getByRole("button", { name: "Ask" })).toBeVisible();
});

test("5. on a phone the page, its question and what the route answered stay inside the screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAssistant(page);
  const said = await routeSaid(await ask(page, QUESTION));
  const region = page.getByRole("region", { name: "Answer" });
  if (said.refusal !== undefined) await expect(region.getByRole("alert")).toBeVisible();
  else await expect(region.getByTestId("assistant-answer")).toHaveText(said.answer!);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBe(0);
});
