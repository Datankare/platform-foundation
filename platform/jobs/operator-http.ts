/**
 * platform/jobs/operator-http.ts — the Jobs console routes' shared answers (ADR-056, ADR-051)
 *
 * @module platform/jobs
 */

import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/platform/errors";
import type { JobsResult } from "./operator";

/** A jobs result as a response: the value as JSON, or its coded error. */
export function jobsResponse<T>(
  result: JobsResult<T>,
  request: NextRequest
): NextResponse {
  if (result.ok) return NextResponse.json({ result: result.value });
  switch (result.code) {
    case "jobs.not_found":
      return apiError("jobs.not_found", { request });
    case "jobs.not_dead":
      return apiError("jobs.not_dead", { request });
    case "audit.unavailable":
      return apiError("service.unavailable", { params: { service: "audit" }, request });
  }
}
