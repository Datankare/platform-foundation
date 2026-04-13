/**
 * hooks/useRealtimeChannel.ts — Generic realtime channel hook
 *
 * Subscribes to a realtime channel for messaging and presence.
 * Uses the RealtimeProvider from the provider registry.
 *
 * Usage:
 *   const { messages, broadcast, presence, isConnected } = useRealtimeChannel("room:lobby");
 *
 * @module hooks
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { RealtimeMessage, PresenceEntry } from "@/platform/realtime/types";

export interface UseRealtimeChannelResult {
  /** Messages received on this channel */
  messages: RealtimeMessage[];
  /** Broadcast a message to the channel */
  broadcast: (
    message: Partial<Omit<RealtimeMessage, "id" | "timestamp" | "channel">>
  ) => Promise<void>;
  /** Current presence entries */
  presence: PresenceEntry[];
  /** Whether the channel is connected */
  isConnected: boolean;
  /** Clear received messages */
  clearMessages: () => void;
}

/**
 * Hook for subscribing to a realtime channel.
 *
 * Note: In the current implementation, this hook works with the mock provider
 * for development. When the RealtimeProvider is wired into the app context,
 * this hook will use the active provider automatically.
 */
export function useRealtimeChannel(channelName: string): UseRealtimeChannelResult {
  const [messages, setMessages] = useState<RealtimeMessage[]>([]);
  const [presence, setPresence] = useState<PresenceEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const channelRef = useRef<string>(channelName);

  useEffect(() => {
    channelRef.current = channelName;
    // Channel subscription will be wired when RealtimeProvider
    // is available in app context (Sprint 5 integration step)
    setIsConnected(false);
    setMessages([]);
    setPresence([]);

    return () => {
      setIsConnected(false);
    };
  }, [channelName]);

  const broadcast = useCallback(
    async (message: Partial<Omit<RealtimeMessage, "id" | "timestamp" | "channel">>) => {
      // Will delegate to RealtimeProvider when wired
      const fullMessage: RealtimeMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        timestamp: Date.now(),
        channel: channelRef.current,
        type: message.type ?? "notification",
        actorType: message.actorType ?? "user",
        actorId: message.actorId ?? "unknown",
        intent: message.intent ?? "inform",
        payload: message.payload ?? null,
        ...message,
      };

      setMessages((prev) => [...prev, fullMessage]);
    },
    []
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return { messages, broadcast, presence, isConnected, clearMessages };
}
