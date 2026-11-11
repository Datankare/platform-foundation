/**
 * E2E global setup (TASK-204, N-94: platform-foundation's, as Playform's since platform
 * TASK-194) — the test double's account, made ready through the app's own routes before any spec
 * runs.
 *
 * In CI the E2E server runs on a real database (playwright.config.ts), so the actor guard's steps
 * read the account: its first guarded request provisions its row with the default role (TASK-117;
 * the role holds can_translate, migration 061), and the consent gate refuses every
 * consent-gated feature to an account whose age was never recorded (audit X-16). A real user
 * records it once, at sign-up or through POST /api/account/age; the test double does the same
 * here, as an adult — no SQL, no bypass. A second run against the same database is answered
 * account.age_already_recorded, which is the state wanted.
 *
 * Locally (no CI) the harness does not own the server (`npm run dev`, started by hand, perhaps
 * without a database), so nothing is set up.
 */

import { request, type FullConfig } from "@playwright/test";
import { AUTH_HEADERS } from "./helpers/auth-setup";

/** An adult's date of birth: the consent gate then requires no parental consent. */
const E2E_DATE_OF_BIRTH = "1990-01-01";

export default async function globalSetup(config: FullConfig): Promise<void> {
  if (!process.env.CI) return;
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("E2E global setup: no baseURL in playwright.config.ts");

  const api = await request.newContext({ baseURL });
  try {
    const res = await api.post("/api/account/age", {
      headers: AUTH_HEADERS,
      data: { dateOfBirth: E2E_DATE_OF_BIRTH },
    });
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    if (res.ok() || body.code === "account.age_already_recorded") return;
    throw new Error(
      `E2E global setup: recording the test account's age answered ${res.status()} ${body.code ?? ""}`.trim()
    );
  } finally {
    await api.dispose();
  }
}
