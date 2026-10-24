/**
 * platform/observability/deployment.ts — which build is running (ADR-050 D6, ADR-055 D2)
 *
 * @module platform/observability
 */

import { getGitCommitSha } from "@/platform/providers/environment-contract";

/**
 * The deployed commit (first 12 characters), or null when unknown. Host-neutral (ADR-055 D2):
 * GIT_COMMIT_SHA, baked into a container image at build, then the commit Vercel provides.
 */
export function deployedCommit(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | null {
  const sha = (getGitCommitSha(env)?.trim() || env.VERCEL_GIT_COMMIT_SHA?.trim()) ?? "";
  return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 12).toLowerCase() : null;
}
