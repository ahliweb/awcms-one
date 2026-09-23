/**
 * axe-core accessibility coverage (issue #183) — a REAL browser run against
 * a REAL build (see `global-setup.ts`), the deterministic replacement for
 * `docs/aksesibilitas.md`'s prior "every claim was verified by reading the
 * source, not by running an automated tool" caveat.
 *
 * Every one of this profile's key pages (`profil-halaman.ts`, itself driven
 * by `src/config/profil.ts`'s own group composition) is scanned for WCAG
 * 2.1 A/AA violations — `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa` tags only,
 * never axe's broader "best practice" rule set, which is a style opinion,
 * not a deterministic pass/fail a CI gate can own. A `serious`/`critical`
 * violation fails the test; `minor`/`moderate` ones are attached to the
 * test's own report (Playwright's `testInfo.attach`, visible in the HTML
 * report artifact) so a reviewer can read them without a lower-impact
 * finding turning a whole profile's run red.
 *
 * What this does NOT prove — restated in `docs/aksesibilitas.md` itself so
 * a reader of that document does not have to find this comment first: axe's
 * own rule set finds a minority of WCAG failures by its own maintainers'
 * account (automated tools generally catch roughly a third of issues); no
 * screen-reader walkthrough, no keyboard-only navigation session, and
 * nothing axe cannot compute from the DOM/CSSOM alone (content that only
 * appears on `:hover`/`:focus`, for instance) is covered here.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { ACTIVE_PROFILE, KEY_PAGES } from "./profil-halaman";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const FAILING_IMPACT = new Set(["serious", "critical"]);

for (const keyPage of KEY_PAGES) {
  test(`${ACTIVE_PROFILE}/${keyPage.name} (${keyPage.path}) has no serious/critical WCAG 2.1 A/AA violations`, async ({
    page
  }, testInfo) => {
    await page.goto(keyPage.path);

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();

    const serious = results.violations.filter((violation) => FAILING_IMPACT.has(violation.impact ?? ""));
    const other = results.violations.filter((violation) => !FAILING_IMPACT.has(violation.impact ?? ""));

    if (other.length > 0) {
      await testInfo.attach("axe-other-violations.json", {
        body: JSON.stringify(other, null, 2),
        contentType: "application/json"
      });
    }

    if (serious.length > 0) {
      await testInfo.attach("axe-serious-violations.json", {
        body: JSON.stringify(serious, null, 2),
        contentType: "application/json"
      });
    }

    const summary = serious
      .map(
        (violation) =>
          `- [${violation.impact}] ${violation.id}: ${violation.help} (${violation.nodes.length} node(s): ${violation.nodes
            .map((node) => node.target.join(" "))
            .join(", ")})`
      )
      .join("\n");

    expect(serious, `Serious/critical WCAG 2.1 A/AA violations on ${keyPage.path}:\n${summary}`).toHaveLength(0);
  });
}
