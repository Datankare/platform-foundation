/** @jest-environment jsdom */
/**
 * __tests__/effect-free-state.test.tsx — state that follows a prop or an external source,
 * without setting state inside an effect (PF v5.1.1, React's set-state-in-effect rule)
 *
 * Each case is the hostile one the old effect allowed: a stale response landing after a newer
 * one, the previous channel's messages rendered under the new name, and the server render
 * disagreeing with hydration.
 */

import React from "react";
import { renderToString } from "react-dom/server";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRealtimeChannel } from "@/hooks/useRealtimeChannel";
import { useProfileForm } from "@/hooks/useProfileForm";
import { AuthContextProvider, useAuth } from "@/platform/auth/context";
import type { UserProfile } from "@/platform/auth/profile";

function profile(displayName: string): UserProfile {
  return {
    id: "u1",
    email: null,
    displayName,
    avatarUrl: null,
    realName: null,
    languagePreference: "en",
    timezone: "UTC",
    profileVisibility: "private",
    displayNameVisibility: "private",
    avatarVisibility: "private",
    languageVisibility: "private",
    timezoneVisibility: "private",
    emailOptIn: false,
    pushNotificationsEnabled: false,
    mfaEnabled: false,
    emailVerified: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastLoginAt: null,
  };
}

describe("useRealtimeChannel", () => {
  it("starts a new channel empty: the old channel's messages never show under it", async () => {
    const { result, rerender } = renderHook(({ name }) => useRealtimeChannel(name), {
      initialProps: { name: "room-a" },
    });
    await act(() => result.current.broadcast({ payload: "hello" }));
    expect(result.current.messages).toHaveLength(1);

    rerender({ name: "room-b" });
    expect(result.current.messages).toEqual([]);
    expect(result.current.isConnected).toBe(false);
  });
});

describe("useProfileForm", () => {
  const save = jest.fn().mockResolvedValue({ success: true });

  it("drops a replaced loader's late response and shows loading for the new one", async () => {
    let releaseOld!: (p: UserProfile) => void;
    const oldLoader = () => new Promise<UserProfile | null>((r) => (releaseOld = r));
    const newLoader = jest.fn().mockResolvedValue(profile("New"));

    const { result, rerender } = renderHook(({ load }) => useProfileForm(load, save), {
      initialProps: { load: oldLoader as () => Promise<UserProfile | null> },
    });
    expect(result.current.isLoading).toBe(true);

    rerender({ load: newLoader });
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.displayName).toBe("New"));

    await act(async () => releaseOld(profile("Stale")));
    expect(result.current.displayName).toBe("New");
    expect(result.current.isLoading).toBe(false);
  });
});

describe("AuthContextProvider after a restore", () => {
  it("a new sign-in replaces the restored session, and sign-out clears both", async () => {
    localStorage.setItem("pf_access_token", "guest_old_" + Date.now());
    localStorage.setItem(
      "pf_user",
      JSON.stringify({ userId: "old", email: "", emailVerified: false, isGuest: true })
    );
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthContextProvider>{children}</AuthContextProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user?.userId).toBe("old"));

    act(() =>
      result.current.setSession({
        accessToken: "new-token",
        userId: "new",
        email: "n@x.y",
        emailVerified: true,
      })
    );
    expect(result.current.user?.userId).toBe("new");
    expect(result.current.getAccessToken()).toBe("new-token");
    expect(localStorage.getItem("pf_access_token")).toBe("new-token");

    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    await act(async () => {
      await result.current.signOut();
    });
    expect(result.current.user).toBeNull();
    expect(result.current.getAccessToken()).toBeNull();
    expect(localStorage.getItem("pf_access_token")).toBeNull();
    expect(localStorage.getItem("pf_user")).toBeNull();
  });
});

describe("AuthContextProvider on the server", () => {
  it("renders loading and reads no storage, so hydration agrees", () => {
    const getItem = jest.spyOn(Storage.prototype, "getItem");
    localStorage.setItem("pf_access_token", "guest_x_" + Date.now());
    localStorage.setItem(
      "pf_user",
      JSON.stringify({ userId: "g", email: "", emailVerified: false, isGuest: true })
    );
    getItem.mockClear();

    function Probe() {
      const { isLoading, user } = useAuth();
      return <span>{isLoading ? "loading" : user ? "signed-in" : "signed-out"}</span>;
    }
    const html = renderToString(
      <AuthContextProvider>
        <Probe />
      </AuthContextProvider>
    );
    expect(html).toContain("loading");
    expect(getItem).not.toHaveBeenCalled();
    getItem.mockRestore();
    localStorage.clear();
  });
});
