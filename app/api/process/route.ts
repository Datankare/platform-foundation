import { NextRequest, NextResponse } from "next/server";
import { checkSafety } from "@/lib/safety";
import { translateToAllLanguages } from "@/lib/translate";
import { textToSpeech } from "@/lib/tts";
import { ProcessResponse } from "@/types";
import { logger, generateRequestId } from "@/lib/logger";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { text } = body;

    if (!text || typeof text !== "string") {
      return NextResponse.json<ProcessResponse>(
        { success: false, error: "Text input is required." },
        { status: 400 }
      );
    }

    const trimmed = text.trim();

    if (trimmed.length === 0) {
      return NextResponse.json<ProcessResponse>(
        { success: false, error: "Text cannot be empty." },
        { status: 400 }
      );
    }

    if (trimmed.length > 100) {
      return NextResponse.json<ProcessResponse>(
        { success: false, error: "Text must be 100 characters or fewer." },
        { status: 400 }
      );
    }

    const safety = await checkSafety(trimmed);

    if (!safety.safe) {
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

    return NextResponse.json<ProcessResponse>({
      success: true,
      translations: results,
    });
  } catch (error) {
    const requestId = generateRequestId();
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
