/**
 * platform/auth/devices.ts — Device registry service
 *
 * Tracks devices a player has signed in from. Integrates with
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
  playerId: string;
  deviceId: string;
  deviceName: string | null;
  isTrusted: boolean;
  lastUsedAt: string;
  createdAt: string;
}

/**
 * Register or update a device for a player.
 * Called on every sign-in to track last used time.
 */
export async function registerDevice(
  playerId: string,
  deviceId: string,
  deviceName?: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseServiceClient();

  const { error } = await supabase.from("player_devices").upsert(
    {
      player_id: playerId,
      device_id: deviceId,
      device_name: deviceName || null,
      last_used_at: new Date().toISOString(),
    },
    { onConflict: "player_id,device_id" }
  );

  if (error) {
    logger.error("Device registration failed", {
      playerId,
      deviceId,
      error: error.message,
      route: "platform/auth/devices",
    });
    return { success: false, error: error.message };
  }

  await writeAuditLog({
    action: "device_registered",
    actorId: playerId,
    targetId: playerId,
    details: { deviceId, deviceName },
  });

  return { success: true };
}

/**
 * List all devices for a player.
 */
export async function listPlayerDevices(playerId: string): Promise<DeviceRecord[]> {
  const supabase = getSupabaseServiceClient();

  const { data, error } = await supabase
    .from("player_devices")
    .select("*")
    .eq("player_id", playerId)
    .order("last_used_at", { ascending: false });

  if (error || !data) return [];

  return data.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    playerId: row.player_id as string,
    deviceId: row.device_id as string,
    deviceName: row.device_name as string | null,
    isTrusted: (row.is_trusted as boolean) || false,
    lastUsedAt: row.last_used_at as string,
    createdAt: row.created_at as string,
  }));
}

/**
 * Remove a device from the player's device list.
 */
export async function removeDevice(
  playerId: string,
  deviceId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseServiceClient();

  const { error } = await supabase
    .from("player_devices")
    .delete()
    .eq("player_id", playerId)
    .eq("device_id", deviceId);

  if (error) {
    logger.error("Device removal failed", {
      playerId,
      deviceId,
      error: error.message,
      route: "platform/auth/devices",
    });
    return { success: false, error: error.message };
  }

  await writeAuditLog({
    action: "device_removed",
    actorId: playerId,
    targetId: playerId,
    details: { deviceId },
  });

  return { success: true };
}
