/**
 * app/api/admin/ai/tool-schemas/roles.ts — roles panel tool schemas.
 */

import type { AdminTool } from "./index";

export const rolesSchemas: Record<string, AdminTool[]> = {
  roles: [
    {
      name: "create_role",
      description:
        "Create a new role with specified permissions. Permissions are referenced by code (e.g. can_play, can_translate).",
      input_schema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Role slug (lowercase, no spaces)",
          },
          display_name: { type: "string", description: "Human-readable name" },
          description: { type: "string", description: "Role description" },
          permissions: {
            type: "array",
            items: { type: "string" },
            description: "Permission codes to assign",
          },
        },
        required: ["name", "display_name"],
      },
    },
    {
      name: "delete_role",
      description: "Delete a role. Returns impact analysis (how many users affected).",
      input_schema: {
        type: "object",
        properties: {
          role_name: { type: "string", description: "Role name to delete" },
        },
        required: ["role_name"],
      },
    },
    {
      name: "duplicate_role",
      description: "Duplicate an existing role with a new name. Copies all permissions.",
      input_schema: {
        type: "object",
        properties: {
          source_role: { type: "string", description: "Role to copy from" },
          new_name: { type: "string", description: "New role slug" },
          new_display_name: { type: "string", description: "New display name" },
        },
        required: ["source_role", "new_name", "new_display_name"],
      },
    },
    {
      name: "assign_permissions",
      description: "Add or remove permissions from a role.",
      input_schema: {
        type: "object",
        properties: {
          role_name: { type: "string", description: "Target role" },
          add: {
            type: "array",
            items: { type: "string" },
            description: "Permission codes to add",
          },
          remove: {
            type: "array",
            items: { type: "string" },
            description: "Permission codes to remove",
          },
        },
        required: ["role_name"],
      },
    },
    {
      name: "assign_role_to_user",
      description: "Assign a role to one or more users.",
      input_schema: {
        type: "object",
        properties: {
          role_name: { type: "string", description: "Role to assign" },
          user_ids: {
            type: "array",
            items: { type: "string" },
            description: "User IDs to assign the role to",
          },
          user_emails: {
            type: "array",
            items: { type: "string" },
            description: "User emails to assign the role to",
          },
        },
        required: ["role_name"],
      },
    },
  ],
  users: [
    {
      name: "change_user_role",
      description: "Change a user's role.",
      input_schema: {
        type: "object",
        properties: {
          user_identifier: {
            type: "string",
            description: "User email or ID",
          },
          new_role: { type: "string", description: "New role name" },
        },
        required: ["user_identifier", "new_role"],
      },
    },
    {
      name: "bulk_change_role",
      description: "Change role for multiple users at once.",
      input_schema: {
        type: "object",
        properties: {
          user_identifiers: {
            type: "array",
            items: { type: "string" },
            description: "User emails or IDs",
          },
          new_role: { type: "string", description: "New role name" },
        },
        required: ["user_identifiers", "new_role"],
      },
    },
    {
      name: "delete_user",
      description: "Soft-delete a user (GDPR). Anonymizes PII, preserves audit trail.",
      input_schema: {
        type: "object",
        properties: {
          user_identifier: {
            type: "string",
            description: "User email or ID",
          },
        },
        required: ["user_identifier"],
      },
    },
  ],
};
