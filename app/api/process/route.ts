import { NextRequest, NextResponse } from "next/server";
import { checkSafety } from "@/lib/safety";
import { translateToAllLanguages } from "@/lib/translate";
import { textToSpeech } from "@/lib/tts";
import { ProcessResponse } from "@/types";
import { logger, generateRequestId } from "@/lib/logger";

export async function POST(request: NextRequest) {
  const requestId = generateRequestId();
  const start = Date.now();
  logger.request("/api/process", "POST", requestId);

  try {
    const body = await request.json();
    const { text } = body;

    if (!text || typeof text !== "string") {
      logger.response("/api/process", "POST", 400, requestId, Date.now() - start);
      return NextResponse.json<ProcessResponse>(
        { success: false, error: "Text input is required." },
        { status: 400 }
      );
    }

    const trimmed = text.trim();

    if (trimmed.length === 0) {
      logger.response("/api/process", "POST", 400, requestId, Date.now() - start);
      return NextResponse.json<ProcessResponse>(
        { success: false, error: "Text cannot be empty." },
        { status: 400 }
      );
    }

    if (trimmed.length > 100) {
      logger.response("/api/process", "POST", 400, requestId, Date.now() - start);
      return NextResponse.json<ProcessResponse>(
        { success: false, error: "Text must be 100 characters or fewer." },
        { status: 400 }
      );
    }

    const safety = await checkSafety(trimmed);

    if (!safety.safe) {
      logger.response("/api/process", "POST", 422, requestId, Date.now() - start);
      return NextResponse.json<ProcessResponse>(
        {
          success: false,
          error: `Content rejected: ${safety.reason || "Input does not meet content guidelines."}`,
        },
        { status: 422 }
      );
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
    return NextResponse.json<ProcessResponse>({
      success: true,
      translations: results,
    });
  } catch (error) {
    logger.error("Process API error", {
      requestId,
      route: "/api/process",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json<ProcessResponse>(
      { success: false, error: "An unexpected error occurred. Please try again." },
      { status: 500 }
    );
  }
}
