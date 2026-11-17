import AxeBuilder from "@axe-core/playwright";
import { Page, expect } from "@playwright/test";

/**
 * The one place an e2e test, a walk or a live journey runs axe (guarded by
 * __tests__/a11y-helper-guard.test.ts: no other browser-side file may use @axe-core/playwright).
 *
 * axe measures colours as painted at the moment it runs. A CSS transition or animation still in
 * flight paints blended colours, so axe can report a contrast failure the settled page does not
 * have (CI, 56e-1: the reset form's submit button, "transition disabled:opacity-40", caught at
 * part opacity on its way from disabled to enabled — a flaky failure). So the audit waits until
 * no transition or animation is running, and FAILS, naming the running ones, when they do not
 * finish within a bounded time (an endless animation on screen at audit time is itself a state
 * the audit cannot judge). It also watches for one starting while axe measures; if one does, it
 * waits again and measures again, a bounded number of times. No rule is weakened.
 */

/** How long the page may take to come to rest before the audit fails, by default. */
export const A11Y_SETTLE_TIMEOUT_MS = 5000;
/** Consecutive quiet checks needed: a state change can start a transition a frame later. */
const QUIET_CHECKS = 2;
/** Audits made again when a transition or animation started while axe was measuring. */
const MAX_AUDITS = 3;

type Settle = { ok: true } | { ok: false; running: string[] };

/**
 * Resolves once no CSS transition or animation in the document is running or pending, seen on
 * QUIET_CHECKS checks in a row. Throws, naming each running one, after `timeoutMs`.
 */
export async function waitForStillPage(
  page: Page,
  timeoutMs: number = A11Y_SETTLE_TIMEOUT_MS
): Promise<void> {
  const result: Settle = await page.evaluate(
    async ({ timeoutMs, quietChecks }) => {
      const describe = (a: Animation): string => {
        const named = a as unknown as {
          transitionProperty?: string;
          animationName?: string;
        };
        const kind = named.transitionProperty
          ? `transition of ${named.transitionProperty}`
          : named.animationName
            ? `animation ${named.animationName}`
            : "animation";
        const target = (a.effect as KeyframeEffect | null)?.target ?? null;
        const cls = target?.getAttribute("class");
        const where = target
          ? `<${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ""}${
              cls ? ` class="${cls.slice(0, 120)}"` : ""
            }>`
          : "(no element)";
        return `${kind} on ${where} (${a.playState})`;
      };
      const running = () =>
        document.getAnimations().filter((a) => a.pending || a.playState === "running");
      // A frame, or a short timer when frames are not being produced (a hidden page).
      const tick = () =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 50);
          requestAnimationFrame(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      const deadline = performance.now() + timeoutMs;
      let quiet = 0;
      for (;;) {
        const now = running();
        if (now.length === 0) {
          quiet += 1;
          if (quiet >= quietChecks) return { ok: true as const };
        } else {
          quiet = 0;
          if (performance.now() >= deadline)
            return { ok: false as const, running: now.map(describe) };
        }
        await tick();
      }
    },
    { timeoutMs, quietChecks: QUIET_CHECKS }
  );
  if (!result.ok) {
    throw new Error(
      `checkA11y: the page did not come to rest within ${timeoutMs} ms, so axe cannot judge ` +
        `its colours. Still running:\n  ${result.running.join("\n  ")}`
    );
  }
}

/** Starts noting any transition or animation that begins from now on. */
async function watchForMotion(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __a11yMotion?: { moved: boolean } };
    if (!w.__a11yMotion) {
      const flag = { moved: false };
      w.__a11yMotion = flag;
      for (const type of ["transitionrun", "transitionstart", "animationstart"]) {
        document.addEventListener(type, () => (flag.moved = true), true);
      }
    }
    w.__a11yMotion.moved = false;
  });
}

/** True when a transition or animation began since watchForMotion, or is running now. */
async function movedSinceWatch(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = window as unknown as { __a11yMotion?: { moved: boolean } };
    return (
      w.__a11yMotion?.moved === true ||
      document.getAnimations().some((a) => a.pending || a.playState === "running")
    );
  });
}

/**
 * Run an axe-core accessibility audit on the current page, once it is still.
 * Fails the test if any violations are found, or if the page does not come to rest.
 */
export async function checkA11y(
  page: Page,
  options?: {
    exclude?: string[];
    tags?: string[];
    /** How long the page may take to come to rest (default A11Y_SETTLE_TIMEOUT_MS). */
    settleTimeoutMs?: number;
  }
) {
  const settleTimeoutMs = options?.settleTimeoutMs ?? A11Y_SETTLE_TIMEOUT_MS;
  let results: Awaited<ReturnType<AxeBuilder["analyze"]>> | undefined;
  for (let audit = 1; audit <= MAX_AUDITS && !results; audit += 1) {
    await waitForStillPage(page, settleTimeoutMs);
    await watchForMotion(page);

    let builder = new AxeBuilder({ page }).withTags(
      options?.tags ?? ["wcag2a", "wcag2aa", "wcag22aa"]
    );
    if (options?.exclude) {
      for (const selector of options.exclude) {
        builder = builder.exclude(selector);
      }
    }
    const measured = await builder.analyze();
    // Motion while axe measured makes this audit unsound: wait for rest and measure again.
    if (!(await movedSinceWatch(page))) results = measured;
  }
  if (!results) {
    throw new Error(
      `checkA11y: a transition or animation began during each of ${MAX_AUDITS} audits, ` +
        "so no audit measured a still page"
    );
  }

  if (results.violations.length > 0) {
    const summary = results.violations
      .map(
        (v) =>
          `[${v.impact}] ${v.id}: ${v.description} (${v.nodes.length} node${v.nodes.length > 1 ? "s" : ""})`
      )
      .join("\n");

    expect(
      results.violations,
      `Accessibility violations found:\n${summary}`
    ).toHaveLength(0);
  }
}
