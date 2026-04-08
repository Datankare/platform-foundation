import { NextResponse } from "next/server";
import { initAuth } from "@/platform/auth/auth-init";
import { getAuthProvider } from "@/platform/auth/config";
import { logger } from "@/lib/logger";

export async function POST() {
  initAuth();
  const auth = getAuthProvider();
  const result = await auth.createGuestToken();

  const response = NextResponse.json(result);

  if (result.success) {
    logger.info("Guest session created", { guestId: result.guestId });
    response.cookies.set("pf_has_session", "true", {
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 72 * 3600, // Guest TTL: 72 hours
    });
  }

  return response;
}
