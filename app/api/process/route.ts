import { NextRequest, NextResponse } from "next/server";
import { checkSafety } from "@/lib/safety";
import { translateToAllLanguages } from "@/lib/translate";
import { textToSpeech } from "@/lib/tts";
import { ProcessResponse } from "@/types";
import { logger, generateRequestId } from "@/lib/logger";
import { MAX_INPUT_CHARACTERS } from "@/shared/config/limits";
import { apiError } from "@/platform/errors";
import { requireActorWithStatus } from "@/platform/auth/actor-guard";
import { enforceGuestAllowance } from "@/platform/auth/guest-allowance";

export async function POST(request: NextRequest) {
  const requestId = generateRequestId();
  const start = Date.now();
  logger.request("/api/process", "POST", requestId);

  // Signed-in users, and guests within the governed allowance (ADR-050 D4). Every call below
  // the validation is paid, so an anonymous request never reaches them.
  const guard = await requireActorWithStatus(request, "translate", { allowGuests: true });
  if (guard.error) return guard.error;

  try {
    const body = await request.json();
    const { text } = body;

    if (!text || typeof text !== "string") {
      logger.response("/api/process", "POST", 400, requestId, Date.now() - start);
      return apiError("request.text_empty", { request });
    }

    const trimmed = text.trim();

    if (trimmed.length === 0) {
      logger.response("/api/process", "POST", 400, requestId, Date.now() - start);
      return apiError("request.text_empty", { request });
    }

    if (trimmed.length > MAX_INPUT_CHARACTERS) {
      logger.response("/api/process", "POST", 400, requestId, Date.now() - start);
      return apiError("request.text_too_long", {
        params: { max: MAX_INPUT_CHARACTERS },
        request,
      });
    }

    // Counted after cheap validation, before the first paid call (the safety classifier).
    const allowance = await enforceGuestAllowance(guard.actor, { request });
    if (allowance.error) {
      logger.response(
        "/api/process",
        "POST",
        allowance.error.status,
        requestId,
        Date.now() - start
      );
      return allowance.error;
    }

    const safety = await checkSafety(trimmed);

    if (!safety.safe) {
      logger.response("/api/process", "POST", 422, requestId, Date.now() - start);
      // The classifier's reason (it may quote matched terms) goes to the log, not the response.
      logger.info("Process input rejected by content screening", {
        requestId,
        reason: safety.reason,
      });
      return apiError("content.rejected", { request });
    }

    const translations = await translateToAllLanguages(trimmed);

    const results = await Promise.all(
      translations.map(async (t) => {
        const audioBase64 = await textToSpeech(t.translated, t.code);
        return {
          language: t.language,
          languageCode: t.code,
          flag: t.flag,
          text: t.translated,
          audioBase64,
        };
      })
    );

    logger.response("/api/process", "POST", 200, requestId, Date.now() - start);
    const response = NextResponse.json<ProcessResponse>({
      success: true,
      translations: results,
    });
    if (allowance.remaining !== null) {
      response.headers.set("X-Guest-Translations-Remaining", String(allowance.remaining));
    }
    return response;
  } catch (error) {
    logger.error("Process API error", {
      requestId,
      route: "/api/process",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return apiError("internal.error", { params: { requestId }, request });
  }
}
