/**
 * @jest-environment node
 */
/**
 * __tests__/catalog-definitions.test.ts — a setting's description and a permission's name are the
 * catalog's, by key and code (TASK-209, N-113)
 *
 * @not-guard: behaviour tests of platform/errors/definitions.ts and of the answers that use it;
 * scripts/catalog-definitions-check.mjs, run by the migration replay, is the guard (every setting
 * and permission the migrations define has its entry; __tests__/catalog-definitions-guard.test.ts)
 */
import {
  permissionKey,
  permissionName,
  permissionNameText,
  settingDescription,
  settingDescriptionKey,
} from "@/platform/errors/definitions";
import { describedByCatalog } from "@/platform/admin/config-http";
import { searchRow } from "@/app/api/admin/ai/handlers/search";
import { renderShown } from "@/platform/errors/shown-text";
import { renderMessage } from "@/platform/errors/messages";

describe("the catalog's words for a setting and a permission (N-113)", () => {
  it("a setting's description is the catalog's key, by the setting's key", () => {
    expect(settingDescriptionKey("signups_enabled")).toBe(
      "screens.settings.signups_enabled"
    );
    expect(settingDescription("jobs.config.expire-approvals.enabled")).toEqual({
      key: "screens.settings.jobs.config.expire-approvals.enabled",
    });
    expect(renderShown(settingDescription("signups_enabled")!)).not.toBe(
      "screens.settings.signups_enabled"
    );
    // A key the catalog does not have (none in the database, the guard says): no description.
    expect(settingDescription("no.such.setting")).toBeNull();
    // A prefix of a key is no setting.
    expect(settingDescription("jobs")).toBeNull();
  });

  it("a permission's name is the catalog's, by its code; an unknown code is shown as data", () => {
    expect(permissionKey("admin_manage_users", "name")).toBe(
      "screens.permissions.admin_manage_users.name"
    );
    expect(permissionName("admin_manage_users")).toEqual({
      key: "screens.permissions.admin_manage_users.name",
    });
    expect(permissionNameText("admin_manage_users")).toBe(
      renderMessage("screens.permissions.admin_manage_users.name")
    );
    expect(permissionName("no_such_permission")).toBe("no_such_permission");
    expect(permissionNameText("no_such_permission")).toBe("no_such_permission");
  });

  it("a listed setting's description is the catalog's, never the stored English", () => {
    const listed = describedByCatalog({
      key: "signups_enabled",
      description: "stored English, the definitional record",
      value: true,
    });
    expect(listed).toEqual({
      key: "signups_enabled",
      description: { key: "screens.settings.signups_enabled" },
      value: true,
    });
  });

  it("a search's setting description and permission name are the catalog's", () => {
    expect(
      searchRow("platform_config", {
        key: "signups_enabled",
        value: true,
        category: "auth",
        description: "stored English",
        permission_tier: "safety",
        overridden: false,
        updated_at: "2026-01-01T00:00:00.000Z",
      })[3]
    ).toEqual({ key: "screens.settings.signups_enabled" });
    expect(
      searchRow("permissions", {
        id: "p",
        code: "admin_manage_users",
        display_name: "stored English",
        category: "admin",
      })[2]
    ).toEqual({ key: "screens.permissions.admin_manage_users.name" });
  });
});
