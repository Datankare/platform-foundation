/**
 * lib/supabase/types.ts — Database type definitions
 *
 * Minimal type definitions matching our schema.
 * Will be replaced by supabase gen types typescript when schema stabilizes.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type TableDef<R extends Record<string, any>> = {
  Row: R;
  Insert: Partial<R>;
  Update: Partial<R>;
  Relationships: [];
};

export interface Database {
  public: {
    Tables: {
      users: TableDef<{
        id: string;
        cognito_sub: string | null;
        guest_token: string | null;
        email: string | null;
        display_name: string | null;
        role_id: string;
        deleted_at: string | null;
        [key: string]: any;
      }>;
      roles: TableDef<{
        id: string;
        name: string;
        display_name: string;
        [key: string]: any;
      }>;
      permissions: TableDef<{
        id: string;
        code: string;
        display_name: string;
        [key: string]: any;
      }>;
      role_permissions: TableDef<{
        id: string;
        role_id: string;
        permission_id: string;
        [key: string]: any;
      }>;
      role_inheritance: TableDef<{
        id: string;
        role_id: string;
        inherits_from_id: string;
        [key: string]: any;
      }>;
      entitlement_groups: TableDef<{
        id: string;
        code: string;
        display_name: string;
        is_active: boolean;
        [key: string]: any;
      }>;
      entitlement_permissions: TableDef<{
        id: string;
        entitlement_group_id: string;
        permission_id: string;
        [key: string]: any;
      }>;
      user_entitlements: TableDef<{
        id: string;
        user_id: string;
        entitlement_group_id: string;
        granted_by: string | null;
        expires_at: string | null;
        revoked_at: string | null;
        revoked_by: string | null;
        [key: string]: any;
      }>;
      audit_log: TableDef<{
        id: string;
        action: string;
        actor_id: string | null;
        target_id: string | null;
        details: Record<string, unknown>;
        ip_address: string | null;
        user_agent: string | null;
        created_at: string;
        [key: string]: any;
      }>;
      consent_records: TableDef<{
        id: string;
        user_id: string;
        [key: string]: any;
      }>;
      user_devices: TableDef<{
        id: string;
        user_id: string;
        device_id: string;
        [key: string]: any;
      }>;
      password_policy: TableDef<{
        id: string;
        [key: string]: any;
      }>;
      deletion_manifest: TableDef<{
        id: string;
        module_name: string;
        [key: string]: any;
      }>;
      guest_config: TableDef<{
        id: string;
        [key: string]: any;
      }>;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
}
