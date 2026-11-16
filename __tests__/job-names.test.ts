/**
 * @jest-environment node
 */
/**
 * __tests__/job-names.test.ts — every recurring job is named for a person, and says whether
 * running it removes records (TASK-221; SF-admin-100, 107)
 *
 * The Jobs screen showed a job by its stored kind ("moderation.escalation-reaper"), and ran any job
 * on one click, those that delete data among them. Every job the platform declares has a short
 * name in the catalogue (screens.admin_console.labels.jobs), and the ones that remove records for
 * good declare it on their schedule (`deletesData`), so the screen confirms their run as one that
 * cannot be undone, and asks why. A consuming app names its own jobs in its catalogue
 * (`screens.app.jobs`).
 */
import { renderMessage } from "@/platform/errors/messages";
import { listScheduledJobs } from "@/platform/jobs";

describe("recurring jobs (TASK-221, SF-admin-100, 107)", () => {
  it("every job the platform declares has a short name in the catalogue — never its stored kind", () => {
    for (const def of listScheduledJobs()) {
      // The platform's in its catalogue; an app's own in the app's (screens.app.jobs).
      const id = def.kind.replace(/[.-]/g, "_");
      const named = [
        `screens.admin_console.labels.jobs.${id}`,
        `screens.app.jobs.${id}`,
      ].some((key) => renderMessage(key) !== key);
      expect([def.kind, named]).toEqual([def.kind, true]);
    }
  });

  it("the jobs that remove records say so (their run cannot be undone)", () => {
    const deletes = listScheduledJobs()
      .filter((d) => d.schedule?.deletesData === true)
      .map((d) => d.kind)
      .sort();
    expect(deletes).toEqual(
      expect.arrayContaining([
        "agents.trajectory-retention",
        "data.retention",
        "gdpr.retention-purge",
        "jobs.prune",
        "tenancy.purge-due",
      ])
    );
  });
});
