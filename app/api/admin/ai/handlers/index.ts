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
  checkCreateRole,
  checkDeleteRole,
  checkDuplicateRole,
  checkAssignPermissions,
  checkChangeUserRole,
  createRoleRule,
  deleteRoleRule,
  duplicateRoleRule,
  assignPermissionsRule,
  changeUserRoleRule,
} from "./roles";
export {
  handleCreateEntitlementGroup,
  handleSetEntitlementGroupActive,
  checkCreateEntitlementGroup,
  checkSetEntitlementGroupActive,
  createEntitlementGroupRule,
  setEntitlementGroupActiveRule,
} from "./entitlements";
export { handlePurgeUserData, checkPurgeUserData, purgeUserDataRule } from "./purge";
export { handleUpdatePasswordPolicy } from "./config";
export { handleSearch } from "./search";
export {
  handleRegisterAgent,
  handleSuspendAgent,
  handleSetAgentScope,
  handleSetAgentTtl,
} from "./agents";
export {
  checkRestrictionTarget,
  restrictionTargetRule,
  handleBlockUserFeature,
  handleUnblockUserFeature,
} from "./restrictions";
export { handleSetApprovalPolicy } from "./approval";
export { handleSetCapabilityMapping } from "./mapping";
