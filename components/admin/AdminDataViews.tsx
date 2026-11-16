"use client";

/**
 * components/admin/AdminDataViews.tsx — the governance views, each in its own file under
 * components/admin/views/ (TASK-220)
 *
 * This file held eight views with five hand-built tables, a highlight that went by itself, and
 * the codes each view showed. Each is now built from the console's shared parts and fixes its
 * screen's findings (SF-admin-050 to 063); this file keeps the names the console and its tests
 * import.
 *
 * @module components/admin
 */

export { RolesDataView, roleDescription } from "@/components/admin/views/RolesView";
export { EntitlementsDataView } from "@/components/admin/views/EntitlementsView";
export { AuditDataView } from "@/components/admin/views/AuditView";
export { PasswordPolicyDataView } from "@/components/admin/views/PasswordPolicyView";
export { PerAccountRestrictionsDataView } from "@/components/admin/views/PerAccountView";
export { ApprovalPolicyDataView } from "@/components/admin/views/ApprovalPolicyView";
export { CapabilitiesDataView } from "@/components/admin/views/CapabilitiesView";
export { CapabilityMappingDataView } from "@/components/admin/views/CapabilityMapView";
/** The Trusted agents screen, with its forms (TASK-202, N-66): TrustedAgentsPanel. */
export { TrustedAgentsPanel as TrustedAgentsDataView } from "@/components/admin/TrustedAgentsPanel";
