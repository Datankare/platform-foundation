/** @jest-environment jsdom */
/**
 * __tests__/effect-free-state.test.tsx — state that follows a prop or an external source,
 * without setting state inside an effect (PF v5.1.1, React's set-state-in-effect rule)
 *
 * Each case is the hostile one the old effect allowed: the server render disagreeing with
 * hydration. (The realtime-channel hook's case went with the hook, TASK-211. Playform's profile form,
 * a stale response landing after a newer one, is Playform's own test since TASK-210 moved the
 * profile screen to the app that serves its route.)
 */

import React from "react";
import { renderToString } from "react-dom/server";
import { act, renderHook, waitFor } from "@testing-library/react";
import { AuthContextProvider, useAuth } from "@/platform/auth/context";

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
