/**
 * platform/auth/devices.ts — Device registry service
 *
 * Tracks devices a user has signed in from. Integrates with
 * the AuthProvider's device management (Cognito tracks devices)
 * and stores device records in user_devices, in the request's tenant (platform/data,
 * ADR-053 D4), for the profile UI.
 *
 * Sprint 4, Task 4.4
 */

import { withTenantTx } from "@/platform/data";
import { AuditWriteError, audited } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";

export interface DeviceRecord {
  id: string;
  userId: string;
  deviceId: string;
  deviceName: string | null;
  isTrusted: boolean;
  lastUsedAt: string;
  createdAt: string;
}

interface DeviceRow {
  id: string;
  user_id: string;
  device_id: string;
  device_name: string | null;
  is_trusted: boolean;
  last_used_at: Date;
  created_at: Date;
}

/** Run a write; its error message, or undefined when it succeeded. */
async function failure(write: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await write();
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Register a new device for a user (audited), or refresh a known device's last-used time.
 */
export async function registerDevice(
  userId: string,
  deviceId: string,
  deviceName?: string
): Promise<{ success: boolean; error?: string }> {
  // A device already on file only has its last-used time refreshed: that is not a new
  // security event, so it is not audited (and sign-in does not depend on the audit log).
  // An unreadable lookup is treated as an unknown device: the audited path below decides.
  let known: string | undefined;
  try {
    const { rows } = await withTenantTx((tx) =>
      tx.query<{ id: string }>(
        "select id from user_devices where user_id = $1::uuid and device_id = $2",
        [userId, deviceId]
      )
    );
    known = rows[0]?.id;
  } catch {
    known = undefined;
  }
  if (known) {
    const id = known;
    const error = await failure(() =>
      withTenantTx((tx) =>
        tx.query("update user_devices set last_used_at = now() where id = $1::uuid", [id])
      )
    );
    return error ? { success: false, error } : { success: true };
  }

  try {
    // A new device is recorded before it is registered; no record, no device (Adversarial
    // Validation, practice 6).
    return await audited(
      {
        action: "device_registered",
        actorId: userId,
        targetId: userId,
        details: { deviceId, deviceName },
      },
      async () => {
        const error = await failure(() =>
          withTenantTx((tx) =>
            tx.query(
              `insert into user_devices (user_id, device_id, device_name, last_used_at)
               values ($1::uuid, $2, $3, now())
               on conflict (user_id, device_id) do update
                 set device_name = excluded.device_name, last_used_at = excluded.last_used_at`,
              [userId, deviceId, deviceName || null]
            )
          )
        );

        if (error) {
          logger.error("Device registration failed", {
            userId,
            deviceId,
            error,
            route: "platform/auth/devices",
          });
          return { success: false, error };
        }

        return { success: true };
      }
    );
  } catch (err) {
    if (err instanceof AuditWriteError)
      return { success: false, error: "audit unavailable" };
    throw err;
  }
}

/**
 * List all devices for a user.
 */
export async function listUserDevices(userId: string): Promise<DeviceRecord[]> {
  let rows: DeviceRow[];
  try {
    ({ rows } = await withTenantTx((tx) =>
      tx.query<DeviceRow>(
        `select id, user_id, device_id, device_name, is_trusted, last_used_at, created_at
           from user_devices where user_id = $1::uuid
          order by last_used_at desc`,
        [userId]
      )
    ));
  } catch {
    return [];
  }

  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    isTrusted: row.is_trusted || false,
    lastUsedAt: row.last_used_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  }));
}

/**
 * Remove a device from the user's device list.
 */
export async function removeDevice(
  userId: string,
  deviceId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    return await audited(
      {
        action: "device_removed",
        actorId: userId,
        targetId: userId,
        details: { deviceId },
      },
      async () => {
        const error = await failure(() =>
          withTenantTx((tx) =>
            tx.query(
              "delete from user_devices where user_id = $1::uuid and device_id = $2",
              [userId, deviceId]
            )
          )
        );

        if (error) {
          logger.error("Device removal failed", {
            userId,
            deviceId,
            error,
            route: "platform/auth/devices",
          });
          return { success: false, error };
        }

        return { success: true };
      }
    );
  } catch (err) {
    if (err instanceof AuditWriteError)
      return { success: false, error: "audit unavailable" };
    throw err;
  }
}
