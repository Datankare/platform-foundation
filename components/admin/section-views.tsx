"use client";

/**
 * components/admin/section-views.tsx — each section's view, held to the section registry
 * (TASK-216, SCREEN-FINDINGS P10)
 *
 * The page kept its own map from section to view, which could miss a section the shell listed.
 * This map is typed over the registry's ids (components/admin/ui/sections.ts): a section without
 * an entry does not compile. `null` is a section the console mounts itself, with props of its
 * own — Users (its filters and its command-bar hand-off) and the review queue.
 *
 * @module components/admin
 */

import type React from "react";
import type { AdminSection } from "@/components/admin/ui/sections";
import { HeldActionsPanel } from "@/components/admin/HeldActionsPanel";
import { DualControlKeysPanel } from "@/components/admin/DualControlKeysPanel";
import {
  RolesDataView,
  EntitlementsDataView,
  AuditDataView,
  PasswordPolicyDataView,
  PerAccountRestrictionsDataView,
  ApprovalPolicyDataView,
  CapabilitiesDataView,
  CapabilityMappingDataView,
} from "@/components/admin/AdminDataViews";
import {
  OperatorTenantsView,
  TenantSettingsView,
} from "@/components/admin/TenancyPanels";
import { OperatorJobsView } from "@/components/admin/JobsPanels";
import { AdminKillSwitchView } from "@/components/admin/AgentKillSwitchPanel";
import { PlatformConfigPanel } from "@/components/admin/PlatformConfigPanel";
import { TrustedAgentsPanel } from "@/components/admin/TrustedAgentsPanel";
import { ErasuresPanel } from "@/components/admin/ErasuresPanel";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * A section's view: its data, and — for the views that change something — the admin's
 * permissions, a way to read the section again after a change, who the admin is (Approvals
 * offers no decision on one's own request: E-56), and whether "Show details" is on.
 */
export type SectionViewProps = {
  data: any;
  hasPermission?: (code: string) => boolean;
  onReload?: () => void;
  viewerId?: string;
  showIds?: boolean;
};

export const SECTION_VIEWS = {
  users: null,
  moderation: null,
  erasures: ErasuresPanel,
  roles: RolesDataView,
  entitlements: EntitlementsDataView,
  "per-account": PerAccountRestrictionsDataView,
  approvals: HeldActionsPanel,
  "approval-policy": ApprovalPolicyDataView,
  "dual-control": DualControlKeysPanel,
  "kill-switch": AdminKillSwitchView,
  "agent-registry": TrustedAgentsPanel,
  capabilities: CapabilitiesDataView,
  "capability-mapping": CapabilityMappingDataView,
  "password-policy": PasswordPolicyDataView,
  "platform-config": PlatformConfigPanel,
  tenant: TenantSettingsView,
  audit: AuditDataView,
  jobs: OperatorJobsView,
  tenants: OperatorTenantsView,
} satisfies Record<AdminSection, React.FC<SectionViewProps> | null>;
