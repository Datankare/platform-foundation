import { NextResponse } from "next/server";
import { logger, generateRequestId } from "@/lib/logger";

export async function GET() {
  // OWASP A05: never expose API key presence to unauthenticated callers
  const requestId = generateRequestId();
  logger.info("Health check", { requestId, route: "/api/health", status: 200 });
  return NextResponse.json({
    status: "ok",
    service: "Platform Foundation Validation Spike v0.1",
    timestamp: new Date().toISOString(),
  });
}
