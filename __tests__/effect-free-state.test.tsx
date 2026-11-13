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
import { AuthContextProvider, useAuth } from "@/platform/auth/context";

describe("AuthContextProvider on the server", () => {
  it("renders loading and reads no storage, so hydration agrees", () => {
    const getItem = jest.spyOn(Storage.prototype, "getItem");
    // What a sign-in before ADR-057 left in storage: read by no render, server or client.
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
