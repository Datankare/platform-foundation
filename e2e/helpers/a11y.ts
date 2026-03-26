import AxeBuilder from "@axe-core/playwright";
import { Page, expect } from "@playwright/test";

/**
 * Run an axe-core accessibility audit on the current page.
 * Fails the test if any violations are found.
 */
export async function checkA11y(
  page: Page,
  options?: {
    exclude?: string[];
    tags?: string[];
  }
) {
  let builder = new AxeBuilder({ page }).withTags(
    options?.tags ?? ["wcag2a", "wcag2aa", "wcag22aa"]
  );

  if (options?.exclude) {
    for (const selector of options.exclude) {
      builder = builder.exclude(selector);
    }
  }

  const results = await builder.analyze();

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
