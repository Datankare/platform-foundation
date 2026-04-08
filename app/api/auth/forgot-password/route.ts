/**
 * app/api/auth/forgot-password/route.ts — Password recovery
 */

import { NextRequest, NextResponse } from "next/server";
import { initAuth } from "@/platform/auth/auth-init";
import { getAuthProvider } from "@/platform/auth/config";

export async function POST(request: NextRequest) {
  initAuth();
  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid request body" },
      { status: 400 }
    );
  }
  if (!body.email) {
    return NextResponse.json(
      { success: false, error: "Email is required" },
      { status: 400 }
    );
  }
  const auth = getAuthProvider();
  const result = await auth.forgotPassword(body.email);
  return NextResponse.json(result);
}
