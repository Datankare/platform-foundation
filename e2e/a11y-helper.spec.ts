import { test, expect } from "@playwright/test";
import { checkA11y } from "./helpers/a11y";

/**
 * e2e/a11y-helper.spec.ts — the shared axe helper measures a still page (TASK-226)
 *
 * CI on 56e-1 failed axe colour contrast on a submit button caught part way through its opacity
 * transition from disabled to enabled (blended colours), and passed on retry. These prove, in a
 * real browser and with no server, that checkA11y waits for a transition in flight before axe
 * measures (without the wait, axe reports colour contrast here: the button is at 40% opacity
 * when the audit starts and only reaches full colour two seconds later), and that an animation
 * which never ends fails the audit within its bound, named, rather than letting axe measure it.
 */

const PAGE = (body: string, style: string) =>
  `<!doctype html><html lang="en"><head><title>Audit at rest</title><style>${style}</style></head>` +
  `<body style="background:#ffffff;margin:0"><main><h1>Audit at rest</h1>${body}</main></body></html>`;

test("axe waits for a transition in flight before it measures colour contrast", async ({
  page,
}) => {
  await page.setContent(
    PAGE(
      '<button id="go" type="button" disabled>Continue</button>',
      // White on blue-700 (#1d4ed8, 6.7:1) at rest; at 40% opacity on white it is far below 4.5:1.
      "#go{background:#1d4ed8;color:#ffffff;border:0;padding:12px 24px;font-size:14px;" +
        "transition:opacity 2s linear}#go:disabled{opacity:.4}"
    )
  );
  await page.evaluate(() => {
    const go = document.getElementById("go") as HTMLButtonElement;
    go.disabled = false;
  });
  // The transition is in flight when the audit is asked for.
  expect(
    await page.evaluate(() =>
      document.getAnimations().some((a) => a.playState === "running" || a.pending)
    )
  ).toBe(true);
  await checkA11y(page);
  expect(
    await page.evaluate(() => getComputedStyle(document.getElementById("go")!).opacity)
  ).toBe("1");
});

test("an animation that never ends fails the audit, named, within its bound", async ({
  page,
}) => {
  await page.setContent(
    PAGE(
      '<p id="spinner">Working</p>',
      "@keyframes endless-spin{to{transform:rotate(360deg)}}" +
        "#spinner{display:inline-block;animation:endless-spin 1s linear infinite}"
    )
  );
  const started = Date.now();
  await expect(checkA11y(page, { settleTimeoutMs: 800 })).rejects.toThrow(
    /did not come to rest within 800 ms[\s\S]*animation endless-spin on <p#spinner>/
  );
  expect(Date.now() - started).toBeLessThan(5000);
});
