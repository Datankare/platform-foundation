/**
 * platform/auth/devices.ts — Device registry service
 *
 * Tracks devices a user has signed in from. Integrates with
 * the AuthProvider's device management (Cognito tracks devices)
 * and stores device records in Supabase for the profile UI.
 *
 * Sprint 4, Task 4.4
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { writeAuditLog } from "@/platform/auth/audit";
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

/**
 * Register or update a device for a user.
 * Called on every sign-in to track last used time.
 */
export async function registerDevice(
  userId: string,
  deviceId: string,
  deviceName?: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseServiceClient();

  const { error } = await supabase.from("user_devices").upsert(
    {
      user_id: userId,
      device_id: deviceId,
      device_name: deviceName || null,
      last_used_at: new Date().toISOString(),
    },
    { onConflict: "user_id,device_id" }
  );

  if (error) {
    logger.error("Device registration failed", {
      userId,
      deviceId,
      error: error.message,
      route: "platform/auth/devices",
    });
    return { success: false, error: error.message };
  }

  await writeAuditLog({
    action: "device_registered",
    actorId: userId,
    targetId: userId,
    details: { deviceId, deviceName },
  });

  return { success: true };
}

/**
 * List all devices for a user.
 */
export async function listUserDevices(userId: string): Promise<DeviceRecord[]> {
  const supabase = getSupabaseServiceClient();

  const { data, error } = await supabase
    .from("user_devices")
    .select("*")
    .eq("user_id", userId)
    .order("last_used_at", { ascending: false });

  if (error || !data) return [];

  return data.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    userId: row.user_id as string,
    deviceId: row.device_id as string,
    deviceName: row.device_name as string | null,
    isTrusted: (row.is_trusted as boolean) || false,
    lastUsedAt: row.last_used_at as string,
    createdAt: row.created_at as string,
  }));
}

/**
 * Remove a device from the user's device list.
 */
export async function removeDevice(
  userId: string,
  deviceId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseServiceClient();

  const { error } = await supabase
    .from("user_devices")
    .delete()
    .eq("user_id", userId)
    .eq("device_id", deviceId);

  if (error) {
    logger.error("Device removal failed", {
      userId,
      deviceId,
      error: error.message,
      route: "platform/auth/devices",
    });
    return { success: false, error: error.message };
  }

  await writeAuditLog({
    action: "device_removed",
    actorId: userId,
    targetId: userId,
    details: { deviceId },
  });

  return { success: true };
}
