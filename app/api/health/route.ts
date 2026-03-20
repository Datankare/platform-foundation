import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "Platform Foundation Validation Spike v0.1",
    timestamp: new Date().toISOString(),
    apis: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      google: !!process.env.GOOGLE_API_KEY,
    },
  });
}
