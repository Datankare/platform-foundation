export function getGoogleApiKey(): string {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY is not configured");
  return key;
}

export function getAnthropicApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not configured");
  return key;
}

/**
 * The Google API key as the translation and voice provider slots check it at boot:
 * GOOGLE_API_KEY, else NEXT_PUBLIC_GOOGLE_API_KEY, else "" (missing — the slot warns).
 */
export function getGoogleApiKeySetting(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  return env.GOOGLE_API_KEY ?? env.NEXT_PUBLIC_GOOGLE_API_KEY ?? "";
}
