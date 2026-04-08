import { NextRequest, NextResponse } from "next/server";
import { initAuth } from "@/platform/auth/auth-init";
import { getAuthProvider } from "@/platform/auth/config";

export async function POST(request: NextRequest) {
  initAuth();
  let body: { email?: string; code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid request body" },
      { status: 400 }
    );
  }
  if (!body.email || !body.code) {
    return NextResponse.json(
      { success: false, error: "Email and code are required" },
      { status: 400 }
    );
  }
  const auth = getAuthProvider();
  return NextResponse.json(await auth.confirmEmailVerification(body.email, body.code));
}
