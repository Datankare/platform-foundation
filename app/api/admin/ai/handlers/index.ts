/**
 * app/api/admin/ai/handlers/index.ts — barrel.
 *
 * Re-exports every action handler so the import path @/app/api/admin/ai/handlers
 * is unchanged after the split from a single file into this directory.
 */

export type { ActionResult } from "./shared";
export {
  handleCreateRole,
  handleDeleteRole,
  handleDuplicateRole,
  handleAssignPermissions,
  handleChangeUserRole,
} from "./roles";
export { handleCreateEntitlementGroup } from "./entitlements";
export { handleUpdateGuestConfig, handleUpdatePasswordPolicy } from "./config";
export { handleSearch } from "./search";
