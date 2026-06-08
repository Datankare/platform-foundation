import { NextRequest, NextResponse } from "next/server";
import { initAuth } from "@/platform/auth/auth-init";
import { getAuthProvider } from "@/platform/auth/config";

export async function POST(request: NextRequest) {
  initAuth();
  let body: { session?: string; newPassword?: string; username?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid request body" },
      { status: 400 }
    );
  }
  if (!body.session || !body.newPassword || !body.username) {
    return NextResponse.json(
      {
        success: false,
        error: "Session, newPassword, and username are required",
      },
      { status: 400 }
    );
  }
  const auth = getAuthProvider();
  return NextResponse.json(
    await auth.respondToNewPasswordChallenge(
      body.session,
      body.newPassword,
      body.username
    )
  );
}
